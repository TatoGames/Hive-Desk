import type { Tier } from './company'
import { tierRank } from './company'

/**
 * Quick assignment (v4 6-0.5): a small job goes straight to one employee instead of through the whole organisation
 * (plan → plan review → split → cross review). Not "the cheapest model" but "the model that can do this job
 * with the least expected usage": usage of one run × expected number of runs.
 */
export type JobKind = 'doc' | 'plan' | 'impl' | 'review' | 'research' | 'other'
export type JobSize = 'small' | 'big' | 'unsure'

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  doc: '문서',
  plan: '기획',
  impl: '구현',
  review: '검토',
  research: '조사',
  other: '일반'
}

export interface JobRead {
  size: JobSize
  kind: JobKind
  /** Does the job change files? (answers and research need no cross review) */
  writes: boolean
  /** Weakest tier that can be trusted with it. */
  minTier: Tier
  reasons: string[]
}

const BIG = /(전체|모든 |전면|리팩터|리팩토링|아키텍처|시스템 전|마이그레이션|처음부터|풀\s?스택|서비스 전체|여러\s?(파일|모듈|화면|기능)|통합|배포|인프라|설계부터)/
const SMALL = /(오타|이름\s?바꾸|한 줄|요약|번역|정리|메모|목록|표로|문서|기획서|설명|수정해|고쳐|작성해|써 ?줘|적어)/
const K_IMPL = /(구현|코드|버그|기능|함수|클래스|화면|스크립트|테스트|api|ui\b|빌드|컴파일|에러|오류)/i
const K_REVIEW = /(리뷰|검토|점검|확인해)/
const K_RESEARCH = /(조사|찾아|비교|알아봐|분석|리서치)/
const K_PLAN = /(계획|기획(?!서)|설계|로드맵|컨셉)/
const K_DOC = /(문서|명세|readme|보고서|요약|번역|정리|작성|기획서|가이드|메모)/i

/** Rules only, no AI run: what kind of job is this, and how big? */
export function readJob(text: string, opts: { attachments?: number } = {}): JobRead {
  const t = text.trim()
  const reasons: string[] = []
  const kinds: JobKind[] = []
  if (K_IMPL.test(t)) kinds.push('impl')
  if (K_REVIEW.test(t)) kinds.push('review')
  if (K_RESEARCH.test(t)) kinds.push('research')
  if (K_PLAN.test(t)) kinds.push('plan')
  if (K_DOC.test(t)) kinds.push('doc')
  // code words win over "작성": "로그인 함수 작성" is an implementation
  const kind: JobKind = kinds.includes('impl') ? 'impl' : kinds.includes('review') ? 'review' : kinds.includes('research') ? 'research' : kinds.includes('plan') ? 'plan' : kinds.includes('doc') ? 'doc' : 'other'

  let size: JobSize
  const long = t.length > 400
  if (BIG.test(t) || long || (opts.attachments ?? 0) > 3 || kinds.length >= 4) {
    size = 'big'
    reasons.push(BIG.test(t) ? '범위가 넓은 말이 있어요' : long ? '지시가 길어요' : '여러 분야가 얽혀 있어요')
  } else if (t.length <= 200 && (SMALL.test(t) || kind === 'research' || kind === 'review' || kind === 'doc') && kinds.length <= 2) {
    size = 'small'
    reasons.push('짧고 한 가지 일이에요')
  } else {
    size = 'unsure'
    reasons.push('크기를 단정하기 어려워요')
  }
  const writes = kind === 'doc' || kind === 'impl' || kind === 'plan' || kind === 'other'
  const minTier: Tier = kind === 'impl' && !/(오타|이름\s?바꾸|한 줄)/.test(t) ? 'balanced' : 'light'
  return { size, kind, writes, minTier, reasons }
}

/** One candidate employee, as the picker sees it. */
export interface Cand {
  agentId: string
  name: string
  modelKey: string
  label: string
  tier: Tier
  /** Usage of one run (catalog weight). */
  weight: number
  idle: boolean
  /** A model that thinks long: left out of small jobs. */
  thinking?: boolean
  /** Left of today's budget (runs); larger is better. */
  budgetLeft?: number
  /** Room under the connection's limit (0..1); larger is better. */
  limitRoom?: number
}

export interface RecordLite {
  modelKey: string
  jobKind?: string
  approved: number
  changes: number
  failed: number
  runs: number
}

export interface PassStats {
  /** Finished tasks of this model for this kind of job. */
  samples: number
  /** First-pass rate with a small prior (by tier) mixed in while the record is thin. */
  rate: number
  /** The model's own record alone, if there is any. */
  measured: number | null
  estimated: boolean
}

const PRIOR: Record<Tier, Record<JobKind, number>> = {
  light: { doc: 0.75, research: 0.75, review: 0.65, plan: 0.6, impl: 0.4, other: 0.6 },
  balanced: { doc: 0.9, research: 0.88, review: 0.85, plan: 0.85, impl: 0.8, other: 0.85 },
  top: { doc: 0.95, research: 0.93, review: 0.92, plan: 0.92, impl: 0.9, other: 0.92 }
}
const PRIOR_WEIGHT = 3
export const MIN_SAMPLES_QUICK = 3
/** Average extra runs a task that was not right the first time takes. */
export const REWORK_RUNS = 2

export function passStats(records: RecordLite[], modelKey: string, kind: JobKind, tier: Tier): PassStats {
  const rs = records.filter((r) => r.modelKey === modelKey && r.jobKind === kind && r.approved + r.changes + r.failed > 0)
  const approved = rs.reduce((n, r) => n + (r.changes + r.failed === 0 && r.approved > 0 ? 1 : 0), 0)
  const samples = rs.length
  const prior = PRIOR[tier][kind]
  const rate = (approved + prior * PRIOR_WEIGHT) / (samples + PRIOR_WEIGHT)
  return { samples, rate, measured: samples ? approved / samples : null, estimated: samples < MIN_SAMPLES_QUICK }
}

export interface Pick {
  cand: Cand
  rate: number
  /** The model's own first-pass rate on this kind of job, when there is a record. */
  measured: number | null
  samples: number
  estimated: boolean
  expectedRuns: number
  expectedUsage: number
  trial: boolean
}

const usageOf = (c: Cand, s: PassStats): Pick => {
  const expectedRuns = 1 + (1 - s.rate) * REWORK_RUNS
  return { cand: c, rate: s.rate, measured: s.measured, samples: s.samples, estimated: s.estimated, expectedRuns, expectedUsage: c.weight * expectedRuns, trial: false }
}

/** Candidates that may do the job, best first: least expected usage; near ties go to whoever is idle, has budget, has limit room. */
export function rank(job: JobRead, cands: Cand[], records: RecordLite[]): Pick[] {
  const ok = cands.filter((c) => tierRank(c.tier) >= tierRank(job.minTier) && !(c.thinking && job.size === 'small'))
  const all = ok.map((c) => usageOf(c, passStats(records, c.modelKey, job.kind, c.tier)))
  // same quality first: a model that really does badly at this kind of job (enough tasks, under half right first time) is left out, however cheap
  const good = all.filter((p) => !(p.samples >= MIN_SAMPLES_QUICK && (p.measured ?? 1) < 0.5))
  const picks = good.length ? good : all
  const best = Math.min(...picks.map((p) => p.expectedUsage))
  const near = (p: Pick): boolean => p.expectedUsage <= best * 1.1
  return picks.sort((a, b) => {
    const na = near(a)
    const nb = near(b)
    if (na !== nb) return na ? -1 : 1
    if (na && nb) {
      return (
        Number(b.cand.idle) - Number(a.cand.idle) ||
        (b.cand.budgetLeft ?? 0) - (a.cand.budgetLeft ?? 0) ||
        (b.cand.limitRoom ?? 0) - (a.cand.limitRoom ?? 0) ||
        a.expectedUsage - b.expectedUsage
      )
    }
    return a.expectedUsage - b.expectedUsage
  })
}

/**
 * The employee for a small job. With a low-risk job (nothing is written) a lighter candidate with a thin record is
 * now and then tried instead (`trialRate`, default 10%) so that records build up; it is marked as a trial.
 */
export function pickWorker(job: JobRead, cands: Cand[], records: RecordLite[], opts: { trialRate?: number; rnd?: () => number } = {}): { pick: Pick | null; ranked: Pick[] } {
  const ranked = rank(job, cands, records)
  if (!ranked.length) return { pick: null, ranked }
  let pick = ranked[0]
  const rate = opts.trialRate ?? 0.1
  if (!job.writes && rate > 0 && (opts.rnd ?? Math.random)() < rate) {
    const lighter = ranked.filter((p) => p.cand.weight < pick.cand.weight && p.samples < MIN_SAMPLES_QUICK)
    if (lighter.length) pick = { ...lighter[0], trial: true }
  }
  return { pick, ranked }
}

/** One step up in tier, with the least expected usage; null when nobody is above. */
export function escalationTarget(job: JobRead, cands: Cand[], records: RecordLite[], current: { modelKey: string; tier: Tier }): Pick | null {
  const higher = cands.filter((c) => tierRank(c.tier) > tierRank(current.tier) && c.modelKey !== current.modelKey)
  if (!higher.length) return null
  const lowest = Math.min(...higher.map((c) => tierRank(c.tier)))
  const next = rank({ ...job, minTier: 'light', size: 'big' }, higher.filter((c) => tierRank(c.tier) === lowest), records)
  return next[0] ?? null
}

/** The line shown before the job is handed over. */
export function quickLine(job: JobRead, p: Pick): string {
  const kind = JOB_KIND_LABEL[job.kind]
  const rec = p.estimated
    ? `${kind} 일 기록이 적어 체급으로 어림했어요`
    : `${kind} 일 첫 통과율 ${Math.round(p.rate * 100)}% (${p.samples}건)`
  return `${job.size === 'small' ? '작은 일' : '일'} · ${kind} → ${p.cand.name} (${p.cand.label}) · ${rec} · 예상 실행 ${p.expectedRuns.toFixed(1)}회${p.trial ? ' · 시험 배정' : ''}`
}
