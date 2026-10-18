import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'

/**
 * A very small Chrome DevTools Protocol client over a WebSocket (no dependencies: the app's own
 * Electron runs Node 20, which has no WebSocket). Enough to watch a page for errors and take a picture.
 */
export interface Cdp {
  send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  on: (handler: (method: string, params: Record<string, unknown>) => void) => void
  close: () => void
}

export function cdpConnect(wsUrl: string, timeoutMs = 10_000): Promise<Cdp> {
  const u = new URL(wsUrl)
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(Number(u.port), u.hostname)
    const key = randomBytes(16).toString('base64')
    let buf = Buffer.alloc(0)
    let open = false
    let nextId = 1
    const waiting = new Map<number, { ok: (v: unknown) => void; bad: (e: Error) => void }>()
    const handlers: ((m: string, p: Record<string, unknown>) => void)[] = []
    let frags: Buffer[] = []
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('DevTools 연결 시간 초과'))
    }, timeoutMs)

    const frame = (payload: Buffer): Buffer => {
      const len = payload.length
      const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : len < 65536 ? Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 0x80 | 127]), bigLen(len)])
      const mask = randomBytes(4)
      const body = Buffer.alloc(len)
      for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3]
      return Buffer.concat([head, mask, body])
    }
    const onMessage = (text: string): void => {
      let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } }
      try {
        m = JSON.parse(text)
      } catch {
        return
      }
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id)!
        waiting.delete(m.id)
        if (m.error) w.bad(new Error(m.error.message))
        else w.ok(m.result)
      } else if (m.method) for (const h of handlers) h(m.method, m.params ?? {})
    }
    const parse = (): void => {
      for (;;) {
        if (buf.length < 2) return
        const fin = (buf[0] & 0x80) !== 0
        const op = buf[0] & 0x0f
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        if (buf.length < off + len) return
        const data = buf.subarray(off, off + len)
        buf = buf.subarray(off + len)
        if (op === 8) return void sock.destroy()
        if (op === 9) continue // ping: the browser does not need an answer for this short session
        if (op === 1 || op === 2 || op === 0) {
          frags.push(Buffer.from(data))
          if (fin) {
            onMessage(Buffer.concat(frags).toString('utf8'))
            frags = []
          }
        }
      }
    }
    sock.on('connect', () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    })
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (!open) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buf.subarray(0, end).toString()
        buf = buf.subarray(end + 4)
        if (!/^HTTP\/1\.1 101/.test(head)) {
          clearTimeout(timer)
          sock.destroy()
          return reject(new Error('DevTools 연결 실패: ' + head.split('\r\n')[0]))
        }
        open = true
        clearTimeout(timer)
        resolve({
          send: (method, params = {}) =>
            new Promise((ok, bad) => {
              const id = nextId++
              waiting.set(id, { ok: ok as (v: unknown) => void, bad })
              sock.write(frame(Buffer.from(JSON.stringify({ id, method, params }))))
            }),
          on: (h) => void handlers.push(h),
          close: () => sock.destroy()
        })
      }
      parse()
    })
    sock.on('error', (e) => {
      clearTimeout(timer)
      for (const w of waiting.values()) w.bad(e)
      waiting.clear()
      if (!open) reject(e)
    })
    sock.on('close', () => {
      for (const w of waiting.values()) w.bad(new Error('DevTools 연결이 끊겼어요'))
      waiting.clear()
    })
  })
}

function bigLen(n: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}
