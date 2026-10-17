import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCommand, cleanEnv, runCli, splitArgs } from '../src/main/adapters'
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
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
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
  return { hive, stripApiKeys: true, runner: runCli, defaultCwd: dir, ...over }
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
    expect(c.args).toEqual(['-p', '--model', 'sonnet', '--permission-mode', 'acceptEdits'])
    const x = buildCommand(makeAgent('a', { name: 'x', adapter: 'codex' }))
    expect(x.args[0]).toBe('exec')
    expect(x.args[x.args.length - 1]).toBe('-')
    const a = buildCommand(makeAgent('a', { name: 'y', adapter: 'agy' }))
    expect(a.command).toBe('agy')
    expect(() => buildCommand(makeAgent('a', { name: 'z', adapter: 'custom' }))).toThrow()
  })

  it('strips API key env vars so the CLI uses the login, not paid API', () => {
    const env = cleanEnv({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', PATH: '/bin' }, true)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/bin')
    expect(cleanEnv({ ANTHROPIC_API_KEY: 'k' }, false).ANTHROPIC_API_KEY).toBe('k')
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
    expect(s2.ok).toBe(true)
    expect(b.listTasks().map((t) => t.title).sort()).toEqual(['from alice', 'from bob'])

    expect((await syncNow(a.root, 'alice')).ok).toBe(true)
    expect(a.listTasks()).toHaveLength(2)
    // per-machine usage never leaves the machine
    a.recordUsage('x', 1)
    await syncNow(a.root, 'alice')
    expect(execFileSync('git', ['ls-files'], { cwd: a.root }).toString()).not.toContain('.local')
  }, 30000)
})
