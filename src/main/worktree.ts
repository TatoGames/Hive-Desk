import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
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

/** A separate folder + branch for one task, so tasks of the same project can run at the same time. */
export async function addWorktree(base: string, taskId: string): Promise<Worktree | null> {
  if (!(await canBranchFrom(base))) return null
  const path = join(base, WORKTREE_DIR, taskId)
  const branch = `hive/${taskId}`
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
  return r.ok ? { path, branch, base } : null
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
  const ahead = await git(wt.base, ['rev-list', '--count', `HEAD..${wt.branch}`])
  if (ahead.ok && ahead.out.trim() === '0') return { ok: true, files: [], message: '바뀐 것이 없어요.' }
  const r = await git(wt.base, ['merge', '--no-ff', '-m', `HiveDesk: ${title}`, wt.branch], ENV)
  if (r.ok) return { ok: true, files: [], message: '합쳤어요.' }
  const conflicts = await git(wt.base, ['diff', '--name-only', '--diff-filter=U'])
  await git(wt.base, ['merge', '--abort'])
  const files = conflicts.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return { ok: false, files, message: files.length ? `같은 파일을 서로 다르게 고쳤어요: ${files.join(', ')}` : r.err.split('\n')[0] || '합치지 못했어요.' }
}

export async function removeWorktree(wt: Worktree): Promise<void> {
  await git(wt.base, ['worktree', 'remove', '--force', wt.path])
  await git(wt.base, ['branch', '-D', wt.branch])
}
