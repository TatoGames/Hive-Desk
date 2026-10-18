import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCommand, claudePathRule, effectivePermission, runCli, type Runner } from '../src/main/adapters'
import { makeAgent } from '../src/main/config'
import { Hive } from '../src/main/hive'
import { buildPrompt, runTask } from '../src/main/runner'

const STREAM = join(__dirname, 'fake-claude-stream.cjs')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-perm-'))
  mkdirSync(join(dir, 'cwd'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const claude = (over = {}) => makeAgent('alice', { name: 'dev', adapter: 'claude', ...over })

describe('A1: attachments the agent can really open', () => {
  it('copies attachments into the work folder for the run, tells the agent that path, and removes them afterwards', async () => {
    const hive = new Hive(join(dir, 'ws'))
    const work = join(dir, 'work')
    mkdirSync(work)
    const agent = claude({ workDir: work })
    const t = hive.createTask({ title: 'copy the pdf', assignee: agent.id, createdBy: 'alice' })
    const src = join(dir, 'spec.pdf')
    writeFileSync(src, 'PDFDATA')
    hive.addAttachment(t.id, { path: src }, 'alice', 5)

    let seen: { exists: boolean; content: string; prompt: string } | null = null
    const runner: Runner = (built, opts) => {
      const m = opts.prompt.match(/- (\S+spec\.pdf)/)
      seen = {
        exists: !!m && existsSync(m[1]),
        content: m && existsSync(m[1]) ? readFileSync(m[1], 'utf8') : '',
        prompt: opts.prompt
      }
      return runCli({ command: 'node', args: [STREAM, ...built.args], stream: built.stream }, opts)
    }
    const out = await runTask(agent, t.id, { hive, stripApiKeys: true, runner, defaultCwd: join(dir, 'cwd'), watchMs: 40 })
    expect(out).toBe('done')
    expect(seen!.exists).toBe(true)
    expect(seen!.content).toBe('PDFDATA')
    // the path the agent got is inside the work folder
    expect(seen!.prompt).toContain(join(work, '.hivedesk', 'attachments', t.id, 'spec.pdf'))
    // cleaned up, and never reported as a change made by the agent
    expect(existsSync(join(work, '.hivedesk'))).toBe(false)
    const rec = hive.getRun(t.id, hive.getTask(t.id)!.lastRunId!)!
    expect(rec.diff.files.map((f) => f.path)).not.toContain('.hivedesk/attachments/' + t.id + '/spec.pdf')
  })

  it('does not touch the git state of the project (no .hivedesk in the diff of a git work folder)', async () => {
    const work = join(dir, 'repo')
    mkdirSync(work)
    const g = (...a: string[]): string =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: work }).toString()
    g('init', '-b', 'main')
    writeFileSync(join(work, 'a.txt'), 'x\n')
    g('add', '-A')
    g('commit', '-m', 'i')
    const hive = new Hive(join(dir, 'ws'))
    const agent = claude({ workDir: work })
    const t = hive.createTask({ title: 'T', assignee: agent.id, createdBy: 'alice' })
    const src = join(dir, 'n.txt')
    writeFileSync(src, 'n')
    hive.addAttachment(t.id, { path: src }, 'alice', 5)
    const runner: Runner = (built, opts) =>
      runCli({ command: 'node', args: [STREAM, ...built.args], stream: built.stream }, opts)
    await runTask(agent, t.id, { hive, stripApiKeys: true, runner, defaultCwd: join(dir, 'cwd'), watchMs: 40 })
    const rec = hive.getRun(t.id, hive.getTask(t.id)!.lastRunId!)!
    expect(rec.diff.files.some((f) => f.path.startsWith('.hivedesk'))).toBe(false)
    expect(g('status', '--porcelain')).not.toContain('.hivedesk')
    expect(existsSync(join(work, '.hivedesk'))).toBe(false)
  })

  it('without a work folder the agent works in the hive and reads the attachment where it is', () => {
    const hive = new Hive(join(dir, 'ws'))
    const agent = claude()
    const t = hive.createTask({ title: 'T', assignee: agent.id, createdBy: 'alice' })
    const src = join(dir, 'n.txt')
    writeFileSync(src, 'n')
    const a = hive.addAttachment(t.id, { path: src }, 'alice', 5)
    const p = buildPrompt({ agent, task: hive.getTask(t.id)!, hive })
    expect(p).toContain(hive.attachmentPath(a))
  })
})

describe('A2: reference folders are read-only', () => {
  it('Claude: folder is opened with --add-dir but every edit tool is denied inside it', () => {
    const b = buildCommand(claude(), { refDirs: ['/data/ref'] })
    expect(b.args).toContain('--add-dir=/data/ref')
    const denied = b.args.slice(b.args.indexOf('--disallowedTools') + 1)
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(denied).toContain(`${tool}(//data/ref/**)`)
    }
  })

  it('Claude: the deny rules also apply at the command-running level', () => {
    const b = buildCommand(claude(), { refDirs: ['/data/ref'], permission: 'exec' })
    expect(b.args).toContain('Write(//data/ref/**)')
  })

  it('writes Windows paths the way Claude Code expects them', () => {
    expect(claudePathRule('Write', 'C:\\My Docs\\ref')).toBe('Write(//c/My Docs/ref/**)')
    expect(claudePathRule('Edit', '/Users/a/ref/')).toBe('Edit(//Users/a/ref/**)')
  })

  it('Codex: no --add-dir (it would make the folder writable); the path is only told in the prompt', () => {
    const b = buildCommand(makeAgent('a', { name: 'x', adapter: 'codex' }), { refDirs: ['/data/ref'] })
    expect(b.args).not.toContain('--add-dir')
  })
})

describe('A3: the default level cannot delete or move', () => {
  const rm = ['Bash(rm *)', 'Bash(mv *)', 'Bash(rmdir *)']
  it('edit level denies destructive commands', () => {
    const b = buildCommand(claude(), { permission: 'edit' })
    const denied = b.args.slice(b.args.indexOf('--disallowedTools') + 1)
    for (const r of rm) expect(denied).toContain(r)
  })
  it('no permission given means the default level (also denies)', () => {
    expect(buildCommand(claude()).args).toContain('Bash(rm *)')
  })
  it('exec level is where they are allowed', () => {
    const b = buildCommand(claude(), { permission: 'exec' })
    expect(b.args).not.toContain('Bash(rm *)')
    expect(b.args).toContain('Bash')
  })
})

describe('A4: CLIs that cannot enforce permissions default to read-only', () => {
  it('Claude and Codex keep the editing default, agy / custom start read-only', () => {
    expect(effectivePermission('claude', undefined)).toBe('edit')
    expect(effectivePermission('codex', undefined)).toBe('edit')
    for (const id of ['agy', 'custom'] as const) expect(effectivePermission(id, undefined)).toBe('read')
  })
  it('an explicit choice always wins', () => {
    expect(effectivePermission('agy', 'edit')).toBe('edit')
    expect(effectivePermission('claude', 'read')).toBe('read')
  })
  it('the prompt of a read-only agy task says so, and the run record keeps the level', async () => {
    const hive = new Hive(join(dir, 'ws'))
    const agent = makeAgent('alice', { name: 'a', adapter: 'agy' })
    const t = hive.createTask({ title: 'T', assignee: agent.id, createdBy: 'alice' })
    const calls: string[] = []
    const runner: Runner = async (_b, opts) => {
      calls.push(opts.prompt)
      return { code: 0, stdout: 'ok', stderr: '', timedOut: false, aborted: false }
    }
    await runTask(agent, t.id, { hive, stripApiKeys: true, runner, defaultCwd: join(dir, 'cwd') })
    expect(calls[0]).toContain('READ-ONLY')
    expect(hive.getRun(t.id, hive.getTask(t.id)!.lastRunId!)!.permission).toBe('read')
  })
  it('agy: only the approval-gated command level turns on its auto-approve flag', () => {
    const agy = makeAgent('a', { name: 'y', adapter: 'agy' })
    expect(buildCommand(agy, { permission: 'edit' }).args).not.toContain('--dangerously-skip-permissions')
    expect(buildCommand(agy, { permission: 'exec' }).args).toContain('--dangerously-skip-permissions')
  })
})
