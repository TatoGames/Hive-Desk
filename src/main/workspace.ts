import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { uniqueName } from '../shared/names'

/**
 * Workspace layout (v3): every company is a completely separate folder.
 *
 *   <workspace>/companies/<id>/   one hive per company (tasks, memory, company.json, … and its own git repo)
 *   <workspace>/.local/           this computer's data shared by all companies (usage limits, model lists)
 */
export interface CompanyMeta {
  id: string
  name: string
  createdAt: string
}

export const companiesDir = (ws: string): string => join(ws, 'companies')
/**
 * The folder of a company. Folders carry the company's name (`companies/졸작팀`); older ones are still named
 * by id. The id in `meta.json` is what identifies a company, so both kinds are found.
 */
export function companyDir(ws: string, id: string): string {
  const base = companiesDir(ws)
  const byId = join(base, id)
  if (existsSync(join(byId, 'meta.json'))) return byId
  try {
    for (const d of readdirSync(base)) {
      const m = readMeta(join(base, d))
      if (m && m.id === id) return join(base, d)
    }
  } catch {
    /* no companies folder yet */
  }
  return byId
}

function folderNames(ws: string, except?: string): string[] {
  try {
    return readdirSync(companiesDir(ws)).filter((d) => d !== except)
  } catch {
    return []
  }
}

export function readMeta(dir: string): CompanyMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as CompanyMeta
    return m && typeof m.id === 'string' && m.id ? m : null
  } catch {
    return null
  }
}

export function writeMeta(ws: string, meta: CompanyMeta): void {
  let dir = companyDir(ws, meta.id)
  // a company that has no folder yet gets one named after it
  if (!existsSync(join(dir, 'meta.json')) && !existsSync(dir)) dir = join(companiesDir(ws), uniqueName(meta.name, folderNames(ws)))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
}

/** Give the company's folder the company's new name. Returns the new path, or null when it stays where it is (name unchanged, folder busy). */
export function renameCompanyFolder(ws: string, id: string, name: string): string | null {
  const cur = companyDir(ws, id)
  if (!existsSync(cur)) return null
  const want = uniqueName(name, folderNames(ws, basename(cur)))
  if (want === basename(cur)) return null
  const next = join(companiesDir(ws), want)
  try {
    renameSync(cur, next)
    return next
  } catch {
    return null // open in another program (Windows) or a folder that cannot be moved: keep the old name
  }
}

/** Companies in the order they were created. */
export function listCompanyMetas(ws: string): CompanyMeta[] {
  const dir = companiesDir(ws)
  if (!existsSync(dir)) return []
  const out: CompanyMeta[] = []
  for (const d of readdirSync(dir)) {
    const m = readMeta(join(dir, d))
    if (m) out.push(m)
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** A v0.2 workspace: the hive's folders sit directly in the workspace and there is no `companies/`. */
export function isLegacyLayout(ws: string): boolean {
  if (existsSync(companiesDir(ws))) return false
  return ['tasks', 'company', 'agents', 'approvals', 'memory', 'projects'].some((d) => existsSync(join(ws, d)))
}

export interface MigrationResult {
  companyId: string
  name: string
  backup: string
}

export interface MigrationHooks {
  /** Test hook: called before each top-level entry is moved; throwing simulates a failure half way. */
  beforeMove?: (name: string) => void
}

/**
 * Move a v0.2 workspace into `companies/<id>` as the first company. The whole workspace is copied
 * to a sibling backup folder first; if anything fails while moving, everything moved so far is put
 * back (and the backup stays for the person to look at).
 */
export function migrateLegacy(ws: string, newId: string, hooks: MigrationHooks = {}): MigrationResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(dirname(ws), `${basename(ws)}-backup-v0.2-${stamp}`)
  cpSync(ws, backup, { recursive: true, errorOnExist: true }) // a failure here leaves the workspace untouched
  let name = '내 회사'
  try {
    const c = JSON.parse(readFileSync(join(ws, 'company', 'company.json'), 'utf8')) as { name?: string }
    if (c.name) name = c.name
  } catch {
    /* no company yet */
  }
  const dest = companyDir(ws, newId)
  const moved: string[] = []
  try {
    mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(ws)) {
      if (entry === 'companies') continue
      hooks.beforeMove?.(entry)
      renameSync(join(ws, entry), join(dest, entry))
      moved.push(entry)
    }
    writeMeta(ws, { id: newId, name, createdAt: new Date().toISOString() })
    writeFileSync(
      join(ws, 'migration.json'),
      JSON.stringify({ from: '0.2', at: new Date().toISOString(), backup, companyId: newId }, null, 2) + '\n',
      'utf8'
    )
  } catch (e) {
    for (const entry of moved.reverse()) {
      try {
        renameSync(join(dest, entry), join(ws, entry))
      } catch {
        /* the backup still has it */
      }
    }
    try {
      rmSync(companiesDir(ws), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw new Error(`기존 데이터를 회사 폴더로 옮기지 못해 원래대로 되돌렸어요 (백업: ${backup}): ${(e as Error).message}`)
  }
  return { companyId: newId, name, backup }
}
