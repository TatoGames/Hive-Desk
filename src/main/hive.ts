import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  Agent,
  Approval,
  ApprovalKind,
  MemoryEntry,
  Message,
  RosterEntry,
  Task,
  Usage
} from '../shared/types'

export function newId(): string {
  return Date.now().toString(36) + '-' + randomBytes(3).toString('hex')
}

export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return out || 'x'
}

function now(): string {
  return new Date().toISOString()
}

function writeJson(file: string, data: unknown): void {
  const tmp = file + '.' + randomBytes(3).toString('hex') + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function listJson<T>(dir: string): T[] {
  if (!existsSync(dir)) return []
  const out: T[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const v = readJson<T>(join(dir, f))
    if (v) out.push(v)
  }
  return out
}

/**
 * The hive is a plain folder of small JSON/markdown files — one file per item,
 * so it merges cleanly in git when a team shares it. Anything under `.local/`
 * (budget usage) is per-machine and never synced.
 */
export class Hive {
  constructor(public readonly root: string) {
    for (const d of ['tasks', 'approvals', 'inbox', 'memory', 'agents', '.local/usage']) {
      mkdirSync(join(root, d), { recursive: true })
    }
    const gi = join(root, '.gitignore')
    if (!existsSync(gi)) writeFileSync(gi, '.local/\n*.tmp\n', 'utf8')
  }

  private p(...parts: string[]): string {
    return join(this.root, ...parts)
  }

  // ---- tasks ----
  listTasks(): Task[] {
    return listJson<Task>(this.p('tasks')).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  getTask(id: string): Task | null {
    return readJson<Task>(this.p('tasks', id + '.json'))
  }

  createTask(input: {
    title: string
    description?: string
    assignee?: string | null
    risky?: boolean
    dependsOn?: string[]
    createdBy: string
  }): Task {
    const t: Task = {
      id: newId(),
      title: input.title.trim(),
      description: input.description?.trim() ?? '',
      assignee: input.assignee ?? null,
      status: 'todo',
      risky: !!input.risky,
      dependsOn: input.dependsOn ?? [],
      createdBy: input.createdBy,
      createdAt: now(),
      updatedAt: now(),
      cleared: [],
      notes: []
    }
    writeJson(this.p('tasks', t.id + '.json'), t)
    return t
  }

  updateTask(id: string, patch: Partial<Task>): Task {
    const cur = this.getTask(id)
    if (!cur) throw new Error('task not found: ' + id)
    const next: Task = { ...cur, ...patch, id: cur.id, updatedAt: now() }
    writeJson(this.p('tasks', id + '.json'), next)
    return next
  }

  deleteTask(id: string): void {
    rmSync(this.p('tasks', id + '.json'), { force: true })
  }

  /** A task is ready when it is `todo` and every dependency is `done`. */
  isReady(t: Task, all: Task[]): boolean {
    if (t.status !== 'todo') return false
    return t.dependsOn.every((d) => all.find((x) => x.id === d)?.status === 'done')
  }

  // ---- approvals ----
  listApprovals(): Approval[] {
    return listJson<Approval>(this.p('approvals')).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
  }

  createApproval(input: {
    kind: ApprovalKind
    taskId: string
    agentId: string
    reason: string
  }): Approval {
    const a: Approval = { id: newId(), status: 'pending', createdAt: now(), ...input }
    writeJson(this.p('approvals', a.id + '.json'), a)
    return a
  }

  hasPendingApproval(taskId: string, kind: ApprovalKind): boolean {
    return this.listApprovals().some(
      (a) => a.taskId === taskId && a.kind === kind && a.status === 'pending'
    )
  }

  /** Approve → task goes back to `todo` with the kind cleared. Reject → task fails. */
  decideApproval(id: string, decision: 'approved' | 'rejected', by: string): Approval {
    const a = readJson<Approval>(this.p('approvals', id + '.json'))
    if (!a) throw new Error('approval not found: ' + id)
    if (a.status !== 'pending') return a
    const next: Approval = { ...a, status: decision, decidedAt: now(), decidedBy: by }
    writeJson(this.p('approvals', id + '.json'), next)

    const task = this.getTask(a.taskId)
    if (task) {
      if (decision === 'approved') {
        const notes =
          a.kind === 'agent-request'
            ? [...task.notes, `${by} 님이 승인함: ${a.reason}`]
            : task.notes
        this.updateTask(task.id, {
          status: 'todo',
          cleared: Array.from(new Set([...task.cleared, a.kind])),
          notes
        })
      } else {
        this.updateTask(task.id, {
          status: 'failed',
          error: `${by} 님이 거절함: ${a.reason}`,
          finishedAt: now()
        })
      }
    }
    return next
  }

  // ---- messages ----
  sendMessage(from: string, to: string, body: string): Message {
    const m: Message = { id: newId(), from, to, body: body.trim(), createdAt: now(), read: false }
    const dir = this.p('inbox', slug(to))
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, m.id + '.json'), m)
    return m
  }

  listInbox(agentId: string): Message[] {
    return listJson<Message>(this.p('inbox', slug(agentId))).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
  }

  markRead(agentId: string, messageId: string): void {
    const f = this.p('inbox', slug(agentId), messageId + '.json')
    const m = readJson<Message>(f)
    if (m && !m.read) writeJson(f, { ...m, read: true })
  }

  // ---- shared memory (append-only entries: never conflicts in git) ----
  addMemory(author: string, text: string): MemoryEntry {
    const e: MemoryEntry = { id: newId(), author, text: text.trim(), createdAt: now() }
    writeJson(this.p('memory', e.id + '.json'), e)
    return e
  }

  listMemory(limit = 200): MemoryEntry[] {
    const all = listJson<MemoryEntry>(this.p('memory')).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
    return all.slice(-limit)
  }

  deleteMemory(id: string): void {
    rmSync(this.p('memory', id + '.json'), { force: true })
  }

  // ---- roster (public view of agents so teammates can assign tasks) ----
  publishAgent(a: Agent): void {
    const r: RosterEntry = {
      id: a.id,
      name: a.name,
      owner: a.owner,
      adapter: a.adapter,
      role: a.role
    }
    writeJson(this.p('agents', a.id + '.json'), r)
  }

  unpublishAgent(id: string): void {
    rmSync(this.p('agents', id + '.json'), { force: true })
  }

  listRoster(): RosterEntry[] {
    return listJson<RosterEntry>(this.p('agents')).sort((a, b) => a.id.localeCompare(b.id))
  }

  // ---- per-machine budget usage ----
  private usageFile(day: string): string {
    return this.p('.local', 'usage', day + '.json')
  }

  static today(d = new Date()): string {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  usageToday(d = new Date()): Record<string, Usage> {
    return readJson<Record<string, Usage>>(this.usageFile(Hive.today(d))) ?? {}
  }

  recordUsage(agentId: string, ms: number, d = new Date()): void {
    const all = this.usageToday(d)
    const cur = all[agentId] ?? { runs: 0, ms: 0 }
    all[agentId] = { runs: cur.runs + 1, ms: cur.ms + Math.max(0, ms) }
    writeJson(this.usageFile(Hive.today(d)), all)
  }
}
