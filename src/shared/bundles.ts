import { FINISHED, rootOf, subtree } from './tree'
import type { Task } from './types'

/** A delegated job as one unit: the planning task and everything below it. */
export interface Bundle {
  root: Task
  total: number
  done: number
  /** Not finished and not running. */
  waiting: number
  running: number
  held: number
  remaining: number
  /** The latest time anything in the bundle changed (or the person confirmed it). */
  lastActivity: string
  progress: number
}

/** The delegated bundles of a company (root tasks that have a plan), newest activity first. */
export function bundlesOf(all: Task[]): Bundle[] {
  const out: Bundle[] = []
  for (const root of all) {
    if (root.parentId || root.hidden || !root.plan || root.plan.status !== 'approved') continue
    const tasks = subtree(all, root.id).filter((t) => !t.hidden && !t.reviewOf)
    const work = tasks.filter((t) => t.id !== root.id)
    const done = work.filter((t) => t.status === 'done' || t.status === 'cancelled').length
    const running = tasks.filter((t) => t.status === 'running' || t.status === 'in_review').length
    const held = tasks.filter((t) => t.status === 'held').length
    const open = work.filter((t) => !FINISHED.includes(t.status))
    const last = [...tasks.map((t) => t.updatedAt), root.staleOkAt ?? ''].sort().pop() ?? root.updatedAt
    out.push({
      root,
      total: work.length,
      done,
      waiting: open.filter((t) => t.status !== 'running' && t.status !== 'in_review' && t.status !== 'held').length,
      running,
      held,
      remaining: open.length,
      lastActivity: last,
      progress: work.length ? done / work.length : 0
    })
  }
  return out.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
}

/** Is a bundle with work left old enough that nothing should start by itself without asking? */
export function isStale(b: Bundle, hours: number, now = Date.now()): boolean {
  return hours > 0 && b.remaining > 0 && b.running === 0 && now - new Date(b.lastActivity).getTime() > hours * 3600e3
}

export { rootOf }
