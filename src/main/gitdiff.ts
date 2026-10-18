import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { DiffFile, RunDiff, TrackMode } from '../shared/types'
import { SHARED_DIRS } from './hive'
import { STAGE_DIR } from './staging'

export const PATCH_LIMIT = 200_000
const MAX_FILES = 1000

interface GitOut {
  ok: boolean
  out: string
  err: string
  /** stdout was cut because it exceeded the buffer */
  overflow: boolean
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, timeout = 60_000): Promise<GitOut> {
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

export function normPath(p: string): string {
  let r: string
  try {
    r = realpathSync(p)
  } catch {
    r = resolve(p)
  }
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** Is `child` the same folder as `parent` or inside it? */
export function containsPath(parent: string, child: string): boolean {
  const p = normPath(parent)
  const c = normPath(child)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
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
  return { available: false, lines: false, reason, files: [], patch: '', truncated: false }
}

/**
 * Writes the whole working tree (tracked + untracked, respecting .gitignore) into a git tree
 * object using a throw-away index, so the user's real index and working files are never touched.
 */
export async function snapshotTree(toplevel: string, exclude: string[]): Promise<string | { error: string }> {
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

/** What a tracker saw when it started: enough to build a checkpoint or to compare later. */
export type TrackSource =
  | { kind: 'git'; toplevel: string; tree: string; exclude: string[] }
  | { kind: 'scan'; root: string; files: Map<string, FileStamp>; skip: string[] }

export interface ChangeTracker {
  mode: TrackMode
  source?: TrackSource
  /** Compare the folder now with how it was when tracking started. Never throws; safe to call repeatedly. */
  finish(): Promise<RunDiff>
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  'target',
  'Library',
  'Temp',
  'obj'
])
const SCAN_LIMIT = 20_000

export interface FileStamp {
  size: number
  mtimeMs: number
}

/** Cheap file inventory for folders that are not git repos. Returns null if the folder is too big. */
export function scanFolder(root: string, skipTop: string[] = []): Map<string, FileStamp> | null {
  const out = new Map<string, FileStamp>()
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const full = join(dir, name)
      const rel = full.slice(root.length + 1).split('\\').join('/')
      if (dir === root && skipTop.includes(name)) continue
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(full)
      } else if (st.isFile()) {
        out.set(rel, { size: st.size, mtimeMs: Math.floor(st.mtimeMs) })
        if (out.size > SCAN_LIMIT) return null
      }
    }
  }
  return out
}

export function diffScans(before: Map<string, FileStamp>, after: Map<string, FileStamp>, root = ''): RunDiff {
  const files: DiffFile[] = []
  for (const [path, a] of after) {
    const b = before.get(path)
    if (!b) files.push({ path, status: 'A', additions: 0, deletions: 0, binary: false })
    else if (b.size !== a.size || b.mtimeMs !== a.mtimeMs) {
      files.push({ path, status: 'M', additions: 0, deletions: 0, binary: false })
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) files.push({ path, status: 'D', additions: 0, deletions: 0, binary: false })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    available: true,
    lines: false,
    root,
    reason: '작업 폴더가 git 저장소가 아니라서 바뀐 파일 목록만 보여줘요 (줄 수·내용 비교는 "변경 추적 켜기" 후 가능).',
    files: files.slice(0, MAX_FILES),
    patch: '',
    truncated: files.length > MAX_FILES
  }
}

/**
 * Start watching a work folder. Inside a git repo, `finish()` reports exactly what changed since
 * this call (with line counts and a patch) — even if the folder already had uncommitted changes.
 * Outside git it falls back to a file-list comparison.
 * `hiveRoot`: when the work folder IS the hive workspace, the hive's own data files are ignored.
 */
export async function trackChanges(cwd: string, opts: { hiveRoot?: string } = {}): Promise<ChangeTracker> {
  const fail = (reason: string, mode: TrackMode = 'none'): ChangeTracker => ({
    mode,
    finish: async () => unavailable(reason)
  })
  try {
    const top = await git(cwd, ['rev-parse', '--show-toplevel'])
    if (!top.ok) {
      const hiveHere = !!opts.hiveRoot && samePath(cwd, opts.hiveRoot)
      const skip = hiveHere ? [STAGE_DIR, ...SHARED_DIRS, '.local'] : [STAGE_DIR]
      const before = scanFolder(cwd, skip)
      if (!before) return fail('작업 폴더에 파일이 너무 많아서 변경 내용을 비교하지 않아요 (git 저장소로 만들면 가능해요).')
      return {
        mode: 'scan',
        source: { kind: 'scan', root: cwd, files: before, skip },
        finish: async () => {
          const after = scanFolder(cwd, skip)
          return after ? diffScans(before, after, cwd) : unavailable('변경 내용을 비교하지 못했어요: 파일이 너무 많아요.')
        }
      }
    }
    const toplevel = top.out.trim()
    // `.local/` is already in the hive's own .gitignore; naming an ignored path makes `git add` fail.
    const exclude = [STAGE_DIR, ...(opts.hiveRoot && samePath(toplevel, opts.hiveRoot) ? SHARED_DIRS : [])]
    const before = await snapshotTree(toplevel, exclude)
    if (typeof before !== 'string') return fail('실행 전 상태를 저장하지 못했어요: ' + before.error)
    return {
      mode: 'git',
      source: { kind: 'git', toplevel, tree: before, exclude },
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

/** Turn the work folder into a git repo so changes can be compared line by line. */
export async function enableTracking(cwd: string): Promise<{ ok: boolean; message: string }> {
  const r = await git(cwd, ['init', '-b', 'main'])
  return r.ok
    ? { ok: true, message: '변경 추적을 켰어요 (이 폴더에 git 저장소를 만들었어요).' }
    : { ok: false, message: 'git 저장소를 만들지 못했어요: ' + (r.err || r.out) }
}

export async function isInsideGit(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).ok
}

export async function diffTrees(toplevel: string, before: string, after: string): Promise<RunDiff> {
  if (before === after) return { available: true, lines: true, root: toplevel, files: [], patch: '', truncated: false }
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
    lines: true,
    root: toplevel,
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
