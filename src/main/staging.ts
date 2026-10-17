import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { Task } from '../shared/types'
import type { Hive } from './hive'

/** Folder inside the work folder where attachments are placed for the length of a run. */
export const STAGE_DIR = '.hivedesk'

export interface Staged {
  /** attachment `rel` → the path the agent should open */
  paths: Map<string, string>
  /** Remove the copies (and the folder, if nothing else is in it). Safe to call twice. */
  cleanup(): void
}

function inside(parent: string, child: string): boolean {
  const r = relative(resolve(parent), resolve(child))
  return !!r && !r.startsWith('..') && !r.startsWith(sep) && !/^[A-Za-z]:/.test(r)
}

/**
 * Attachments live in the hive, outside the folder the agent works in, so most CLIs refuse to read
 * them. For the run we copy them into `<work folder>/.hivedesk/attachments/<task id>/` and hand the
 * agent those paths; change tracking ignores that folder and `cleanup()` removes it afterwards.
 */
export function stageAttachments(task: Task, hive: Hive, cwd: string): Staged {
  const paths = new Map<string, string>()
  const base = join(cwd, STAGE_DIR, 'attachments', task.id)
  let made = false
  for (const a of task.attachments ?? []) {
    const src = hive.attachmentPath(a)
    if (!existsSync(src)) continue
    if (inside(cwd, src)) {
      paths.set(a.rel, src) // already within reach (agent works in the hive folder)
      continue
    }
    try {
      mkdirSync(base, { recursive: true })
      made = true
      const dest = join(base, basename(a.rel))
      copyFileSync(src, dest)
      paths.set(a.rel, dest)
    } catch {
      paths.set(a.rel, src) // could not copy (read-only folder?): fall back to the original
    }
  }
  const cleanup = (): void => {
    if (!made) return
    made = false
    try {
      rmSync(base, { recursive: true, force: true })
      const att = join(cwd, STAGE_DIR, 'attachments')
      if (existsSync(att) && readdirSync(att).length === 0) rmSync(att, { recursive: true, force: true })
      const top = join(cwd, STAGE_DIR)
      if (existsSync(top) && readdirSync(top).length === 0) rmSync(top, { recursive: true, force: true })
    } catch {
      /* leftovers are harmless and removed by the next run */
    }
  }
  return { paths, cleanup }
}
