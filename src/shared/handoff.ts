import type { Tier } from './company'
import type { AdapterId, PermissionLevel, StepSave, TaskKind } from './types'

/**
 * v5: who carries on a task when its employee's connection ran out of usage.
 * Pure: the engine hands in what it knows about each employee and the task.
 */

const TIER_RANK: Record<Tier, number> = { light: 1, balanced: 2, top: 3 }

/** An employee that might take the task over. */
export interface HandoffCand {
  agentId: string
  name: string
  adapter: AdapterId
  modelKey: string
  tier: Tier
  /** Usage weight of one run (catalog). */
  weight: number
  /** Rank level (1 = highest), when the employee sits on a seat. */
  rankLevel?: number
  isManager: boolean
  /** Nothing running or ready for this person right now. */
  idle: boolean
  /** The connection is out of usage, or the employee's own daily budget is used up. */
  limited: boolean
  /** The connection is close to where it ran out last times. */
  nearLimit?: boolean
  /** First-pass rate for this kind of job (0..1), when known. */
  passRate?: number
  /** How many tasks this person was handed in the same round (spreads a bundle out). */
  taken?: number
}

/** What the task needs from whoever takes it. */
export interface HandoffNeed {
  kind?: TaskKind
  permission: PermissionLevel
  minTier: Tier
  /** The task uses external connections (web, MCP): only employees that can use them. */
  usesExternal: boolean
  /** Models the taker must not be (a review must be done by another model than the work). */
  avoidModels: string[]
  /** Connections this task already went through (never back). */
  triedAdapters: AdapterId[]
}

export interface HandoffPick {
  cand: HandoffCand
  /** Usage weight of the taker ÷ the one it came from. */
  costX: number
  /** Taken from a stronger tier than the one it came from. */
  up: boolean
}

export interface HandoffResult {
  pick: HandoffPick | null
  /** Why each left-out employee could not take it (shown when nobody can). */
  skipped: { agentId: string; why: string }[]
}

/** CLIs that enforce the permission level themselves (a read-only task stays read-only there). */
export const ENFORCING: AdapterId[] = ['claude', 'codex']
/** CLIs that can use external connections (web, MCP) with live approval. */
export const EXTERNAL_CAPABLE: AdapterId[] = ['claude']

const MANAGER_ONLY: TaskKind[] = ['plan', 'integrate']

/** Why this employee cannot take the task (null = can). */
export function whyNot(c: HandoffCand, from: { adapter: AdapterId; agentId: string }, need: HandoffNeed): string | null {
  if (c.agentId === from.agentId) return '지금 담당'
  if (c.adapter === from.adapter) return '같은 연결(같은 한도)'
  if (need.triedAdapters.includes(c.adapter)) return '이미 거쳐 간 연결'
  if (c.limited) return '한도·예산 소진'
  if (TIER_RANK[c.tier] < TIER_RANK[need.minTier]) return '체급이 모자람'
  if (need.kind && MANAGER_ONLY.includes(need.kind) && !c.isManager) return '관리자만 할 수 있는 업무'
  if (need.avoidModels.includes(c.modelKey)) return '검토는 작업한 모델과 달라야 함'
  if (need.usesExternal && !EXTERNAL_CAPABLE.includes(c.adapter)) return '외부 연결을 쓸 수 없는 AI'
  if (need.permission === 'read' && !ENFORCING.includes(c.adapter)) return "'읽기만'을 강제하지 못하는 AI"
  return null
}

/**
 * Same tier as the employee it comes from first, then one tier up, and so on (`up` off = same tier only).
 * Within a tier: idle → fewer hand-overs this round → better first-pass record → lighter model →
 * not close to its limit → rank closest to the one it came from. Managers go last for ordinary work.
 */
export function pickHandoff(
  from: { agentId: string; adapter: AdapterId; tier: Tier; weight: number; rankLevel?: number },
  cands: HandoffCand[],
  need: HandoffNeed,
  opts: { up?: boolean } = {}
): HandoffResult {
  const skipped: HandoffResult['skipped'] = []
  const ok: HandoffCand[] = []
  for (const c of cands) {
    const why = whyNot(c, from, need)
    if (why) {
      if (c.agentId !== from.agentId) skipped.push({ agentId: c.agentId, why })
    } else ok.push(c)
  }
  const start = TIER_RANK[from.tier]
  const tiers = [...new Set(ok.map((c) => TIER_RANK[c.tier]))].filter((t) => t >= start && (opts.up !== false || t === start)).sort((a, b) => a - b)
  const managerWork = !!need.kind && MANAGER_ONLY.includes(need.kind)
  for (const t of tiers) {
    const here = ok
      .filter((c) => TIER_RANK[c.tier] === t)
      .sort(
        (a, b) =>
          (managerWork ? 0 : Number(a.isManager) - Number(b.isManager)) ||
          Number(b.idle) - Number(a.idle) ||
          (a.taken ?? 0) - (b.taken ?? 0) ||
          (b.passRate ?? 0.5) - (a.passRate ?? 0.5) ||
          a.weight - b.weight ||
          Number(!!a.nearLimit) - Number(!!b.nearLimit) ||
          Math.abs((a.rankLevel ?? 99) - (from.rankLevel ?? 99)) - Math.abs((b.rankLevel ?? 99) - (from.rankLevel ?? 99)) ||
          a.agentId.localeCompare(b.agentId)
      )
    if (here.length) {
      const c = here[0]
      return { pick: { cand: c, costX: from.weight > 0 ? c.weight / from.weight : 1, up: t > start }, skipped }
    }
  }
  return { pick: null, skipped }
}

/** Wait for the limit instead of handing over: only when the reset time is known and close. */
export function shouldWait(limit: { until: string; guessed: boolean }, waitMinutes: number, now = Date.now()): boolean {
  if (limit.guessed || waitMinutes <= 0) return false
  const left = new Date(limit.until).getTime() - now
  return left > 0 && left <= waitMinutes * 60_000
}

/** Close to the limit: this many runs since the last one is 85% (or more) of what it took before (median). */
export function nearLimit(stat: { since: number; hits: number[] } | undefined): boolean {
  if (!stat || !stat.hits.length) return false
  const h = [...stat.hits].sort((a, b) => a - b)
  const median = h[Math.floor(h.length / 2)]
  return median > 0 && stat.since >= Math.ceil(median * 0.85)
}

/** "약 2배" — how much more a run of the new model uses. */
export function costLine(costX: number): string {
  if (costX >= 1.15) return `약 ${costX >= 10 ? Math.round(costX) : Math.round(costX * 10) / 10}배 비용`
  if (costX <= 0.85) return `약 ${Math.round(costX * 10) / 10}배 비용(더 가벼움)`
  return '비슷한 비용'
}

/**
 * What the employee who takes over reads first (kept short: about a thousand tokens).
 * Built by the app from the last step saving point — no AI run.
 */
export function handoffNote(o: {
  fromName: string
  fromModel: string
  reason: 'limit' | 'manual'
  save?: StepSave
  /** Files changed by the last run when there is no step saving point. */
  files?: string[]
  /** The end of the last run's output when there is no step saving point. */
  lastOutput?: string
  /** The step in progress was put back to how it was when it started. */
  rolledBack: boolean
}): string {
  const why = o.reason === 'limit' ? 'ran out of its usage limit' : 'was handed to you by a person'
  const out: string[] = [`This task was started by ${o.fromName} (${o.fromModel}), who ${why}. You carry it on — do not start over.`]
  const s = o.save
  if (s && s.plan.length) {
    const lines = s.plan.map((p, i) => `${i + 1}. ${i < s.done ? '[done] ' : i === s.done ? '[in progress] ' : ''}${p}`)
    out.push('Their plan:\n' + lines.join('\n'))
    const next = s.plan[s.done]
    if (next) {
      out.push(
        o.rolledBack
          ? `Step ${s.done + 1} ("${next}") was in progress; its half-done changes were undone, so do that step from its start, then the rest.`
          : `Step ${s.done + 1} ("${next}") was in progress and may be half done: check the files it touched first, then finish it and the rest.`
      )
    } else out.push('All planned steps were finished; check the result and write the report.')
  }
  const files = (s?.files.length ? s.files : o.files ?? []).slice(0, 30)
  if (files.length) out.push('Files changed so far:\n' + files.map((f) => `- ${f}`).join('\n'))
  const last = (s?.last || o.lastOutput || '').trim()
  if (last) out.push('Their last words:\n' + last.slice(-600))
  return out.join('\n\n').slice(0, 3800)
}
