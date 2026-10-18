import type { Task } from './types'

/** The root of the delegation tree a task belongs to (itself when it has no parent). */
export function rootOf(all: Task[], t: Task): Task {
  let cur = t
  for (let i = 0; i < 12; i++) {
    const up = cur.parentId ?? cur.reviewOf
    const parent = up ? all.find((x) => x.id === up) : undefined
    if (!parent) break
    cur = parent
  }
  return cur
}

/** The task and everything below it: sub-tasks, their reviews, their sub-tasks … */
export function subtree(all: Task[], rootId: string): Task[] {
  const out = new Map<string, Task>()
  const root = all.find((t) => t.id === rootId)
  if (!root) return []
  out.set(root.id, root)
  let grew = true
  while (grew) {
    grew = false
    for (const t of all) {
      if (out.has(t.id)) continue
      if ((t.parentId && out.has(t.parentId)) || (t.reviewOf && out.has(t.reviewOf))) {
        out.set(t.id, t)
        grew = true
      }
    }
  }
  return [...out.values()]
}

/** Statuses that are over: nothing more will run. */
export const FINISHED: Task['status'][] = ['done', 'cancelled']
export const isActive = (t: Task): boolean => !FINISHED.includes(t.status) && t.status !== 'failed'

export interface CancelPreview {
  running: number
  waiting: number
  done: number
  held: number
  ids: { running: string[]; waiting: string[] }
}

/**
 * What a cancel would touch. `pending` keeps what is running (and what is already done) and cancels only what has not started.
 */
export function cancelTargets(all: Task[], rootId: string, scope: 'this' | 'tree' | 'pending', runningIds: string[]): { cancel: Task[]; preview: CancelPreview } {
  const root = all.find((t) => t.id === rootId)
  const pool = scope === 'this' ? (root ? [root] : []) : subtree(all, rootId)
  const isRunning = (t: Task): boolean => runningIds.includes(t.id) || t.status === 'running'
  const live = pool.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
  const cancel = scope === 'pending' ? live.filter((t) => !isRunning(t) && t.id !== rootId) : live
  const preview: CancelPreview = {
    running: live.filter(isRunning).length,
    waiting: live.filter((t) => !isRunning(t) && t.status !== 'held').length,
    held: live.filter((t) => t.status === 'held').length,
    done: pool.filter((t) => t.status === 'done').length,
    ids: { running: live.filter(isRunning).map((t) => t.id), waiting: live.filter((t) => !isRunning(t)).map((t) => t.id) }
  }
  return { cancel, preview }
}
