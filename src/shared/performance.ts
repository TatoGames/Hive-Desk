import type { AptitudeRecord } from './aptitude'
import type { ModelEntry } from './company'
import type { Task } from './types'

export interface PerfRow {
  key: string
  label: string
  tasks: number
  done: number
  failed: number
  /** Cross-review rounds that asked for changes. */
  changeRounds: number
  passed: number
  runs: number
  minutes: number
  /** runs × relative limit weight of the model. */
  load: number
}

const blank = (key: string, label: string): PerfRow => ({
  key, label, tasks: 0, done: 0, failed: 0, changeRounds: 0, passed: 0, runs: 0, minutes: 0, load: 0
})

export interface PerfInput {
  tasks: Task[]
  aptitude: AptitudeRecord[]
  catalog: ModelEntry[]
  /** agent id → { name, unit id } */
  agents: Record<string, { name: string; unitId?: string }>
  units: Record<string, string>
}

/** Per agent, per unit and per model: how much was done, how well, and how much limit it used. */
export function performance(inp: PerfInput): { agents: PerfRow[]; units: PerfRow[]; models: PerfRow[] } {
  const agents = new Map<string, PerfRow>()
  const units = new Map<string, PerfRow>()
  for (const t of inp.tasks) {
    if (!t.assignee || t.hidden) continue
    const who = inp.agents[t.assignee]
    const rows = [get(agents, t.assignee, who?.name ?? t.assignee)]
    if (who?.unitId) rows.push(get(units, who.unitId, inp.units[who.unitId] ?? who.unitId))
    for (const r of rows) {
      r.tasks++
      if (t.status === 'done') r.done++
      if (t.status === 'failed') r.failed++
      r.changeRounds += t.reviewState?.round ?? 0
      if (t.reviewState?.status === 'passed') r.passed++
    }
  }
  const models = new Map<string, PerfRow>()
  for (const a of inp.aptitude) {
    const r = get(models, a.modelKey, a.modelLabel)
    const w = inp.catalog.find((m) => m.id === a.modelKey)?.weight ?? 1
    r.tasks++
    r.done += a.approved
    r.failed += a.failed
    r.changeRounds += a.changes
    r.runs += a.runs
    r.minutes += Math.round(a.ms / 60000)
    r.load += a.runs * w
  }
  const sort = (m: Map<string, PerfRow>): PerfRow[] => [...m.values()].sort((a, b) => b.tasks - a.tasks)
  return { agents: sort(agents), units: sort(units), models: sort(models) }
}

function get(m: Map<string, PerfRow>, key: string, label: string): PerfRow {
  let r = m.get(key)
  if (!r) m.set(key, (r = blank(key, label)))
  return r
}
