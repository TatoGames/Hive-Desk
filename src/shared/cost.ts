import type { AptitudeRecord } from './aptitude'
import type { Task } from './types'
import { subtree } from './tree'

/** One stage of a job: how many AI runs it took and how long they ran. */
export interface StageCost {
  stage: 'plan' | 'work' | 'rework' | 'review' | 'integrate'
  label: string
  runs: number
  ms: number
}

export interface TaskCost {
  stages: StageCost[]
  /** AI runs and time of the whole job (plans, work, reviews, integration). */
  runs: number
  ms: number
  /** What the app did itself, with no AI (automatic checks). */
  checkMs: number
  checkRuns: number
  /** AI reviews that were not needed (small safe change that passed the checks, or left for the review of the whole bundle). */
  reviewsSaved: number
  tasks: number
}

export const STAGE_LABEL: Record<StageCost['stage'], string> = { plan: '계획', work: '작업', rework: '다시 작업', review: '검토', integrate: '통합' }

/**
 * Where the AI runs and time of a job went, by stage — so the person can see what is worth turning down.
 * `rework` is every run of a work task after its first (sent back by a check, a reviewer or the person).
 */
export function taskCost(all: Task[], rootId: string, apt: AptitudeRecord[]): TaskCost {
  const tree = subtree(all, rootId)
  const ids = new Map(tree.map((t) => [t.id, t]))
  const acc: Record<StageCost['stage'], StageCost> = {
    plan: { stage: 'plan', label: STAGE_LABEL.plan, runs: 0, ms: 0 },
    work: { stage: 'work', label: STAGE_LABEL.work, runs: 0, ms: 0 },
    rework: { stage: 'rework', label: STAGE_LABEL.rework, runs: 0, ms: 0 },
    review: { stage: 'review', label: STAGE_LABEL.review, runs: 0, ms: 0 },
    integrate: { stage: 'integrate', label: STAGE_LABEL.integrate, runs: 0, ms: 0 }
  }
  // one record per task (and model): add them up per task first
  const per = new Map<string, { runs: number; ms: number }>()
  for (const a of apt) {
    const base = a.taskId.split('~')[0]
    if (!ids.has(base)) continue
    const cur = per.get(base) ?? { runs: 0, ms: 0 }
    per.set(base, { runs: cur.runs + a.runs, ms: cur.ms + a.ms })
  }
  for (const [id, v] of per) {
    const t = ids.get(id)!
    const k = t.kind
    if (k === 'plan' || k === 'committee') {
      acc.plan.runs += v.runs
      acc.plan.ms += v.ms
    } else if (k === 'review') {
      acc.review.runs += v.runs
      acc.review.ms += v.ms
    } else if (k === 'integrate') {
      acc.integrate.runs += v.runs
      acc.integrate.ms += v.ms
    } else {
      // work (or a task without a kind): the first run is the work, the rest is rework
      const first = Math.min(1, v.runs)
      const rest = v.runs - first
      const avg = v.runs ? v.ms / v.runs : 0
      acc.work.runs += first
      acc.work.ms += avg * first
      acc.rework.runs += rest
      acc.rework.ms += avg * rest
    }
  }
  let checkMs = 0
  let checkRuns = 0
  let reviewsSaved = 0
  for (const t of tree) {
    for (const i of t.checks?.items ?? []) {
      if (!i.skipped) {
        checkMs += i.ms
        checkRuns++
      }
    }
    if (t.reviewState?.status === 'skipped' && (t.reviewState.deferred || /^AI 검토 생략/.test(t.reviewState.note ?? ''))) reviewsSaved++
  }
  const stages = Object.values(acc).filter((s) => s.runs > 0)
  return {
    stages: stages.map((s) => ({ ...s, ms: Math.round(s.ms) })),
    runs: stages.reduce((n, s) => n + s.runs, 0),
    ms: Math.round(stages.reduce((n, s) => n + s.ms, 0)),
    checkMs,
    checkRuns,
    reviewsSaved,
    tasks: tree.filter((t) => t.kind !== 'review').length
  }
}
