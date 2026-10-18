import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { addWorktree, commitWorktree, gitState, initGitFolder, mergeWorktree, removeWorktree } from '../src/main/worktree'
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

  it('an empty repository (no commit) gets its first record; a sub-folder of a repository is refused', async () => {
    const w = join(dir, 'e')
    mkdirSync(w)
    git(w, 'init', '-q', '-b', 'main')
    writeFileSync(join(w, 'a.txt'), 'a')
    expect(await gitState(w)).toBe('no-commit')
    expect((await initGitFolder(w)).ok).toBe(true)
    expect(await gitState(w)).toBe('ok')
    const sub = join(w, 'server')
    mkdirSync(sub)
    expect(await gitState(sub)).toBe('not-top')
    const r = await initGitFolder(sub)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('맨 위 폴더')
    expect(existsSync(join(sub, '.git'))).toBe(false)
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
  it('single tasks are told how it works; sub-tasks in a plain folder are offered git', async () => {
    const { eng, a } = setup()
    const solo = eng.createTask({ title: '단독', assignee: a.id })
    expect((await eng.parallelAdvice(solo.id)).state).toBe('single')
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

  it('a git folder with the switch off only needs the switch; a sub-folder cannot be fixed', async () => {
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
    expect(adv.state).toBe('not-top')
    expect((await eng.enableParallel(t2.id)).ok).toBe(false)
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
