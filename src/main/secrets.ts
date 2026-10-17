import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Names that usually hold passwords or keys. `.env.example` and friends are deliberately not listed. */
const EXACT = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.staging',
  '.env.test',
  'credentials.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  '.npmrc',
  '.pypirc',
  '.netrc'
])
const PATTERNS = [/\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.keystore$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i]

export function looksSecret(name: string): boolean {
  if (/\.(example|sample|template|dist)$/i.test(name)) return false
  return EXACT.has(name.toLowerCase()) || PATTERNS.some((r) => r.test(name))
}

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'Library', 'Temp', 'obj', 'target', '.next'])

/** Look for secret-looking files in a work folder (a few levels deep; stops early in huge folders). */
export function findSecrets(root: string, maxDepth = 4, maxEntries = 20_000): string[] {
  const found: string[] = []
  let seen = 0
  const walk = (dir: string, rel: string, depth: number): void => {
    if (seen > maxEntries) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (++seen > maxEntries) return
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      const r = rel ? `${rel}/${name}` : name
      if (st.isDirectory()) {
        if (depth < maxDepth && !SKIP.has(name)) walk(full, r, depth + 1)
      } else if (looksSecret(name)) found.push(r)
    }
  }
  walk(root, '', 0)
  return found
}

/** Claude Code deny rules that keep the file-reading tool away from secret files. */
export const SECRET_READ_RULES = [
  'Read(**/.env)',
  'Read(**/.env.local)',
  'Read(**/.env.development)',
  'Read(**/.env.production)',
  'Read(**/.env.staging)',
  'Read(**/*.pem)',
  'Read(**/*.key)',
  'Read(**/*.p12)',
  'Read(**/*.pfx)',
  'Read(**/id_rsa*)',
  'Read(**/id_ed25519*)'
]
