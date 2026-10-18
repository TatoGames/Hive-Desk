import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { join } from 'node:path'
import type { CheckItem, CheckRun } from '../shared/types'
import { cdpConnect } from './cdp'

/**
 * v5.1: after a work run the app checks the result itself — the project's own test / type / lint commands,
 * and for an Electron app: start it and look at it. No AI and no tokens; a failure goes straight back to the worker.
 */

export interface CheckSpec {
  name: string
  cmd: string
}

const NO_TEST = /no test specified/i
const TAIL = 4000

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function packageManager(dir: string): string {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

/** Is this an Electron app (the project depends on electron)? */
export function isElectronApp(dir: string): boolean {
  const pkg = readJson(join(dir, 'package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null
  return !!pkg && !!(pkg.dependencies?.electron || pkg.devDependencies?.electron)
}

/** The project's own checks, found from its files (nothing is guessed beyond the usual commands). */
export function detectChecks(dir: string, o: { app?: boolean } = {}): { specs: CheckSpec[]; skipped: CheckItem[] } {
  const specs: CheckSpec[] = []
  const skipped: CheckItem[] = []
  const pkg = readJson(join(dir, 'package.json')) as { scripts?: Record<string, string> } | null
  if (pkg) {
    const s = pkg.scripts ?? {}
    const pm = packageManager(dir)
    const run = (name: string): string => (pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`)
    const wanted: CheckSpec[] = []
    if (s.typecheck) wanted.push({ name: 'typecheck', cmd: run('typecheck') })
    if (s.lint) wanted.push({ name: 'lint', cmd: run('lint') })
    if (s.test && !NO_TEST.test(s.test)) wanted.push({ name: 'test', cmd: pm === 'npm' ? 'npm test' : `${pm} test` })
    // an Electron app built by a tool (electron-vite, webpack) has to be built before it can start
    if (o.app && isElectronApp(dir) && s.build) wanted.push({ name: 'build', cmd: run('build') })
    if (wanted.length && !existsSync(join(dir, 'node_modules'))) {
      skipped.push({ name: 'node', cmd: `${pm} install`, ok: true, ms: 0, tail: '', skipped: '패키지가 설치되지 않아서 검사를 건너뛰었어요 (node_modules 없음)' })
    } else specs.push(...wanted)
  }
  const py = existsSync(join(dir, 'pytest.ini')) || existsSync(join(dir, 'conftest.py')) || (existsSync(join(dir, 'pyproject.toml')) && /pytest/.test(safeRead(join(dir, 'pyproject.toml'))))
  if (py) specs.push({ name: 'test', cmd: 'python -m pytest -q' })
  if (existsSync(join(dir, 'Cargo.toml'))) specs.push({ name: 'test', cmd: 'cargo test --quiet' })
  if (existsSync(join(dir, 'go.mod'))) specs.push({ name: 'test', cmd: 'go test ./...' })
  return { specs, skipped }
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** Runs one command in the folder; the end of its output is kept. */
export function runCommand(cmd: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; out: string; ms: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let out = ''
    let timedOut = false
    // CI=1 keeps test runners (vitest, jest) out of watch mode
    const child = spawn(cmd, { cwd, shell: true, env: { ...env, CI: '1', FORCE_COLOR: '0' }, windowsHide: true, detached: process.platform !== 'win32' })
    const add = (b: Buffer): void => {
      out = (out + b.toString()).slice(-TAIL * 2)
    }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, out: out + '\n' + e.message, ms: Date.now() - t0, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out: out.slice(-TAIL), ms: Date.now() - t0, timedOut })
    })
  })
}

function killTree(pid?: number): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined)
    else process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** A tool that is not installed is not the worker's fault: the check is skipped, not failed. */
const MISSING = /command not found|is not recognized as an internal or external command|No module named pytest|not found: (cargo|go|python)|ENOENT/i

export interface ChecksOptions {
  app: boolean
  /** Where screenshots are kept. */
  shotDir: string
  /** File name stem for the screenshot. */
  shotName: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export async function runChecks(dir: string, o: ChecksOptions): Promise<CheckRun> {
  const { specs, skipped } = detectChecks(dir, { app: o.app })
  const items: CheckItem[] = [...skipped]
  for (const s of specs) {
    const r = await runCommand(s.cmd, dir, o.timeoutMs ?? 10 * 60_000, o.env)
    if (r.code !== 0 && !r.timedOut && MISSING.test(r.out)) {
      items.push({ ...s, ok: true, ms: r.ms, tail: r.out, skipped: '검사 도구가 설치돼 있지 않아요' })
      continue
    }
    // pytest: 5 = no tests were collected (nothing to fail)
    const ok = r.code === 0 || (s.cmd.includes('pytest') && r.code === 5)
    items.push({ ...s, ok, ms: r.ms, tail: r.timedOut ? r.out + '\n(시간 초과로 멈췄어요)' : r.out })
    // a failed build means the app cannot start; the rest still runs so the worker sees everything at once
  }
  if (o.app && isElectronApp(dir)) {
    const built = items.find((i) => i.name === 'build')
    if (built && !built.ok) items.push({ name: 'app', cmd: 'electron .', ok: true, ms: 0, tail: '', skipped: '빌드가 실패해서 앱을 띄우지 않았어요' })
    else items.push(await electronCheck(dir, o))
  }
  return { at: new Date().toISOString(), ok: items.every((i) => i.ok || !!i.skipped), items }
}

/** The Electron binary the project installed (node_modules/electron/path.txt names it). */
export function electronBinary(dir: string): string | null {
  const base = join(dir, 'node_modules', 'electron')
  const rel = safeRead(join(base, 'path.txt')).trim()
  if (!rel) return null
  const p = join(base, 'dist', rel)
  return existsSync(p) ? p : null
}

function httpJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(s))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface AppProbe {
  bin: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** How long to watch the window after it appeared. */
  watchMs?: number
  /** How long the window may take to appear. */
  startMs?: number
  shotFile: string
}

/**
 * Starts a Chromium-based app with a DevTools port, waits for its first window, watches it for uncaught errors,
 * takes a picture and closes it. Works for Electron (and plain Chromium, which the tests use).
 */
export async function probeApp(p: AppProbe): Promise<CheckItem> {
  const t0 = Date.now()
  const cmd = `${p.bin} ${p.args.join(' ')}`
  const child = spawn(p.bin, ['--remote-debugging-port=0', ...p.args], {
    cwd: p.cwd,
    env: { ...(p.env ?? process.env), ELECTRON_ENABLE_LOGGING: '1', ELECTRON_RUN_AS_NODE: '' },
    windowsHide: true,
    detached: process.platform !== 'win32'
  })
  let log = ''
  let exited: number | null | undefined
  const errors: string[] = []
  const warnings: string[] = []
  const add = (b: Buffer): void => {
    log = (log + b.toString()).slice(-TAIL * 2)
  }
  child.stdout?.on('data', add)
  child.stderr?.on('data', add)
  child.on('exit', (code) => (exited = code))
  child.on('error', (e) => {
    exited = -1
    log += '\n' + e.message
  })
  const finish = (ok: boolean, why: string, screenshot?: string): CheckItem => {
    killTree(child.pid)
    const main = log.split('\n').filter((l) => /Uncaught|Error:|TypeError|ReferenceError|Cannot find module/.test(l)).slice(-10)
    const tail = [why, ...errors.map((e) => '오류: ' + e), ...warnings.slice(0, 10).map((w) => 'console.error: ' + w), ...(main.length ? ['메인 프로세스:', ...main] : [])].join('\n')
    return { name: 'app', cmd, ok, ms: Date.now() - t0, tail: tail.slice(-TAIL), ...(screenshot ? { screenshot } : {}) }
  }
  try {
    // the DevTools port is printed when it is ready
    let port = 0
    const until = Date.now() + (p.startMs ?? 30_000)
    while (!port && Date.now() < until) {
      const m = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//)
      if (m) port = Number(m[1])
      else if (exited !== undefined) return finish(false, `앱이 창을 띄우기 전에 꺼졌어요 (종료 코드 ${exited}).`)
      else await wait(100)
    }
    if (!port) return finish(false, '앱이 시간 안에 시작되지 않았어요.')
    let page: { webSocketDebuggerUrl: string; url: string } | undefined
    while (!page && Date.now() < until) {
      const list = await httpJson<{ type: string; url: string; webSocketDebuggerUrl: string }[]>(`http://127.0.0.1:${port}/json/list`).catch(() => [])
      page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
      if (!page) {
        if (exited !== undefined) return finish(false, `앱이 창을 띄우기 전에 꺼졌어요 (종료 코드 ${exited}).`)
        await wait(200)
      }
    }
    if (!page) return finish(false, '앱 창이 나타나지 않았어요.')
    const cdp = await cdpConnect(page.webSocketDebuggerUrl)
    cdp.on((method, params) => {
      if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
        errors.push(((d?.exception?.description ?? d?.text ?? 'exception') + '').split('\n').slice(0, 3).join(' | '))
      } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        const args = (params.args as { value?: unknown; description?: string }[]) ?? []
        warnings.push(args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300))
      }
    })
    await cdp.send('Runtime.enable')
    // errors thrown before we connected: reload once with listeners on, so they are seen
    await cdp.send('Page.enable').catch(() => undefined)
    await cdp.send('Page.reload', { ignoreCache: true }).catch(() => undefined)
    await wait(p.watchMs ?? 4000)
    let shot: string | undefined
    try {
      const r = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
      mkdirSync(join(p.shotFile, '..'), { recursive: true })
      writeFileSync(p.shotFile, Buffer.from(r.data, 'base64'))
      shot = p.shotFile
    } catch {
      /* a picture is a bonus */
    }
    cdp.close()
    if (exited !== undefined) return finish(false, `앱이 실행 중에 꺼졌어요 (종료 코드 ${exited}).`, shot)
    if (errors.length) return finish(false, `앱 화면에서 처리되지 않은 오류가 ${errors.length}개 났어요.`, shot)
    return finish(true, `앱이 떴고 ${Math.round((p.watchMs ?? 4000) / 1000)}초 동안 오류가 없었어요.${warnings.length ? ` (console.error ${warnings.length}개)` : ''}`, shot)
  } catch (e) {
    return finish(false, '앱 확인 중 문제: ' + (e as Error).message)
  }
}

async function electronCheck(dir: string, o: ChecksOptions): Promise<CheckItem> {
  const bin = electronBinary(dir)
  if (!bin) return { name: 'app', cmd: 'electron .', ok: true, ms: 0, tail: '', skipped: 'Electron이 설치돼 있지 않아서 앱을 띄우지 않았어요 (npm install 필요)' }
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { name: 'app', cmd: 'electron .', ok: true, ms: 0, tail: '', skipped: '화면이 없는 환경이라 앱을 띄우지 않았어요' }
  }
  return probeApp({ bin, args: ['.'], cwd: dir, env: o.env, shotFile: join(o.shotDir, `${o.shotName}.png`) })
}
