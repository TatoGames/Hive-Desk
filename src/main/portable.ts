import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'

/** Portable mode: the data lives in HiveDesk-data next to the app, nothing is written to the system app data. */
export const PORTABLE_FLAG = 'portable.flag'
export const PORTABLE_DATA = 'HiveDesk-data'

export interface PortableInput {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** process.execPath */
  execPath: string
  exists?: (p: string) => boolean
  /** true if <dir> can be created and written to. Injected so tests need no real read-only media. */
  canWrite?: (dir: string) => boolean
}

export interface PortableResult {
  portable: boolean
  /** The folder the app (or the .app bundle, or the portable exe) sits in. */
  baseDir: string
  /** <baseDir>/HiveDesk-data: used as the one-folder homeDir when portable. */
  homeDir: string | null
  reason: 'env' | 'flag' | 'data-folder' | 'none' | 'read-only'
  /** Korean message when portable was intended but the folder cannot be written (the app falls back to normal mode). */
  warning?: string
}

/** Folder that holds the app: for a macOS bundle the folder holding the .app (not Contents/MacOS), else the exe's folder. */
export function appBaseDir(execPath: string, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? win32 : posix
  if (platform === 'darwin') {
    const parts = execPath.split('/')
    const i = parts.findIndex((s) => s.toLowerCase().endsWith('.app'))
    if (i > 0) return parts.slice(0, i).join('/') || '/'
  }
  return p.dirname(execPath)
}

/** Writes and removes a probe file; creates the folder if needed. Never throws. */
export function canWriteDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.write-test-${process.pid}`)
    writeFileSync(probe, 'x')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Order: (1) PORTABLE_EXECUTABLE_DIR (Windows portable exe: it unpacks to a temp folder, so execPath is not where the exe was;
 * the variable is the exe's real folder and also proves this is the portable build), (2) portable.flag next to the app,
 * (3) an existing HiveDesk-data folder next to the app. Anything else is the normal mode.
 */
export function detectPortable(input: PortableInput): PortableResult {
  const exists = input.exists ?? existsSync
  const canWrite = input.canWrite ?? canWriteDir
  const envDir = input.platform === 'win32' ? input.env.PORTABLE_EXECUTABLE_DIR?.trim() : undefined
  const baseDir = envDir || appBaseDir(input.execPath, input.platform)
  const sep = input.platform === 'win32' ? win32 : posix
  let reason: PortableResult['reason'] = 'none'
  if (envDir) reason = 'env'
  else if (exists(sep.join(baseDir, PORTABLE_FLAG))) reason = 'flag'
  else if (exists(sep.join(baseDir, PORTABLE_DATA))) reason = 'data-folder'
  if (reason === 'none') return { portable: false, baseDir, homeDir: null, reason }
  const homeDir = sep.join(baseDir, PORTABLE_DATA)
  if (!canWrite(homeDir)) {
    return {
      portable: false,
      baseDir,
      homeDir: null,
      reason: 'read-only',
      warning: `휴대용 폴더에 쓸 수 없어요(${baseDir}). 읽기 전용 USB이거나 권한이 없을 수 있어요. 이번에는 일반 모드로 시작하고, 데이터는 이 컴퓨터의 앱 데이터 폴더에 저장돼요.`
    }
  }
  return { portable: true, baseDir, homeDir, reason }
}

export const portableNotice = (homeDir: string): string => `휴대용 모드예요: 데이터는 ${homeDir}에만 있어요`

