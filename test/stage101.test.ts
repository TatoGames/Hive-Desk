import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { addWorktree, commitWorktree, gitState, initGitFolder, mergeWorktree, removeWorktree, worktreeCwd } from '../src/main/worktree'
import { runChecks } from '../src/main/checks'
import { lstatSync } from 'node:fs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s101-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd }).toString()
const idle: Runner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false })

describe('a folder without git can become one (after the person agrees)', () => {
  it('state: none → ok; the files become the first record, installed packages stay out', async () => {
    const w = join(dir, 'w')
    mkdirSync(join(w, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(w, 'node_modules', 'x', 'big.js'), 'x')
    writeFileSync(join(w, 'index.html'), '<h1>hi</h1>')
    expect(await gitState(w)).toBe('none')
    const r = await initGitFolder(w)
    expect(r.ok).toBe(true)
    expect(await gitState(w)).toBe('ok')
    expect(git(w, 'ls-files').trim().split('\n').sort()).toEqual(['.gitignore', 'index.html'])
    expect(readFileSync(join(w, '.gitignore'), 'utf8')).toContain('node_modules/')
    // a work tree can be made from it now
    expect(await addWorktree(w, 't1')).not.toBeNull()
    // doing it again changes nothing
    expect((await initGitFolder(w)).message).toContain('이미')
  })

  it('an empty repository (no commit) gets its first record; a sub-folder of a repository works once the repository has one (C4)', async () => {
    const w = join(dir, 'e')
    mkdirSync(w)
    git(w, 'init', '-q', '-b', 'main')
    writeFileSync(join(w, 'a.txt'), 'a')
    expect(await gitState(w)).toBe('no-commit')
    expect((await initGitFolder(w)).ok).toBe(true)
    expect(await gitState(w)).toBe('ok')
    const sub = join(w, 'server')
    mkdirSync(sub)
    expect(await gitState(sub)).toBe('ok')
    const r = await initGitFolder(sub)
    expect(r.message).toContain('이미')
    expect(existsSync(join(sub, '.git'))).toBe(false)
    // …but a sub-folder of a repository without any record is not turned into the first record
    const e2 = join(dir, 'e2')
    mkdirSync(join(e2, 'server'), { recursive: true })
    git(e2, 'init', '-q', '-b', 'main')
    expect(await gitState(join(e2, 'server'))).toBe('no-commit')
    const r2 = await initGitFolder(join(e2, 'server'))
    expect(r2.ok).toBe(false)
    expect(r2.message).toContain('맨 위 폴더')
  })
})

function setup() {
  const w = join(dir, 'work')
  mkdirSync(w, { recursive: true })
  writeFileSync(join(w, 'a.txt'), 'a')
  const eng = new Engine(join(dir, 'c.json'), () => {}, idle, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), parallelWorktrees: false })
  const a = eng.saveAgent({ name: '개발', adapter: 'claude', workDir: w, modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
  const sub = (title: string) => {
    const t = eng.createTask({ title, assignee: a.id })
    return eng.hive.updateTask(t.id, { kind: 'work', parentId: 'parent-x' })
  }
  return { eng, w, sub, a }
}

describe('why a task waits for its folder, and the fix', () => {
  it('single tasks and sub-tasks in a plain folder are offered git', async () => {
    const { eng, a } = setup()
    const solo = eng.createTask({ title: '단독', assignee: a.id })
    expect((await eng.parallelAdvice(solo.id)).state).toBe('none')
    const { sub } = setup2(eng, a)
    expect((await eng.parallelAdvice(sub.id)).state).toBe('none')
    eng.shutdown()
  })

  it('enabling makes the folder a git folder and turns parallel work on; then nothing is left to fix', async () => {
    const { eng, sub, w } = setup()
    const t = sub('모델')
    const r = await eng.enableParallel(t.id)
    expect(r.ok).toBe(true)
    expect(eng.config.parallelWorktrees).toBe(true)
    expect(await gitState(w)).toBe('ok')
    expect((await eng.parallelAdvice(t.id)).state).toBe('ok')
    eng.shutdown()
  })

  it('a git folder with the switch off only needs the switch; a sub-folder of it works the same (C4)', async () => {
    const { eng, sub, w } = setup()
    await initGitFolder(w)
    const t = sub('라우터')
    expect((await eng.parallelAdvice(t.id)).state).toBe('off')
    expect((await eng.enableParallel(t.id)).ok).toBe(true)
    // a sub-folder of a repository
    const inner = join(w, 'server')
    mkdirSync(inner)
    const a2 = eng.saveAgent({ name: '서버', adapter: 'codex', workDir: inner, modelRef: { id: 'openai-gpt-6-1-sol', pin: 'pinned' } })
    const t2 = eng.hive.updateTask(eng.createTask({ title: '서버 일', assignee: a2.id }).id, { kind: 'work', parentId: 'p' })
    const adv = await eng.parallelAdvice(t2.id)
    expect(adv.state).toBe('ok')
    expect((await eng.enableParallel(t2.id)).ok).toBe(true)
    eng.shutdown()
  })
})

function setup2(eng: Engine, a: { id: string }) {
  const t = eng.createTask({ title: '하위', assignee: a.id })
  return { sub: eng.hive.updateTask(t.id, { kind: 'work', parentId: 'parent-x' }) }
}

describe('work trees share the project\'s installed packages (never saved, never deleted)', () => {
  it('the link lets checks run in the work tree; the branch does not contain it; removing keeps the real packages', async () => {
    const w = join(dir, 'proj')
    mkdirSync(join(w, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(w, 'node_modules', 'dep', 'index.js'), 'module.exports = 1')
    writeFileSync(join(w, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }))
    writeFileSync(join(w, 't.js'), 'require("dep")')
    writeFileSync(join(w, 't2.js'), '')
    expect((await initGitFolder(w)).ok).toBe(true)
    const wt = (await addWorktree(w, 'task1'))!
    expect(lstatSync(join(wt.path, 'node_modules')).isSymbolicLink()).toBe(true)
    // the tests of the work tree can use the packages (this is what the automatic check does)
    const run = await runChecks(wt.path, { app: false, shotDir: dir, shotName: 'x' })
    expect(run.items.map((i) => [i.name, i.ok, !!i.skipped])).toEqual([['test', true, false]])
    writeFileSync(join(wt.path, 'new.txt'), 'n')
    await commitWorktree(wt, '작업')
    expect(git(w, 'ls-tree', '-r', '--name-only', wt.branch)).not.toContain('node_modules')
    expect((await mergeWorktree(wt, '작업')).ok).toBe(true)
    expect(git(w, 'status', '--porcelain').trim()).toBe('')
    await removeWorktree(wt)
    expect(existsSync(join(w, 'node_modules', 'dep', 'index.js'))).toBe(true)
    expect(existsSync(wt.path)).toBe(false)
  })
})

describe('single tasks in one git folder run together, each in its own work tree, and are merged when done', () => {
  it('two tasks of two employees overlap; both results end up in the folder; work trees are cleaned up', async () => {
    const w = join(dir, 'proj')
    mkdirSync(w, { recursive: true })
    writeFileSync(join(w, 'README.md'), 'hi\n')
    expect((await initGitFolder(w)).ok).toBe(true)
    let active = 0
    let maxActive = 0
    const cwds: string[] = []
    const runner: Runner = async (_b, o) => {
      cwds.push(o.cwd)
      const name = /## Your task\n(.*)/.exec(o.prompt)?.[1] ?? 'x'
      maxActive = Math.max(maxActive, ++active)
      // wait until the other run has started too (or 5 s): sequential runs would never overlap
      for (let i = 0; i < 600 && maxActive < 2; i++) await new Promise((r) => setTimeout(r, 20))
      writeFileSync(join(o.cwd, name + '.txt'), name + '\n')
      active--
      return { code: 0, stdout: '[[DID: ' + name + ']]\n[[FILES: ' + name + '.txt]]\n[[VERIFY: x]]\n[[RISK: none]]\n[[NEXT: none]]', stderr: '', timedOut: false, aborted: false }
    }
    const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), parallelWorktrees: true, maxConcurrent: 4, humanReview: 'off', review: { checks: true, appCheck: false, policy: 'risk', maxRounds: 2 } })
    const a = eng.saveAgent({ name: '가', adapter: 'claude', workDir: w, modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    const b = eng.saveAgent({ name: '나', adapter: 'codex', workDir: w, modelRef: { id: 'openai-gpt-6-1-sol', pin: 'pinned' } })
    const t1 = eng.createTask({ title: '파일하나', assignee: a.id })
    const t2 = eng.createTask({ title: '파일둘', assignee: b.id })
    await Promise.all([eng.runTask(t1.id), eng.runTask(t2.id)])
    const merged = async (): Promise<void> => {
      for (let i = 0; i < 300; i++) {
        if ([t1.id, t2.id].every((id) => { const x = eng.hive.getTask(id); return x?.status === 'done' && (!x.worktree || x.worktree.merged) })) return
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    await merged()
    expect(maxActive).toBe(2)
    // one worked in the folder itself, the other apart from it
    expect(cwds.filter((c) => c.includes('.hive-worktrees')).length).toBe(1)
    expect(existsSync(join(w, '파일하나.txt'))).toBe(true)
    expect(existsSync(join(w, '파일둘.txt'))).toBe(true)
    const apart = [t1, t2].map((t) => eng.hive.getTask(t.id)!).find((t) => t.worktree)!
    expect(apart.worktree?.merged).toBe(true)
    expect(eng.hive.listEvents(apart.id).some((e) => e.text.includes('별도 작업 폴더에서 동시에'))).toBe(true)
    expect(existsSync(apart.worktree!.path)).toBe(false)
    eng.shutdown()
  }, 40_000)

  it('a task alone in its folder stays in the folder (no work tree is made)', async () => {
    const w = join(dir, 'solo')
    mkdirSync(w, { recursive: true })
    writeFileSync(join(w, 'a.txt'), 'a')
    await initGitFolder(w)
    const cwds: string[] = []
    const runner: Runner = async (_b, o) => (cwds.push(o.cwd), { code: 0, stdout: '[[DID: ok]]', stderr: '', timedOut: false, aborted: false })
    const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), parallelWorktrees: true, humanReview: 'off' })
    const a = eng.saveAgent({ name: '가', adapter: 'claude', workDir: w, modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    const t = eng.createTask({ title: '혼자', assignee: a.id })
    await eng.runTask(t.id)
    expect(cwds).toEqual([w])
    expect(eng.hive.getTask(t.id)!.worktree).toBeUndefined()
    eng.shutdown()
  })
})

describe('C4: a project folder inside a repository gets work trees too', () => {
  it('the checkout is the whole repository, the task works in the same sub-folder of it, and the result merges back', async () => {
    const repo = join(dir, 'mono')
    mkdirSync(join(repo, 'server'), { recursive: true })
    mkdirSync(join(repo, 'web'), { recursive: true })
    writeFileSync(join(repo, 'server', 'a.txt'), 'a')
    writeFileSync(join(repo, 'web', 'w.txt'), 'w')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    const server = join(repo, 'server')
    const wt = (await addWorktree(server, 't1'))!
    expect(wt).not.toBeNull()
    expect(wt.sub).toBe('server')
    expect(worktreeCwd(wt)).toBe(join(wt.path, 'server'))
    expect(existsSync(join(worktreeCwd(wt), 'a.txt'))).toBe(true)
    // the work tree lives inside the sub-folder and stays out of the project's own status
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
    writeFileSync(join(worktreeCwd(wt), 'new.txt'), 'n')
    expect(await commitWorktree(wt, '서버 일')).toBe(true)
    expect((await mergeWorktree(wt, '서버 일')).ok).toBe(true)
    expect(readFileSync(join(server, 'new.txt'), 'utf8')).toBe('n')
    await removeWorktree(wt)
    expect(existsSync(wt.path)).toBe(false)
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
  })

  it('installed packages of the sub-folder are linked at the right place and never saved', async () => {
    const repo = join(dir, 'mono2')
    mkdirSync(join(repo, 'server', 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(repo, 'server', 'node_modules', 'dep', 'index.js'), 'module.exports = 1')
    writeFileSync(join(repo, 'server', 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }))
    writeFileSync(join(repo, 'server', 't.js'), 'require("dep")')
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.hive-worktrees/\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    const server = join(repo, 'server')
    const wt = (await addWorktree(server, 't2'))!
    expect(lstatSync(join(worktreeCwd(wt), 'node_modules')).isSymbolicLink()).toBe(true)
    const run = await runChecks(worktreeCwd(wt), { app: false, shotDir: dir, shotName: 'x' })
    expect(run.items.map((i) => [i.name, i.ok])).toEqual([['test', true]])
    await removeWorktree(wt)
    expect(existsSync(join(server, 'node_modules', 'dep', 'index.js'))).toBe(true)
  })

  it('two tasks of the same sub-folder run apart and both land', async () => {
    const repo = join(dir, 'mono3')
    mkdirSync(join(repo, 'server'), { recursive: true })
    writeFileSync(join(repo, 'server', 'a.txt'), 'a')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    const server = join(repo, 'server')
    const w1 = (await addWorktree(server, 'x1'))!
    const w2 = (await addWorktree(server, 'x2'))!
    writeFileSync(join(worktreeCwd(w1), 'one.txt'), '1')
    writeFileSync(join(worktreeCwd(w2), 'two.txt'), '2')
    await commitWorktree(w1, '1')
    await commitWorktree(w2, '2')
    expect((await mergeWorktree(w1, '1')).ok).toBe(true)
    expect((await mergeWorktree(w2, '2')).ok).toBe(true)
    expect(existsSync(join(server, 'one.txt')) && existsSync(join(server, 'two.txt'))).toBe(true)
  })
})
