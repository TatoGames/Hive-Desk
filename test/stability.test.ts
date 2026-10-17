import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner, RunResult } from '../src/main/adapters'
import { BACKUP_MAX_FILES } from '../src/main/checkpoint'
import { Engine } from '../src/main/engine'
import { detectLimit, looksLikeLimit, parseReset } from '../src/main/limits'
import type { Agent } from '../src/shared/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-stab-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const ok = (stdout = 'done'): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false })

function gitRepo(name = 'repo'): { work: string; g: (...a: string[]) => string } {
  const work = join(dir, name)
  mkdirSync(work, { recursive: true })
  const g = (...a: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: work }).toString()
  g('init', '-b', 'main')
  g('config', 'core.autocrlf', 'false') // Windows runners default to CRLF checkouts
  writeFileSync(join(work, 'a.txt'), 'original\n')
  writeFileSync(join(work, 'gone.txt'), 'will be deleted\n')
  g('add', '-A')
  g('commit', '-m', 'init')
  return { work, g }
}

function makeEngine(runner: Runner, cfgName = 'config.json'): Engine {
  const eng = new Engine(join(dir, cfgName), () => {}, runner, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
  eng.watchMs = 30
  return eng
}

function addAgent(eng: Engine, workDir: string, name = 'dev', adapter: Agent['adapter'] = 'claude'): Agent {
  return eng.saveAgent({ name, adapter, workDir })
}

/** A "CLI" that edits files in the work folder, like an agent would. */
const mutating =
  (fn: (cwd: string) => void): Runner =>
  async (_b, o) => {
    fn(o.cwd)
    return ok()
  }

describe('B1: undo a run (git work folder)', () => {
  it('puts files back, removes new files, keeps what the human had changed before, never touches branches or the index', async () => {
    const { work, g } = gitRepo()
    // the human's own unfinished work, present BEFORE the run
    writeFileSync(join(work, 'mine.txt'), 'my notes\n')
    const eng = makeEngine(
      mutating((cwd) => {
        writeFileSync(join(cwd, 'a.txt'), 'changed by agent\n')
        writeFileSync(join(cwd, 'new.txt'), 'created by agent\n')
        mkdirSync(join(cwd, 'sub'))
        writeFileSync(join(cwd, 'sub', 'x.txt'), 'x\n')
        rmSync(join(cwd, 'gone.txt'))
      })
    )
    const agent = addAgent(eng, work)
    const t = eng.createTask({ title: 'Edit', assignee: agent.id })
    const head = g('rev-parse', 'HEAD')
    expect(await eng.runTask(t.id)).toBe('done')
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('changed by agent\n')

    const rec = eng.hive.getRun(t.id, eng.hive.getTask(t.id)!.lastRunId!)!
    expect(rec.checkpoint?.kind).toBe('git')
    expect(g('rev-parse', '--verify', rec.checkpoint!.ref!).trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(rec.diff.files.map((f) => f.path).sort()).toEqual(['a.txt', 'gone.txt', 'new.txt', 'sub/x.txt'])

    const r = await eng.rollbackRun(t.id, rec.id)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('original\n')
    expect(readFileSync(join(work, 'gone.txt'), 'utf8')).toBe('will be deleted\n')
    expect(existsSync(join(work, 'new.txt'))).toBe(false)
    expect(existsSync(join(work, 'sub'))).toBe(false) // folder the agent made is gone too
    expect(readFileSync(join(work, 'mine.txt'), 'utf8')).toBe('my notes\n') // pre-existing work survives

    expect(g('rev-parse', 'HEAD')).toBe(head) // no commit on the user's branch
    expect(g('diff', '--cached', '--name-only').trim()).toBe('') // index untouched
    expect(g('branch', '--list').trim()).toBe('* main')

    const after = eng.hive.getRun(t.id, rec.id)!
    expect(after.rolledBackAt).toBeTruthy()
    expect(eng.hive.listEvents(t.id).map((e) => e.kind)).toContain('rollback')
    expect(eng.hive.getTask(t.id)!.status).toBe('todo') // a rolled-back "done" task is open again
    expect((await eng.rollbackRun(t.id, rec.id)).ok).toBe(false) // only once
    eng.shutdown()
  })

  it('a run that changed nothing can still be "undone" without harm', async () => {
    const { work } = gitRepo()
    const eng = makeEngine(mutating(() => {}))
    const agent = addAgent(eng, work)
    const t = eng.createTask({ title: 'Nothing', assignee: agent.id })
    await eng.runTask(t.id)
    const rec = eng.hive.getRun(t.id, eng.hive.getTask(t.id)!.lastRunId!)!
    const r = await eng.rollbackRun(t.id, rec.id)
    expect(r).toMatchObject({ ok: true, message: '되돌릴 변경이 없었어요.' })
    eng.shutdown()
  })
})

describe('B1: undo a run (folder that is not a git repo)', () => {
  it('backs the files up first and restores them', async () => {
    const work = join(dir, 'plain')
    mkdirSync(work)
    writeFileSync(join(work, 'a.txt'), 'original\n')
    writeFileSync(join(work, 'gone.txt'), 'bye\n')
    const eng = makeEngine(
      mutating((cwd) => {
        writeFileSync(join(cwd, 'a.txt'), 'changed!!\n') // different size, so it counts as changed
        writeFileSync(join(cwd, 'new.txt'), 'n')
        rmSync(join(cwd, 'gone.txt'))
      })
    )
    const agent = addAgent(eng, work)
    const t = eng.createTask({ title: 'Edit', assignee: agent.id })
    await eng.runTask(t.id)
    const rec = eng.hive.getRun(t.id, eng.hive.getTask(t.id)!.lastRunId!)!
    expect(rec.checkpoint?.kind).toBe('copy')
    const r = await eng.rollbackRun(t.id, rec.id)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('original\n')
    expect(readFileSync(join(work, 'gone.txt'), 'utf8')).toBe('bye\n')
    expect(existsSync(join(work, 'new.txt'))).toBe(false)
    eng.shutdown()
  })

  it('skips the backup of a huge folder and says why', async () => {
    const work = join(dir, 'huge')
    mkdirSync(work)
    for (let i = 0; i <= BACKUP_MAX_FILES; i++) writeFileSync(join(work, `f${i}.txt`), 'x')
    const eng = makeEngine(mutating(() => {}))
    const agent = addAgent(eng, work)
    const t = eng.createTask({ title: 'Big', assignee: agent.id })
    await eng.runTask(t.id)
    const rec = eng.hive.getRun(t.id, eng.hive.getTask(t.id)!.lastRunId!)!
    expect(rec.checkpoint).toBeUndefined()
    expect(rec.checkpointNote).toMatch(/커서/)
    const r = await eng.rollbackRun(t.id, rec.id)
    expect(r.ok).toBe(false)
    eng.shutdown()
  }, 60000)
})

describe('C3: closing the app in the middle of a run', () => {
  it('keeps the half-done run as "interrupted", shows what changed, and can undo it', async () => {
    const { work } = gitRepo()
    let release!: () => void
    const hang = new Promise<void>((r) => (release = r))
    const runner: Runner = async (_b, o) => {
      writeFileSync(join(o.cwd, 'a.txt'), 'half done\n')
      writeFileSync(join(o.cwd, 'partial.txt'), 'p\n')
      await hang // the app "dies" here
      return ok()
    }
    const first = makeEngine(runner)
    const agent = addAgent(first, work)
    const t = first.createTask({ title: 'Long job', assignee: agent.id })
    const firstRun = first.runTask(t.id)
    // wait until the run record exists and the files are changed
    for (let i = 0; i < 100 && !(first.hive.unfinishedRun(t.id) && existsSync(join(work, 'partial.txt'))); i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(first.hive.unfinishedRun(t.id)).toBeTruthy()

    // a fresh start of the app finds the task "running" with nobody running it
    const second = new Engine(join(dir, 'config.json'), () => {}, mutating(() => {}), dir)
    await second.recovering
    const task = second.hive.getTask(t.id)!
    expect(task.status).toBe('todo')
    expect(task.interruptedRun).toBeTruthy()
    const rec = second.hive.getRun(t.id, task.interruptedRun!)!
    expect(rec.outcome).toBe('interrupted')
    expect(rec.diff.files.map((f) => f.path).sort()).toEqual(['a.txt', 'partial.txt'])
    expect(second.hive.listEvents(t.id).some((e) => e.text.includes('중단'))).toBe(true)

    expect((await second.rollbackRun(t.id, rec.id)).ok).toBe(true)
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('original\n')
    expect(existsSync(join(work, 'partial.txt'))).toBe(false)
    expect(second.hive.getTask(t.id)!.interruptedRun).toBeUndefined()
    release()
    await firstRun // let the stale run end before the folder is deleted
    first.shutdown()
    second.shutdown()
  })
})

describe('B2: one run per work folder', () => {
  function tracker(): { runner: Runner; max: () => number } {
    let cur = 0
    let max = 0
    return {
      max: () => max,
      runner: async () => {
        cur++
        max = Math.max(max, cur)
        await new Promise((r) => setTimeout(r, 120))
        cur--
        return ok()
      }
    }
  }

  it('tasks in the same folder run one after another and show as waiting', async () => {
    const work = join(dir, 'shared')
    mkdirSync(work)
    const tr = tracker()
    const eng = makeEngine(tr.runner)
    const a = addAgent(eng, work, 'one')
    const b = addAgent(eng, work, 'two')
    const t1 = eng.createTask({ title: 'A', assignee: a.id })
    const t2 = eng.createTask({ title: 'B', assignee: b.id })
    const p1 = eng.runTask(t1.id)
    const p2 = eng.runTask(t2.id)
    await new Promise((r) => setTimeout(r, 40))
    expect(eng.snapshot().waiting).toEqual({ [t2.id]: t1.id })
    expect(eng.hive.getTask(t2.id)!.status).toBe('todo')
    expect(await Promise.all([p1, p2])).toEqual(['done', 'done'])
    expect(tr.max()).toBe(1)
    expect(eng.snapshot().waiting).toEqual({})
    eng.shutdown()
  })

  it('different folders run side by side', async () => {
    const w1 = join(dir, 'w1')
    const w2 = join(dir, 'w2')
    mkdirSync(w1)
    mkdirSync(w2)
    const tr = tracker()
    const eng = makeEngine(tr.runner)
    const t1 = eng.createTask({ title: 'A', assignee: addAgent(eng, w1, 'one').id })
    const t2 = eng.createTask({ title: 'B', assignee: addAgent(eng, w2, 'two').id })
    await Promise.all([eng.runTask(t1.id), eng.runTask(t2.id)])
    expect(tr.max()).toBe(2)
    eng.shutdown()
  })

  it('stopping a task that is still waiting just cancels it', async () => {
    const work = join(dir, 'shared')
    mkdirSync(work)
    const tr = tracker()
    const eng = makeEngine(tr.runner)
    const t1 = eng.createTask({ title: 'A', assignee: addAgent(eng, work, 'one').id })
    const t2 = eng.createTask({ title: 'B', assignee: addAgent(eng, work, 'two').id })
    const p1 = eng.runTask(t1.id)
    const p2 = eng.runTask(t2.id)
    await new Promise((r) => setTimeout(r, 30))
    eng.stopTask(t2.id)
    expect(await p2).toBe('cancelled')
    expect(eng.hive.getTask(t2.id)!.status).toBe('todo')
    expect(await p1).toBe('done')
    expect(eng.snapshot().waiting).toEqual({})
    // the folder is free again afterwards
    expect(await eng.runTask(t2.id)).toBe('done')
    eng.shutdown()
  })
})

describe('C1: usage limit', () => {
  const NOW = new Date('2026-10-17T10:00:00')

  it('recognises limit messages of the CLIs and ordinary text is left alone', () => {
    expect(looksLikeLimit('Claude AI usage limit reached|1760000000')).toBe(true)
    expect(looksLikeLimit("You've hit your limit · resets 3pm (Asia/Seoul)")).toBe(true)
    expect(looksLikeLimit('ERROR: You have exceeded your usage limit. Try again in 5 hours.')).toBe(true)
    expect(looksLikeLimit('429 Too Many Requests')).toBe(true)
    expect(looksLikeLimit('I refactored the limit calculation and fixed the bug.')).toBe(false)
    expect(looksLikeLimit('')).toBe(false)
  })

  it('reads when it resets', () => {
    expect(parseReset('Claude AI usage limit reached|1760000000', NOW)!.getTime()).toBe(1760000000 * 1000)
    expect(parseReset('resets 3pm (Asia/Seoul)', NOW)!.getHours()).toBe(15)
    expect(parseReset('resets at 9:30 AM', new Date('2026-10-17T10:00:00'))!.getDate()).toBe(18) // already past → tomorrow
    expect(parseReset('try again in 5 hours', NOW)!.getTime()).toBe(NOW.getTime() + 5 * 3600_000)
    expect(parseReset('retry after 30 minutes', NOW)!.getTime()).toBe(NOW.getTime() + 30 * 60_000)
    expect(parseReset('in 2 hours 10 minutes', NOW)!.getTime()).toBe(NOW.getTime() + 130 * 60_000)
    expect(parseReset('no time here', NOW)).toBeNull()
  })

  it('guesses an hour when the CLI does not say', () => {
    const l = detectLimit('You have hit your usage limit.', NOW)!
    expect(l.guessed).toBe(true)
    expect(new Date(l.until).getTime()).toBe(NOW.getTime() + 3600_000)
  })

  it('a failed run that hit the limit is not a failure: the task stays ready, auto-run pauses that CLI', async () => {
    const work = join(dir, 'w')
    mkdirSync(work)
    let calls = 0
    const runner: Runner = async () => {
      calls++
      return { code: 1, stdout: '', stderr: 'Claude AI usage limit reached|' + (Math.floor(Date.now() / 1000) + 7200), timedOut: false, aborted: false }
    }
    const eng = makeEngine(runner)
    eng.saveSettings({ autoRun: true })
    const agent = addAgent(eng, work)
    const t = eng.createTask({ title: 'Needs quota', assignee: agent.id })
    expect(await eng.runTask(t.id)).toBe('limited')
    const task = eng.hive.getTask(t.id)!
    expect(task.status).toBe('todo')
    expect(task.error).toMatch(/사용량 한도/)
    expect(eng.hive.getRun(t.id, task.lastRunId!)!.outcome).toBe('limit')
    expect(eng.limitFor('claude')).toBeTruthy()
    expect(Object.keys(eng.snapshot().limits)).toEqual(['claude'])

    // auto-run leaves it alone while the limit is active
    await eng.tick()
    expect(calls).toBe(1)
    // survives a restart of the app
    eng.shutdown()
    const again = new Engine(join(dir, 'config.json'), () => {}, runner, dir)
    expect(again.limitFor('claude')).toBeTruthy()
    // the human can override it
    again.clearLimit('claude')
    expect(again.limitFor('claude')).toBeUndefined()
    again.shutdown()
  })

  it('an ordinary failure is still a failure', async () => {
    const work = join(dir, 'w')
    mkdirSync(work)
    const eng = makeEngine(async () => ({ code: 2, stdout: '', stderr: 'segfault', timedOut: false, aborted: false }))
    const t = eng.createTask({ title: 'Broken', assignee: addAgent(eng, work).id })
    expect(await eng.runTask(t.id)).toBe('failed')
    expect(eng.limitFor('claude')).toBeUndefined()
    eng.shutdown()
  })

  it('a successful long answer that merely talks about rate limits is not a limit', async () => {
    const work = join(dir, 'w')
    mkdirSync(work)
    const text = 'I added retry logic for requests that were rate limited. '.repeat(20)
    const eng = makeEngine(async () => ok(text))
    const t = eng.createTask({ title: 'Retry logic', assignee: addAgent(eng, work).id })
    expect(await eng.runTask(t.id)).toBe('done')
    eng.shutdown()
  })
})
