import type { Agenda } from './types'

/** `[[VOTE: 2 | 이유]]` → proposal number and reason. */
export function parseVote(text: string, proposals: number): { choice: number; reason: string } | null {
  const m = /\[\[VOTE:\s*(\d+)\s*(?:\|\s*([\s\S]*?))?\]\]/i.exec(text)
  if (!m) return null
  const choice = Number(m[1])
  if (!Number.isInteger(choice) || choice < 1 || choice > proposals) return null
  return { choice, reason: (m[2] ?? '').trim() }
}

/** Majority wins; a tie (or no vote) means no clear winner (0). Minority = everyone who voted differently. */
export function tally(
  votes: Agenda['votes'],
  proposals: number
): NonNullable<Agenda['recommendation']> {
  const counts = Array.from({ length: proposals }, () => 0)
  for (const v of votes) counts[v.choice - 1]++
  const top = Math.max(0, ...counts)
  const winners = counts.flatMap((c, i) => (c === top && top > 0 ? [i + 1] : []))
  const choice = winners.length === 1 ? winners[0] : 0
  return {
    choice,
    tally: counts,
    minority: choice ? votes.filter((v) => v.choice !== choice) : votes
  }
}

export const PHASE_LABEL: Record<Agenda['phase'], string> = {
  proposals: '각자 제안 중',
  critique: '서로 비판 중',
  votes: '투표 중',
  board: '이사회 결정 대기',
  decided: '결정됨',
  failed: '진행 못 함'
}

/** `[[ESCALATE: 질문]]` in a manager's answer: the direction is unclear, ask the committee. */
export function parseEscalation(text: string): string | null {
  const m = /\[\[ESCALATE:\s*([\s\S]*?)\]\]/i.exec(text)
  return m ? m[1].trim() || null : null
}
