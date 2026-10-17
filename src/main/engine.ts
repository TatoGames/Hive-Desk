import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type {
  Agent,
  AppConfig,
  AttachResult,
  EngineEvent,
  LiveState,
  PermissionLevel,
  Preflight,
  PreflightItem,
  RunRecord,
  Snapshot,
  SyncResult,
  Task,
  TaskHistory,
  TaskStatus
} from '../shared/types'
import type { LiveRun } from './activity'
import { adapterAccess, runCli, type Runner } from './adapters'
import { loadConfig, makeAgent, saveConfig } from './config'
import { enableTracking, isInsideGit } from './gitdiff'
import { Hive } from './hive'
import { budgetProblem, runTask } from './runner'
import { initSync, isGitRepo, syncNow } from './sync'

export type Emit = (e: EngineEvent) => void

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '할 일',
  awaiting_approval: '승인 대기',
  needs_input: '자료 요청',
  running: '실행 중',
  done: '완료',
  failed: '실패'
}

/** Owns config + hive, runs tasks (manually or via auto-run), and schedules git sync. */
export class Engine {
  config: AppConfig
  hive: Hive
  private running = new Map<string, AbortController>()
  private liveRuns = new Map<string, LiveRun>()
  /** How often the work folder is inspected while a task runs (ms); tests lower it. */
  watchMs = 3000
  private timer: NodeJS.Timeout | null = null
  private syncTimer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(
    private configFile: string,
    private emit: Emit,
    private runner: Runner = runCli,
    home: string = homedir()
  ) {
    this.config = loadConfig(configFile, home)
    mkdirSync(this.config.workspace, { recursive: true })
    this.hive = new Hive(this.config.workspace)
    this.recoverInterrupted()
    this.publishRoster()
    this.applyTimers()
  }

  /** Tasks left "running" by a crash go back to todo. */
  private recoverInterrupted(): void {
    for (const t of this.hive.listTasks()) {
      if (t.status === 'running' && this.localAgent(t.assignee)) {
        this.hive.updateTask(t.id, {
          status: 'todo',
          notes: [...t.notes, '앱이 닫혀 실행이 중단되어 다시 할 일로 돌려놨어요.']
        })
        this.hive.addEvent(t.id, 'status', 'system', '앱이 닫혀 실행이 중단되어 다시 할 일로 돌려놨어요.')
      }
    }
  }

  private localAgent(id: string | null): Agent | undefined {
    return id ? this.config.agents.find((a) => a.id === id) : undefined
  }

  private publishRoster(): void {
    const mine = new Set(this.config.agents.map((a) => a.id))
    for (const a of this.config.agents) this.hive.publishAgent(a)
    for (const r of this.hive.listRoster()) {
      if (r.owner === this.config.memberName && !mine.has(r.id)) this.hive.unpublishAgent(r.id)
    }
  }

  private changed(): void {
    this.emit({ type: 'changed' })
  }

  snapshot(): Snapshot {
    const local = this.config.agents
    const messages = local.flatMap((a) => this.hive.listInbox(a.id))
    return {
      config: this.config,
      tasks: this.hive.listTasks(),
      approvals: this.hive.listApprovals(),
      roster: this.hive.listRoster(),
      messages: messages.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      memory: this.hive.listMemory(),
      usage: this.hive.usageToday(),
      running: [...this.running.keys()],
      gitEnabled: isGitRepo(this.config.workspace),
      live: Object.fromEntries([...this.liveRuns].map(([id, l]) => [id, l.summary()]))
    }
  }

  // ---- settings & agents ----
  saveSettings(patch: Partial<AppConfig>): void {
    const prevWorkspace = this.config.workspace
    const prevName = this.config.memberName
    this.config = { ...this.config, ...patch, agents: this.config.agents }
    if (patch.memberName !== undefined && patch.memberName !== prevName) {
      // agent ids embed the owner name; rebuild them
      this.config.agents = this.config.agents.map((a) =>
        makeAgent(this.config.memberName, { ...a, id: undefined })
      )
    }
    saveConfig(this.configFile, this.config)
    if (this.config.workspace !== prevWorkspace) {
      mkdirSync(this.config.workspace, { recursive: true })
      this.hive = new Hive(this.config.workspace)
    }
    this.publishRoster()
    this.applyTimers()
    this.changed()
  }

  saveAgent(input: Partial<Agent> & { name: string; adapter: Agent['adapter'] }): Agent {
    const existingId = input.id
    const next = makeAgent(this.config.memberName, input)
    const agents = this.config.agents.filter((a) => a.id !== (existingId ?? next.id))
    agents.push(next)
    this.config = { ...this.config, agents }
    saveConfig(this.configFile, this.config)
    if (existingId && existingId !== next.id) this.hive.unpublishAgent(existingId)
    this.publishRoster()
    this.changed()
    return next
  }

  deleteAgent(id: string): void {
    this.config = { ...this.config, agents: this.config.agents.filter((a) => a.id !== id) }
    saveConfig(this.configFile, this.config)
    this.hive.unpublishAgent(id)
    this.changed()
  }

  // ---- tasks ----
  createTask(input: {
    title: string
    description?: string
    assignee?: string | null
    risky?: boolean
    dependsOn?: string[]
    permission?: PermissionLevel
    refDirs?: string[]
  }): Task {
    const t = this.hive.createTask({ ...input, createdBy: this.config.memberName || 'me' })
    this.changed()
    return t
  }

  updateTask(id: string, patch: Partial<Task>): Task {
    const before = this.hive.getTask(id)
    const t = this.hive.updateTask(id, patch)
    if (before && patch.status && patch.status !== before.status) {
      this.hive.addEvent(
        id,
        'status',
        this.config.memberName || 'me',
        `상태를 직접 바꿨어요: ${STATUS_LABEL[before.status]} → ${STATUS_LABEL[patch.status]}`
      )
    }
    this.changed()
    return t
  }

  /** Timeline (shared) + run list (this machine) for one task. */
  taskHistory(id: string): TaskHistory {
    return { events: this.hive.listEvents(id), runs: this.hive.listRuns(id) }
  }

  runDetail(taskId: string, runId: string): RunRecord | null {
    return this.hive.getRun(taskId, runId)
  }

  deleteTask(id: string): void {
    this.stopTask(id)
    this.hive.deleteTask(id)
    this.changed()
  }

  /** Run a task; if the human added instructions while it ran, apply them right after (same session if possible). */
  async runTask(id: string): Promise<string> {
    const task = this.hive.getTask(id)
    if (!task) return 'not_ready'
    const agent = this.localAgent(task.assignee)
    if (!agent) return 'not_ready'
    if (this.running.has(id)) return 'not_ready'
    const ac = new AbortController()
    this.running.set(id, ac)
    this.changed()
    try {
      let outcome = await this.runOnce(agent, id, ac)
      for (let i = 0; i < 3 && outcome === 'done' && !ac.signal.aborted; i++) {
        const t = this.hive.getTask(id)
        const extra = t?.followups ?? []
        if (!t || !extra.length) break
        this.hive.updateTask(id, {
          status: 'todo',
          followups: [],
          reply: extra.map((x, k) => (extra.length > 1 ? `${k + 1}. ` : '') + x).join('\n')
        })
        outcome = await this.runOnce(agent, id, ac)
      }
      return outcome
    } finally {
      this.running.delete(id)
      this.liveRuns.delete(id)
      this.changed()
    }
  }

  private runOnce(agent: Agent, id: string, ac: AbortController): Promise<string> {
    return runTask(agent, id, {
      hive: this.hive,
      stripApiKeys: this.config.stripApiKeys,
      runner: this.runner,
      defaultCwd: this.config.workspace,
      signal: ac.signal,
      watchMs: this.watchMs,
      onOutput: (taskId, chunk) => this.emit({ type: 'output', taskId, chunk }),
      onLive: (live) => this.liveRuns.set(live.taskId, live),
      onActivity: (taskId, events, live) =>
        this.emit({ type: 'activity', taskId, events, summary: live.summary() })
    })
  }

  /** Everything the detail panel needs for a task that is running right now. */
  liveState(id: string): LiveState | null {
    return this.liveRuns.get(id)?.state() ?? null
  }

  stopTask(id: string): void {
    this.running.get(id)?.abort()
  }

  // ---- before a run: what will be touched, what could go wrong ----
  async preflight(id: string): Promise<Preflight> {
    const task = this.hive.getTask(id)
    const items: PreflightItem[] = []
    const add = (level: PreflightItem['level'], text: string, fix?: PreflightItem['fix']): void => {
      items.push({ level, text, ...(fix ? { fix } : {}) })
    }
    if (!task) return { workDir: '', items: [{ level: 'error', text: '태스크를 찾을 수 없어요.' }], canRun: false }
    const agent = this.localAgent(task.assignee)
    if (!agent) {
      add('error', '이 컴퓨터에 있는 에이전트가 아니라서 여기서는 실행할 수 없어요.')
      return { workDir: '', items, canRun: false }
    }
    const acc = adapterAccess(agent.adapter)
    let canRun = true

    // where it works
    let cwd = this.config.workspace
    if (agent.workDir) {
      if (existsSync(agent.workDir) && statSync(agent.workDir).isDirectory()) {
        cwd = agent.workDir
        add('ok', `작업 폴더: ${cwd}`)
      } else {
        add('error', `작업 폴더를 찾을 수 없어요: ${agent.workDir} (에이전트 설정을 확인하세요)`)
        canRun = false
      }
    } else {
      add('warn', `에이전트에 작업 폴더가 없어서 작업공간 폴더(${cwd})에서 실행해요. 프로젝트 폴더를 지정하면 그 안에서 일해요.`)
    }

    // can we see what changed?
    if (canRun) {
      if (await isInsideGit(cwd)) add('ok', '변경한 파일을 줄 단위로 추적해요 (git).')
      else add('warn', '이 폴더는 git 저장소가 아니라서 바뀐 파일 목록만 볼 수 있어요. 변경 추적을 켜면 줄 단위 diff도 볼 수 있어요.', 'git-init')
    }

    // permission level
    const level = task.permission ?? 'edit'
    if (level === 'read') {
      add(acc.permission === 'flag' ? 'ok' : 'warn', acc.permission === 'flag'
        ? '권한: 읽기만 — CLI가 파일 수정과 명령 실행을 막아요.'
        : '권한: 읽기만 — 이 CLI는 권한을 직접 강제하지 못해서 "수정하지 말라"고 지시로만 안내해요.')
    } else if (level === 'exec') {
      add('warn', agent.adapter === 'codex'
        ? '권한: 명령 실행 — 샌드박스 없이 실행해요(danger-full-access). 실행 전 승인이 필요해요.'
        : acc.permission === 'flag'
          ? '권한: 명령 실행 허용 — 실행 전 승인이 필요해요.'
          : '권한: 명령 실행 — 이 CLI의 명령 허용 설정은 에이전트의 추가 인자를 따라요. 실행 전 승인이 필요해요.')
    } else {
      add('ok', '권한: 작업 폴더 안 파일 수정 (에이전트 설정 그대로).')
    }

    // materials
    for (const a of task.attachments ?? []) {
      if (!existsSync(this.hive.attachmentPath(a))) {
        add('warn', `첨부 파일이 이 컴퓨터에 없어요: ${a.name}${a.local ? ' (용량이 커서 만든 사람 컴퓨터에만 있어요)' : ''}`)
      }
    }
    if (task.attachments?.length) add('ok', `첨부 ${task.attachments.length}개를 에이전트에게 알려줘요.`)
    for (const d of task.refDirs ?? []) {
      if (!existsSync(d)) add('warn', `참고 폴더를 찾을 수 없어요 (이 컴퓨터에 없어요): ${d}`)
      else if (acc.refDirs === 'flag') {
        add('ok', `참고 폴더 열람 허용: ${d}${agent.adapter === 'codex' ? ' (Codex는 이 폴더에 쓰기도 가능해져요)' : ''}`)
      } else add('warn', `참고 폴더: ${d} — 이 CLI는 폴더 접근을 직접 허용하지 못해서 경로만 알려줘요. 못 읽으면 에이전트 작업 폴더 안으로 옮기세요.`)
    }

    if (task.reply !== undefined) {
      add('ok', acc.resume === 'session' && task.sessionId
        ? '답변을 이전 대화에 이어서 보내요.'
        : '이 CLI는 대화를 이어갈 수 없어서, 지금까지의 내용과 답변을 담아 새로 실행해요.')
    }
    const problem = budgetProblem(this.hive, agent, new Date())
    if (problem && !task.cleared.includes('budget')) add('warn', problem + ' 실행하면 승인 요청이 만들어져요.')
    if ((task.risky || agent.requireApproval || level === 'exec') && !task.cleared.includes('risky-task')) {
      add('warn', '실행 전에 승인이 필요해요. 실행을 누르면 승인 요청이 만들어져요.')
    }
    return { workDir: cwd, items, canRun }
  }

  /** "변경 추적 켜기": make the agent's work folder a git repo so diffs are line by line. */
  async enableTracking(id: string): Promise<{ ok: boolean; message: string }> {
    const task = this.hive.getTask(id)
    const agent = this.localAgent(task?.assignee ?? null)
    const cwd = agent?.workDir && existsSync(agent.workDir) ? agent.workDir : this.config.workspace
    const r = await enableTracking(cwd)
    if (r.ok && task) this.hive.addEvent(id, 'status', this.config.memberName || 'me', r.message)
    this.changed()
    return r
  }

  // ---- materials ----
  /** Files become attachments; dropped folders become reference folders. */
  attachPaths(id: string, paths: string[]): AttachResult {
    const out: AttachResult = { attached: [], folders: [], errors: [] }
    const by = this.config.memberName || 'me'
    for (const p of paths) {
      try {
        const st = statSync(p)
        if (st.isDirectory()) {
          const t = this.hive.getTask(id)
          if (t && !(t.refDirs ?? []).includes(p)) this.hive.updateTask(id, { refDirs: [...(t.refDirs ?? []), p] })
          out.folders.push(p)
        } else if (st.isFile()) {
          out.attached.push(this.hive.addAttachment(id, { path: p }, by, this.config.attachShareMaxMB))
        } else out.errors.push(`${p}: 파일이 아니에요`)
      } catch (e) {
        out.errors.push(`${p}: ${(e as Error).message}`)
      }
    }
    this.changed()
    return out
  }

  attachData(id: string, name: string, data: Uint8Array): AttachResult {
    const out: AttachResult = { attached: [], folders: [], errors: [] }
    try {
      out.attached.push(
        this.hive.addAttachment(id, { name, data: Buffer.from(data) }, this.config.memberName || 'me', this.config.attachShareMaxMB)
      )
    } catch (e) {
      out.errors.push(`${name}: ${(e as Error).message}`)
    }
    this.changed()
    return out
  }

  removeAttachment(id: string, rel: string): void {
    this.hive.removeAttachment(id, rel, this.config.memberName || 'me')
    this.changed()
  }

  // ---- talking to a task ----
  /** Answer an agent's `[[NEED]]` and let it continue. */
  replyToTask(id: string, text: string): void {
    const t = this.hive.getTask(id)
    if (!t || t.status !== 'needs_input' || !text.trim()) return
    this.hive.updateTask(id, { status: 'todo', reply: text.trim() })
    this.hive.addEvent(id, 'reply', this.config.memberName || 'me', `답변: ${text.trim()}`)
    this.changed()
    if (this.localAgent(t.assignee)) void this.runTask(id)
  }

  /** Add an instruction. While the task runs it is applied when the current step ends. */
  addInstruction(id: string, text: string): void {
    const t = this.hive.getTask(id)
    const body = text.trim()
    if (!t || !body) return
    const by = this.config.memberName || 'me'
    if (t.status === 'running') {
      this.hive.updateTask(id, { followups: [...(t.followups ?? []), body] })
      this.hive.addEvent(id, 'instruction', by, `추가 지시 (현재 단계가 끝나면 반영): ${body}`)
    } else {
      this.hive.updateTask(id, { notes: [...t.notes, `추가 지시: ${body}`] })
      this.hive.addEvent(id, 'instruction', by, `추가 지시: ${body}`)
    }
    this.changed()
  }

  decideApproval(id: string, decision: 'approved' | 'rejected'): void {
    this.hive.decideApproval(id, decision, this.config.memberName || 'me')
    this.changed()
  }

  sendMessage(from: string, to: string, body: string): void {
    this.hive.sendMessage(from, to, body)
    this.changed()
  }

  addMemory(text: string): void {
    this.hive.addMemory(this.config.memberName || 'me', text)
    this.changed()
  }

  deleteMemory(id: string): void {
    this.hive.deleteMemory(id)
    this.changed()
  }

  // ---- auto-run ----
  /** Start ready tasks assigned to local agents, up to maxConcurrent. */
  async tick(): Promise<void> {
    if (this.ticking || !this.config.autoRun) return
    this.ticking = true
    try {
      const all = this.hive.listTasks()
      const busyAgents = new Set(
        [...this.running.keys()].map((id) => all.find((t) => t.id === id)?.assignee)
      )
      for (const t of all) {
        if (this.running.size >= this.config.maxConcurrent) break
        const agent = this.localAgent(t.assignee)
        if (!agent || busyAgents.has(agent.id) || !this.hive.isReady(t, all)) continue
        busyAgents.add(agent.id)
        void this.runTask(t.id)
      }
    } finally {
      this.ticking = false
    }
  }

  private applyTimers(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => void this.tick(), 4000)
    this.timer.unref?.()
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = null
    const m = this.config.syncIntervalMinutes
    if (m > 0 && isGitRepo(this.config.workspace)) {
      this.syncTimer = setInterval(() => void this.sync(), m * 60_000)
      this.syncTimer.unref?.()
    }
  }

  // ---- sharing ----
  async enableSharing(remoteUrl: string): Promise<SyncResult> {
    const r = await initSync(this.config.workspace, remoteUrl)
    this.applyTimers()
    this.changed()
    return r
  }

  async sync(): Promise<SyncResult> {
    const r = await syncNow(this.config.workspace, this.config.memberName)
    this.publishRoster()
    this.changed()
    return r
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.syncTimer) clearInterval(this.syncTimer)
    for (const ac of this.running.values()) ac.abort()
  }
}
