import type { AdapterId, PermissionLevel } from './types'

// ---- model catalog ----
export type Tier = 'top' | 'balanced' | 'light'
export const TIER_LABEL: Record<Tier, string> = { top: '최상위', balanced: '균형', light: '경량' }
const TIER_RANK: Record<Tier, number> = { light: 1, balanced: 2, top: 3 }
export const tierRank = (t: Tier): number => TIER_RANK[t]

export interface ModelEntry {
  /** Stable id used by seats and agents. */
  id: string
  company: string
  family: string
  version: string
  /** Which CLI runs this model. */
  adapter: AdapterId
  /** Exact model argument for the CLI (a pinned version). */
  cliArg: string
  /** Argument that follows the newest version of the family (when the CLI has one). */
  aliasArg?: string
  tier: Tier
  /** Relative usage-limit cost (1 = the lightest). */
  weight: number
  /** Work areas the model is generally suited to (see JOBS). */
  domains: string[]
  note?: string
  /** Added by the user (kept in the user's own catalog file). */
  custom?: boolean
  /** Where the name was confirmed. Without it the entry is shown as "미확인". */
  verified?: { source: string; at: string }
  /** Came from the CLI's own model list for this login (not from the bundled catalog). */
  fromAccount?: boolean
}

/** What a CLI's model-list command printed: one slug per line, possibly with bullets and a description. */
export function parseModelList(text: string): { slug: string; label: string }[] {
  const out: { slug: string; label: string }[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^[\s*•·>\-–\d.)]+/, '').trim()
    if (!line || /:$/.test(line)) continue
    const slug = line.split(/[\s,(]+/)[0]
    if (!/^[A-Za-z0-9][\w.:/-]{1,80}$/.test(slug) || seen.has(slug)) continue
    // a plain English word at the start of a sentence is a heading, not a model
    if (!/[-\d.]/.test(slug)) continue
    seen.add(slug)
    const rest = line.slice(slug.length).replace(/^[\s,:(-]+|[)\s]+$/g, '')
    out.push({ slug, label: rest || slug })
  }
  return out
}

export function tierOfSlug(slug: string): Tier {
  const parts = slug.toLowerCase().split(/[^a-z0-9]+/)
  if (parts.some((p) => ['flash', 'lite', 'mini', 'haiku', 'nano'].includes(p))) return 'light'
  if (parts.some((p) => ['pro', 'ultra', 'opus', 'max'].includes(p))) return 'top'
  return 'balanced'
}

/** Catalog entries for the models a CLI login reported. */
export function accountEntries(adapter: AdapterId, models: { slug: string; label: string }[], at: string): ModelEntry[] {
  return models.map((m) => {
    const tier = tierOfSlug(m.slug)
    return {
      id: `acct-${adapter}-${m.slug}`,
      company: adapter === 'agy' ? 'Google' : adapter,
      family: m.label === m.slug ? m.slug : m.label,
      version: '',
      adapter,
      cliArg: m.slug,
      tier,
      weight: tier === 'top' ? 6 : tier === 'balanced' ? 3 : 1,
      domains: tier === 'light' ? ['docs', 'ops', 'research'] : ['plan', 'build', 'review', 'research'],
      verified: { source: `${adapter} 계정 모델 목록`, at: at.slice(0, 10) },
      fromAccount: true
    }
  })
}

/** `alias` follows the newest version; `pinned` always uses the exact one. */
export interface ModelRef {
  id: string
  pin: 'alias' | 'pinned'
}

export function modelLabel(m: Pick<ModelEntry, 'company' | 'family' | 'version'>): string {
  return `${m.family} ${m.version}`.trim()
}

/** The argument to pass to the CLI for a model reference. */
export function resolveModelArg(m: ModelEntry, pin: ModelRef['pin']): string {
  return pin === 'alias' && m.aliasArg ? m.aliasArg : m.cliArg
}

/** Defaults first, then the user's file: entries with the same id replace the default. */
export function mergeCatalog(defaults: ModelEntry[], user: ModelEntry[]): ModelEntry[] {
  const out = new Map<string, ModelEntry>()
  for (const m of defaults) out.set(m.id, m)
  for (const m of user) if (isModelEntry(m)) out.set(m.id, { ...m, custom: true })
  return [...out.values()]
}

export function isModelEntry(m: unknown): m is ModelEntry {
  const e = m as Partial<ModelEntry> | null
  return (
    !!e &&
    typeof e.id === 'string' &&
    !!e.id &&
    typeof e.cliArg === 'string' &&
    !!e.cliArg &&
    typeof e.adapter === 'string' &&
    typeof e.family === 'string' &&
    (e.tier === 'top' || e.tier === 'balanced' || e.tier === 'light')
  )
}

/** Whether the model works on this account, as shown by the last [사용 확인] on this computer. */
export interface ModelAvailability {
  ok: boolean
  at: string
  message: string
}

// ---- jobs ----
export const JOBS: { id: string; label: string }[] = [
  { id: 'ceo', label: 'CEO' },
  { id: 'coo', label: '총괄 본부장' },
  { id: 'lead', label: '관리(장)' },
  { id: 'plan', label: '기획' },
  { id: 'build', label: '구현' },
  { id: 'review', label: '리뷰' },
  { id: 'qa', label: 'QA' },
  { id: 'docs', label: '문서' },
  { id: 'research', label: '리서치' },
  { id: 'ops', label: '운영·마케팅' }
]
export const jobLabel = (id?: string): string => JOBS.find((j) => j.id === id)?.label ?? (id || '미지정')
/** Jobs that produce work (as opposed to checking or managing it). */
export const WORKER_JOBS = ['plan', 'build', 'docs', 'research', 'ops']
export const REVIEWER_JOBS = ['review', 'qa']

// ---- company ----
export interface Rank {
  id: string
  name: string
  /** 1 = highest. */
  level: number
}

export interface PlacementRules {
  /** A team with two or more members needs at least two different models. */
  minModelsPerTeam: boolean
  /** The reviewer's model differs from the workers' and is at least as strong. */
  reviewerDiffers: boolean
  /** The CEOs run on different models (ideally different companies). */
  ceoTrioDiffers: boolean
}

export interface Company {
  name: string
  templateId: string
  ranks: Rank[]
  rules: PlacementRules
  /** Planned AI runs above which a plan needs the board's approval (used from stage 3). */
  bigJobRuns: number
  createdAt: string
}

export interface OrgUnit {
  id: string
  name: string
  /** 본부 / 실 / 팀 / 파트 … (free text). */
  kind: string
  parentId: string | null
  mission: string
  /** Shared name of the unit's work folder (paths are mapped per computer in a project). */
  folderName: string
  order: number
}

export interface Seat {
  id: string
  unitId: string
  title: string
  rankId: string
  job: string
  /** Hard design / difficult work vs. routine work: decides the recommended tier. */
  difficulty: 'hard' | 'routine'
  /** Chosen or recommended model while no agent sits here. */
  modelId?: string
  /** Roster id of the agent who holds the seat. */
  agentId?: string
  /** Position inside its unit (display order). */
  order?: number
}

export const DEFAULT_RULES: PlacementRules = { minModelsPerTeam: true, reviewerDiffers: true, ceoTrioDiffers: true }
