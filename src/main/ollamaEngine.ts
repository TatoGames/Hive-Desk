import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'
import { engineDirOf, modelsDirOf } from './paths'
import { probe, type FetchFn } from './openai'

/**
 * Ollama inside the HiveDesk folder: download the program (no installer), check its sha256, unpack, run `ollama serve`
 * with the models kept next to it. Electron is not imported: everything it needs is passed in, so tests run it for real
 * against a fake server and a fake program.
 */

export interface EngineFile {
  url: string
  sha256: string
  format: 'tgz' | 'zip'
  /** Path of the program inside the archive. */
  exe: string
  sizeBytes?: number
  verification?: string
}

export interface EngineManifest {
  version: string
  platforms: Record<string, Partial<EngineFile> | undefined>
}

export type Plan = { ok: true; version: string; file: EngineFile } | { ok: false; reason: string }

const SHA256 = /^[0-9a-f]{64}$/

/** The download for this PC, or the reason there is none. A missing or malformed value is "unverified": no install. */
export function planFor(m: EngineManifest, key: string): Plan {
  if (!/^[0-9A-Za-z._-]+$/.test(m.version ?? '')) return { ok: false, reason: '내려받기 정보의 버전이 비어 있거나 올바르지 않아요.' }
  const f = m.platforms?.[key]
  if (!f) return { ok: false, reason: `이 PC(${key})용 Ollama 내려받기 정보가 아직 확인되지 않았어요.` }
  if (typeof f.url !== 'string' || !/^https?:\/\//i.test(f.url)) return { ok: false, reason: `이 PC(${key})용 내려받기 주소가 확인되지 않았어요.` }
  if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256)) return { ok: false, reason: `이 PC(${key})용 파일의 sha256 값이 확인되지 않아서 설치할 수 없어요. 값을 검증하지 못한 파일은 받지 않아요.` }
  if (f.format !== 'tgz' && f.format !== 'zip') return { ok: false, reason: '압축 형식이 확인되지 않았어요.' }
  if (typeof f.exe !== 'string' || !f.exe || isAbsolute(f.exe) || f.exe.split(/[\\/]/).includes('..')) return { ok: false, reason: '실행 파일 위치가 확인되지 않았어요.' }
  return { ok: true, version: m.version, file: { url: f.url, sha256: f.sha256, format: f.format, exe: f.exe, sizeBytes: f.sizeBytes, verification: f.verification } }
}

/** Only GitHub's release downloads (and the hosts GitHub redirects them to), over https. */
export function githubOnly(u: URL): boolean {
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  return h === 'github.com' || h.endsWith('.github.com') || h === 'githubusercontent.com' || h.endsWith('.githubusercontent.com')
}

// ---- unpacking ----

/** A path from an archive that stays inside the folder it is unpacked to. Throws on anything else (zip slip). */
export function safeJoin(dest: string, entry: string): string {
  const name = entry.replace(/\\/g, '/')
  if (!name || name.includes('\0')) throw new Error(`압축 안의 이름이 올바르지 않아요: ${JSON.stringify(entry)}`)
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`압축 안에 절대 경로가 있어서 풀지 않았어요: ${entry}`)
  if (name.split('/').includes('..')) throw new Error(`압축 안에 폴더 밖으로 나가는 경로가 있어서 풀지 않았어요: ${entry}`)
  const full = resolve(dest, name)
  const rel = relative(resolve(dest), full)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`압축 안에 폴더 밖으로 나가는 경로가 있어서 풀지 않았어요: ${entry}`)
  return full
}

interface ZipEntry {
  name: string
  method: number
  csize: number
  usize: number
  offset: number
  mode: number
}

async function readZipEntries(file: string): Promise<ZipEntry[]> {
  const fh = await open(file, 'r')
  try {
    const size = (await fh.stat()).size
    const tailLen = Math.min(size, 65557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    const e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (e < 0) throw new Error('zip 파일이 아니에요.')
    const count = tail.readUInt16LE(e + 10)
    const cdSize = tail.readUInt32LE(e + 12)
    const cdOff = tail.readUInt32LE(e + 16)
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('이 zip 형식(zip64)은 지원하지 않아요.')
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOff)
    const out: ZipEntry[] = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 목록이 깨져 있어요.')
      const flags = cd.readUInt16LE(p + 8)
      if (flags & 1) throw new Error('암호가 걸린 zip은 풀 수 없어요.')
      const fl = cd.readUInt16LE(p + 28)
      const el = cd.readUInt16LE(p + 30)
      const cl = cd.readUInt16LE(p + 32)
      const csize = cd.readUInt32LE(p + 20)
      const usize = cd.readUInt32LE(p + 24)
      const offset = cd.readUInt32LE(p + 42)
      if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new Error('이 zip 형식(zip64)은 지원하지 않아요.')
      out.push({ name: cd.toString('utf8', p + 46, p + 46 + fl), method: cd.readUInt16LE(p + 10), csize, usize, offset, mode: cd.readUInt32LE(p + 38) >>> 16 })
      p += 46 + fl + el + cl
    }
    return out
  } finally {
    await fh.close()
  }
}

/** Unpack a zip without any outside tool. Every name is checked before the first byte is written. */
export async function extractZip(zip: string, dest: string, signal?: AbortSignal): Promise<void> {
  const entries = await readZipEntries(zip)
  const plan = entries.map((en) => {
    if (((en.mode & 0o170000) === 0o120000)) throw new Error(`압축 안에 바로가기(심볼릭 링크)가 있어서 풀지 않았어요: ${en.name}`)
    if (en.method !== 0 && en.method !== 8) throw new Error(`지원하지 않는 압축 방식이에요: ${en.name}`)
    return { en, target: safeJoin(dest, en.name), dir: en.name.endsWith('/') || en.name.endsWith('\\') }
  })
  mkdirSync(dest, { recursive: true })
  const fh = await open(zip, 'r')
  try {
    for (const { en, target, dir } of plan) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      if (dir) {
        mkdirSync(target, { recursive: true })
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      const head = Buffer.alloc(30)
      await fh.read(head, 0, 30, en.offset)
      if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`zip 안의 파일 머리글이 깨져 있어요: ${en.name}`)
      const start = en.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
      const out = createWriteStream(target)
      if (en.csize === 0) {
        out.end()
        await new Promise<void>((r) => out.on('close', () => r()))
        continue
      }
      const src = createReadStream(zip, { start, end: start + en.csize - 1 })
      await pipeline(...(en.method === 8 ? [src, createInflateRaw(), out] : [src, out]) as [NodeJS.ReadableStream, NodeJS.WritableStream], signal ? { signal } : {})
      if (statSync(target).size !== en.usize) throw new Error(`풀린 크기가 맞지 않아요: ${en.name}`)
    }
  } finally {
    await fh.close()
  }
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? rej(new Error(`${cmd} ${err.message}\n${stderr}`.trim())) : res(stdout))))

/** Every file and link under `dir` must resolve to a place inside `dir`. */
function assertContained(dir: string): void {
  const root = realpathSync(dir)
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(p), readlinkSync(p))
        const rel = relative(root, target)
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`압축 안의 바로가기가 폴더 밖을 가리켜서 지웠어요: ${n}`)
      } else if (st.isDirectory()) walk(p)
    }
  }
  walk(root)
}

/** Unpack a .tgz with the system `tar` (macOS and Linux have it). Names are listed and checked first. */
export async function extractTgz(tgz: string, dest: string): Promise<void> {
  const names = (await run('tar', ['-tzf', tgz])).split('\n').filter(Boolean)
  for (const n of names) safeJoin(dest, n)
  mkdirSync(dest, { recursive: true })
  await run('tar', ['-xzf', tgz, '-C', dest])
  assertContained(dest)
}

// ---- state shown on the screen ----

export interface EngineJob {
  state: 'downloading' | 'verifying' | 'extracting' | 'done' | 'failed' | 'cancelled'
  text: string
  fraction?: number
  error?: string
}

export interface EngineStatus {
  /** `darwin-arm64`, `win32-x64`, ... */
  platformKey: string
  /** Why nothing can be installed here (unverified download info, unsupported PC); undefined = ready. */
  unavailable?: string
  version?: string
  sizeBytes?: number
  /** Where the download comes from (host only, for the screen). */
  host?: string
  installed: boolean
  installedVersion?: string
  engineDir: string
  modelsDir: string
  running: boolean
  port?: number
  baseUrl?: string
  portNote?: string
  /** Another Ollama (not started by HiveDesk) answers on the usual port. */
  foreignOnDefaultPort: boolean
  defaultPort: number
  job?: EngineJob
  /** The last problem, word for word from the system / the program. */
  lastError?: string
}

export interface OllamaEngineOpts {
  homeDir: () => string
  manifest: EngineManifest
  /** Called when something on the screen changed. */
  changed: () => void
  /** Called with the address once the server answers (adds the connection). */
  connect: (url: string) => Promise<unknown>
  platform?: string
  arch?: string
  fetchFn?: FetchFn
  /** Which download addresses are allowed (default: GitHub over https only). */
  allowUrl?: (u: URL) => boolean
  defaultPort?: number
  startTimeoutMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const isAbort = (e: unknown): boolean => (e as Error)?.name === 'AbortError' || (e as { code?: string })?.code === 'ABORT_ERR'

/** Is this port free on the loopback address? */
export function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer()
    s.once('error', () => res(false))
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)))
  })
}

export class OllamaEngine {
  private job?: EngineJob
  private ac?: AbortController
  private task?: Promise<void>
  private child?: ChildProcess
  private port?: number
  private portNote?: string
  private lastError?: string
  private stopping = false
  private starting = false
  private lastEmit = 0
  private tail: string[] = []

  constructor(private o: OllamaEngineOpts) {}

  private get key(): string {
    return `${this.o.platform ?? process.platform}-${this.o.arch ?? process.arch}`
  }
  private get defaultPort(): number {
    return this.o.defaultPort ?? 11434
  }
  private get plan(): Plan {
    return planFor(this.o.manifest, this.key)
  }
  private get exeName(): string | undefined {
    const p = this.plan
    return p.ok ? p.file.exe : undefined
  }

  private emit(throttle = false): void {
    const now = Date.now()
    if (throttle && now - this.lastEmit < 150) return
    this.lastEmit = now
    this.o.changed()
  }

  private setJob(j: EngineJob | undefined, throttle = false): void {
    this.job = j
    this.emit(throttle)
  }

  /** The newest installed version that has its program file, if any. */
  private installed(): { version: string; exe: string } | undefined {
    const exe = this.exeName
    const root = engineDirOf(this.o.homeDir())
    if (!exe || !existsSync(root)) return undefined
    const versions = readdirSync(root)
      .filter((n) => !n.startsWith('.') && existsSync(join(root, n, exe)))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    return versions.length ? { version: versions[0], exe: join(root, versions[0], exe) } : undefined
  }

  async status(): Promise<EngineStatus> {
    const plan = this.plan
    const inst = this.installed()
    let foreign = false
    if (!(this.child && this.port === this.defaultPort)) {
      try {
        const f = this.o.fetchFn ?? fetch
        const r = await f(`http://127.0.0.1:${this.defaultPort}/api/version`, { signal: AbortSignal.timeout(1200) })
        foreign = r.ok
      } catch {
        foreign = false
      }
    }
    return {
      platformKey: this.key,
      unavailable: plan.ok ? undefined : plan.reason,
      version: plan.ok ? plan.version : undefined,
      sizeBytes: plan.ok ? plan.file.sizeBytes : undefined,
      host: plan.ok ? new URL(plan.file.url).hostname : undefined,
      installed: !!inst,
      installedVersion: inst?.version,
      engineDir: engineDirOf(this.o.homeDir()),
      modelsDir: modelsDirOf(this.o.homeDir()),
      running: !!this.child && !this.stopping,
      port: this.child ? this.port : undefined,
      baseUrl: this.child && this.port ? `http://127.0.0.1:${this.port}` : undefined,
      portNote: this.child ? this.portNote : undefined,
      foreignOnDefaultPort: foreign,
      defaultPort: this.defaultPort,
      job: this.job,
      lastError: this.lastError
    }
  }

  // ---- install ----

  /** Check what can be checked now and throw a readable reason; the download itself runs in the background (`whenIdle`). */
  async install(): Promise<void> {
    if (this.task) throw new Error('이미 설치하는 중이에요.')
    const plan = this.plan
    if (!plan.ok) {
      this.setJob({ state: 'failed', text: '설치할 수 없어요', error: plan.reason })
      throw new Error(plan.reason)
    }
    if (!(this.o.allowUrl ?? githubOnly)(new URL(plan.file.url))) {
      const reason = `허용하지 않는 내려받기 주소예요 (${new URL(plan.file.url).hostname}). https로 된 GitHub 릴리스만 받아요.`
      this.setJob({ state: 'failed', text: '설치할 수 없어요', error: reason })
      throw new Error(reason)
    }
    const inst = this.installed()
    if (inst?.version === plan.version) throw new Error(`이미 설치되어 있어요 (${plan.version}).`)
    this.ac = new AbortController()
    this.setJob({ state: 'downloading', text: '내려받기를 시작해요', fraction: 0 })
    const ac = this.ac
    this.task = this.runInstall(plan.version, plan.file, ac.signal).finally(() => {
      this.task = undefined
    })
  }

  whenIdle(): Promise<void> {
    return this.task ?? Promise.resolve()
  }

  cancel(): void {
    this.ac?.abort()
  }

  private async runInstall(version: string, f: EngineFile, signal: AbortSignal): Promise<void> {
    const root = engineDirOf(this.o.homeDir())
    const dlDir = join(dirname(root), '.download')
    const part = join(dlDir, `ollama-${version}-${this.key}.${f.format}.part`)
    const staging = join(root, `.staging-${randomBytes(4).toString('hex')}`)
    try {
      mkdirSync(dlDir, { recursive: true })
      await this.download(f, part, signal)
      // nothing is unpacked or run before this check passes
      this.setJob({ state: 'verifying', text: '받은 파일이 맞는지 확인하는 중이에요 (sha256)' })
      const got = await sha256File(part, signal)
      if (got !== f.sha256) {
        rmSync(part, { force: true })
        throw new Error(`받은 파일의 sha256이 기대한 값과 달라서 풀지도 실행하지도 않고 지웠어요. 기대 ${f.sha256.slice(0, 12)}… / 실제 ${got.slice(0, 12)}…`)
      }
      this.setJob({ state: 'extracting', text: '압축을 푸는 중이에요' })
      mkdirSync(root, { recursive: true })
      if (f.format === 'tgz') await extractTgz(part, staging)
      else await extractZip(part, staging, signal)
      const exe = join(staging, f.exe)
      if (!existsSync(exe)) throw new Error(`압축 안에서 ${f.exe} 파일을 찾지 못했어요.`)
      if (process.platform !== 'win32') chmodSync(exe, 0o755)
      const target = join(root, version)
      rmSync(target, { recursive: true, force: true })
      renameSync(staging, target)
      rmSync(part, { force: true })
      this.lastError = undefined
      this.setJob({ state: 'done', text: `설치했어요 (${version})` })
    } catch (e) {
      rmSync(staging, { recursive: true, force: true })
      if (isAbort(e)) this.setJob({ state: 'cancelled', text: '중지했어요. 다시 누르면 받은 데까지 이어받아요' })
      else this.setJob({ state: 'failed', text: '설치하지 못했어요', error: (e as Error).message })
    }
  }

  private async download(f: EngineFile, part: string, signal: AbortSignal): Promise<void> {
    const fetchFn = this.o.fetchFn ?? fetch
    const allow = this.o.allowUrl ?? githubOnly
    let have = existsSync(part) ? statSync(part).size : 0
    for (let attempt = 0; attempt < 2; attempt++) {
      let url = new URL(f.url)
      let res: Response | undefined
      for (let hop = 0; hop < 6; hop++) {
        if (!allow(url)) throw new Error(`허용하지 않는 내려받기 주소예요 (${url.hostname}). GitHub 릴리스만 받아요.`)
        res = await fetchFn(url, { redirect: 'manual', signal, headers: have > 0 ? { Range: `bytes=${have}-` } : {} })
        const loc = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && loc) {
          await res.body?.cancel().catch(() => undefined)
          url = new URL(loc, url)
          continue
        }
        break
      }
      if (!res) throw new Error('내려받기에 실패했어요.')
      if (res.status === 416 && have > 0) {
        // the partial file does not fit this download: start over
        await res.body?.cancel().catch(() => undefined)
        rmSync(part, { force: true })
        have = 0
        continue
      }
      if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel().catch(() => undefined)
        throw new Error(`내려받지 못했어요. 서버가 ${res.status} 응답을 줬어요.`)
      }
      const resumed = res.status === 206
      if (!resumed) have = 0
      const lenHeader = Number(res.headers.get('content-length') ?? 0)
      const total = resumed ? Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? have + lenHeader) : lenHeader
      const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' })
      let got = have
      try {
        if (!res.body) throw new Error('서버가 내용을 주지 않았어요.')
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
          got += chunk.byteLength
          this.setJob({ state: 'downloading', text: total ? `내려받는 중 ${mb(got)} / ${mb(total)}` : `내려받는 중 ${mb(got)}`, fraction: total ? got / total : undefined }, true)
        }
      } finally {
        await new Promise<void>((r) => out.end(r))
      }
      if (total && statSync(part).size !== total) throw new Error('내려받기가 중간에 끊겼어요. 다시 누르면 이어받아요.')
      return
    }
    throw new Error('이어받기에 실패했어요. 다시 시도해 주세요.')
  }

  // ---- run ----

  async start(): Promise<EngineStatus> {
    if (this.child || this.starting) return this.status()
    const inst = this.installed()
    if (!inst) throw new Error('먼저 Ollama를 설치해 주세요.')
    this.starting = true
    this.lastError = undefined
    this.tail = []
    this.emit()
    let child: ChildProcess | undefined
    try {
      let port = this.defaultPort
      let found = false
      for (let i = 0; i < 30; i++, port++) {
        if (await portFree(port)) {
          found = true
          break
        }
      }
      if (!found) throw new Error(`비어 있는 포트를 찾지 못했어요 (${this.defaultPort}~${port - 1}).`)
      const models = modelsDirOf(this.o.homeDir())
      mkdirSync(models, { recursive: true })
      if (process.platform !== 'win32') {
        try {
          chmodSync(inst.exe, 0o755)
        } catch {
          /* the start below reports the real problem */
        }
      }
      let spawnErr: Error | undefined
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
      child = spawn(inst.exe, ['serve'], {
        cwd: dirname(inst.exe),
        env: { ...process.env, OLLAMA_MODELS: models, OLLAMA_HOST: `127.0.0.1:${port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      const me = child
      const onData = (d: Buffer): void => {
        this.tail.push(...d.toString().split(/\r?\n/).filter(Boolean))
        if (this.tail.length > 20) this.tail = this.tail.slice(-20)
      }
      me.stdout?.on('data', onData)
      me.stderr?.on('data', onData)
      me.on('error', (e) => {
        spawnErr = e
      })
      me.on('exit', (code, signal) => {
        exited = { code, signal }
        if (this.child === me) {
          this.child = undefined
          this.port = undefined
          if (!this.stopping) {
            this.lastError = `Ollama가 갑자기 멈췄어요 (${signal ? `신호 ${signal}` : `종료 코드 ${code}`}).${this.tailText()}`
            this.emit()
          }
        }
      })
      const url = `http://127.0.0.1:${port}`
      const deadline = Date.now() + (this.o.startTimeoutMs ?? 30000)
      for (;;) {
        if (spawnErr) throw new Error(`실행하지 못했어요: ${spawnErr.message}`)
        if (exited) throw new Error(`시작하자마자 꺼졌어요 (${exited.signal ? `신호 ${exited.signal}` : `종료 코드 ${exited.code}`}).${this.tailText()}`)
        try {
          await probe({ url, fetchFn: this.o.fetchFn })
          break
        } catch {
          /* not up yet */
        }
        if (Date.now() > deadline) throw new Error(`${Math.round((this.o.startTimeoutMs ?? 30000) / 1000)}초 안에 준비되지 않았어요.${this.tailText()}`)
        await sleep(150)
      }
      this.child = me
      this.port = port
      this.portNote = port !== this.defaultPort ? `기본 포트 ${this.defaultPort}은 이미 다른 프로그램이 쓰고 있어서 ${port}번 포트로 켰어요.` : undefined
      this.stopping = false
      try {
        await this.o.connect(url)
      } catch (e) {
        this.lastError = `켜졌지만 연결을 추가하지 못했어요: ${(e as Error).message}`
      }
    } catch (e) {
      if (child && child.exitCode === null && !child.killed) child.kill()
      this.lastError = (e as Error).message
      this.emit()
      throw e
    } finally {
      this.starting = false
      this.emit()
    }
    return this.status()
  }

  private tailText(): string {
    return this.tail.length ? `\n프로그램이 남긴 말:\n${this.tail.slice(-8).join('\n')}` : ''
  }

  async stop(): Promise<void> {
    const c = this.child
    if (!c) return
    this.stopping = true
    const gone = new Promise<void>((r) => (c.exitCode !== null ? r() : c.once('exit', () => r())))
    c.kill()
    const hard = setTimeout(() => c.kill('SIGKILL'), 5000)
    await gone
    clearTimeout(hard)
    this.child = undefined
    this.port = undefined
    this.stopping = false
    this.emit()
  }

  /** The app is quitting: no waiting. */
  shutdown(): void {
    this.ac?.abort()
    const c = this.child
    if (c && c.exitCode === null) {
      this.stopping = true
      c.kill()
    }
  }

  /** Delete the program files only (every version and half-done downloads). Models stay. */
  async remove(): Promise<void> {
    if (this.task) throw new Error('설치하는 중에는 지울 수 없어요. 먼저 중지해 주세요.')
    await this.stop()
    const root = engineDirOf(this.o.homeDir())
    rmSync(root, { recursive: true, force: true })
    rmSync(join(dirname(root), '.download'), { recursive: true, force: true })
    this.job = undefined
    this.lastError = undefined
    this.emit()
  }
}

const mb = (n: number): string => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'GB' : Math.round(n / 1e6) + 'MB')

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) h.update(chunk as Buffer)
  return h.digest('hex')
}
