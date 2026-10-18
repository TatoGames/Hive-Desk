import type { Approval, LiveSummary, Task } from './types'

export type EmployeeState = 'idle' | 'working' | 'reviewing' | 'waiting-input' | 'waiting-approval' | 'limit' | 'error' | 'held'

export const STATE_LABEL: Record<EmployeeState, string> = {
  idle: '대기',
  working: '작업 중',
  reviewing: '검토 중',
  'waiting-input': '자료 대기',
  'waiting-approval': '결재 대기',
  limit: '한도 대기',
  error: '오류',
  held: '보류'
}

/** Colors of the state chips (CSS variables with fallbacks). */
export const STATE_COLOR: Record<EmployeeState, string> = {
  idle: '#8b93a1',
  working: '#3b82f6',
  reviewing: '#a855f7',
  'waiting-input': '#e0a100',
  'waiting-approval': '#e0a100',
  limit: '#f97316',
  error: '#ef4444',
  held: '#6b7280'
}

export interface EmployeeView {
  state: EmployeeState
  /** The task the state is about (the one running, or the one waiting). */
  task?: Task
  /** Ready tasks waiting in this person's queue. */
  queued: Task[]
}

/** What one employee is doing right now, from the board's data. */
export function employeeState(
  agentId: string,
  tasks: Task[],
  approvals: Approval[],
  running: string[],
  limited: boolean
): EmployeeView {
  const mine = tasks.filter((t) => t.assignee === agentId && !(t.hidden && t.kind !== 'committee'))
  const queued = mine.filter((t) => t.status === 'todo' && !running.includes(t.id))
  const run = mine.find((t) => running.includes(t.id) || t.status === 'running')
  if (run) return { state: run.kind === 'review' ? 'reviewing' : 'working', task: run, queued }
  const ask = mine.find((t) => t.status === 'needs_input')
  if (ask) return { state: 'waiting-input', task: ask, queued }
  const approval = mine.find(
    (t) => t.status === 'awaiting_approval' || approvals.some((a) => a.status === 'pending' && a.taskId === t.id)
  )
  if (approval) return { state: 'waiting-approval', task: approval, queued }
  const held = mine.find((t) => t.status === 'held')
  if (held && !queued.length) return { state: 'held', task: held, queued }
  if (limited && queued.length) return { state: 'limit', task: queued[0], queued }
  const failed = mine.filter((t) => t.status === 'failed').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0]
  if (failed) return { state: 'error', task: failed, queued }
  return { state: 'idle', queued }
}

/**
 * Progress 0..1 of a task. A task with sub-tasks is the average of them, weighted by their
 * expected number of AI runs; a plain task follows the agent's own checklist when it has one,
 * else its status. This is what the AI reported, so it is a hint — read it together with the changes.
 */
export function progressOf(t: Task, all: Task[], live: Record<string, LiveSummary> = {}, depth = 0): number {
  if (t.status === 'done') return 1
  const kids = depth > 6 ? [] : all.filter((x) => x.parentId === t.id && !x.hidden)
  if (kids.length) {
    let sum = 0
    let w = 0
    for (const k of kids) {
      const weight = Math.max(1, k.plan?.estimateRuns ?? 1)
      sum += weight * progressOf(k, all, live, depth + 1)
      w += weight
    }
    const avg = w ? sum / w : 0
    return t.kind === 'integrate' ? Math.max(0.9, avg) : Math.min(0.9, avg)
  }
  switch (t.status) {
    case 'in_review':
      return 0.9
    case 'needs_review':
      return 0.95
    case 'running': {
      const plan = live[t.id]?.plan
      if (plan?.length) return Math.min(0.9, (plan.filter((p) => p.done).length / plan.length) * 0.9)
      return t.kind === 'plan' ? 0.05 : 0.3
    }
    case 'needs_input':
    case 'awaiting_approval':
      return 0.1
    case 'delegated':
      return 0.05
    default:
      return 0
  }
}

export interface TreeNode {
  task: Task
  progress: number
  children: TreeNode[]
}

/** Root tasks of delegations (those with sub-tasks, or started as delegated) as trees. */
export function delegationTrees(all: Task[], live: Record<string, LiveSummary> = {}): TreeNode[] {
  const visible = all.filter((t) => !t.hidden)
  const build = (t: Task, depth: number): TreeNode => ({
    task: t,
    progress: progressOf(t, all, live),
    children: depth > 6 ? [] : visible.filter((x) => x.parentId === t.id).map((x) => build(x, depth + 1))
  })
  const roots = visible.filter((t) => !t.parentId && (t.kind || visible.some((x) => x.parentId === t.id)))
  return roots.map((r) => build(r, 0))
}

/** Who handed work to whom, for the lines on the office floor (only work that is still going). */
export function handoffs(all: Task[]): { from: string; to: string; taskId: string }[] {
  const byId = new Map(all.map((t) => [t.id, t]))
  const out: { from: string; to: string; taskId: string }[] = []
  for (const t of all) {
    if (!t.parentId || t.hidden || t.status === 'done') continue
    const parent = byId.get(t.parentId)
    if (parent?.assignee && t.assignee && parent.assignee !== t.assignee) out.push({ from: parent.assignee, to: t.assignee, taskId: t.id })
  }
  return out
}
