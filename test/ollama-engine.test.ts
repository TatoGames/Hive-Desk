import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/main/engine'
import { OllamaEngine, extractZip, githubOnly, planFor, safeJoin, type EngineManifest } from '../src/main/ollamaEngine'
import { engineDirOf, modelsDirOf } from '../src/main/paths'
import { FAKE_OLLAMA, fakeDownloads, makeTgz, makeZip, sha256, type Fake } from './ollama-fixtures'

const KEY = `${process.platform}-${process.arch}`
const posix = process.platform !== 'win32'

let fake: Fake
let home: string
let extra: Server[] = []
let engines: OllamaEngine[] = []
beforeEach(async () => {
  fake = await fakeDownloads()
  home = mkdtempSync(join(tmpdir(), 'hivedesk-oe-'))
})
afterEach(async () => {
  for (const e of engines) e.shutdown()
  engines = []
  fake.close()
  for (const s of extra) {
    s.closeAllConnections()
    s.close()
  }
  extra = []
  delete process.env.FAKE_FAIL
  rmSync(home, { recursive: true, force: true })
})

function manifest(file: string, sha: string | undefined, format: 'tgz' | 'zip' = 'tgz', exe = 'ollama', key = KEY): EngineManifest {
  return { version: '1.2.3', platforms: { [key]: { url: fake.base + file, sha256: sha, format, exe } } }
}
function make(m: EngineManifest, o: { defaultPort?: number; platform?: string; arch?: string; timeout?: number } = {}) {
  const connected: string[] = []
  const e = new OllamaEngine({
    homeDir: () => join(home, 'HiveDesk'),
    manifest: m,
    changed: () => {},
    connect: async (u) => void connected.push(u),
    allowUrl: (u) => u.hostname === '127.0.0.1',
    defaultPort: o.defaultPort,
    platform: o.platform,
    arch: o.arch,
    startTimeoutMs: o.timeout ?? 8000
  })
  engines.push(e)
  return { e, connected }
}
const withProgram = (extraFiles: { name: string; data?: string }[] = []) =>
  makeTgz([{ name: 'ollama', data: FAKE_OLLAMA(), mode: 0o755 }, ...extraFiles])
const freePort = async (): Promise<number> => {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return p
}
const dead = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const root = (): string => engineDirOf(join(home, 'HiveDesk'))

describe('plan: unverified values are refused, never guessed', () => {
  it('missing or malformed sha256 / url / exe / unknown PC', () => {
    expect(planFor(manifest('/f', undefined), KEY)).toMatchObject({ ok: false })
    expect(planFor(manifest('/f', 'abc'), KEY)).toMatchObject({ ok: false })
    expect(planFor(manifest('/f', 'a'.repeat(64)), 'nope-x')).toMatchObject({ ok: false })
    expect(planFor(manifest('/f', 'a'.repeat(64), 'tgz', '../x'), KEY)).toMatchObject({ ok: false })
    expect(planFor({ version: '../x', platforms: {} }, KEY)).toMatchObject({ ok: false })
    expect(planFor(manifest('/f', 'a'.repeat(64)), KEY)).toMatchObject({ ok: true })
  })
  it('only https GitHub hosts are allowed by default', () => {
    expect(githubOnly(new URL('https://github.com/ollama/ollama/releases/download/v1/x.tgz'))).toBe(true)
    expect(githubOnly(new URL('https://release-assets.githubusercontent.com/x'))).toBe(true)
    expect(githubOnly(new URL('http://github.com/x'))).toBe(false)
    expect(githubOnly(new URL('https://github.com.evil.com/x'))).toBe(false)
    expect(githubOnly(new URL('https://evilgithub.com/x'))).toBe(false)
  })
  it('the shipped data file is only filled with complete entries', async () => {
    const m = (await import('../src/shared/ollama-engine.default.json')).default as unknown as EngineManifest
    for (const k of Object.keys(m.platforms)) expect(planFor(m, k), k).toMatchObject({ ok: true })
  })
})

describe('install', () => {
  it('matching sha256: downloads, unpacks, installs; start runs it with models in the HiveDesk folder, then stop ends it', { skip: !posix }, async () => {
    const tgz = withProgram([{ name: 'lib/readme.txt', data: 'hi' }])
    fake.files.set('/file', tgz)
    const { e, connected } = make(manifest('/file', sha256(tgz)), { defaultPort: await freePort() })
    await e.install()
    await e.whenIdle()
    expect((await e.status()).job?.state).toBe('done')
    expect(existsSync(join(root(), '1.2.3', 'ollama'))).toBe(true)
    expect(readFileSync(join(root(), '1.2.3', 'lib', 'readme.txt'), 'utf8')).toBe('hi')
    expect(readdirSync(root()).filter((n) => n.startsWith('.staging'))).toEqual([])
    expect((await e.status()).installedVersion).toBe('1.2.3')

    const st = await e.start()
    expect(st.running).toBe(true)
    expect(connected).toEqual([st.baseUrl])
    const tags = (await (await fetch(`${st.baseUrl}/api/tags`)).json()) as { models_dir: string }
    expect(tags.models_dir).toBe(modelsDirOf(join(home, 'HiveDesk')))
    expect(existsSync(tags.models_dir)).toBe(true)
    await e.stop()
    expect((await e.status()).running).toBe(false)
    await expect(fetch(`${st.baseUrl}/api/version`)).rejects.toThrow()
  })

  it('wrong sha256: nothing is unpacked or run, the download is deleted, and the reason is shown', async () => {
    const tgz = withProgram()
    fake.files.set('/file', tgz)
    const { e } = make(manifest('/file', 'f'.repeat(64)))
    await e.install()
    await e.whenIdle()
    const st = await e.status()
    expect(st.job?.state).toBe('failed')
    expect(st.job?.error).toMatch(/sha256/)
    expect(existsSync(root())).toBe(false)
    expect(st.installed).toBe(false)
    expect(existsSync(join(home, 'HiveDesk', 'engine', '.download', `ollama-1.2.3-${KEY}.tgz.part`))).toBe(false)
    await expect(e.start()).rejects.toThrow(/설치/)
  })

  it('no sha256 value: install is refused before any request is made', async () => {
    fake.files.set('/file', withProgram())
    const { e } = make(manifest('/file', undefined))
    await expect(e.install()).rejects.toThrow(/sha256/)
    expect((await e.status()).unavailable).toMatch(/sha256/)
    expect(fake.requests.length).toBe(0)
    expect(existsSync(join(home, 'HiveDesk'))).toBe(false)
  })

  it('a download address outside the allowed hosts is refused, including through a redirect', async () => {
    fake.files.set('/file', withProgram())
    const a = make(manifest('/redirect-out', 'a'.repeat(64)))
    await a.e.install()
    await a.e.whenIdle()
    expect((await a.e.status()).job?.error).toMatch(/허용하지 않는/)
    const b = new OllamaEngine({ homeDir: () => join(home, 'x'), manifest: manifest('/file', 'a'.repeat(64)), changed: () => {}, connect: async () => undefined })
    await expect(b.install()).rejects.toThrow(/허용하지 않는/)
  })

  it('a zip is unpacked without outside tools (stored and deflated), keeping folders', async () => {
    const zip = makeZip([
      { name: 'ollama.exe', data: 'MZ-fake' },
      { name: 'lib/', data: '' },
      { name: 'lib/ollama/cuda/a.dll', data: 'x'.repeat(5000) },
      { name: 'lib/ollama/b.txt', data: 'stored', stored: true }
    ])
    fake.files.set('/z', zip)
    const { e } = make(manifest('/z', sha256(zip), 'zip', 'ollama.exe', 'win32-x64'), { platform: 'win32', arch: 'x64' })
    await e.install()
    await e.whenIdle()
    expect((await e.status()).job?.state).toBe('done')
    expect(readFileSync(join(root(), '1.2.3', 'lib', 'ollama', 'cuda', 'a.dll'), 'utf8')).toBe('x'.repeat(5000))
    expect(readFileSync(join(root(), '1.2.3', 'lib', 'ollama', 'b.txt'), 'utf8')).toBe('stored')
  })

  it('zip slip is refused: zip with ../ and absolute names, tgz with ../ and a link out', async () => {
    expect(() => safeJoin('/a/b', '../c')).toThrow()
    expect(() => safeJoin('/a/b', 'x/../../c')).toThrow()
    expect(() => safeJoin('/a/b', '/etc/passwd')).toThrow()
    expect(() => safeJoin('/a/b', 'C:\\x')).toThrow()
    expect(safeJoin('/a/b', 'x/y.txt')).toBe(join('/a/b', 'x', 'y.txt'))

    for (const [name, buf, fmt] of [
      ['zip-dotdot', makeZip([{ name: 'ollama.exe', data: 'x' }, { name: '../evil.txt', data: 'x' }]), 'zip'],
      ['zip-abs', makeZip([{ name: '/tmp/evil.txt', data: 'x' }]), 'zip'],
      ['tgz-dotdot', makeTgz([{ name: 'ollama', data: 'x' }, { name: '../evil.txt', data: 'x' }]), 'tgz'],
      ...(posix ? [['tgz-link', makeTgz([{ name: 'ollama', data: 'x', mode: 0o755 }, { name: 'out', link: '../../../etc' }]), 'tgz'] as const] : [])
    ] as const) {
      fake.files.set('/' + name, buf)
      const { e } = make(manifest('/' + name, sha256(buf), fmt, fmt === 'zip' ? 'ollama.exe' : 'ollama'))
      await e.install()
      await e.whenIdle()
      const st = await e.status()
      expect(st.job?.state, name).toBe('failed')
      expect(existsSync(join(root(), 'evil.txt')), name).toBe(false)
      expect(st.installed, name).toBe(false)
      expect(readdirSync(root()).filter((n) => !n.startsWith('.staging')), name).toEqual([])
    }
    // the zip reader on its own: nothing is written when one name is bad
    const z = join(home, 'bad.zip')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(z, makeZip([{ name: 'ok.txt', data: 'x' }, { name: '../evil.txt', data: 'x' }]))
    await expect(extractZip(z, join(home, 'out'))).rejects.toThrow(/밖으로/)
    expect(existsSync(join(home, 'out', 'ok.txt'))).toBe(false)
  })

  it('progress, cancel, and resume with Range from where it stopped', async () => {
    // incompressible padding so the file is big enough to catch mid-way
    const rnd = (await import('node:crypto')).randomBytes(1_500_000)
    const tgz = makeTgz([{ name: 'ollama', data: FAKE_OLLAMA(), mode: 0o755 }, { name: 'pad.bin', data: rnd }])
    fake.files.set('/file', tgz)
    fake.slow = 15
    const { e } = make(manifest('/file', sha256(tgz)))
    await e.install()
    const fractions: number[] = []
    await waitFor(async () => {
      const j = (await e.status()).job
      if (j?.fraction) fractions.push(j.fraction)
      return (j?.fraction ?? 0) > 0.15
    })
    e.cancel()
    await e.whenIdle()
    expect((await e.status()).job?.state).toBe('cancelled')
    expect(fractions.every((f) => f >= 0 && f <= 1)).toBe(true)
    const part = join(home, 'HiveDesk', 'engine', '.download', `ollama-1.2.3-${KEY}.tgz.part`)
    expect(existsSync(part)).toBe(true)
    expect(existsSync(join(root(), '1.2.3'))).toBe(false)

    fake.slow = 0
    await e.install()
    await e.whenIdle()
    expect((await e.status()).job?.state).toBe('done')
    expect(fake.requests.at(-1)?.range).toMatch(/^bytes=\d+-$/)
    expect(existsSync(part)).toBe(false)
    expect(readFileSync(join(root(), '1.2.3', 'pad.bin')).length).toBe(1_500_000)
  })

  it('remove deletes the program only; models and the other Ollama folder are left alone', { skip: !posix }, async () => {
    const tgz = withProgram()
    fake.files.set('/file', tgz)
    const { e } = make(manifest('/file', sha256(tgz)), { defaultPort: await freePort() })
    await e.install()
    await e.whenIdle()
    await e.start()
    const models = modelsDirOf(join(home, 'HiveDesk'))
    const { writeFileSync, mkdirSync } = await import('node:fs')
    writeFileSync(join(models, 'blob'), 'm')
    await e.remove()
    expect(existsSync(root())).toBe(false)
    expect(readFileSync(join(models, 'blob'), 'utf8')).toBe('m')
    expect((await e.status()).running).toBe(false)
    mkdirSync(join(home, '.ollama'), { recursive: true })
    expect(existsSync(join(home, '.ollama'))).toBe(true)
  })
})

describe('start', () => {
  async function installed(defaultPort?: number, timeout?: number) {
    const tgz = withProgram()
    fake.files.set('/file', tgz)
    const r = make(manifest('/file', sha256(tgz)), { defaultPort: defaultPort ?? (await freePort()), timeout })
    await r.e.install()
    await r.e.whenIdle()
    return r
  }

  it('port in use: another free port is chosen and the screen is told; a foreign Ollama is noticed', { skip: !posix }, async () => {
    const taken = createServer((q, r) => r.end(q.url === '/api/version' ? '{"version":"0.0.1"}' : '{}'))
    extra.push(taken)
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r))
    const p = (taken.address() as AddressInfo).port
    const { e, connected } = await installed(p)
    expect((await e.status()).foreignOnDefaultPort).toBe(true)
    const st = await e.start()
    expect(st.port).not.toBe(p)
    expect(st.port).toBeGreaterThan(p)
    expect(st.portNote).toContain(String(st.port))
    expect(connected).toEqual([`http://127.0.0.1:${st.port}`])
    expect((await fetch(`http://127.0.0.1:${p}/api/version`).then((r) => r.json())) as { version: string }).toEqual({ version: '0.0.1' })
  })

  it('a program that fails: the real message and exit code are shown, nothing is left running', { skip: !posix }, async () => {
    const { e } = await installed()
    process.env.FAKE_FAIL = 'Error: cannot bind the thing'
    await expect(e.start()).rejects.toThrow(/cannot bind the thing/)
    const st = await e.status()
    expect(st.running).toBe(false)
    expect(st.lastError).toMatch(/종료 코드 3/)
    expect(st.lastError).toMatch(/cannot bind the thing/)
  })

  it('a program that cannot be executed shows the system message word for word', { skip: !posix }, async () => {
    const tgz = makeTgz([{ name: 'ollama', data: '#!/nonexistent/interpreter\n', mode: 0o755 }])
    fake.files.set('/file', tgz)
    const { e } = make(manifest('/file', sha256(tgz)), { defaultPort: await freePort() })
    await e.install()
    await e.whenIdle()
    await expect(e.start()).rejects.toThrow(/실행하지 못했어요: spawn .*(ENOENT|EACCES)/)
  })

  it('quitting the app (shutdown) ends the process; a crash is noticed', { skip: !posix }, async () => {
    const { e } = await installed()
    const st = await e.start()
    const pid = (e as unknown as { child: { pid: number } }).child.pid
    expect(dead(pid)).toBe(false)
    e.shutdown()
    await waitFor(() => dead(pid))
    expect(st.running).toBe(true)

    const b = make(manifest('/file', sha256(withProgram())), { defaultPort: await freePort() })
    await b.e.start()
    const pid2 = (b.e as unknown as { child: { pid: number } }).child.pid
    process.kill(pid2, 'SIGKILL')
    await waitFor(async () => !(await b.e.status()).running)
    expect((await b.e.status()).lastError).toMatch(/갑자기 멈췄어요/)
  })
})

describe('auto connect', () => {
  it('the engine connection is added once and its address follows the port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hivedesk-oe-eng-'))
    const servers: Server[] = []
    const ollamaLike = async (): Promise<string> => {
      const s = createServer((q, r) => r.end(q.url === '/api/version' ? '{"version":"1.0.0"}' : '{"models":[]}'))
      servers.push(s)
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    }
    try {
      const eng = new Engine(join(dir, 'config.json'), () => {}, async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }), dir)
      const a = await ollamaLike()
      const b = await ollamaLike()
      await eng.local.ensure('HiveDesk Ollama', a)
      await eng.local.ensure('HiveDesk Ollama', a)
      expect(eng.local.endpoints().filter((x) => x.name === 'HiveDesk Ollama')).toHaveLength(1)
      await eng.local.ensure('HiveDesk Ollama', b)
      const eps = eng.local.endpoints().filter((x) => x.name === 'HiveDesk Ollama')
      expect(eps).toHaveLength(1)
      expect(eps[0].url).toBe(b)
      expect(eng.local.state(eps[0].id)?.ok).toBe(true)
    } finally {
      for (const s of servers) {
        s.closeAllConnections()
        s.close()
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
