import type { ModelEntry, Tier } from './company'
import type { AdapterId, ConnectionCheck } from './types'
import type { LimitInfo } from '../main/limits'

/** A model of a connection (CLI login) that can be hired as an employee. */
export interface ModelAgent {
  id: string
  adapter: AdapterId
  /** Catalog id of the model. */
  modelId: string
  createdAt: string
}

export type ModelAgentStatus = 'unchecked' | 'ok' | 'unavailable'

export interface ModelAgentView {
  id: string
  adapter: AdapterId
  modelId: string
  label: string
  tier: Tier
  weight: number
  status: ModelAgentStatus
  message?: string
  /** Name confirmed (catalog `verified`) or listed by the account. */
  verified: boolean
}

export interface ConnectionView {
  adapter: AdapterId
  check?: ConnectionCheck
  limit?: LimitInfo
  /** Can this CLI list the models of the login? */
  canList: boolean
  models: ModelAgentView[]
  /** Company ids, highest priority first. */
  order: string[]
}

/** One line of the auto-connect preview table. */
export interface AutoRow {
  seatId: string
  seatTitle: string
  unitName: string
  job: string
  recommended: string | null
  recommendedLabel: string
  /** Is the recommended model usable here (connected and not known to be unavailable)? */
  usable: boolean
  chosen: string | null
  chosenLabel: string
  substituted: boolean
  /** Model agent that would be hired. */
  modelAgentId: string | null
  note: string
}

export const modelAgentId = (adapter: AdapterId, modelId: string): string => `ma-${adapter}-${modelId}`

/** Same tier first, then stronger, then weaker: the closest usable stand-in for a model. */
export function substituteFor(wanted: ModelEntry | undefined, usable: ModelEntry[]): ModelEntry | undefined {
  if (!usable.length) return undefined
  if (!wanted) return usable[0]
  const rank: Record<Tier, number> = { light: 1, balanced: 2, top: 3 }
  const w = rank[wanted.tier]
  const score = (m: ModelEntry): number => {
    const t = rank[m.tier]
    return t === w ? 0 : t > w ? 10 * (t - w) : 100 * (w - t)
  }
  return [...usable].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id))[0]
}
