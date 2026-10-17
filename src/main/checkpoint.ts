import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Checkpoint, RunDiff } from '../shared/types'
import { diffScans, diffTrees, FileStamp, git, scanFolder, snapshotTree, unavailable, type TrackSource } from './gitdiff'
import type { Hive } from './hive'

/** Backing up a folder that is not a git repo has to stay cheap. */
export const BACKUP_MAX_FILES = 5000
export const BACKUP_MAX_BYTES = 100 * 1024 * 1024
/** Older file backups beyond this many are deleted (git checkpoints are tiny and stay). */
const KEEP_BACKUPS = 8

const IDENT = {
  GIT_AUTHOR_NAME: 'HiveDesk',
  GIT_AUTHOR_EMAIL: 'hivedesk@localhost',
  GIT_COMMITTER_NAME: 'HiveDesk',
  GIT_COMMITTER_EMAIL: 'hivedesk@localhost'
}

export interface CheckpointResult {
  checkpoint?: Checkpoint
  /** Why there is none (shown to the human). */
  note?: string
}

/**
 * Save the state of the work folder before a run so the run can be undone.
 * Git repo: a commit of the whole tree kept under a hidden ref (never touches branches, the index
 * or the working files). Otherwise: a copy of the files, if the folder is small enough.
 */
export async function createCheckpoint(hive: Hive, runId: string, source?: TrackSource): Promise<CheckpointResult> {
  if (!source) return { note: '이 폴더는 상태를 저장할 수 없어서 되돌리기를 쓸 수 없어요.' }
  try {
    if (source.kind === 'git') {
      const c = await git(
        source.toplevel,
        ['commit-tree', source.tree, '-m', `HiveDesk checkpoint before run ${runId}`],
        IDENT
      )
      const sha = c.out.trim()
      if (!c.ok || !sha) return { note: '실행 전 상태를 저장하지 못했어요: ' + (c.err || 'commit-tree 실패') }
      const ref = `refs/hivedesk/${runId}`
      const u = await git(source.toplevel, ['update-ref', ref, sha])
      if (!u.ok) return { note: '실행 전 상태를 저장하지 못했어요: ' + u.err }
      return { checkpoint: { kind: 'git', ref, tree: source.tree, root: source.toplevel } }
    }
    // not a git repo: back up the files (within limits)
    let bytes = 0
    for (const st of source.files.values()) bytes += st.size
    if (source.files.size > BACKUP_MAX_FILES || bytes > BACKUP_MAX_BYTES) {
      return {
        note: `폴더가 커서(${source.files.size}개 파일, ${(bytes / 1024 / 1024).toFixed(0)}MB) 되돌리기용 백업을 만들지 않았어요. "변경 추적 켜기"로 git 저장소로 만들면 되돌리기를 쓸 수 있어요.`
      }
    }
    const base = hive.checkpointDir(runId)
    const files = join(base, 'files')
    for (const rel of source.files.keys()) {
      const to = join(files, rel)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(join(source.root, rel), to)
    }
    writeFileSync(join(base, 'manifest.json'), JSON.stringify([...source.files]), 'utf8')
    prune(hive, runId)
    return {
      checkpoint: {
        kind: 'copy',
        root: source.root,
        dir: join('.local', 'checkpoints', runId).split('\\').join('/'),
        files: source.files.size,
        bytes
      }
    }
  } catch (e) {
    return { note: '실행 전 상태를 저장하지 못했어요: ' + (e as Error).message }
  }
}

function prune(hive: Hive, keep: string): void {
  try {
    const root = join(hive.root, '.local', 'checkpoints')
    const dirs = readdirSync(root)
      .map((n) => ({ n, t: statSync(join(root, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const d of dirs.slice(KEEP_BACKUPS)) if (d.n !== keep) rmSync(join(root, d.n), { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/** What changed in the folder since the checkpoint (used for runs that were cut off). */
export async function diffSinceCheckpoint(hive: Hive, cp: Checkpoint, exclude: string[] = []): Promise<RunDiff> {
  try {
    if (cp.kind === 'git') {
      const now = await snapshotTree(cp.root, exclude)
      if (typeof now !== 'string') return unavailable('지금 상태를 저장하지 못했어요: ' + now.error)
      return await diffTrees(cp.root, cp.tree!, now)
    }
    const before = readManifest(hive, cp)
    const after = scanFolder(cp.root, exclude)
    if (!before || !after) return unavailable('변경 내용을 비교하지 못했어요.')
    return diffScans(before, after, cp.root)
  } catch (e) {
    return unavailable('변경 내용을 비교하지 못했어요: ' + (e as Error).message)
  }
}

function readManifest(hive: Hive, cp: Checkpoint): Map<string, FileStamp> | null {
  try {
    const raw = JSON.parse(readFileSync(join(hive.root, cp.dir!, 'manifest.json'), 'utf8')) as [string, FileStamp][]
    return new Map(raw)
  } catch {
    return null
  }
}

export interface RollbackResult {
  ok: boolean
  message: string
  restored: number
  removed: number
}

/** Put the folder back as it was at the checkpoint. Files the agent created are deleted, the rest restored. */
export async function rollback(hive: Hive, cp: Checkpoint, exclude: string[] = []): Promise<RollbackResult> {
  const fail = (message: string): RollbackResult => ({ ok: false, message, restored: 0, removed: 0 })
  try {
    if (cp.kind === 'git') return await rollbackGit(cp, exclude)
    const before = readManifest(hive, cp)
    const after = scanFolder(cp.root, exclude)
    if (!before || !after) return fail('되돌릴 정보를 읽지 못했어요.')
    let restored = 0
    let removed = 0
    for (const rel of after.keys()) {
      if (!before.has(rel)) {
        rmSync(join(cp.root, rel), { force: true })
        removed++
      }
    }
    for (const [rel, st] of before) {
      const now = after.get(rel)
      if (now && now.size === st.size && now.mtimeMs === st.mtimeMs) continue
      const from = join(hive.root, cp.dir!, 'files', rel)
      if (!existsSync(from)) continue
      const to = join(cp.root, rel)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      try {
        utimesSync(to, st.mtimeMs / 1000, st.mtimeMs / 1000)
      } catch {
        /* mtime is cosmetic */
      }
      restored++
    }
    return { ok: true, message: msg(restored, removed), restored, removed }
  } catch (e) {
    return fail('되돌리지 못했어요: ' + (e as Error).message)
  }
}

function msg(restored: number, removed: number): string {
  return restored + removed === 0
    ? '되돌릴 변경이 없었어요.'
    : `되돌렸어요: 복원 ${restored}개, 새로 만들어진 파일 삭제 ${removed}개.`
}

async function rollbackGit(cp: Checkpoint, exclude: string[]): Promise<RollbackResult> {
  const root = cp.root
  const now = await snapshotTree(root, exclude)
  if (typeof now !== 'string') return { ok: false, message: '지금 상태를 읽지 못했어요: ' + now.error, restored: 0, removed: 0 }
  // Keep the pre-undo state too, so the undo itself can be undone by hand (`git log refs/hivedesk/...`).
  const safety = await git(root, ['commit-tree', now, '-m', 'HiveDesk state before undo'], IDENT)
  if (safety.ok && safety.out.trim()) {
    await git(root, ['update-ref', `refs/hivedesk/before-undo-${Date.now().toString(36)}`, safety.out.trim()])
  }
  const d = await git(root, ['diff-tree', '-r', '--no-renames', '--name-status', '-z', cp.tree!, now])
  if (!d.ok) return { ok: false, message: 'git diff-tree 실패: ' + d.err, restored: 0, removed: 0 }
  const toks = d.out.split('\0').filter((x) => x !== '')
  const add: string[] = []
  const back: string[] = []
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const st = toks[i][0]
    const path = toks[i + 1]
    if (st === 'A') add.push(path)
    else back.push(path)
  }
  let restored = 0
  if (back.length) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hivedesk-undo-'))
    try {
      const env = { GIT_INDEX_FILE: join(tmpDir, 'index') }
      const rt = await git(root, ['read-tree', cp.tree!], env)
      if (!rt.ok) return { ok: false, message: 'git read-tree 실패: ' + rt.err, restored: 0, removed: 0 }
      await new Promise<void>((resolve, reject) => {
        const p = spawn('git', ['checkout-index', '-f', '-z', '--stdin'], {
          cwd: root,
          env: { ...process.env, ...env },
          windowsHide: true
        })
        let err = ''
        p.stderr.on('data', (c) => (err += c))
        p.on('error', reject)
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || 'checkout-index 실패'))))
        p.stdin.end(back.join('\0') + '\0')
      })
      restored = back.length
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }
  let removed = 0
  for (const rel of add) {
    rmSync(join(root, rel), { force: true })
    removed++
    // remove folders the agent created and that are now empty
    let dir = dirname(join(root, rel))
    while (dir.length > root.length) {
      try {
        if (readdirSync(dir).length) break
        rmdirSync(dir)
      } catch {
        break
      }
      dir = dirname(dir)
    }
  }
  return { ok: true, message: msg(restored, removed), restored, removed }
}
