import type { AptitudeRecord } from './aptitude'
import { MIN_SAMPLES } from './aptitude'
import type { HandoffSettings } from './types'

/**
 * A2: is it worth giving this task to a model on this PC? (v6-design 5-4)
 *
 *   benefit = p × (usage saved + wait avoided) − (1 − p) × (cost of doing it again)
 *
 * Pure. Units are "weight of one outside run" (the same usage weights as `cost.ts` / the model catalog), so the
 * number is comparable between models: a heavy model that is saved is worth more than a light one.
 */
export const LOCAL_BENEFIT = {
  /** Fewer finished tasks of this kind than this and the record is only a hint: the default rate is used (same as `MIN_SAMPLES` of the aptitude board). */
  minSamples: MIN_SAMPLES,
  /**
   * Pass rate assumed while there is no record. Conservative: below what a small local model has to show to be worth it
   * for hard work, but above the break-even (about 0.53 for a balanced outside model when a limit is the reason: 0.51, see the tests), so an easy task
   * (a few small files, the guard of `localFit`) with no history still goes to a model on this PC when a limit stops
   * everyone else. Same as the light-tier prior for "other" jobs in `quick.ts`.
   */
  defaultPassRate: 0.6,
  /** Waiting for a usage limit that is avoided counts as this many outside runs saved (only when the task is stuck on a limit). */
  waitAvoided: 0.5,
  /** Usage weight of one run on this PC (it costs no subscription usage; kept tiny so wasted tries still show). */
  localWeight: 0.1,
  /** A failed local try is retried on this PC this many times before it goes outside (v6-design 5-4: two failures in a row). */
  retryRuns: 2,
  /** A person has to look at a result that failed (in outside runs). */
  humanReview: 0.5,
  /** An automatic check finds a bad result before a person does: the cost of a failure shrinks to this share. */
  checkedShare: 0.4,
  /** A risky task costs this many times more when it goes wrong. */
  riskyFactor: 2,
  /** Recommended when the benefit is above this. */
  minScore: 0,
  /** Confidence: below `minSamples` = low, below this = medium, else high. */
  highSamples: 10
} as const

export type LocalConfidence = 'low' | 'medium' | 'high'

export interface LocalBenefitInput {
  /** Kind of job (doc / impl / …), only used in the message. */
  kind?: string
  /** A risky task: a failure costs more. */
  risky?: boolean
  /** Tasks of this kind the model on this PC passed first time / tried (decided). */
  passed: number
  attempts: number
  /** Usage weight of one outside run that this would replace. */
  externalWeight: number
  /** The project has automatic checks (tests, typecheck …). */
  hasChecks: boolean
  /** The task is stuck on a usage limit (waiting is avoided too). */
  limited?: boolean
}

export interface LocalBenefit {
  score: number
  recommend: boolean
  reason: string
  confidence: LocalConfidence
  /** The pass rate that was used. */
  passRate: number
  /** True when the record was too thin and the default was used. */
  assumed: boolean
}

const pct = (x: number): string => `${Math.round(x * 100)}%`
const round2 = (x: number): number => Math.round(x * 100) / 100

export function localBenefit(i: LocalBenefitInput): LocalBenefit {
  const C = LOCAL_BENEFIT
  const attempts = Math.max(0, i.attempts)
  const assumed = attempts < C.minSamples
  const p = assumed ? C.defaultPassRate : Math.min(1, Math.max(0, i.passed / attempts))
  const ext = Math.max(0, i.externalWeight)
  const saved = ext + (i.limited ? C.waitAvoided : 0)
  const redo = (C.retryRuns * C.localWeight + ext + C.humanReview) * (i.hasChecks ? C.checkedShare : 1) * (i.risky ? C.riskyFactor : 1)
  const score = round2(p * saved - (1 - p) * redo)
  const recommend = score > C.minScore
  const confidence: LocalConfidence = assumed ? 'low' : attempts < C.highSamples ? 'medium' : 'high'
  const check = i.hasChecks ? '' : ' (자동 검사가 없어요)'
  let reason: string
  if (assumed) {
    const head = `아직 이력이 적어요(${attempts}건) — 기본 통과율 ${pct(p)}로 따져 보면`
    reason = recommend ? `${head} 쓰는 게 이득이에요${check}` : `${head} 다시 하는 비용이 더 커서 쓰지 않는 게 나아요${check}`
  } else {
    const head = `이런 일은 통과율 ${pct(p)}(${attempts}건)라서`
    reason = recommend ? `${head} 쓰는 게 이득이에요` : `${head} 다시 하는 비용이 더 커서 쓰지 않는 게 나아요${check}`
  }
  return { score, recommend, reason, confidence, passRate: p, assumed }
}

/** First-pass record of one model for a kind of job (all kinds when `kind` is unknown or has no record). Hand-overs do not count (not first pass). */
export function localHistory(records: AptitudeRecord[], modelKey: string, kind?: string): { passed: number; attempts: number } {
  const mine = records.filter((r) => r.modelKey === modelKey && !r.handedOver && r.approved + r.changes + r.failed > 0)
  const ofKind = kind ? mine.filter((r) => r.jobKind === kind || r.domain === kind) : mine
  const rs = ofKind.length ? ofKind : mine
  return { passed: rs.filter((r) => r.approved > 0 && r.changes + r.failed === 0).length, attempts: rs.length }
}

export type LocalScope = 'off' | 'easy' | 'limit-only'

export const LOCAL_SCOPE_LABEL: Record<LocalScope, string> = {
  off: '안 써요',
  easy: '쉬운 일만',
  'limit-only': '한도 찰 때만'
}

export const LOCAL_SCOPE_HELP: Record<LocalScope, string> = {
  off: '내 PC AI에게 넘기지도, 맡겨도 된다고 안내하지도 않아요.',
  easy: '한도가 찼을 때 이어받는 것에 더해, 쉬운 일을 내 PC AI에게 맡길 때 "해도 괜찮아 보여요"라고 미리 알려 드려요. 자동으로 맡기지는 않아요.',
  'limit-only': '한도가 찼을 때 이어받는 데만 써요. 맡길 때 안내는 하지 않아요.'
}

/**
 * Which scope applies. `localScope` wins when it is set. Older settings only have `allowLocal` (A1):
 * `allowLocal: false` is read as `off`, anything else (true or missing) as `easy`, the default.
 * Nothing is rewritten on disk: the first time the person picks a scope in Settings, `localScope` is saved.
 */
export function localScopeOf(s: Pick<HandoffSettings, 'localScope' | 'allowLocal'>): LocalScope {
  if (s.localScope === 'off' || s.localScope === 'easy' || s.localScope === 'limit-only') return s.localScope
  return s.allowLocal === false ? 'off' : 'easy'
}

/** Weight used for the usage a task would have taken outside when nothing better is known: a balanced model (catalog weight 3). */
export const DEFAULT_EXTERNAL_WEIGHT = 3

export interface LocalSavings {
  /** Tasks a model on this PC finished and that passed (accepted, no change asked). */
  tasks: number
  /** Estimated usage (weight × runs) the same work would have used outside: one run of the model that was first asked. */
  usage: number
}

/**
 * How much the models on this PC saved: finished-and-passed tasks, and an estimate of what they would have used outside.
 * Estimate = Σ weight of the outside model the task came from (`weightOf`, the default balanced weight when unknown).
 * Read from the aptitude records, no new store. Hand-overs count too (that is when the saving is real).
 */
export function localSavings(records: AptitudeRecord[], weightOf: (taskId: string) => number | undefined): LocalSavings {
  let tasks = 0
  let usage = 0
  for (const r of records) {
    if (!r.modelKey.startsWith('local:')) continue
    if (!(r.approved > 0 && r.changes + r.failed === 0)) continue
    tasks++
    usage += weightOf(r.taskId.split('~')[0]) ?? DEFAULT_EXTERNAL_WEIGHT
  }
  return { tasks, usage: round2(usage) }
}
