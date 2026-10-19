import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './gitdiff'

export const WORKTREE_DIR = '.hive-worktrees'

export interface Worktree {
  path: string
  branch: string
  /** The folder the work tree was made from (the project / work folder). */
  base: string
}

const ENV = { GIT_AUTHOR_NAME: 'HiveDesk', GIT_AUTHOR_EMAIL: 'hivedesk@localhost', GIT_COMMITTER_NAME: 'HiveDesk', GIT_COMMITTER_EMAIL: 'hivedesk@localhost' }

/** Is `dir` the top of a git repository with at least one commit? (Only then a work tree can be made from it.) */
export async function canBranchFrom(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return false
  try {
    // native: Windows short names (C:\Users\RUNNER~1) and git's long, forward-slash path must compare equal
    const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
    if (!same(realpathSync.native(top.out.trim()), realpathSync.native(dir))) return false
  } catch {
    return false
  }
  return (await git(dir, ['rev-parse', '--verify', 'HEAD'])).ok
}

export type GitState = 'ok' | 'none' | 'not-top' | 'no-commit'

/** What is missing before work trees can be made from `dir`. */
export async function gitState(dir: string): Promise<GitState> {
  if (!existsSync(dir)) return 'none'
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return 'none'
  if (!(await canBranchFrom(dir))) {
    // a repository, but `dir` is not its top (a sub-folder), or it has no commit yet
    try {
      const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
      if (!same(realpathSync.native(top.out.trim()), realpathSync.native(dir))) return 'not-top'
    } catch {
      return 'not-top'
    }
    return 'no-commit'
  }
  return 'ok'
}

/** More files than this: the first commit would be huge, so nothing is made (the person should add a .gitignore first). */
export const INIT_MAX_FILES = 20000

const IGNORE = ['node_modules/', 'dist/', 'out/', 'build/', '.venv/', '__pycache__/', '.DS_Store', WORKTREE_DIR + '/']

/**
 * Make `dir` a git folder with its current files as the first record (the person agreed to it).
 * A `.gitignore` is added when there is none, so installed packages are not saved.
 */
export async function initGitFolder(dir: string): Promise<{ ok: boolean; message: string }> {
  const state = await gitState(dir)
  if (state === 'ok') return { ok: true, message: '이미 git 폴더예요.' }
  if (state === 'not-top') return { ok: false, message: '이 폴더는 다른 git 폴더 안에 있어요. 그 맨 위 폴더를 작업 폴더로 지정해 주세요.' }
  const created = state === 'none'
  if (created) {
    const r = await git(dir, ['init', '-q', '-b', 'main'])
    if (!r.ok) return { ok: false, message: 'git을 실행할 수 없어요. git이 설치돼 있는지 확인해 주세요.' }
  }
  try {
    const f = join(dir, '.gitignore')
    if (!existsSync(f)) writeFileSync(f, IGNORE.join('\n') + '\n')
  } catch {
    /* without it the first record may include more files */
  }
  const count = await git(dir, ['ls-files', '-o', '--exclude-standard'])
  const n = count.ok ? count.out.split('\n').filter(Boolean).length : 0
  if (n > INIT_MAX_FILES) {
    if (created) rmSync(join(dir, '.git'), { recursive: true, force: true })
    return { ok: false, message: `파일이 ${n}개나 돼서 첫 기록을 만들지 않았어요. 불필요한 폴더를 .gitignore에 적은 뒤 다시 해 주세요.` }
  }
  await git(dir, ['add', '-A'], ENV)
  const c = await git(dir, ['commit', '-q', '--allow-empty', '-m', 'HiveDesk: 시작 상태'], ENV)
  if (!c.ok) return { ok: false, message: 'git 기록을 만들지 못했어요: ' + c.err.split('\n')[0] }
  return { ok: true, message: `git 폴더로 만들었어요 (파일 ${n}개를 첫 기록으로 저장).` }
}

/** A separate folder + branch for one task, so tasks of the same project can run at the same time. */
export async function addWorktree(base: string, taskId: string, branch = `hive/${taskId}`): Promise<Worktree | null> {
  if (!(await canBranchFrom(base))) return null
  const path = join(base, WORKTREE_DIR, taskId)
  if (existsSync(path)) return { path, branch, base }
  mkdirSync(join(base, WORKTREE_DIR), { recursive: true })
  // keep the folder out of the project's own `git status`
  const ex = await git(base, ['rev-parse', '--git-path', 'info/exclude'])
  if (ex.ok) {
    const f = join(base, ex.out.trim())
    try {
      const cur = existsSync(f) ? readFileSync(f, 'utf8') : ''
      if (!cur.split(/\r?\n/).includes(WORKTREE_DIR + '/')) appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + WORKTREE_DIR + '/\n')
    } catch {
      /* the exclude file is a nicety */
    }
  }
  const r = await git(base, ['worktree', 'add', '-q', '-b', branch, path, 'HEAD'])
  if (!r.ok) return null
  await linkPackages(base, path)
  return { path, branch, base }
}

/**
 * The installed packages are not in git, so a work tree starts without them. Linking the project's own `node_modules`
 * lets the tests / type check / app check run in the work tree too. The link is kept out of git (`/node_modules`
 * in the shared exclude file), so it is never saved on the task's branch or merged into the project.
 */
async function linkPackages(base: string, path: string): Promise<void> {
  const from = join(base, 'node_modules')
  const to = join(path, 'node_modules')
  try {
    if (!existsSync(from) || existsSync(to) || !existsSync(join(base, 'package.json'))) return
    const ex = await git(base, ['rev-parse', '--git-path', 'info/exclude'])
    if (ex.ok) {
      const f = join(base, ex.out.trim())
      const cur = existsSync(f) ? readFileSync(f, 'utf8') : ''
      if (!cur.split(/\r?\n/).includes('/node_modules')) appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '/node_modules\n')
    }
    // a junction needs no special right on Windows
    symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    /* without the link the checks of this task are skipped, nothing else changes */
  }
}

/** Take the link away first, so removing the work tree can never reach into the project's real packages. */
function unlinkPackages(path: string): void {
  const link = join(path, 'node_modules')
  try {
    if (!lstatSync(link).isSymbolicLink()) return
    if (process.platform === 'win32') rmdirSync(link)
    else unlinkSync(link)
  } catch {
    /* nothing linked */
  }
}

/** Save what the AI changed in the work tree on its branch (so it can be merged, and survives a crash). */
export async function commitWorktree(wt: Worktree, message: string): Promise<boolean> {
  await git(wt.path, ['add', '-A'])
  const status = await git(wt.path, ['status', '--porcelain'])
  if (!status.out.trim()) return false
  return (await git(wt.path, ['commit', '-q', '-m', message], ENV)).ok
}

export interface MergeResult {
  ok: boolean
  /** Files that clash, or the reason the merge could not even start. */
  files: string[]
  message: string
}

/** Merge a task's branch into the folder it came from. A clash is undone (nothing half-merged is left behind). */
export async function mergeWorktree(wt: Worktree, title: string): Promise<MergeResult> {
  return mergeBranchInto(wt.base, wt.branch, title)
}

/** Merge `branch` into whatever is checked out in `dir` (the project folder, or a bundle's own work folder). */
export async function mergeBranchInto(dir: string, branch: string, title: string): Promise<MergeResult> {
  const ahead = await git(dir, ['rev-list', '--count', `HEAD..${branch}`])
  if (ahead.ok && ahead.out.trim() === '0') return { ok: true, files: [], message: '바뀐 것이 없어요.' }
  const r = await git(dir, ['merge', '--no-ff', '-m', `HiveDesk: ${title}`, branch], ENV)
  if (r.ok) return { ok: true, files: [], message: '합쳤어요.' }
  const conflicts = await git(dir, ['diff', '--name-only', '--diff-filter=U'])
  await git(dir, ['merge', '--abort'])
  const files = conflicts.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return { ok: false, files, message: files.length ? `같은 파일을 서로 다르게 고쳤어요: ${files.join(', ')}` : r.err.split('\n')[0] || '합치지 못했어요.' }
}

export async function removeWorktree(wt: Worktree): Promise<void> {
  unlinkPackages(wt.path)
  await git(wt.base, ['worktree', 'remove', '--force', wt.path])
  await git(wt.base, ['branch', '-D', wt.branch])
}
