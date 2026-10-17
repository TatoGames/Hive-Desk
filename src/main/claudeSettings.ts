import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface Found {
  file: string
  allow: number
  defaultMode?: string
}

function read(file: string): Found | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { permissions?: { allow?: unknown[]; defaultMode?: string } }
    const allow = Array.isArray(j.permissions?.allow) ? j.permissions!.allow!.length : 0
    const defaultMode = j.permissions?.defaultMode
    return allow || defaultMode ? { file, allow, defaultMode } : null
  } catch {
    return null
  }
}

/**
 * Claude Code merges the person's own settings with what HiveDesk passes on the command line.
 * Deny rules always win, but allow rules can let it do more than the permission level suggests:
 * list where such rules live so the pre-run check can say so.
 */
export function personalClaudeRules(workDir: string, home: string): string[] {
  const files = [
    join(home, '.claude', 'settings.json'),
    join(workDir, '.claude', 'settings.json'),
    join(workDir, '.claude', 'settings.local.json')
  ]
  const out: string[] = []
  for (const f of files) {
    const r = read(f)
    if (!r) continue
    const parts: string[] = []
    if (r.allow) parts.push(`허용 규칙 ${r.allow}개`)
    if (r.defaultMode) parts.push(`기본 모드 ${r.defaultMode}`)
    out.push(`${f} (${parts.join(', ')})`)
  }
  return out
}
