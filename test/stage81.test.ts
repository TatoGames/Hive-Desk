import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunOptions, Runner } from '../src/main/adapters'
import { detectChecks, probeApp, runChecks } from '../src/main/checks'
import { Engine } from '../src/main/engine'
import { canSkipReview, isLongCommand, reviewRisk } from '../src/shared/review'
import type { ReviewSettings } from '../src/shared/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s81-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd }).toString()
const REPORT = '[[DID: 했어요]]\n[[FILES: calc.js]]\n[[VERIFY: npm test]]\n[[RISK: none]]\n[[NEXT: none]]'

describe('8-2: how risky a change is, from the diff alone', () => {
  const f = (path: string, additions = 5, deletions = 0, status = 'M') => ({ path, status, additions, deletions })
  it('small → low, docs → low, sensitive or big → high', () => {
    expect(reviewRisk({ files: [f('src/calc.js', 10, 2)] }).risk).toBe('low')
    expect(reviewRisk({ files: [f('README.md', 300)] }).risk).toBe('low')
    expect(reviewRisk({ files: [f('src/auth/login.ts', 3)] }).risk).toBe('high')
    expect(reviewRisk({ files: [f('package.json', 1)] }).risk).toBe('high')
    expect(reviewRisk({ files: [f('.github/workflows/ci.yml', 1)] }).risk).toBe('high')
    expect(reviewRisk({ files: [f('a.js', 0, 0, 'D'), f('b.js', 0, 0, 'D'), f('c.js', 0, 0, 'D'), f('d.js', 0, 0, 'D')] }).risk).toBe('high')
    expect(reviewRisk({ files: Array.from({ length: 6 }, (_, i) => f(`src/m${i}.js`, 30)) }).risk).toBe('medium')
    // not git: lines unknown, so not "small"
    expect(reviewRisk({ files: [f('a.js', 0)], lines: false }).risk).toBe('medium')
  })

  it('a review is left out only for low risk that something actually checked', () => {
    const low = reviewRisk({ files: [f('src/calc.js', 3)] })
    const passed = { at: '', ok: true, items: [{ name: 'test', cmd: 'npm test', ok: true, ms: 1, tail: '' }] }
    const nothing = { at: '', ok: true, items: [{ name: 'node', cmd: 'npm install', ok: true, ms: 0, tail: '', skipped: 'x' }] }
    expect(canSkipReview('risk', low, passed)).toBe(true)
    expect(canSkipReview('risk', low, nothing)).toBe(false)
    expect(canSkipReview('risk', low, undefined)).toBe(false)
    expect(canSkipReview('always', low, passed)).toBe(false)
    expect(canSkipReview('risk', reviewRisk({ files: [f('docs/a.md')] }), undefined)).toBe(true)
  })

  it('8-4: installs, builds and tests are long commands', () => {
    expect(isLongCommand('npm install')).toBe(true)
    expect(isLongCommand('pnpm add react')).toBe(true)
    expect(isLongCommand('npm run build')).toBe(true)
    expect(isLongCommand('npx electron-builder --mac')).toBe(true)
    expect(isLongCommand('pytest -q')).toBe(true)
    expect(isLongCommand('ls -la')).toBe(false)
    expect(isLongCommand('cat src/a.ts')).toBe(false)
  })
})

describe('8-1: the project\'s own checks', () => {
  it('finds test / typecheck / lint from package.json; skips them when nothing is installed', () => {
    const p = join(dir, 'p')
    mkdirSync(p)
    writeFileSync(join(p, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc', lint: 'eslint .', dev: 'vite' } }))
    expect(detectChecks(p).skipped[0].skipped).toContain('node_modules')
    mkdirSync(join(p, 'node_modules'))
    expect(detectChecks(p).specs.map((s) => s.name)).toEqual(['typecheck', 'lint', 'test'])
    writeFileSync(join(p, 'pnpm-lock.yaml'), '')
    expect(detectChecks(p).specs.find((s) => s.name === 'test')?.cmd).toBe('pnpm test')
    // npm's placeholder test script is not a test
    writeFileSync(join(p, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))
    expect(detectChecks(p).specs).toEqual([])
  })

  it('runs them and keeps the end of a failure', async () => {
    const p = join(dir, 'p')
    mkdirSync(join(p, 'node_modules'), { recursive: true })
    writeFileSync(join(p, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }))
    writeFileSync(join(p, 't.js'), 'console.error("expected 4, got 5"); process.exit(1)')
    const r = await runChecks(p, { app: false, shotDir: dir, shotName: 'x' })
    expect(r.ok).toBe(false)
    expect(r.items[0].tail).toContain('expected 4, got 5')
    writeFileSync(join(p, 't.js'), 'console.log("ok")')
    expect((await runChecks(p, { app: false, shotDir: dir, shotName: 'x' })).ok).toBe(true)
  })
})

/** A worker (claude) and a reviewer on another model (codex), working in a git folder with `npm test`. */
function setup(review: Partial<ReviewSettings>, work: (cwd: string, n: number) => void) {
  const w = join(dir, 'work')
  mkdirSync(join(w, 'node_modules'), { recursive: true })
  git(w, 'init', '-q', '-b', 'main')
  writeFileSync(join(w, '.gitignore'), 'node_modules\n')
  writeFileSync(join(w, 'package.json'), JSON.stringify({ scripts: { test: 'node check.js' } }))
  writeFileSync(join(w, 'check.js'), 'const add = require("./calc.js"); if (add(2, 2) !== 4) { console.error("add(2,2) should be 4, got " + add(2, 2)); process.exit(1) }')
  writeFileSync(join(w, 'calc.js'), 'module.exports = () => 0\n')
  git(w, 'add', '-A')
  git(w, 'commit', '-q', '-m', 'init')
  const prompts = { work: [] as string[], review: [] as string[] }
  const runner: Runner = async (_b, o: RunOptions) => {
    if (o.prompt.includes('CROSS REVIEWER')) {
      prompts.review.push(o.prompt)
      return { code: 0, stdout: '[[VERDICT: pass]]', stderr: '', timedOut: false, aborted: false }
    }
    prompts.work.push(o.prompt)
    work(o.cwd, prompts.work.length)
    return { code: 0, stdout: REPORT, stderr: '', timedOut: false, aborted: false }
  }
  const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'off', autoRun: true, review: { checks: true, appCheck: false, policy: 'risk', maxRounds: 2, ...review } })
  eng.watchMs = 20
  const dev = eng.saveAgent({ name: '개발', adapter: 'claude', workDir: w, modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
  eng.saveAgent({ name: '검토', adapter: 'codex', workDir: w, modelRef: { id: 'openai-gpt-6-1-sol', pin: 'pinned' } })
  return { eng, dev, prompts, w }
}

/** Done, nothing running, and the review question settled (passed or left out). */
const finished = (eng: Engine, id: string): boolean => {
  const t = eng.hive.getTask(id)!
  return t.status === 'done' && !eng.snapshot().running.length && !!t.reviewState && t.reviewState.status !== 'pending'
}

async function settle(eng: Engine, until: () => boolean, ms = 20_000): Promise<void> {
  const t0 = Date.now()
  while (!until() && Date.now() - t0 < ms) {
    await eng.tick()
    await wait(30)
  }
}

describe('8-1/8-2: checks first, then an AI review only when it is worth it', () => {
  it('a failed check goes straight back with its output (no AI review); a small fix that passes needs no review', async () => {
    const { eng, dev, prompts } = setup({}, (cwd, n) => writeFileSync(join(cwd, 'calc.js'), n === 1 ? 'module.exports = (a, b) => a + b + 1\n' : 'module.exports = (a, b) => a + b\n'))
    const t = eng.createTask({ title: '더하기 고치기', assignee: dev.id, delegate: true })
    await settle(eng, () => finished(eng, t.id))
    const done = eng.hive.getTask(t.id)!
    expect(done.status).toBe('done')
    expect(prompts.work.length).toBe(2)
    expect(prompts.work[1]).toContain('add(2,2) should be 4, got 5')
    expect(prompts.review.length).toBe(0)
    expect(done.reviewState).toMatchObject({ status: 'skipped' })
    expect(done.reviewState?.note).toContain('AI 검토 생략')
    expect(done.checks?.ok).toBe(true)
    const ev = eng.hive.listEvents(t.id).map((e) => e.text)
    expect(ev.some((e) => e.includes('자동 검사 실패 (test)'))).toBe(true)
    expect(ev.some((e) => e.includes('수정 요청 1/2 (자동 검사)'))).toBe(true)
    eng.shutdown()
  }, 40_000)

  it('a risky change is still reviewed — the reviewer is told what already passed and is pointed at the diff', async () => {
    const { eng, dev, prompts } = setup({}, (cwd) => {
      writeFileSync(join(cwd, 'calc.js'), 'module.exports = (a, b) => a + b\n')
      mkdirSync(join(cwd, 'auth'), { recursive: true })
      writeFileSync(join(cwd, 'auth', 'token.js'), 'module.exports = "x"\n')
    })
    const t = eng.createTask({ title: '로그인 토큰', assignee: dev.id, delegate: true })
    await settle(eng, () => finished(eng, t.id))
    expect(eng.hive.getTask(t.id)!.reviewState?.status).toBe('passed')
    expect(prompts.review.length).toBe(1)
    expect(prompts.review[0]).toContain('do NOT run them again')
    expect(prompts.review[0]).toContain('- test (npm test): passed')
    expect(prompts.review[0]).toContain('Judge from the report and the diff above')
    eng.shutdown()
  }, 40_000)

  it('"always" reviews even a small change; the round limit is a setting', async () => {
    const { eng, dev, prompts } = setup({ policy: 'always', maxRounds: 1 }, (cwd) => writeFileSync(join(cwd, 'calc.js'), 'module.exports = (a, b) => a + b\n'))
    const t = eng.createTask({ title: '더하기', assignee: dev.id, delegate: true })
    await settle(eng, () => finished(eng, t.id))
    expect(prompts.review.length).toBe(1)
    eng.shutdown()
  }, 40_000)

  it('the very same failure again (a test that was broken before) goes to a reviewer instead of looping', async () => {
    const { eng, dev, prompts, w } = setup({}, (cwd) => writeFileSync(join(cwd, 'calc.js'), 'module.exports = (a, b) => a + b\n'))
    writeFileSync(join(w, 'package.json'), JSON.stringify({ scripts: { test: 'node check.js && node old.js' } }))
    writeFileSync(join(w, 'old.js'), 'console.error("legacy test broken since " + Date.now()); process.exit(1)')
    git(w, 'add', '-A')
    git(w, 'commit', '-q', '-m', 'old broken test')
    const t = eng.createTask({ title: '더하기', assignee: dev.id, delegate: true })
    await settle(eng, () => finished(eng, t.id))
    expect(prompts.work.length).toBe(2)
    expect(prompts.review.length).toBe(1)
    expect(prompts.review[0]).toContain('FAILED')
    expect(eng.hive.listEvents(t.id).some((e) => e.text.includes('원래 있던 문제일 수 있어서'))).toBe(true)
    eng.shutdown()
  }, 40_000)

  it('workers are told never to start servers or the app themselves', async () => {
    const { eng, dev, prompts } = setup({}, (cwd) => writeFileSync(join(cwd, 'calc.js'), 'module.exports = (a, b) => a + b\n'))
    const t = eng.createTask({ title: '더하기', assignee: dev.id, delegate: true })
    await settle(eng, () => finished(eng, t.id))
    expect(prompts.work[0]).toContain('Never start anything that keeps running')
    eng.shutdown()
  }, 40_000)
})

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
describe.skipIf(!existsSync(CHROME))('8-3: start the app, watch it, take a picture', () => {
  const page = (body: string): string => {
    const f = join(dir, 'index.html')
    writeFileSync(f, `<!doctype html><html><body><h1>계산기</h1><script>${body}</script></body></html>`)
    return 'file://' + f
  }
  const args = (url: string): string[] => ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${join(dir, 'profile')}`, url]

  it('a window without errors passes and leaves a screenshot', async () => {
    const shot = join(dir, 'shots', 'ok.png')
    const r = await probeApp({ bin: CHROME, args: args(page('console.log("hi")')), cwd: dir, shotFile: shot, watchMs: 800 })
    expect(r.ok).toBe(true)
    expect(r.screenshot).toBe(shot)
    expect(readFileSync(shot).subarray(1, 4).toString()).toBe('PNG')
  }, 40_000)

  it('an uncaught error in the window fails the check, with the message', async () => {
    const r = await probeApp({ bin: CHROME, args: args(page('undefinedFunction()')), cwd: dir, shotFile: join(dir, 'bad.png'), watchMs: 800 })
    expect(r.ok).toBe(false)
    expect(r.tail).toContain('undefinedFunction')
  }, 40_000)

  it('a program that exits at once fails without hanging', async () => {
    const r = await probeApp({ bin: process.execPath, args: ['-e', 'process.exit(3)'], cwd: dir, shotFile: join(dir, 'x.png'), startMs: 5000 })
    expect(r.ok).toBe(false)
    expect(r.tail).toContain('꺼졌어요')
  }, 20_000)
})
