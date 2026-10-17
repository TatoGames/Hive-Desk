import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DiffFile, RunDiff } from '../shared/types'
import { SHARED_DIRS } from './hive'

export const PATCH_LIMIT = 200_000
const MAX_FILES = 1000

interface GitOut {
  ok: boolean
  out: string
  err: string
  /** stdout was cut because it exceeded the buffer */
  overflow: boolean
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, timeout = 60_000): Promise<GitOut> {
  return new Promise((done) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
        windowsHide: true
      },
      (e, stdout, stderr) => {
        const overflow = (e as NodeJS.ErrnoException | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        done({
          ok: !e || overflow,
          out: String(stdout),
          err: String(stderr).trim() || (e && !overflow ? e.message : ''),
          overflow
        })
      }
    )
  })
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let r: string
    try {
      r = realpathSync(p)
    } catch {
      r = resolve(p)
    }
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

export function unavailable(reason: string): RunDiff {
  return { available: false, reason, files: [], patch: '', truncated: false }
}

/**
 * Writes the whole working tree (tracked + untracked, respecting .gitignore) into a git tree
 * object using a throw-away index, so the user's real index and working files are never touched.
 */
async function snapshotTree(toplevel: string, exclude: string[]): Promise<string | { error: string }> {
  const gd = await git(toplevel, ['rev-parse', '--absolute-git-dir'])
  if (!gd.ok) return { error: gd.err || 'git 폴더를 찾지 못했어요.' }
  const gitDir = gd.out.trim()
  const tmp = mkdtempSync(join(tmpdir(), 'hivedesk-idx-'))
  try {
    const index = join(tmp, 'index')
    const real = join(gitDir, 'index')
    if (existsSync(real)) copyFileSync(real, index) // reuse stat cache so unchanged files are not re-hashed
    const env = { GIT_INDEX_FILE: index }
    const add = await git(toplevel, ['add', '-A', '--', '.', ...exclude.map((e) => `:(exclude)${e}`)], env)
    if (!add.ok) return { error: add.err || 'git add 실패' }
    const wt = await git(toplevel, ['write-tree'], env)
    if (!wt.ok) return { error: wt.err || 'git write-tree 실패' }
    return wt.out.trim()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export interface ChangeTracker {
  /** Compare the folder now with how it was when tracking started. Never throws. */
  finish(): Promise<RunDiff>
}

/**
 * Start watching a work folder. If it is inside a git repo, `finish()` reports exactly what
 * changed since this call — even if the folder already had uncommitted changes.
 * `hiveRoot`: when the work folder IS the hive workspace, the hive's own data files are ignored.
 */
export async function trackChanges(cwd: string, opts: { hiveRoot?: string } = {}): Promise<ChangeTracker> {
  const fail = (reason: string): ChangeTracker => ({ finish: async () => unavailable(reason) })
  try {
    const top = await git(cwd, ['rev-parse', '--show-toplevel'])
    if (!top.ok) return fail('작업 폴더가 git 저장소가 아니라서 변경 내용을 비교할 수 없어요.')
    const toplevel = top.out.trim()
    // `.local/` is already in the hive's own .gitignore; naming an ignored path makes `git add` fail.
    const exclude = opts.hiveRoot && samePath(toplevel, opts.hiveRoot) ? [...SHARED_DIRS] : []
    const before = await snapshotTree(toplevel, exclude)
    if (typeof before !== 'string') return fail('실행 전 상태를 저장하지 못했어요: ' + before.error)
    return {
      finish: async () => {
        try {
          const after = await snapshotTree(toplevel, exclude)
          if (typeof after !== 'string') return unavailable('실행 후 상태를 저장하지 못했어요: ' + after.error)
          return await diffTrees(toplevel, before, after)
        } catch (e) {
          return unavailable('변경 내용을 비교하지 못했어요: ' + (e as Error).message)
        }
      }
    }
  } catch (e) {
    return fail('변경 추적을 시작하지 못했어요: ' + (e as Error).message)
  }
}

export async function diffTrees(toplevel: string, before: string, after: string): Promise<RunDiff> {
  if (before === after) return { available: true, files: [], patch: '', truncated: false }
  const base = ['diff', '--no-color', '--no-ext-diff', '--no-renames']
  const [num, st, patch] = await Promise.all([
    git(toplevel, [...base, '--numstat', before, after]),
    git(toplevel, [...base, '--name-status', before, after]),
    git(toplevel, [...base, before, after])
  ])
  if (!num.ok || !st.ok) return unavailable('git diff 실패: ' + (num.err || st.err))

  const status = new Map<string, string>()
  for (const line of st.out.split('\n')) {
    const m = line.match(/^([A-Z])\d*\t(.+)$/)
    if (m) status.set(m[2], m[1])
  }
  const files: DiffFile[] = []
  for (const line of num.out.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue
    const binary = m[1] === '-'
    files.push({
      path: m[3],
      status: status.get(m[3]) ?? 'M',
      additions: binary ? 0 : Number(m[1]),
      deletions: binary ? 0 : Number(m[2]),
      binary
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const text = patch.ok ? patch.out : ''
  const truncated = patch.overflow || text.length > PATCH_LIMIT || files.length > MAX_FILES
  return {
    available: true,
    files: files.slice(0, MAX_FILES),
    patch: text.slice(0, PATCH_LIMIT),
    truncated
  }
}

export function diffStat(d: RunDiff): { available: boolean; files: number; additions: number; deletions: number } {
  return {
    available: d.available,
    files: d.files.length,
    additions: d.files.reduce((n, f) => n + f.additions, 0),
    deletions: d.files.reduce((n, f) => n + f.deletions, 0)
  }
}
