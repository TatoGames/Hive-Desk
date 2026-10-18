import type { Company, OrgUnit, Seat } from './company'
import type { Agent } from './types'

/**
 * v0.6: a team saved once and set up again in any company — the org chart and the employees on it.
 * Kept per computer (paths and logins belong to this machine; work folders are not saved).
 */

export type TeamMember = Pick<
  Agent,
  'name' | 'adapter' | 'role' | 'extraArgs' | 'dailyRunLimit' | 'dailyMinuteLimit' | 'timeoutMinutes' | 'requireApproval' | 'job' | 'modelRef' | 'permission' | 'command'
> & {
  /** The seat (id in `seats`) the member sat on. */
  seat?: string
}

export interface TeamTemplate {
  id: string
  name: string
  savedAt: string
  /** The company it was saved from. */
  from: string
  company: Pick<Company, 'templateId' | 'ranks' | 'rules' | 'bigJobRuns'>
  units: OrgUnit[]
  /** Seats without their holder (`agentId` is gone; members point at their seat). */
  seats: Omit<Seat, 'agentId'>[]
  members: TeamMember[]
}

export interface TeamSummary {
  id: string
  name: string
  savedAt: string
  from: string
  units: number
  seats: number
  members: number
  /** "Claude 3 · Codex 2" */
  adapters: string
}

export function summarize(t: TeamTemplate): TeamSummary {
  const by = new Map<string, number>()
  for (const m of t.members) by.set(m.adapter, (by.get(m.adapter) ?? 0) + 1)
  return {
    id: t.id,
    name: t.name,
    savedAt: t.savedAt,
    from: t.from,
    units: t.units.length,
    seats: t.seats.length,
    members: t.members.length,
    adapters: [...by].map(([a, n]) => `${ADAPTER_NAME[a] ?? a} ${n}`).join(' · ')
  }
}

const ADAPTER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', custom: '직접 지정' }

/** `name`, `name 2`, `name 3` … — the first one not in `taken`. */
export function freeName(base: string, taken: (name: string) => boolean): string {
  const b = base.trim() || '직원'
  if (!taken(b)) return b
  for (let i = 2; i < 1000; i++) if (!taken(`${b} ${i}`)) return `${b} ${i}`
  return `${b} ${Date.now()}`
}
