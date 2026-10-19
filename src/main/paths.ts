import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** One-folder mode: settings and temp files live under a single HiveDesk folder. Off by default. */
export interface Bootstrap {
  oneFolder: boolean
  homeDir: string
}

/** The only file that stays outside the HiveDesk folder (it must be readable before userData is known). */
export function bootstrapFile(appData: string): string {
  return join(appData, 'HiveDesk-bootstrap.json')
}

export function readBootstrap(file: string): Bootstrap | null {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Bootstrap>
    if (raw.oneFolder === true && typeof raw.homeDir === 'string' && raw.homeDir.trim()) return { oneFolder: true, homeDir: raw.homeDir }
    return null
  } catch {
    return null
  }
}

export function writeBootstrap(file: string, b: Bootstrap): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(b, null, 2) + '\n', 'utf8')
}

export const dataDirOf = (homeDir: string): string => join(homeDir, 'data')
export const tmpDirOf = (homeDir: string): string => join(homeDir, 'tmp')
/** Ollama's program files (one folder per version) and its models. New folders: nothing to migrate, so they are used even when one-folder mode is off. */
export const engineDirOf = (homeDir: string): string => join(homeDir, 'engine', 'ollama')
export const modelsDirOf = (homeDir: string): string => join(homeDir, 'models')
/** The HiveDesk folder when one-folder mode is off. */
export const defaultHomeDir = (userHome: string): string => join(userHome, 'HiveDesk')

/** Where userData should point: the HiveDesk folder's data/ when the mode is on, else Electron's default. */
export function resolveUserData(b: Bootstrap | null, defaultUserData: string): string {
  return b?.oneFolder ? dataDirOf(b.homeDir) : defaultUserData
}

let tempRoot: string | null = null

/** Set once at startup. null (or never called) = the operating system's temp folder. */
export function setTempRoot(dir: string | null): void {
  tempRoot = dir
}

/** A fresh temp folder; inside <home>/tmp in one-folder mode, else os.tmpdir(). */
export function tempDir(prefix: string): string {
  if (tempRoot) {
    try {
      mkdirSync(tempRoot, { recursive: true })
      return mkdtempSync(join(tempRoot, prefix))
    } catch {
      /* an unwritable folder must not break a run: use the system temp */
    }
  }
  return mkdtempSync(join(tmpdir(), prefix))
}

export const MIGRATED_FILES = ['config.json', 'local-models.json']

export interface MigrateResult {
  ok: boolean
  copied: string[]
  skipped: string[]
  /** The old folder, which is left untouched. */
  leftBehind: string
  error?: string
}

/** COPY (never move) the settings files into <home>/data. Verifies each copy; on any failure removes only what it created. */
export function migrateToHome(oldDataDir: string, homeDir: string, files = MIGRATED_FILES): MigrateResult {
  const dest = dataDirOf(homeDir)
  const res: MigrateResult = { ok: false, copied: [], skipped: [], leftBehind: oldDataDir }
  const created: string[] = []
  try {
    mkdirSync(dest, { recursive: true })
    mkdirSync(tmpDirOf(homeDir), { recursive: true })
    for (const f of files) {
      const from = join(oldDataDir, f)
      const to = join(dest, f)
      if (!existsSync(from)) continue
      if (existsSync(to)) {
        res.skipped.push(f) // never overwrite what is already there
        continue
      }
      const part = to + '.part'
      copyFileSync(from, part)
      created.push(part)
      if (statSync(part).size !== statSync(from).size || !readFileSync(part).equals(readFileSync(from))) throw new Error(`${f} 복사본이 원본과 달라요.`)
      renameSync(part, to)
      created.pop()
      created.push(to)
      res.copied.push(f)
    }
    res.ok = true
  } catch (e) {
    for (const p of created) rmSync(p, { force: true })
    res.error = (e as Error).message
  }
  return res
}
