import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, posix, win32 } from 'node:path'

/**
 * Apps opened from the Dock/Finder (and terminals whose profile was not reloaded
 * after installing a CLI) do not see the folders where AI CLIs usually live.
 * Build a PATH that includes the login shell's PATH plus the common install
 * folders, so `claude`, `codex`, `agy` and `node` are found either way.
 */
export function candidateDirs(home: string, platform: NodeJS.Platform): string[] {
  const join = platform === 'win32' ? win32.join : posix.join
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [join(appData, 'npm'), join(home, '.local', 'bin'), join(home, '.npm-global')]
  }
  const dirs = [
    join(home, '.local', 'bin'), // Claude Code & Antigravity native installers
    join(home, '.npm-global', 'bin'), // npm --prefix ~/.npm-global
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ]
  // nvm: newest installed node version first
  const nvm = join(home, '.nvm', 'versions', 'node')
  try {
    const versions = readdirSync(nvm).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true })
    )
    dirs.push(...versions.map((v) => join(nvm, v, 'bin')))
  } catch {
    /* no nvm */
  }
  return dirs
}

export function mergePath(parts: (string | undefined)[], exists: (p: string) => boolean): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    if (!part) continue
    for (const dir of part.split(delimiter)) {
      const d = dir.trim()
      if (!d || seen.has(d)) continue
      seen.add(d)
      if (exists(d)) out.push(d)
    }
  }
  return out.join(delimiter)
}

function loginShellPath(): string | undefined {
  if (process.platform === 'win32') return undefined
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__HD__%s__HD__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.match(/__HD__(.*)__HD__/s)?.[1]
  } catch {
    return undefined
  }
}

/** Call once at startup, before anything spawns a CLI. */
export function fixPath(): void {
  const home = homedir()
  process.env.PATH = mergePath(
    [process.env.PATH, loginShellPath(), candidateDirs(home, process.platform).join(delimiter)],
    existsSync
  )
}
