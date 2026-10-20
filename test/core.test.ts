import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCommand, cleanEnv, DESTRUCTIVE_BASH_RULES, runCli, splitArgs } from '../src/main/adapters'
import { SECRET_READ_RULES } from '../src/main/secrets'
import { makeAgent } from '../src/main/config'
import { Engine } from '../src/main/engine'
import { Hive } from '../src/main/hive'
import { parseMarkers, runTask, type RunnerDeps } from '../src/main/runner'
import { initSync, syncNow } from '../src/main/sync'
import type { Agent } from '../src/shared/types'

const FAKE = join(__dirname, 'fake-cli.cjs')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-'))
  mkdirSync(join(dir, 'cwd'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function fakeAgent(over: Partial<Agent> = {}): Agent {
  return makeAgent('alice', {
    name: 'dev',
    adapter: 'custom',
    command: 'node',
    extraArgs: FAKE,
    role: 'developer',
    ...over
  })
}

function deps(hive: Hive, over: Partial<RunnerDeps> = {}): RunnerDeps {
  return { hive, stripApiKeys: true, runner: runCli, defaultCwd: join(dir, 'cwd'), ...over }
}

describe('hive store', () => {
  it('creates tasks and resolves dependencies', () => {
    const h = new Hive(join(dir, 'hive'))
    const a = h.createTask({ title: 'A', createdBy: 'alice' })
    const b = h.createTask({ title: 'B', dependsOn: [a.id], createdBy: 'alice' })
    expect(h.isReady(h.getTask(b.id)!, h.listTasks())).toBe(false)
    h.updateTask(a.id, { status: 'done' })
    expect(h.isReady(h.getTask(b.id)!, h.listTasks())).toBe(true)
  })

  it('routes messages to an inbox and marks them read', () => {
    const h = new Hive(join(dir, 'hive'))
    const m = h.sendMessage('a', 'bob-tester', 'hi')
    expect(h.listInbox('bob-tester')).toHaveLength(1)
    h.markRead('bob-tester', m.id)
    expect(h.listInbox('bob-tester')[0].read).toBe(true)
  })

  it('keeps usage per day, outside the shared files', () => {
    const h = new Hive(join(dir, 'hive'))
    h.recordUsage('x', 1000)
    h.recordUsage('x', 2000)
    expect(h.usageToday().x).toEqual({ runs: 2, ms: 3000 })
  })
})

describe('markers & adapters', () => {
  it('parses marker lines and strips them from the result', () => {
    const p = parseMarkers(
      'Hello\n[[MEMORY: uses pnpm]]\n[[MSG to=bob-x: ping]]\n[[APPROVAL: drop table]]\nBye'
    )
    expect(p.memory).toEqual(['uses pnpm'])
    expect(p.messages).toEqual([{ to: 'bob-x', body: 'ping' }])
    expect(p.approvals).toEqual(['drop table'])
    expect(p.clean).toBe('Hello\n\nBye')
  })

  it('splits args with quotes', () => {
    expect(splitArgs('--a "b c" d')).toEqual(['--a', 'b c', 'd'])
  })

  it('builds the right command per adapter', () => {
    const c = buildCommand(makeAgent('a', { name: 'c', adapter: 'claude', model: 'sonnet' }))
    expect(c.command).toBe('claude')
    expect(c.args).toEqual(['-p', '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--disallowedTools', ...DESTRUCTIVE_BASH_RULES, ...SECRET_READ_RULES])
    const x = buildCommand(makeAgent('a', { name: 'x', adapter: 'codex' }))
    expect(x.args[0]).toBe('exec')
    expect(x.args[x.args.length - 1]).toBe('-')
    const a = buildCommand(makeAgent('a', { name: 'y', adapter: 'agy' }))
    expect(a.command).toBe('agy')
    if (process.platform !== 'win32') {
      // agy gets the prompt as the -p value, not via stdin
      expect(a.args[a.args.length - 1]).toBe('-p')
      expect(a.promptArg).toBe(true)
    }
    expect(() => buildCommand(makeAgent('a', { name: 'z', adapter: 'custom' }))).toThrow()
  })

  it('strips API key env vars so the CLI uses the login, not paid API', () => {
    const env = cleanEnv({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', PATH: '/bin' }, true)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/bin')
    expect(cleanEnv({ ANTHROPIC_API_KEY: 'k' }, false).ANTHROPIC_API_KEY).toBe('k')
  })

  it('passes the prompt as an argument when the adapter asks for it', async () => {
    const script = join(dir, 'echo-args.cjs')
    writeFileSync(script, "let i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),stdin:i})))")
    const r = await runCli(
      { command: 'node', args: [script, '-p'], promptArg: true },
      { cwd: dir, prompt: 'line one\n"quoted" line two', timeoutMs: 10000, env: process.env }
    )
    const out = JSON.parse(r.stdout)
    if (process.platform === 'win32') expect(out.stdin).toContain('line one')
    else expect(out).toEqual({ args: ['-p', 'line one\n"quoted" line two'], stdin: '' })
  })

  it('kills a hanging CLI on timeout', async () => {
    const r = await runCli(
      { command: 'node', args: [FAKE] },
      { cwd: dir, prompt: 'SCENARIO:hang', timeoutMs: 400, env: process.env }
    )
    expect(r.timedOut).toBe(true)
  })

  it('reports a missing command clearly', async () => {
    const r = await runCli(
      { command: 'definitely-not-a-real-cli', args: [] },
      { cwd: dir, prompt: 'x', timeoutMs: 5000, env: process.env }
    )
    expect(r.spawnError).toMatch(/찾을 수 없어요/)
  })
})

describe('runTask', () => {
  it('runs, saves result, memory, messages and usage; next task sees the memory', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent()
    const t1 = h.createTask({ title: 'Add login', assignee: agent.id, createdBy: 'alice' })
    expect(await runTask(agent, t1.id, deps(h))).toBe('done')
    const done = h.getTask(t1.id)!
    expect(done.status).toBe('done')
    expect(done.result).toContain('Done: Add login')
    expect(done.result).not.toContain('[[')
    expect(h.listMemory().map((m) => m.text)).toContain('project uses pnpm')
    expect(h.listInbox('bob-tester')[0].body).toMatch(/login page/)
    expect(h.usageToday()[agent.id].runs).toBe(1)

    const t2 = h.createTask({ title: 'Second', assignee: agent.id, createdBy: 'alice' })
    await runTask(agent, t2.id, deps(h))
    expect(h.getTask(t2.id)!.result).toContain('SAW_MEMORY')
    // the same fact reported twice is stored once
    expect(h.listMemory().filter((m) => m.text === 'project uses pnpm')).toHaveLength(1)
  })

  it('holds risky tasks for approval, then runs after approval', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent()
    const t = h.createTask({ title: 'Deploy', assignee: agent.id, risky: true, createdBy: 'alice' })
    expect(await runTask(agent, t.id, deps(h))).toBe('awaiting_approval')
    expect(h.getTask(t.id)!.status).toBe('awaiting_approval')
    const [ap] = h.listApprovals()
    expect(ap.kind).toBe('risky-task')
    expect(h.usageToday()[agent.id]).toBeUndefined()

    h.decideApproval(ap.id, 'approved', 'alice')
    expect(await runTask(agent, t.id, deps(h))).toBe('done')
  })

  it('rejecting an approval fails the task', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent({ requireApproval: true })
    const t = h.createTask({ title: 'X', assignee: agent.id, createdBy: 'alice' })
    await runTask(agent, t.id, deps(h))
    h.decideApproval(h.listApprovals()[0].id, 'rejected', 'alice')
    expect(h.getTask(t.id)!.status).toBe('failed')
  })

  it('enforces the daily run budget and allows a one-time override', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent({ dailyRunLimit: 1 })
    const a = h.createTask({ title: 'one', assignee: agent.id, createdBy: 'alice' })
    const b = h.createTask({ title: 'two', assignee: agent.id, createdBy: 'alice' })
    expect(await runTask(agent, a.id, deps(h))).toBe('done')
    expect(await runTask(agent, b.id, deps(h))).toBe('awaiting_approval')
    const ap = h.listApprovals().find((x) => x.kind === 'budget')!
    expect(ap.reason).toMatch(/실행 한도/)
    h.decideApproval(ap.id, 'approved', 'alice')
    expect(await runTask(agent, b.id, deps(h))).toBe('done')
  })

  it('pauses when the agent asks for approval', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent()
    const t = h.createTask({
      title: 'Migrate SCENARIO:ask',
      assignee: agent.id,
      createdBy: 'alice'
    })
    expect(await runTask(agent, t.id, deps(h))).toBe('awaiting_approval')
    const ap = h.listApprovals()[0]
    expect(ap.kind).toBe('agent-request')
    expect(ap.reason).toMatch(/drop the old table/)
    h.decideApproval(ap.id, 'approved', 'alice')
    const after = h.getTask(t.id)!
    expect(after.status).toBe('todo')
    expect(after.notes.join(' ')).toMatch(/승인함/)
  })

  it('marks non-zero exit as failed with stderr', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent()
    const t = h.createTask({ title: 'SCENARIO:fail', assignee: agent.id, createdBy: 'alice' })
    expect(await runTask(agent, t.id, deps(h))).toBe('failed')
    expect(h.getTask(t.id)!.error).toMatch(/오류 코드 3[\s\S]*boom/)
  })

  it('ignores tasks assigned to someone else', async () => {
    const h = new Hive(join(dir, 'hive'))
    const t = h.createTask({ title: 'x', assignee: 'bob-tester', createdBy: 'alice' })
    expect(await runTask(fakeAgent(), t.id, deps(h))).toBe('not_ready')
  })
})

describe('transparency: reports, run records, timeline', () => {
  it('parses a multi-line structured report and strips it from the result', () => {
    const p = parseMarkers(
      'Fixed it.\n[[DID: fixed the bug]]\n[[FILES: a.ts\nb.ts]]\n[[VERIFY: run npm test]]\n[[RISK: none]]\n[[NEXT: release]]'
    )
    expect(p.clean).toBe('Fixed it.')
    expect(p.report).toEqual({
      did: 'fixed the bug',
      files: 'a.ts\nb.ts',
      verify: 'run npm test',
      risks: 'none',
      next: 'release'
    })
    expect(parseMarkers('plain answer').report).toBeUndefined()
  })

  it('keeps every run, never overwrites, and builds the timeline', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent()
    const t = h.createTask({ title: 'Do it SCENARIO:report', assignee: agent.id, createdBy: 'alice' })
    expect(await runTask(agent, t.id, deps(h))).toBe('done')
    const first = h.getTask(t.id)!
    expect(first.report?.did).toBe('wrote the files')
    expect(first.result).toBe('All finished.')
    expect(first.lastRunId).toBeTruthy()

    h.updateTask(t.id, { status: 'todo' })
    expect(await runTask(agent, t.id, deps(h))).toBe('done')
    const runs = h.listRuns(t.id)
    expect(runs).toHaveLength(2)
    expect(new Set(runs.map((r) => r.id)).size).toBe(2)
    const full = h.getRun(t.id, runs[0].id)!
    expect(full.prompt).toContain('## Your task')
    expect(full.response).toContain('[[DID: wrote the files]]') // raw answer is kept as-is
    expect(full.exitCode).toBe(0)
    expect(full.outcome).toBe('done')
    expect(full.report?.next).toBe('add tests')

    const kinds = h.listEvents(t.id).map((e) => e.kind)
    expect(kinds).toEqual(['created', 'run_started', 'run_finished', 'run_started', 'run_finished'])
  })

  it('records failures and approvals on the timeline', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent()
    const bad = h.createTask({ title: 'SCENARIO:fail', assignee: agent.id, createdBy: 'alice' })
    expect(await runTask(agent, bad.id, deps(h))).toBe('failed')
    const [run] = h.listRuns(bad.id)
    expect(run.outcome).toBe('failed')
    expect(run.exitCode).toBe(3)
    expect(h.getRun(bad.id, run.id)!.stderr).toContain('boom')
    expect(h.listEvents(bad.id).at(-1)!.text).toMatch(/^실패/)

    const risky = h.createTask({ title: 'Deploy', assignee: agent.id, risky: true, createdBy: 'alice' })
    await runTask(agent, risky.id, deps(h))
    h.decideApproval(h.listApprovals().find((a) => a.taskId === risky.id)!.id, 'approved', 'alice')
    await runTask(agent, risky.id, deps(h))
    expect(h.listEvents(risky.id).map((e) => e.kind)).toEqual([
      'created',
      'approval_requested',
      'approval_decided',
      'run_started',
      'run_finished'
    ])
  })

  it('deleting a task removes its timeline and run records', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent()
    const t = h.createTask({ title: 'x', assignee: agent.id, createdBy: 'alice' })
    await runTask(agent, t.id, deps(h))
    h.deleteTask(t.id)
    expect(h.listEvents(t.id)).toEqual([])
    expect(h.listRuns(t.id)).toEqual([])
  })

  it('run records stay on this machine, events are shared', async () => {
    const remote = join(dir, 'remote.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', remote])
    const h = new Hive(join(dir, 'a'))
    await initSync(h.root, remote)
    const agent = fakeAgent()
    const t = h.createTask({ title: 'x', assignee: agent.id, createdBy: 'alice' })
    await runTask(agent, t.id, deps(h))
    expect((await syncNow(h.root, 'alice')).ok).toBe(true)
    const files = execFileSync('git', ['ls-files'], { cwd: h.root }).toString()
    expect(files).toContain('events/')
    expect(files).not.toContain('.local')
  }, 30000)
})

describe('transparency: change diff', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).toString()

  function repo(): string {
    const work = join(dir, 'work')
    mkdirSync(work)
    git(work, 'init', '-b', 'main')
    writeFileSync(join(work, 'a.txt'), 'one\n')
    writeFileSync(join(work, 'gone.txt'), 'bye\n')
    writeFileSync(join(work, 'dirty.txt'), 'v1\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-m', 'init')
    return work
  }

  it('shows exactly what one run changed, ignoring earlier uncommitted work', async () => {
    const work = repo()
    writeFileSync(join(work, 'dirty.txt'), 'v2 (edited by the human before the run)\n')
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent({ workDir: work })
    const t = h.createTask({ title: 'SCENARIO:write', assignee: agent.id, createdBy: 'alice' })
    expect(await runTask(agent, t.id, deps(h))).toBe('done')

    const run = h.getRun(t.id, h.getTask(t.id)!.lastRunId!)!
    expect(run.diff.available).toBe(true)
    const byPath = Object.fromEntries(run.diff.files.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(['a.txt', 'gone.txt', 'out.txt'])
    expect(byPath['out.txt']).toMatchObject({ status: 'A', additions: 1, deletions: 0 })
    expect(byPath['a.txt']).toMatchObject({ status: 'M', additions: 1 })
    expect(byPath['gone.txt']).toMatchObject({ status: 'D', deletions: 1 })
    expect(run.diff.patch).toContain('+changed')
    expect(h.listRuns(t.id)[0].diffStat).toEqual({ available: true, files: 3, additions: 2, deletions: 1 })
    expect(h.listEvents(t.id).at(-1)!.text).toMatch(/파일 3개 변경 \(\+2 −1\)/)

    // the user's own repo state is untouched: nothing staged, nothing committed
    expect(git(work, 'diff', '--cached', '--name-only').trim()).toBe('')
    expect(git(work, 'log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('says so when the work folder is not a git repo', async () => {
    const work = join(dir, 'plain')
    mkdirSync(work)
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent({ workDir: work })
    const t = h.createTask({ title: 'x', assignee: agent.id, createdBy: 'alice' })
    await runTask(agent, t.id, deps(h))
    const run = h.getRun(t.id, h.getTask(t.id)!.lastRunId!)!
    // not a git repo: we still list changed files, just without line counts
    expect(run.diff.available).toBe(true)
    expect(run.diff.lines).toBe(false)
    expect(run.diff.reason).toMatch(/git 저장소가 아니/)
  })

  it('refuses to run in a folder that holds the company data (the AI could change tasks and memory)', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = fakeAgent()
    for (const cwd of [h.root, dir, join(h.root, 'tasks')]) {
      const t = h.createTask({ title: 'x', assignee: agent.id, createdBy: 'alice' })
      expect(await runTask(agent, t.id, deps(h, { defaultCwd: cwd }))).toBe('failed')
      expect(h.getTask(t.id)!.error).toMatch(/회사 데이터/)
    }
    // the company's own work folder inside is fine
    const t = h.createTask({ title: 'y', assignee: agent.id, createdBy: 'alice' })
    expect(await runTask(agent, t.id, deps(h, { defaultCwd: h.ensureWorkspace() }))).toBe('done')
  })
})

describe('engine', () => {
  it('auto-run executes ready tasks in dependency order', async () => {
    const events: string[] = []
    const eng = new Engine(join(dir, 'config.json'), (e) => events.push(e.type), runCli, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), autoRun: true })
    const agent = eng.saveAgent({
      name: 'dev',
      adapter: 'custom',
      command: 'node',
      extraArgs: FAKE
    })
    const first = eng.createTask({ title: 'first', assignee: agent.id })
    const second = eng.createTask({ title: 'second', assignee: agent.id, dependsOn: [first.id] })
    await eng.tick()
    for (let i = 0; i < 50 && eng.hive.getTask(first.id)!.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(eng.hive.getTask(first.id)!.status).toBe('done')
    expect(eng.hive.getTask(second.id)!.status).toBe('todo')
    await eng.tick()
    for (let i = 0; i < 50 && eng.hive.getTask(second.id)!.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(eng.hive.getTask(second.id)!.status).toBe('done')
    expect(eng.snapshot().roster.map((r) => r.id)).toContain('alice-dev')
    eng.shutdown()
  })

  it('logs manual status changes and serves task history', async () => {
    const eng = new Engine(join(dir, 'config.json'), () => {}, runCli, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    const t = eng.createTask({ title: 'x' })
    eng.updateTask(t.id, { status: 'failed' })
    eng.updateTask(t.id, { status: 'todo' })
    eng.updateTask(t.id, { title: 'renamed' }) // rename → a 'changed' event (E3)
    const h = eng.taskHistory(t.id)
    expect(h.events.map((e) => e.kind)).toEqual(['created', 'status', 'status', 'changed'])
    expect(h.events[2].text).toBe('상태를 직접 바꿨어요: 실패 → 할 일')
    expect(h.runs).toEqual([])
    expect(eng.runDetail(t.id, 'nope')).toBeNull()
    eng.shutdown()
  })
})

describe('git sharing', () => {
  it('two members share tasks through a remote', async () => {
    const remote = join(dir, 'remote.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', remote])
    const a = new Hive(join(dir, 'a'))
    const b = new Hive(join(dir, 'b'))
    expect((await initSync(a.root, remote)).ok).toBe(true)
    a.createTask({ title: 'from alice', createdBy: 'alice' })
    const s1 = await syncNow(a.root, 'alice')
    expect(s1.ok).toBe(true)

    expect((await initSync(b.root, remote)).ok).toBe(true)
    b.createTask({ title: 'from bob', createdBy: 'bob' })
    const s2 = await syncNow(b.root, 'bob')
    expect(s2.message).toBe('동기화했어요.')
    expect(b.listTasks().map((t) => t.title).sort()).toEqual(['from alice', 'from bob'])

    expect((await syncNow(a.root, 'alice')).ok).toBe(true)
    expect(a.listTasks()).toHaveLength(2)
    // per-machine usage never leaves the machine
    a.recordUsage('x', 1)
    await syncNow(a.root, 'alice')
    expect(execFileSync('git', ['ls-files'], { cwd: a.root }).toString()).not.toContain('.local')
  }, 30000)
})

describe('PATH discovery', () => {
  it('adds common CLI folders, keeps order, drops missing and duplicates', async () => {
    const { mergePath, candidateDirs } = await import('../src/main/shellPath')
    const dirs = candidateDirs('/Users/minu', 'darwin')
    expect(dirs).toContain('/Users/minu/.local/bin')
    expect(dirs).toContain('/Users/minu/.npm-global/bin')
    expect(dirs).toContain('/opt/homebrew/bin')
    const exists = (p: string) => p !== '/nope'
    const d = (await import('node:path')).delimiter
    const p = (...xs: string[]) => xs.join(d)
    expect(mergePath([p('/usr/bin', '/bin'), p('/nope', '/usr/bin', '/a'), '/b'], exists)).toBe(
      p('/usr/bin', '/bin', '/a', '/b')
    )
  })
})

describe('one-click setup', () => {
  it('reports connected, needs-login and missing CLI clearly', async () => {
    const { checkCli, installCommand } = await import('../src/main/setup')
    expect(installCommand('claude')).toMatch(/claude\.ai\/install/)
    const ok = await checkCli('claude', async () => ({ code: 0, stdout: 'OK\n', stderr: '', timedOut: false, aborted: false }))
    expect(ok.ok).toBe(true)
    const login = await checkCli('codex', async () => ({ code: 1, stdout: '', stderr: 'Not logged in. Run codex login', timedOut: false, aborted: false }))
    expect(login).toMatchObject({ ok: false, needsLogin: true })
    const missing = await checkCli('agy', async () => ({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: '명령을 찾을 수 없어요: agy' }))
    expect(missing).toMatchObject({ ok: false, needsLogin: false })
  })
})

describe('task order', () => {
  it('keeps creation order even for tasks made in the same millisecond', () => {
    const h = new Hive(join(dir, 'hive-order'))
    const titles = Array.from({ length: 30 }, (_, i) => 'sub ' + i)
    for (const t of titles) h.createTask({ title: t, createdBy: 'minu' })
    expect(h.listTasks().map((t) => t.title)).toEqual(titles)
  })
})

describe('Codex 연결 확인이 시간 초과일 때', () => {
  it('설정이 다른 서버를 가리키면 그 사실을 알려 주고, 설정이 없으면 기존 문구만 쓴다', async () => {
    const { codexTimeoutNote, checkCli } = await import('../src/main/setup')
    expect(codexTimeoutNote('')).toBe('')
    expect(codexTimeoutNote('model = "gpt-5"\n')).toContain('model=gpt-5')
    const n = codexTimeoutNote('model = "qwen2.5-coder:7b"\nmodel_provider = "ollama"\n[projects]\nx=1\n')
    expect(n).toContain('model_provider=ollama')
    expect(n).toContain('Ollama')
    const r = await checkCli('claude', async () => ({ code: null, stdout: 'starting...', stderr: '', timedOut: true, aborted: false }))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('응답이 없어요')
    expect(r.message).toContain('starting...')
  })
})

describe('Codex 설정이 Ollama로 돌리는 경우', () => {
  const REAL = `model = "gemma4:31b:cloud"
model_reasoning_effort = "medium"
model_catalog_json = "/Users/minu/.codex/ollama-launch-models.json"
openai_base_url = "http://127.0.0.1:11434/api/codex/v1"

[desktop]
x = 1
[projects."/a"]
openai_base_url = "http://elsewhere"
`
  it('openai_base_url·model_catalog_json까지 찾아서 알려 준다 (model만 바꿔서는 안 된다)', async () => {
    const { codexRedirects, codexTimeoutNote } = await import('../src/main/setup')
    const r = codexRedirects(REAL)
    expect(r.redirected).toBe(true)
    expect(r.baseUrl).toBe('http://127.0.0.1:11434/api/codex/v1')
    expect(r.lines).toEqual(['model=gemma4:31b:cloud', 'openai_base_url=http://127.0.0.1:11434/api/codex/v1', 'model_catalog_json=/Users/minu/.codex/ollama-launch-models.json'])
    const n = codexTimeoutNote(REAL)
    expect(n).toContain('openai_base_url')
    expect(n).toContain('model_catalog_json')
    expect(n).toContain('Ollama')
  })
  it('평범한 설정은 돌려 보내는 설정으로 보지 않는다', async () => {
    const { codexRedirects } = await import('../src/main/setup')
    expect(codexRedirects('model = "gpt-5"\nmodel_reasoning_effort = "high"\n').redirected).toBe(false)
    expect(codexRedirects('openai_base_url = "https://api.openai.com/v1"\n').redirected).toBe(false)
    expect(codexRedirects('').lines).toEqual([])
    expect(codexRedirects('model_provider = "ollama"\n').redirected).toBe(true)
    expect(codexRedirects('openai_base_url = "http://localhost:1234/v1"\n').redirected).toBe(true)
  })
  it('Ollama 계정 안내도 세 줄을 함께 막으라고 말한다', async () => {
    const { checkCli } = await import('../src/main/setup')
    const r = await checkCli('codex', async () => ({ code: 1, stdout: '', stderr: 'ERROR: This model requires an Ollama account. Please sign in to Ollama to use this model.', timedOut: false, aborted: false }))
    expect(r.needsLogin).toBe(false)
    expect(r.message).toContain('openai_base_url')
    expect(r.message).toContain('#')
  })
})
