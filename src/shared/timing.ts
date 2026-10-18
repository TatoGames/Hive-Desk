import type { Approval, RunSummary, Task, TaskEvent } from './types'

/** Where the time of one task went (ms). */
export interface TimeBreakdown {
  total: number
  ai: number
  folder: number
  approval: number
  asking: number
  other: number
}

/** AI run / waiting for the folder / waiting for a decision / waiting for an answer — so the person sees what holds a task back. */
export function timeBreakdown(task: Task, events: TaskEvent[], runs: Pick<RunSummary, 'durationMs' | 'outcome'>[], approvals: Approval[], now = Date.now()): TimeBreakdown {
  const start = new Date(task.createdAt).getTime()
  const end = task.status === 'done' || task.status === 'cancelled' || task.status === 'failed' ? new Date(task.finishedAt ?? task.updatedAt).getTime() : now
  const total = Math.max(0, end - start)
  let ai = runs.filter((r) => r.outcome !== 'running').reduce((n, r) => n + (r.durationMs || 0), 0)
  if (task.status === 'running' && task.startedAt) ai += Math.max(0, now - new Date(task.startedAt).getTime())
  const approval = approvals
    .filter((a) => a.taskId === task.id)
    .reduce((n, a) => n + Math.max(0, (a.decidedAt ? new Date(a.decidedAt).getTime() : now) - new Date(a.createdAt).getTime()), 0)
  // the agent asked → the human answered
  let asking = 0
  let askedAt: number | null = null
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (e.kind === 'need') askedAt = new Date(e.at).getTime()
    else if (e.kind === 'reply' && askedAt !== null) {
      asking += new Date(e.at).getTime() - askedAt
      askedAt = null
    }
  }
  if (askedAt !== null && task.status === 'needs_input') asking += Math.max(0, now - askedAt)
  const folder = task.folderWaitMs ?? 0
  const other = Math.max(0, total - ai - folder - approval - asking)
  return { total, ai, folder, approval, asking, other }
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`
}
