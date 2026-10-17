import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createParser } from '../src/main/activity'
import { SECRET_READ_RULES } from '../src/main/secrets'
import { buildCommand, claudePathRule, DESTRUCTIVE_BASH_RULES, runCli, type BuiltCommand, type Runner } from '../src/main/adapters'
import { makeAgent } from '../src/main/config'
import { Engine } from '../src/main/engine'
import { diffScans, scanFolder, trackChanges } from '../src/main/gitdiff'
import { Hive } from '../src/main/hive'
import { buildPrompt, parseMarkers, runTask, type RunnerDeps } from '../src/main/runner'
import { initSync, syncNow } from '../src/main/sync'
import type { ActivityEvent, Agent } from '../src/shared/types'

const STREAM = join(__dirname, 'fake-claude-stream.cjs')
const FAKE = join(__dirname, 'fake-cli.cjs')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-live-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** A `claude`-adapter agent whose command is swapped for the streaming fake (see runner below). */
function claudeAgent(over: Partial<Agent> = {}): Agent {
  return makeAgent('alice', { name: 'dev', adapter: 'claude', role: 'developer', ...over })
}

/** Runs the fake instead of the real CLI, remembering how the app tried to call it. */
function fakeRunner(calls: BuiltCommand[] = []): Runner {
  return (built, opts) => {
    calls.push(built)
    return runCli({ command: 'node', args: [STREAM, ...built.args], stream: built.stream }, opts)
  }
}

function deps(hive: Hive, over: Partial<RunnerDeps> = {}): RunnerDeps {
  return { hive, stripApiKeys: true, runner: fakeRunner(), defaultCwd: dir, watchMs: 40, ...over }
}

function gitRepo(name = 'work'): string {
  const work = join(dir, name)
  mkdirSync(work, { recursive: true })
  const g = (...a: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: work }).toString()
  g('init', '-b', 'main')
  writeFileSync(join(work, 'a.txt'), 'hello\n')
  g('add', '-A')
  g('commit', '-m', 'init')
  return work
}

describe('activity parsers', () => {
  it('reads a REAL Claude stream-json capture: feed, session, final answer', () => {
    const raw = readFileSync(join(__dirname, 'fixtures', 'claude-stream.jsonl'), 'utf8')
    const p = createParser('claude')
    const evs = [...p.push(raw), ...p.end()]
    expect(evs.map((e) => e.kind)).toEqual(['read', 'write', 'message'])
    expect(evs[0].text).toMatch(/^파일 읽음: .*note\.txt$/)
    expect(evs[1]).toMatchObject({ kind: 'write', add: 1 })
    expect(p.sessionId()).toBe('sess-real-1')
    expect(p.finalText(raw)).toBe('done')
    expect(p.denials()).toEqual([])
  })

  it('works when the stream arrives in arbitrary chunks and ignores junk lines', () => {
    const raw = readFileSync(join(__dirname, 'fixtures', 'claude-stream.jsonl'), 'utf8')
    const p = createParser('claude')
    const evs: ActivityEvent[] = []
    evs.push(...p.push('warning: something\n'))
    for (let i = 0; i < raw.length; i += 37) evs.push(...p.push(raw.slice(i, i + 37)))
    evs.push(...p.end())
    expect(evs.map((e) => e.kind)).toEqual(['read', 'write', 'message'])
    expect(evs.map((e) => e.n)).toEqual([1, 2, 3])
  })

  it('counts lines for Edit/MultiEdit and shows commands, searches, tool errors and denials', () => {
    const line = (o: unknown): string => JSON.stringify(o) + '\n'
    const use = (name: string, input: unknown): string =>
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
    const p = createParser('claude')
    const evs = [
      ...p.push(use('Edit', { file_path: 'a.ts', old_string: 'x\ny', new_string: 'x\ny\nz\n' })),
      ...p.push(use('Bash', { command: 'npm test' })),
      ...p.push(use('Grep', { pattern: 'TODO' })),
      ...p.push(
        line({
          type: 'user',
          message: { content: [{ type: 'tool_result', is_error: true, content: 'permission denied' }] }
        })
      ),
      ...p.push(
        line({
          type: 'result',
          result: 'x',
          permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/etc/passwd' } }]
        })
      )
    ]
    expect(evs[0]).toMatchObject({ kind: 'edit', path: 'a.ts', add: 3, del: 2 })
    expect(evs.map((e) => e.kind)).toEqual(['edit', 'command', 'search', 'error'])
    expect(p.denials()).toEqual(['Write → /etc/passwd'])
  })

  it('tracks the plan from [[PLAN]]/[[STEP]] markers and from TodoWrite', () => {
    const text = (t: string): string =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }) + '\n'
    const p = createParser('claude')
    const evs = p.push(text('[[PLAN: a | b | c]]') + text('working\n[[STEP: 2]]'))
    expect(p.plan()).toEqual([
      { text: 'a', done: true },
      { text: 'b', done: true },
      { text: 'c', done: false }
    ])
    expect(evs.some((e) => e.kind === 'message' && e.text === 'working')).toBe(true)
    expect(evs.every((e) => !e.text.includes('[['))).toBe(true)

    const todo = createParser('claude')
    todo.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TodoWrite',
              input: { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'pending' }] }
            }
          ]
        }
      }) + '\n'
    )
    expect(todo.plan().map((x) => x.done)).toEqual([true, false])
  })

  it('reads Codex --json events (field names per its documented schema)', () => {
    const lines = [
      { type: 'thread.started', thread_id: 'thr-9' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'false', exit_code: 1 } },
      { type: 'item.completed', item: { id: 'i3', item_type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }] } },
      { type: 'item.completed', item: { id: 'i4', item_type: 'assistant_message', text: '[[PLAN: x | y]]\nall set' } },
      { type: 'item.completed', item: { id: 'i5', type: 'agent_message', text: 'final answer' } },
      { type: 'turn.completed', usage: {} }
    ]
    const raw = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    const p = createParser('codex')
    const evs = [...p.push(raw), ...p.end()]
    expect(p.sessionId()).toBe('thr-9')
    expect(evs.filter((e) => e.kind === 'command').map((e) => e.text)).toEqual(['명령: ls', '명령: false'])
    expect(evs.some((e) => e.kind === 'error' && /종료 코드 1/.test(e.text))).toBe(true)
    expect(evs.filter((e) => e.kind === 'edit' || e.kind === 'write').map((e) => e.path)).toEqual(['a.ts', 'b.ts'])
    expect(p.plan()).toHaveLength(2)
    expect(p.finalText(raw)).toBe('final answer')
  })

  it('plain-text CLIs: each finished line is a feed line; markers are not echoed raw', () => {
    const p = createParser('text')
    const evs = [
      ...p.push('first line\nsecond'),
      ...p.push(' line\n[[PLAN: a | b]]\n[[DID: x]]\n'),
      ...p.end()
    ]
    expect(evs.map((e) => e.text)).toEqual(['first line', 'second line', '계획 2단계: a → b'])
    expect(p.finalText('RAW')).toBe('RAW')
  })

  it('a Claude stream without a result event falls back to the last assistant text', () => {
    const p = createParser('claude')
    p.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\n')
    expect(p.finalText('...')).toBe('hello')
    expect(createParser('claude').finalText('plain old output')).toBe('plain old output')
  })

  it('parseMarkers handles NEED and drops PLAN/STEP from the result', () => {
    const m = parseMarkers('Result\n[[PLAN: a | b]]\n[[STEP: 1]]\n[[NEED: send me the spec]]')
    expect(m.needs).toEqual(['send me the spec'])
    expect(m.clean).toBe('Result')
  })
})

describe('building CLI commands', () => {
  it('Claude: streaming, permission levels, reference folders, resume', () => {
    const a = claudeAgent({ model: 'sonnet' })
    const plain = buildCommand(a)
    expect(plain.stream).toBeUndefined() // connection checks stay plain text
    expect(plain.args).toEqual(['-p', '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--disallowedTools', ...DESTRUCTIVE_BASH_RULES, ...SECRET_READ_RULES])

    const edit = buildCommand(a, { stream: true })
    expect(edit.stream).toBe('claude')
    expect(edit.args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose',
      '--model', 'sonnet', '--permission-mode', 'acceptEdits',
      '--disallowedTools', ...DESTRUCTIVE_BASH_RULES, ...SECRET_READ_RULES
    ])

    const read = buildCommand(a, { stream: true, permission: 'read' }).args
    expect(read).toContain('--disallowedTools')
    expect(read.join(' ')).toMatch(/--permission-mode default --allowedTools Read,Grep,Glob --disallowedTools Edit Write MultiEdit NotebookEdit Bash/)
    expect(read.filter((x) => x === '--permission-mode')).toHaveLength(1) // agent's own mode replaced, not duplicated

    const exec = buildCommand(a, { permission: 'exec' }).args
    expect(exec.join(' ')).toMatch(/--permission-mode acceptEdits --allowedTools Bash --disallowedTools Read/)

    const full = buildCommand(a, { stream: true, refDirs: ['/data/ref', 'C:\\My Docs'], resumeSession: 'abc' })
    expect(full.args).toContain('--add-dir=/data/ref')
    expect(full.args).toContain('--add-dir=C:\\My Docs')
    expect(full.args.slice(-2)).toEqual(['--resume', 'abc'])
    expect(full.resumed).toBe(true)
  })

  it('Codex: --json, sandbox per level, no --add-dir (read-only reference folders), prompt still on stdin', () => {
    const a = makeAgent('a', { name: 'x', adapter: 'codex' })
    expect(buildCommand(a).args).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-'])
    const read = buildCommand(a, { stream: true, permission: 'read', refDirs: ['/r'] })
    expect(read.stream).toBe('codex')
    expect(read.args).toEqual(['exec', '--skip-git-repo-check', '--json', '--sandbox', 'read-only', '-'])
    expect(buildCommand(a, { permission: 'exec' }).args).toContain('danger-full-access')
  })

  it('CLIs without a known flag keep their old arguments (permission/folders go in the prompt)', () => {
    const agy = buildCommand(makeAgent('a', { name: 'y', adapter: 'agy' }), { stream: true, permission: 'read', refDirs: ['/r'] })
    expect(agy.stream).toBeUndefined()
    expect(agy.args).not.toContain('/r')
  })
})

describe('a watched run', () => {
  it('shows progress while it runs and stores the feed with the run', async () => {
    const work = gitRepo()
    const h = new Hive(join(dir, 'hive'))
    const agent = claudeAgent({ workDir: work })
    const t = h.createTask({ title: 'Do it SCENARIO:slow', assignee: agent.id, createdBy: 'alice' })

    const seen: { files: number; plan: string; steps: number }[] = []
    const out = await runTask(
      agent,
      t.id,
      deps(h, {
        onActivity: (_id, _evs, live) => {
          const s = live.summary()
          seen.push({ files: s.files, plan: s.plan.map((p) => (p.done ? 'x' : '-')).join(''), steps: s.steps })
        }
      })
    )
    expect(out).toBe('done')
    // the folder watcher noticed out.txt BEFORE the run ended, and the plan advanced step by step
    expect(seen.some((s) => s.files === 1)).toBe(true)
    expect(seen.map((s) => s.plan)).toContain('x--')
    expect(seen.map((s) => s.plan)).toContain('xx-')
    expect(Math.max(...seen.map((s) => s.steps))).toBe(3) // Read, Write, Bash

    const done = h.getTask(t.id)!
    expect(done.result).toBe('All done.')
    expect(done.report?.did).toBe('wrote out.txt')
    expect(done.sessionId).toBe('sess-1')
    const rec = h.getRun(t.id, done.lastRunId!)!
    expect(rec.cwd).toBe(work)
    expect(rec.sessionId).toBe('sess-1')
    expect(rec.activity.map((e) => e.kind)).toEqual(['plan', 'read', 'plan', 'write', 'command', 'plan'])
    expect(rec.diff.files.map((f) => f.path)).toEqual(['out.txt'])
    expect(rec.diff.files[0]).toMatchObject({ status: 'A', additions: 2 })
  })

  it('reports permission denials to the human', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = claudeAgent()
    const t = h.createTask({ title: 'SCENARIO:deny', assignee: agent.id, createdBy: 'alice' })
    expect(await runTask(agent, t.id, deps(h))).toBe('done')
    const task = h.getTask(t.id)!
    expect(task.notes.join(' ')).toMatch(/권한 때문에 거부된 작업이 있어요 \(Write → \/etc\/x\)/)
    const rec = h.getRun(t.id, task.lastRunId!)!
    expect(rec.activity.some((e) => e.kind === 'error' && /거부된 작업 1건/.test(e.text))).toBe(true)
  })

  it('a failing stream CLI is a failure with its stderr', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = claudeAgent()
    const t = h.createTask({ title: 'SCENARIO:fail', assignee: agent.id, createdBy: 'alice' })
    expect(await runTask(agent, t.id, deps(h))).toBe('failed')
    expect(h.getTask(t.id)!.error).toMatch(/오류 코드 3[\s\S]*boom/)
  })

  it('plain-text CLIs still work and feed raw text to the live view', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = makeAgent('alice', { name: 'p', adapter: 'custom', command: 'node', extraArgs: FAKE })
    const t = h.createTask({ title: 'Plain', assignee: agent.id, createdBy: 'alice' })
    let raw = ''
    expect(await runTask(agent, t.id, { hive: h, stripApiKeys: true, runner: runCli, defaultCwd: dir, watchMs: 40, onOutput: (_i, c) => (raw += c) })).toBe('done')
    expect(raw).toContain('Done: Plain')
    const rec = h.getRun(t.id, h.getTask(t.id)!.lastRunId!)!
    expect(rec.activity.some((e) => e.kind === 'message' && e.text.startsWith('Done: Plain'))).toBe(true)
  })

  it('stopping keeps the list of files changed so far', async () => {
    const work = gitRepo()
    const h = new Hive(join(dir, 'hive'))
    const agent = claudeAgent({ workDir: work })
    const t = h.createTask({ title: 'SCENARIO:slow', assignee: agent.id, createdBy: 'alice' })
    const ac = new AbortController()
    const p = runTask(agent, t.id, deps(h, { signal: ac.signal, onActivity: (_i, evs) => { if (evs.some((e) => e.kind === 'command')) ac.abort() } }))
    expect(await p).toBe('cancelled')
    const rec = h.getRun(t.id, h.getTask(t.id)!.lastRunId!)!
    expect(rec.outcome).toBe('cancelled')
    expect(rec.diff.files.map((f) => f.path)).toEqual(['out.txt'])
  })
})

describe('asking the human, answering, continuing', () => {
  it('[[NEED]] pauses the task; the answer continues the SAME session on Claude', async () => {
    const calls: BuiltCommand[] = []
    const eng = new Engine(join(dir, 'config.json'), () => {}, fakeRunner(calls), dir)
    eng.watchMs = 40
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    const agent = eng.saveAgent({ name: 'dev', adapter: 'claude' })
    const t = eng.createTask({ title: 'Build SCENARIO:need', assignee: agent.id })

    expect(await eng.runTask(t.id)).toBe('needs_input')
    const asked = eng.hive.getTask(t.id)!
    expect(asked.status).toBe('needs_input')
    expect(asked.question).toBe('please attach the design spec')
    expect(asked.sessionId).toBe('sess-1')

    eng.replyToTask(t.id, 'here is the spec: use blue')
    await waitFor(() => eng.hive.getTask(t.id)!.status === 'done')
    const after = eng.hive.getTask(t.id)!
    expect(after.result).toContain('Resumed with: SESSION')
    expect(after.result).toContain('here is the spec: use blue')
    expect(after.reply).toBeUndefined()
    expect(calls[1].args.slice(-2)).toEqual(['--resume', 'sess-1'])
    expect(calls[1].resumed).toBe(true)
    expect(eng.hive.listEvents(t.id).map((e) => e.kind)).toEqual([
      'created', 'run_started', 'run_finished', 'need', 'reply', 'run_started', 'run_finished'
    ])
    eng.shutdown()
  })

  it('CLIs that cannot resume get the whole story in a fresh prompt', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = makeAgent('alice', { name: 'c', adapter: 'custom', command: 'node', extraArgs: FAKE })
    const t = h.createTask({ title: 'T', assignee: agent.id, createdBy: 'alice' })
    h.updateTask(t.id, { question: 'which color?', result: 'half done', reply: 'blue', sessionId: 'x' })
    const prompt = buildPrompt({ agent, task: h.getTask(t.id)!, hive: h })
    expect(prompt).toContain('You asked the human:\nwhich color?')
    expect(prompt).toContain('Your earlier output:\nhalf done')
    expect(prompt).toContain('The human replied:\nblue')
  })

  it('instructions added while running are applied right after, in the same session', async () => {
    const calls: BuiltCommand[] = []
    const eng = new Engine(join(dir, 'config.json'), () => {}, fakeRunner(calls), dir)
    eng.watchMs = 40
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    const agent = eng.saveAgent({ name: 'dev', adapter: 'claude' })
    const t = eng.createTask({ title: 'Work SCENARIO:slow', assignee: agent.id })
    const p = eng.runTask(t.id)
    await waitFor(() => eng.hive.getTask(t.id)!.status === 'running')
    eng.addInstruction(t.id, 'also add a README')
    expect(eng.hive.getTask(t.id)!.followups).toEqual(['also add a README'])
    expect(await p).toBe('done')
    expect(calls).toHaveLength(2)
    expect(calls[1].args).toContain('--resume')
    const final = eng.hive.getTask(t.id)!
    expect(final.result).toContain('also add a README')
    expect(final.followups).toEqual([])
    expect(eng.hive.listEvents(t.id).some((e) => e.kind === 'instruction')).toBe(true)
    eng.shutdown()
  })

  it('the engine exposes live state and a snapshot summary only while running', async () => {
    const eng = new Engine(join(dir, 'config.json'), () => {}, fakeRunner(), dir)
    eng.watchMs = 40
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    const work = gitRepo()
    const agent = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: work })
    const t = eng.createTask({ title: 'SCENARIO:slow', assignee: agent.id })
    const p = eng.runTask(t.id)
    await waitFor(() => (eng.liveState(t.id)?.changes.length ?? 0) > 0)
    const st = eng.liveState(t.id)!
    expect(st.tracking).toBe('git')
    expect(st.cwd).toBe(work)
    expect(st.changes[0]).toMatchObject({ path: 'out.txt', status: 'A' })
    expect(st.patch).toContain('+ok')
    expect(st.events.length).toBeGreaterThan(2)
    expect(eng.snapshot().live[t.id].files).toBe(1)
    await p
    expect(eng.liveState(t.id)).toBeNull()
    expect(eng.snapshot().live[t.id]).toBeUndefined()
    eng.shutdown()
  })
})

describe('permission level', () => {
  it('"exec" needs a human approval before it runs; "read" does not', async () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = claudeAgent()
    const ex = h.createTask({ title: 'Install deps', assignee: agent.id, createdBy: 'alice' })
    h.updateTask(ex.id, { permission: 'exec' })
    expect(await runTask(agent, ex.id, deps(h))).toBe('awaiting_approval')
    const ap = h.listApprovals().find((a) => a.taskId === ex.id)!
    expect(ap.reason).toMatch(/명령 실행/)
    h.decideApproval(ap.id, 'approved', 'alice')
    const calls: BuiltCommand[] = []
    expect(await runTask(agent, ex.id, deps(h, { runner: fakeRunner(calls) }))).toBe('done')
    expect(calls[0].args.join(' ')).toMatch(/--allowedTools Bash/)

    const rd = h.createTask({ title: 'Review', assignee: agent.id, createdBy: 'alice' })
    h.updateTask(rd.id, { permission: 'read' })
    const calls2: BuiltCommand[] = []
    expect(await runTask(agent, rd.id, deps(h, { runner: fakeRunner(calls2) }))).toBe('done')
    expect(calls2[0].args.join(' ')).toMatch(/--disallowedTools Edit Write MultiEdit NotebookEdit Bash/)
    const rec = h.getRun(rd.id, h.getTask(rd.id)!.lastRunId!)!
    expect(rec.permission).toBe('read')
    expect(rec.prompt).toContain('READ-ONLY')
  })
})

describe('materials: attachments and reference folders', () => {
  it('copies files into the task folder, tells the agent the path, and cleans up', () => {
    const h = new Hive(join(dir, 'hive'))
    const agent = claudeAgent()
    const t = h.createTask({ title: 'Use the spec', assignee: agent.id, createdBy: 'alice' })
    const src = join(dir, 'spec.pdf')
    writeFileSync(src, 'PDFDATA')
    const a1 = h.addAttachment(t.id, { path: src }, 'alice', 5)
    const a2 = h.addAttachment(t.id, { path: src }, 'alice', 5) // same name → not overwritten
    const a3 = h.addAttachment(t.id, { name: '../../evil.txt', data: Buffer.from('x') }, 'alice', 5)
    expect([a1.name, a2.name]).toEqual(['spec.pdf', 'spec-2.pdf'])
    expect(a3.name).not.toContain('/')
    expect(a3.rel.startsWith('attachments/' + t.id + '/')).toBe(true)
    expect(readFileSync(h.attachmentPath(a1), 'utf8')).toBe('PDFDATA')
    expect(h.getTask(t.id)!.attachments).toHaveLength(3)

    const prompt = buildPrompt({ agent, task: h.getTask(t.id)!, hive: h })
    expect(prompt).toContain('Materials the human attached')
    expect(prompt).toContain(h.attachmentPath(a1))

    h.removeAttachment(t.id, a2.rel, 'alice')
    expect(existsSync(h.attachmentPath(a2))).toBe(false)
    expect(h.getTask(t.id)!.attachments).toHaveLength(2)
    h.deleteTask(t.id)
    expect(existsSync(join(h.root, 'attachments', t.id))).toBe(false)
  })

  it('big files stay on this machine and never reach the shared repo', async () => {
    const remote = join(dir, 'remote.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', remote])
    const h = new Hive(join(dir, 'a'))
    await initSync(h.root, remote)
    const t = h.createTask({ title: 'x', createdBy: 'alice' })
    const small = h.addAttachment(t.id, { name: 'small.txt', data: Buffer.from('hi') }, 'alice', 1)
    const big = h.addAttachment(t.id, { name: 'big.bin', data: Buffer.alloc(2 * 1024 * 1024) }, 'alice', 1)
    expect(small.local).toBe(false)
    expect(big.local).toBe(true)
    expect(big.rel.startsWith('.local/attachments/')).toBe(true)
    expect((await syncNow(h.root, 'alice')).ok).toBe(true)
    const files = execFileSync('git', ['ls-files'], { cwd: h.root }).toString()
    expect(files).toContain('attachments/' + t.id + '/small.txt')
    expect(files).not.toContain('big.bin')

    // a teammate without the big file is told so instead of getting a dead path
    const agent = claudeAgent()
    rmSync(h.attachmentPath(big))
    expect(buildPrompt({ agent, task: h.getTask(t.id)!, hive: h })).toMatch(/big\.bin: not available on this machine \(too large to share\)/)
  }, 30000)

  it('dropped folders become reference folders; they reach the CLI and the prompt', async () => {
    const eng = new Engine(join(dir, 'config.json'), () => {}, fakeRunner(), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    const ref = join(dir, 'reference')
    mkdirSync(ref)
    const file = join(dir, 'notes.md')
    writeFileSync(file, '# notes')
    const agent = eng.saveAgent({ name: 'dev', adapter: 'claude' })
    const t = eng.createTask({ title: 'T', assignee: agent.id })
    const r = eng.attachPaths(t.id, [file, ref, join(dir, 'missing')])
    expect(r.attached.map((a) => a.name)).toEqual(['notes.md'])
    expect(r.folders).toEqual([ref])
    expect(r.errors).toHaveLength(1)
    expect(eng.hive.getTask(t.id)!.refDirs).toEqual([ref])

    const calls: BuiltCommand[] = []
    ;(eng as unknown as { runner: Runner }).runner = fakeRunner(calls)
    await eng.runTask(t.id)
    expect(calls[0].args).toContain(`--add-dir=${ref}`)
    // reference folders stay read-only: opened, but no edit tool may touch them
    expect(calls[0].args).toContain(claudePathRule('Write', ref))
    const rec = eng.hive.getRun(t.id, eng.hive.getTask(t.id)!.lastRunId!)!
    expect(rec.prompt).toContain('Reference folders you may read')
    expect(rec.prompt).toContain(ref)
    eng.shutdown()
  })
})

describe('pre-run check', () => {
  it('flags a missing work folder, a non-git folder (with a fix) and missing materials', async () => {
    const eng = new Engine(join(dir, 'config.json'), () => {}, fakeRunner(), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    const plain = join(dir, 'plain')
    mkdirSync(plain)
    const agent = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: plain })
    const t = eng.createTask({ title: 'T', assignee: agent.id, permission: 'exec', refDirs: [join(dir, 'gone')] })

    let pf = await eng.preflight(t.id)
    expect(pf.canRun).toBe(true)
    expect(pf.workDir).toBe(plain)
    expect(pf.items.find((i) => i.fix === 'git-init')?.level).toBe('warn')
    expect(pf.items.some((i) => i.level === 'warn' && /참고 폴더를 찾을 수 없어요/.test(i.text))).toBe(true)
    expect(pf.items.some((i) => /명령 실행/.test(i.text))).toBe(true)
    expect(pf.items.some((i) => /승인이 필요/.test(i.text))).toBe(true)

    expect((await eng.enableTracking(t.id)).ok).toBe(true)
    expect(existsSync(join(plain, '.git'))).toBe(true)
    pf = await eng.preflight(t.id)
    expect(pf.items.find((i) => i.fix === 'git-init')).toBeUndefined()
    expect(pf.items.some((i) => /줄 단위로 추적/.test(i.text))).toBe(true)

    eng.saveAgent({ id: agent.id, name: 'dev', adapter: 'claude', workDir: join(dir, 'nope') })
    pf = await eng.preflight(t.id)
    expect(pf.canRun).toBe(false)
    expect(pf.items.some((i) => i.level === 'error' && /작업 폴더를 찾을 수 없어요/.test(i.text))).toBe(true)
    eng.shutdown()
  })

  it('is honest about CLIs that cannot enforce permission or folders', async () => {
    const eng = new Engine(join(dir, 'config.json'), () => {}, fakeRunner(), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    const agent = eng.saveAgent({ name: 'g', adapter: 'agy' })
    const t = eng.createTask({ title: 'T', assignee: agent.id, permission: 'read', refDirs: [dir] })
    const pf = await eng.preflight(t.id)
    expect(pf.items.some((i) => i.level === 'warn' && /직접 강제하지 못해서/.test(i.text))).toBe(true)
    expect(pf.items.some((i) => i.level === 'warn' && /경로만 알려줘요/.test(i.text))).toBe(true)
    eng.shutdown()
  })
})

describe('change tracking outside git', () => {
  it('lists added / changed / deleted files, skips junk folders, and says lines are not counted', async () => {
    const work = join(dir, 'plain')
    mkdirSync(join(work, 'node_modules'), { recursive: true })
    writeFileSync(join(work, 'keep.txt'), 'same')
    writeFileSync(join(work, 'edit.txt'), 'v1')
    writeFileSync(join(work, 'gone.txt'), 'bye')
    writeFileSync(join(work, 'node_modules', 'x.js'), '1')
    const tracker = await trackChanges(work)
    expect(tracker.mode).toBe('scan')
    writeFileSync(join(work, 'edit.txt'), 'version two')
    writeFileSync(join(work, 'new.txt'), 'n')
    rmSync(join(work, 'gone.txt'))
    writeFileSync(join(work, 'node_modules', 'y.js'), '2')
    const d = await tracker.finish()
    expect(d).toMatchObject({ available: true, lines: false, root: work })
    expect(d.files.map((f) => `${f.status}:${f.path}`)).toEqual(['D:gone.txt', 'M:edit.txt', 'A:new.txt'].sort((a, b) => a.slice(2).localeCompare(b.slice(2))))
    expect(d.reason).toMatch(/git 저장소가 아니라서/)
  })

  it('too many files → no scan, with a reason', () => {
    expect(diffScans(new Map(), new Map()).files).toEqual([])
    expect(scanFolder(join(dir, 'does-not-exist'))?.size).toBe(0)
  })

  it('git root above the work folder: paths are relative to the root', async () => {
    const repo = gitRepo('repo')
    const sub = join(repo, 'pkg')
    mkdirSync(sub)
    const tracker = await trackChanges(sub)
    writeFileSync(join(sub, 'f.txt'), 'x')
    const d = await tracker.finish()
    expect(d.files.map((f) => f.path)).toEqual(['pkg/f.txt'])
    expect(d.root && d.root.endsWith('repo')).toBe(true)
  })
})

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}
