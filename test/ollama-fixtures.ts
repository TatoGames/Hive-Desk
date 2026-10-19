import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { deflateRawSync, gzipSync } from 'node:zlib'

/** Small builders for fake release files, a fake Ollama program and a fake download server (no network, no real Ollama). */

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

const CRC = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t.push(c >>> 0)
  }
  return t
})()
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface FileSpec {
  name: string
  data?: Buffer | string
  /** Unix mode (default 0o644). */
  mode?: number
  stored?: boolean
  /** tar only: a symbolic link to this target. */
  link?: string
}

export function makeZip(files: FileSpec[]): Buffer {
  const parts: Buffer[] = []
  const cd: Buffer[] = []
  let off = 0
  for (const f of files) {
    const raw = Buffer.from(f.data ?? '')
    const dir = f.name.endsWith('/')
    const comp = f.stored || dir ? raw : deflateRawSync(raw)
    const method = f.stored || dir ? 0 : 8
    const name = Buffer.from(f.name)
    const crc = crc32(raw)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(name.length, 26)
    parts.push(lh, name, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE((((f.mode ?? 0o644) | (dir ? 0o040000 : 0o100000)) << 16) >>> 0, 38)
    ch.writeUInt32LE(off, 42)
    cd.push(ch, name)
    off += 30 + name.length + comp.length
  }
  const cdBuf = Buffer.concat(cd)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cdBuf, end])
}

export function makeTgz(files: FileSpec[]): Buffer {
  const blocks: Buffer[] = []
  for (const f of files) {
    const data = Buffer.from(f.data ?? '')
    const h = Buffer.alloc(512)
    h.write(f.name, 0, 100)
    h.write((f.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write((f.link ? 0 : data.length).toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.write('        ', 148)
    h.write(f.link ? '2' : '0', 156)
    if (f.link) h.write(f.link, 157, 100)
    h.write('ustar\0' + '00', 257)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h)
    if (!f.link && data.length) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** A program that behaves like `ollama serve` on the two routes the app uses. Run through the test's own node. */
export const FAKE_OLLAMA = (): string => `#!${process.execPath}
const http = require('http')
if (process.argv[2] !== 'serve') process.exit(2)
if (process.env.FAKE_FAIL) { console.error(process.env.FAKE_FAIL); process.exit(3) }
const i = process.env.OLLAMA_HOST.lastIndexOf(':')
http.createServer((q, r) => {
  if (q.url === '/api/version') return r.end('{"version":"9.9.9"}')
  if (q.url === '/api/tags') return r.end(JSON.stringify({ models: [], models_dir: process.env.OLLAMA_MODELS }))
  r.statusCode = 404; r.end()
}).listen(+process.env.OLLAMA_HOST.slice(i + 1), process.env.OLLAMA_HOST.slice(0, i))
process.on('SIGTERM', () => process.exit(0))
`

export interface Fake {
  server: Server
  base: string
  files: Map<string, Buffer>
  requests: { url: string; range?: string }[]
  /** Milliseconds between 64KB pieces (0 = at once). */
  slow: number
  close: () => void
}

export async function fakeDownloads(): Promise<Fake> {
  const files = new Map<string, Buffer>()
  const requests: Fake['requests'] = []
  const f: Fake = { files, requests, slow: 0, base: '', server: undefined as unknown as Server, close: () => undefined }
  f.server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', range: req.headers.range })
    if (req.url === '/redirect-out') return void res.writeHead(302, { Location: 'http://localhost:9/evil' }).end()
    if (req.url === '/redirect') return void res.writeHead(302, { Location: '/file' }).end()
    const body = files.get(req.url ?? '')
    if (!body) return void res.writeHead(404).end()
    let start = 0
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    if (m) start = Number(m[1])
    if (start >= body.length) return void res.writeHead(416).end()
    res.writeHead(m ? 206 : 200, {
      'Content-Length': body.length - start,
      ...(m ? { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` } : {})
    })
    let at = start
    const send = (): void => {
      if (res.destroyed) return
      if (at >= body.length) return void res.end()
      res.write(body.subarray(at, at + 65536))
      at += 65536
      if (f.slow) setTimeout(send, f.slow)
      else setImmediate(send)
    }
    send()
  })
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r))
  f.base = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`
  f.close = () => {
    f.server.closeAllConnections()
    f.server.close()
  }
  return f
}
