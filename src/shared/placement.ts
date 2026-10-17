import type { AdapterId } from './types'
import {
  REVIEWER_JOBS,
  WORKER_JOBS,
  jobLabel,
  tierRank,
  type Company,
  type ModelAvailability,
  type ModelEntry,
  type OrgUnit,
  type Seat,
  type Tier
} from './company'

/** What the rules need to know about an agent that holds a seat. */
export interface SeatAgent {
  id: string
  adapter: AdapterId
  modelId?: string
  model?: string
}

export interface PlacementInput {
  units: OrgUnit[]
  seats: Seat[]
  agents: SeatAgent[]
  catalog: ModelEntry[]
}

/** Identity of the model on a seat: catalog id when known, else `adapter:model`. null = nothing decided yet. */
export function seatModelKey(s: Seat, inp: Pick<PlacementInput, 'agents'>): string | null {
  if (s.agentId) {
    const a = inp.agents.find((x) => x.id === s.agentId)
    if (a) return a.modelId ?? `${a.adapter}:${a.model ?? 'default'}`
  }
  return s.modelId ?? null
}

function entryOf(key: string | null, catalog: ModelEntry[]): ModelEntry | undefined {
  return key ? catalog.find((m) => m.id === key) : undefined
}

/** The tier a seat should get, following the design's table. */
export function recommendTier(s: Pick<Seat, 'job' | 'difficulty'>, depth = 0): Tier {
  if (s.job === 'ceo' || s.job === 'coo') return 'top'
  if (s.job === 'lead') return depth >= 3 ? (s.difficulty === 'routine' ? 'light' : 'balanced') : 'balanced'
  if (s.job === 'review') return 'balanced' // raised to match the worker's tier when placing
  return s.difficulty === 'routine' ? 'light' : 'balanced'
}

export interface Finding {
  rule: 'min-models' | 'reviewer-differs' | 'ceo-trio'
  level: 'warn' | 'info'
  unitId?: string
  seatIds: string[]
  text: string
}

function descendants(units: OrgUnit[], id: string): string[] {
  const out = [id]
  for (const u of units) if (u.parentId === id) out.push(...descendants(units, u.id))
  return out
}

/** Check the three placement rules the company switched on. */
export function checkPlacement(company: Pick<Company, 'rules'>, inp: PlacementInput): Finding[] {
  const out: Finding[] = []
  const key = (s: Seat): string | null => seatModelKey(s, inp)
  const name = (id: string): string => inp.units.find((u) => u.id === id)?.name ?? '?'
  const label = (k: string): string => {
    const e = entryOf(k, inp.catalog)
    return e ? `${e.family} ${e.version}` : k
  }

  if (company.rules.minModelsPerTeam) {
    for (const u of inp.units) {
      const here = inp.seats.filter((s) => s.unitId === u.id && key(s))
      if (here.length < 2) continue
      const kinds = new Set(here.map((s) => key(s)))
      if (kinds.size < 2) {
        out.push({
          rule: 'min-models',
          level: 'warn',
          unitId: u.id,
          seatIds: here.map((s) => s.id),
          text: `${u.name}: 모두 같은 모델(${label([...kinds][0]!)})이에요. 팀 안에 모델을 2개 이상 섞으세요.`
        })
      }
    }
  }

  if (company.rules.reviewerDiffers) {
    for (const r of inp.seats.filter((s) => REVIEWER_JOBS.includes(s.job) && key(s))) {
      const scope = new Set(descendants(inp.units, r.unitId))
      const workers = inp.seats.filter((s) => scope.has(s.unitId) && WORKER_JOBS.includes(s.job) && key(s))
      const same = workers.filter((w) => key(w) === key(r))
      if (same.length) {
        out.push({
          rule: 'reviewer-differs',
          level: 'warn',
          unitId: r.unitId,
          seatIds: [r.id, ...same.map((w) => w.id)],
          text: `${name(r.unitId)}: ${jobLabel(r.job)} "${r.title}"가 작업자와 같은 모델(${label(key(r)!)})이에요. 검토자는 다른 모델이어야 해요.`
        })
      }
      const re = entryOf(key(r), inp.catalog)
      const weaker = workers.filter((w) => {
        const we = entryOf(key(w), inp.catalog)
        return re && we && tierRank(re.tier) < tierRank(we.tier)
      })
      if (weaker.length) {
        out.push({
          rule: 'reviewer-differs',
          level: 'warn',
          unitId: r.unitId,
          seatIds: [r.id, ...weaker.map((w) => w.id)],
          text: `${name(r.unitId)}: 검토자 "${r.title}"의 체급이 작업자보다 낮아요. 검토자는 같거나 높은 체급이 좋아요.`
        })
      }
    }
  }

  if (company.rules.ceoTrioDiffers) {
    const ceos = inp.seats.filter((s) => s.job === 'ceo' && key(s))
    if (ceos.length >= 2) {
      const keys = ceos.map((s) => key(s)!)
      if (new Set(keys).size < keys.length) {
        out.push({
          rule: 'ceo-trio',
          level: 'warn',
          seatIds: ceos.map((s) => s.id),
          text: 'CEO들 중에 같은 모델이 있어요. 서로 다른 모델이어야 의견이 다양해져요.'
        })
      } else {
        const companies = new Set(keys.map((k) => entryOf(k, inp.catalog)?.company ?? k))
        if (companies.size === 1) {
          out.push({
            rule: 'ceo-trio',
            level: 'info',
            seatIds: ceos.map((s) => s.id),
            text: 'CEO들이 모두 같은 회사의 모델이에요. 모델은 다르지만, 가능하면 다른 회사 모델을 섞으면 더 좋아요.'
          })
        }
      }
    }
  }
  return out
}

function usable(m: ModelEntry, availability: Record<string, ModelAvailability>): boolean {
  return availability[m.id]?.ok !== false // not checked yet counts as usable
}

/**
 * Recommend a model for every seat that has no agent: right tier, rules respected as far as the
 * catalog allows. Returns seatId → modelId. Seats that already hold an agent are left alone.
 */
export function autoPlace(
  inp: PlacementInput,
  rules: Company['rules'],
  availability: Record<string, ModelAvailability> = {},
  onlyEmpty = true
): Record<string, string> {
  const catalog = inp.catalog.filter((m) => usable(m, availability))
  const result: Record<string, string> = {}
  const keyOf = (s: Seat): string | null => result[s.id] ?? seatModelKey(s, inp)
  const depthOf = (u: OrgUnit): number => {
    let d = 0
    for (let p = u; p.parentId; d++) p = inp.units.find((x) => x.id === p.parentId) ?? { ...p, parentId: null }
    return d
  }
  const unitOf = (s: Seat): OrgUnit | undefined => inp.units.find((u) => u.id === s.unitId)
  const todo = (s: Seat): boolean => !s.agentId && (!onlyEmpty || !s.modelId)

  // order: CEOs, then managers/workers, then reviewers (they depend on the workers' choices)
  const phase = (s: Seat): number => (s.job === 'ceo' ? 0 : REVIEWER_JOBS.includes(s.job) ? 2 : 1)
  const seats = [...inp.seats].sort((a, b) => phase(a) - phase(b))
  const ceoCompanies: string[] = []

  for (const s of seats) {
    if (!todo(s)) continue
    const unit = unitOf(s)
    const wanted = recommendTier(s, unit ? depthOf(unit) : 0)
    const siblings = inp.seats.filter((x) => x.unitId === s.unitId && x.id !== s.id)
    const usedHere = new Set(siblings.map(keyOf).filter((k): k is string => !!k))

    let pool = catalog
    let minTier = tierRank(wanted)
    if (REVIEWER_JOBS.includes(s.job) && unit) {
      const scope = new Set(descendants(inp.units, unit.id))
      const workers = inp.seats.filter((x) => scope.has(x.unitId) && WORKER_JOBS.includes(x.job))
      const workerKeys = new Set(workers.map(keyOf).filter((k): k is string => !!k))
      let strongest = 0
      for (const w of workers) {
        const e = entryOf(keyOf(w), inp.catalog)
        if (e) strongest = Math.max(strongest, tierRank(e.tier))
      }
      minTier = Math.max(minTier, strongest)
      if (rules.reviewerDiffers) {
        const other = pool.filter((m) => !workerKeys.has(m.id))
        if (other.length) pool = other
      }
    }
    // exact tier first, then stronger, then weaker; the jobs a model is suited to break ties
    const rankScore = (m: ModelEntry): number => {
      const t = tierRank(m.tier)
      const base = t === minTier ? 0 : t > minTier ? 10 * (t - minTier) : 100 * (minTier - t)
      return base - (m.domains.includes(s.job) ? 1 : 0)
    }
    let cands = [...pool].sort((a, b) => rankScore(a) - rankScore(b))
    if (!cands.length) continue

    if (s.job === 'ceo' && rules.ceoTrioDiffers) {
      const taken = new Set(seats.filter((x) => x.job === 'ceo' && x.id !== s.id).map(keyOf).filter((k): k is string => !!k))
      const free = cands.filter((m) => !taken.has(m.id))
      if (free.length) cands = free
      const newCompany = cands.filter((m) => !ceoCompanies.includes(m.company))
      if (newCompany.length) cands = newCompany
    } else if (rules.minModelsPerTeam) {
      const fresh = cands.filter((m) => !usedHere.has(m.id))
      // prefer a model new to the team, but never leave the right tier for it unless nothing else fits
      const sameTier = fresh.filter((m) => tierRank(m.tier) === minTier)
      if (sameTier.length) cands = sameTier
      else if (usedHere.size === 1 && fresh.length) cands = fresh
    }
    const pick = cands[0]
    result[s.id] = pick.id
    if (s.job === 'ceo') ceoCompanies.push(pick.company)
  }
  return result
}
