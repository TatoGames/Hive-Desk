import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AptitudeRecord } from '../shared/aptitude'
import type { ModelAgent } from '../shared/connections'
import type { ExternalItem } from '../shared/collab'
import type { Company, ModelAvailability, OrgUnit, Seat } from '../shared/company'
import type {
  Agent,
  Approval,
  ApprovalKind,
  Attachment,
  MemoryEntry,
  Message,
  PermissionLevel,
  Project,
  RunShared,
  ConnectionCheck,
  Agenda,
  FinalReport,
  RosterEntry,
  RunRecord,
  RunSummary,
  Task,
  TaskEvent,
  TaskEventKind,
  Usage
} from '../shared/types'

/** Folders of shared (git-synced) hive data. Anything else lives under `.local/`. */
export const SHARED_DIRS = ['tasks', 'approvals', 'inbox', 'memory', 'agents', 'events', 'attachments', 'projects', 'reports', 'company', 'aptitude', 'finals', 'agenda', 'external']

export function newId(): string {
  return Date.now().toString(36) + '-' + randomBytes(3).toString('hex')
}

let eventSeq = 0
/** Sortable in creation order even when several events land in the same millisecond. */
function eventId(): string {
  const n = (eventSeq++ % 1_679_616).toString(36).padStart(4, '0')
  return Date.now().toString(36) + '-' + n + '-' + randomBytes(2).toString('hex')
}

export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return out || 'x'
}

const APPROVAL_LABEL: Record<ApprovalKind, string> = {
  'risky-task': '위험 작업',
  budget: '예산',
  'agent-request': '에이전트 요청',
  plan: '분배 계획'
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
  /**
   * `id` is the company this hive belongs to ('' for the computer-wide store, which has no shared folders).
   */
  constructor(
    public readonly root: string,
    public readonly id = '',
    opts: { shared?: boolean } = {}
  ) {
    const shared = opts.shared !== false
    for (const d of [...(shared ? SHARED_DIRS : []), '.local/usage', '.local/runs', '.local/attachments', '.local/checkpoints']) {
      mkdirSync(join(root, d), { recursive: true })
    }
    const gi = join(root, '.gitignore')
    if (shared && !existsSync(gi)) writeFileSync(gi, '.local/\n*.tmp\n', 'utf8')
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
    permission?: PermissionLevel
    refDirs?: string[]
    projectId?: string
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
      notes: [],
      ...(input.permission ? { permission: input.permission } : {}),
      ...(input.refDirs?.length ? { refDirs: input.refDirs } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {})
    }
    writeJson(this.p('tasks', t.id + '.json'), t)
    const perm = t.permission === 'read' ? ' · 읽기만' : t.permission === 'exec' ? ' · 명령 실행 허용' : ''
    this.addEvent(
      t.id,
      'created',
      t.createdBy,
      `태스크를 만들었어요 · 담당 ${t.assignee ?? '미배정'}${t.risky ? ' · 위험 표시' : ''}${perm}`
    )
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
    rmSync(this.p('events', id), { recursive: true, force: true })
    rmSync(this.p('.local', 'runs', id), { recursive: true, force: true })
    rmSync(this.p('attachments', id), { recursive: true, force: true })
    rmSync(this.p('reports', id), { recursive: true, force: true })
    rmSync(this.p('.local', 'attachments', id), { recursive: true, force: true })
  }

  // ---- attachments (files the human hands to a task) ----
  /** Absolute path of an attachment on this machine. */
  attachmentPath(a: Attachment): string {
    return this.p(...a.rel.split('/'))
  }

  /**
   * Copy a file into the task's folder. Files up to `shareMaxMB` live in the shared hive (teammates
   * get them through git); bigger ones stay on this machine only.
   */
  addAttachment(
    taskId: string,
    source: { path: string } | { name: string; data: Buffer },
    by: string,
    shareMaxMB: number
  ): Attachment {
    const task = this.getTask(taskId)
    if (!task) throw new Error('task not found: ' + taskId)
    const rawName = 'path' in source ? basename(source.path) : source.name
    const clean = rawName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file'
    const size = 'path' in source ? statSync(source.path).size : source.data.length
    const local = size > Math.max(0, shareMaxMB) * 1024 * 1024
    const root = local ? ['.local', 'attachments', taskId] : ['attachments', taskId]
    const dir = this.p(...root)
    mkdirSync(dir, { recursive: true })
    const dot = clean.lastIndexOf('.')
    const stem = dot > 0 ? clean.slice(0, dot) : clean
    const ext = dot > 0 ? clean.slice(dot) : ''
    let name = clean
    for (let i = 2; existsSync(join(dir, name)); i++) name = `${stem}-${i}${ext}`
    if ('path' in source) copyFileSync(source.path, join(dir, name))
    else writeFileSync(join(dir, name), source.data)
    const att: Attachment = {
      name,
      rel: [...root, name].join('/'),
      size,
      local,
      addedBy: by,
      addedAt: now()
    }
    this.updateTask(taskId, { attachments: [...(task.attachments ?? []), att] })
    this.addEvent(taskId, 'status', by, `자료를 첨부했어요: ${name}${local ? ' (용량이 커서 이 컴퓨터에만 보관)' : ''}`)
    return att
  }

  removeAttachment(taskId: string, rel: string, by: string): void {
    const task = this.getTask(taskId)
    const att = task?.attachments?.find((a) => a.rel === rel)
    if (!task || !att) return
    rmSync(this.attachmentPath(att), { force: true })
    this.updateTask(taskId, { attachments: (task.attachments ?? []).filter((a) => a.rel !== rel) })
    this.addEvent(taskId, 'status', by, `첨부를 뺐어요: ${att.name}`)
  }

  // ---- timeline events (append-only, shared) ----
  addEvent(
    taskId: string,
    kind: TaskEventKind,
    actor: string,
    text: string,
    runId?: string
  ): TaskEvent {
    const e: TaskEvent = { id: eventId(), taskId, at: now(), kind, actor, text, ...(runId ? { runId } : {}) }
    const dir = this.p('events', taskId)
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, e.id + '.json'), e)
    return e
  }

  listEvents(taskId: string): TaskEvent[] {
    return listJson<TaskEvent>(this.p('events', taskId)).sort(
      (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)
    )
  }

  // ---- run records (per machine, never overwritten: one file per execution) ----
  addRun(r: RunRecord): void {
    const dir = this.p('.local', 'runs', r.taskId)
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, r.id + '.json'), r)
  }

  /** The newest run of a task that has not finished (the app was closed during it). */
  unfinishedRun(taskId: string): RunRecord | null {
    const all = listJson<RunRecord>(this.p('.local', 'runs', taskId)).filter((r) => r.outcome === 'running')
    all.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    return all[0] ?? null
  }

  checkpointDir(runId: string): string {
    return this.p('.local', 'checkpoints', runId)
  }

  getRun(taskId: string, runId: string): RunRecord | null {
    return readJson<RunRecord>(this.p('.local', 'runs', taskId, runId + '.json'))
  }

  listRuns(taskId: string): RunSummary[] {
    return listJson<RunRecord>(this.p('.local', 'runs', taskId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
      .map((r) => {
        const { prompt: _p, response: _r, stderr: _s, diff, ...rest } = r
        return {
          ...rest,
          diffStat: {
            available: diff.available,
            files: diff.files.length,
            additions: diff.files.reduce((n, f) => n + f.additions, 0),
            deletions: diff.files.reduce((n, f) => n + f.deletions, 0)
          }
        }
      })
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
    this.addEvent(a.taskId, 'approval_requested', a.agentId, `결재 요청 (${APPROVAL_LABEL[a.kind]}): ${a.reason}`)
    return a
  }

  hasPendingApproval(taskId: string, kind: ApprovalKind): boolean {
    return this.listApprovals().some(
      (a) => a.taskId === taskId && a.kind === kind && a.status === 'pending'
    )
  }

  /** Approve → task goes back to `todo` with the kind cleared. Reject → task fails. */
  decideApproval(id: string, decision: 'approved' | 'rejected', by: string, note?: string): Approval {
    const a = readJson<Approval>(this.p('approvals', id + '.json'))
    if (!a) throw new Error('approval not found: ' + id)
    if (a.status !== 'pending') return a
    const next: Approval = { ...a, status: decision, decidedAt: now(), decidedBy: by, ...(note ? { note } : {}) }
    writeJson(this.p('approvals', id + '.json'), next)
    this.addEvent(
      a.taskId,
      'approval_decided',
      by,
      `${decision === 'approved' ? '승인' : '거절'} (${APPROVAL_LABEL[a.kind]})`
    )

    const task = this.getTask(a.taskId)
    // a plan's task is moved by the delegation engine (it creates the sub-tasks or sends the plan back)
    if (task && a.kind !== 'plan') {
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
  addMemory(author: string, text: string, kind: 'fixed' | 'recent' = 'recent'): MemoryEntry {
    const e: MemoryEntry = { id: newId(), author, text: text.trim(), createdAt: now(), ...(kind === 'fixed' ? { kind } : {}) }
    writeJson(this.p('memory', e.id + '.json'), e)
    return e
  }

  listMemory(limit = 200): MemoryEntry[] {
    const all = listJson<MemoryEntry>(this.p('memory')).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
    return all.slice(-limit)
  }

  /** Memory for a prompt: every fixed entry, plus the most recent others. */
  memoryForPrompt(recentLimit = 20): { fixed: MemoryEntry[]; recent: MemoryEntry[] } {
    const all = this.listMemory(1000)
    return {
      fixed: all.filter((m) => m.kind === 'fixed'),
      recent: all.filter((m) => m.kind !== 'fixed').slice(-recentLimit)
    }
  }

  setMemoryKind(id: string, kind: 'fixed' | 'recent'): void {
    const f = this.p('memory', id + '.json')
    const m = readJson<MemoryEntry>(f)
    if (!m) return
    const { kind: _old, ...rest } = m
    writeJson(f, kind === 'fixed' ? { ...rest, kind } : rest)
  }

  deleteMemory(id: string): void {
    rmSync(this.p('memory', id + '.json'), { force: true })
  }

  // ---- roster (public view of agents so teammates can assign tasks) ----
  publishAgent(a: Agent, check?: ConnectionCheck): void {
    const prev = readJson<RosterEntry>(this.p('agents', a.id + '.json'))
    const keep = check ?? prev?.check
    const r: RosterEntry = {
      id: a.id,
      name: a.name,
      owner: a.owner,
      adapter: a.adapter,
      role: a.role,
      ...(a.rankId ? { rankId: a.rankId } : {}),
      ...(a.unitId ? { unitId: a.unitId } : {}),
      ...(a.job ? { job: a.job } : {}),
      ...(a.modelRef ? { modelId: a.modelRef.id } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...(keep ? { check: keep } : {})
    }
    writeJson(this.p('agents', a.id + '.json'), r)
  }

  unpublishAgent(id: string): void {
    rmSync(this.p('agents', id + '.json'), { force: true })
  }

  listRoster(): RosterEntry[] {
    return listJson<RosterEntry>(this.p('agents')).sort((a, b) => a.id.localeCompare(b.id))
  }

  // ---- projects (shared) + this computer's folder for each ----
  listProjects(): Project[] {
    return listJson<Project>(this.p('projects')).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  getProject(id: string | undefined): Project | null {
    return id ? readJson<Project>(this.p('projects', id + '.json')) : null
  }

  saveProject(input: Partial<Project> & { name: string; createdBy: string }): Project {
    const cur = input.id ? this.getProject(input.id) : null
    const p: Project = {
      id: cur?.id ?? newId(),
      name: input.name.trim(),
      description: (input.description ?? cur?.description ?? '').trim(),
      briefing: (input.briefing ?? cur?.briefing ?? '').trim(),
      folderName: (input.folderName ?? cur?.folderName ?? '').trim(),
      ...((input.runBudget ?? cur?.runBudget) ? { runBudget: input.runBudget ?? cur?.runBudget } : {}),
      createdBy: cur?.createdBy ?? input.createdBy,
      createdAt: cur?.createdAt ?? now()
    }
    writeJson(this.p('projects', p.id + '.json'), p)
    return p
  }

  deleteProject(id: string): void {
    rmSync(this.p('projects', id + '.json'), { force: true })
    for (const t of this.listTasks()) if (t.projectId === id) this.updateTask(t.id, { projectId: undefined })
  }

  projectPaths(): Record<string, string> {
    return readJson<Record<string, string>>(this.p('.local', 'paths.json')) ?? {}
  }

  setProjectPath(id: string, path: string): void {
    const all = this.projectPaths()
    if (path.trim()) all[id] = path.trim()
    else delete all[id]
    writeJson(this.p('.local', 'paths.json'), all)
  }

  /** This computer's existing folder for the project, if one is set. */
  projectDir(id: string | undefined): string | null {
    if (!id) return null
    const p = this.projectPaths()[id]
    return p && existsSync(p) ? p : null
  }

  // ---- shared run summaries (teammates see what ran on other computers) ----
  addSharedRun(r: RunShared): void {
    const dir = this.p('reports', r.taskId)
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, r.id + '.json'), r)
  }

  listSharedRuns(taskId: string): RunShared[] {
    return listJson<RunShared>(this.p('reports', taskId)).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  // ---- company model (shared: one file per unit / seat, so teammates' edits merge) ----
  getCompany(): Company | null {
    return readJson<Company>(this.p('company', 'company.json'))
  }

  saveCompany(c: Company): void {
    mkdirSync(this.p('company'), { recursive: true })
    writeJson(this.p('company', 'company.json'), c)
  }

  listUnits(): OrgUnit[] {
    return listJson<OrgUnit>(this.p('company', 'units')).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }

  saveUnit(u: OrgUnit): void {
    mkdirSync(this.p('company', 'units'), { recursive: true })
    writeJson(this.p('company', 'units', u.id + '.json'), u)
  }

  deleteUnit(id: string): void {
    rmSync(this.p('company', 'units', id + '.json'), { force: true })
  }

  listSeats(): Seat[] {
    return listJson<Seat>(this.p('company', 'seats')).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.id.localeCompare(b.id))
  }

  saveSeat(s: Seat): void {
    mkdirSync(this.p('company', 'seats'), { recursive: true })
    writeJson(this.p('company', 'seats', s.id + '.json'), s)
  }

  deleteSeat(id: string): void {
    rmSync(this.p('company', 'seats', id + '.json'), { force: true })
  }

  /** Remove the whole org (units + seats); the company file is rewritten by the caller. */
  clearOrg(): void {
    rmSync(this.p('company', 'units'), { recursive: true, force: true })
    rmSync(this.p('company', 'seats'), { recursive: true, force: true })
  }

  // ---- aptitude records (one file per task, shared) ----
  getAptitude(taskId: string): AptitudeRecord | null {
    return readJson<AptitudeRecord>(this.p('aptitude', taskId + '.json'))
  }

  saveAptitude(r: AptitudeRecord): void {
    writeJson(this.p('aptitude', r.taskId + '.json'), r)
  }

  listAptitude(): AptitudeRecord[] {
    return listJson<AptitudeRecord>(this.p('aptitude'))
  }

  // ---- committee agendas (shared) ----
  getAgenda(id: string): Agenda | null {
    return readJson<Agenda>(this.p('agenda', id + '.json'))
  }
  saveAgenda(a: Agenda): void {
    writeJson(this.p('agenda', a.id + '.json'), a)
  }
  // ---- external box: copies that came from other companies (with their source) ----
  listExternal(): ExternalItem[] {
    return listJson<ExternalItem>(this.p('external')).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
  }
  addExternal(i: Omit<ExternalItem, 'id' | 'receivedAt'>): ExternalItem {
    const item: ExternalItem = { ...i, id: newId(), receivedAt: now() }
    writeJson(this.p('external', item.id + '.json'), item)
    return item
  }
  /** Mark the copies of a channel as recalled: kept for the record, never given to an AI again. */
  recallExternal(channelId: string): number {
    let n = 0
    for (const i of this.listExternal()) {
      if (i.channelId === channelId && !i.recalledAt) {
        writeJson(this.p('external', i.id + '.json'), { ...i, recalledAt: now() })
        n++
      }
    }
    return n
  }
  /** What an AI may see: copies not recalled. */
  externalForPrompt(): ExternalItem[] {
    return this.listExternal().filter((i) => !i.recalledAt && i.kind !== 'request')
  }

  listAgendas(): Agenda[] {
    return listJson<Agenda>(this.p('agenda')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  // ---- final reports (shared) ----
  getFinal(taskId: string): FinalReport | null {
    return readJson<FinalReport>(this.p('finals', taskId + '.json'))
  }

  saveFinal(r: FinalReport): void {
    writeJson(this.p('finals', r.id + '.json'), r)
  }

  listFinals(): FinalReport[] {
    return listJson<FinalReport>(this.p('finals')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  // ---- model availability on this computer ----
  availability(): Record<string, ModelAvailability> {
    return readJson<Record<string, ModelAvailability>>(this.p('.local', 'model-availability.json')) ?? {}
  }

  // ---- this computer's AI connections (login + CLI), shared by every agent on that connection ----
  connectionChecks(): Record<string, ConnectionCheck> {
    return readJson<Record<string, ConnectionCheck>>(this.p('.local', 'connection-checks.json')) ?? {}
  }
  setConnectionCheck(adapter: string, c: ConnectionCheck): void {
    writeJson(this.p('.local', 'connection-checks.json'), { ...this.connectionChecks(), [adapter]: c })
  }

  /** Models each CLI login reported (`agy models` …), per machine. */
  accountModels(): Record<string, { at: string; models: { slug: string; label: string }[] }> {
    return readJson(this.p('.local', 'account-models.json')) ?? {}
  }
  setAccountModels(adapter: string, models: { slug: string; label: string }[]): void {
    writeJson(this.p('.local', 'account-models.json'), { ...this.accountModels(), [adapter]: { at: now(), models } })
  }

  modelAgents(): ModelAgent[] {
    return readJson<ModelAgent[]>(this.p('connections', 'model-agents.json')) ?? []
  }
  saveModelAgents(list: ModelAgent[]): void {
    mkdirSync(this.p('connections'), { recursive: true })
    writeJson(this.p('connections', 'model-agents.json'), list)
  }
  /** When each CLI last ran into its usage limit (the sharing rule gets stricter for a while after that). */
  limitHistory(): Record<string, string> {
    return readJson<Record<string, string>>(this.p('.local', 'limit-history.json')) ?? {}
  }
  noteLimitHit(adapter: string): void {
    writeJson(this.p('.local', 'limit-history.json'), { ...this.limitHistory(), [adapter]: now() })
  }

  setAvailability(id: string, a: ModelAvailability): void {
    writeJson(this.p('.local', 'model-availability.json'), { ...this.availability(), [id]: a })
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
