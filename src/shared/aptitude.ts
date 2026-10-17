import { jobLabel } from './company'

/** How one task went with one model: the raw material of the aptitude score. */
export interface AptitudeRecord {
  taskId: string
  /** Catalog id, or `adapter:model` for a model that is not in the catalog. */
  modelKey: string
  /** Name shown for the model (family + version), frozen when the task ran. */
  modelLabel: string
  /** Work area (the agent's job), `general` when none. */
  domain: string
  runs: number
  ms: number
  /** Results a human accepted (or that needed no check). */
  approved: number
  /** Times a human asked for changes or undid the result. */
  changes: number
  failed: number
  updatedAt: string
}

/** Fewer finished tasks than this and the number is only a hint. */
export const MIN_SAMPLES = 3

export interface AptitudeRow {
  modelKey: string
  modelLabel: string
  domain: string
  tasks: number
  runs: number
  minutes: number
  passRate: number
  avgChanges: number
  avgMinutes: number
  /** 0..100, see `scoreOf`. */
  score: number
  enough: boolean
}

/** Pass rate dominates; every change request and long tasks cost points. */
export function scoreOf(passRate: number, avgChanges: number, avgMinutes: number): number {
  const v = passRate * 100 - avgChanges * 10 - Math.min(10, avgMinutes / 10)
  return Math.max(0, Math.min(100, Math.round(v)))
}

/** One row per (model version × domain). A new version starts with an empty record. */
export function aptitudeBoard(records: AptitudeRecord[]): AptitudeRow[] {
  const groups = new Map<string, AptitudeRecord[]>()
  for (const r of records) {
    const finished = r.approved + r.changes + r.failed
    if (!finished) continue // nothing decided yet
    const k = r.modelKey + '|' + r.domain
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const rows: AptitudeRow[] = []
  for (const list of groups.values()) {
    const tasks = list.length
    const approved = list.reduce((n, r) => n + r.approved, 0)
    const changes = list.reduce((n, r) => n + r.changes, 0)
    const failed = list.reduce((n, r) => n + r.failed, 0)
    const ms = list.reduce((n, r) => n + r.ms, 0)
    const passRate = approved / Math.max(1, approved + changes + failed)
    const avgChanges = changes / tasks
    const avgMinutes = ms / 60000 / tasks
    rows.push({
      modelKey: list[0].modelKey,
      modelLabel: list[0].modelLabel,
      domain: list[0].domain,
      tasks,
      runs: list.reduce((n, r) => n + r.runs, 0),
      minutes: Math.round(ms / 60000),
      passRate,
      avgChanges,
      avgMinutes,
      score: scoreOf(passRate, avgChanges, avgMinutes),
      enough: tasks >= MIN_SAMPLES
    })
  }
  return rows.sort((a, b) => a.domain.localeCompare(b.domain) || b.score - a.score)
}

export interface Reassignment {
  domain: string
  from: string
  to: string
  gain: number
  text: string
}

/** Suggest a better model for a domain when there is enough evidence on both sides. */
export function recommendReassignments(
  rows: AptitudeRow[],
  current: { domain: string; modelKey: string; modelLabel: string }[],
  minGain = 10
): Reassignment[] {
  const out: Reassignment[] = []
  const seen = new Set<string>()
  for (const c of current) {
    const id = c.domain + '|' + c.modelKey
    if (seen.has(id)) continue
    seen.add(id)
    const mine = rows.find((r) => r.domain === c.domain && r.modelKey === c.modelKey && r.enough)
    if (!mine) continue
    const best = rows
      .filter((r) => r.domain === c.domain && r.enough && r.modelKey !== c.modelKey)
      .sort((a, b) => b.score - a.score)[0]
    if (best && best.score - mine.score >= minGain) {
      out.push({
        domain: c.domain,
        from: c.modelLabel,
        to: best.modelLabel,
        gain: best.score - mine.score,
        text: `${jobLabel(c.domain)} 분야: ${c.modelLabel}(${mine.score}점) 대신 ${best.modelLabel}(${best.score}점)이 더 잘했어요.`
      })
    }
  }
  return out
}
