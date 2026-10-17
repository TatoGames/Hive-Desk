import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  Project,
  RunShared,
  ConnectionCheck,
  TaskHistory,
  TaskStatus
} from '../shared/types'
import type { LiveRun } from './activity'
import { ADAPTERS, adapterAccess, cleanEnv, effectivePermission, runCli, type Runner } from './adapters'
import { checkCli } from './setup'
import { Committee } from './committee'
import { Delegation } from './delegation'
import { newId } from './hive'
import { STAGE_DIR } from './staging'
import { attachmentAdvice } from './attachAdvice'
import { personalClaudeRules } from './claudeSettings'
import { findSecrets } from './secrets'
import { SHARED_DIRS } from './hive'
import { loadConfig, makeAgent, saveConfig } from './config'
import { diffSinceCheckpoint, rollback } from './checkpoint'
import { enableTracking, isInsideGit, normPath } from './gitdiff'
import type { LimitInfo } from './limits'
import { Hive } from './hive'
import { budgetProblem, resolveCwd, runTask } from './runner'
import type { AptitudeRecord } from '../shared/aptitude'
import {
  DEFAULT_RULES,
  accountEntries,
  isModelEntry,
  mergeCatalog,
  modelLabel,
  parseModelList,
  resolveModelArg,
  type Company,
  type ModelEntry,
  type OrgUnit,
  type Seat
} from '../shared/company'
import DEFAULT_MODELS from '../shared/models.default.json'
import { autoPlace } from '../shared/placement'
import { TEMPLATES, buildFromTemplate } from '../shared/templates'
import { initSync, isGitRepo, syncNow } from './sync'

export type Emit = (e: EngineEvent) => void

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '할 일',
  awaiting_approval: '승인 대기',
  needs_input: '자료 요청',
  running: '실행 중',
  needs_review: '사람 확인',
  in_review: '교차 검토',
  delegated: '위임 진행',
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
  /** One run per work folder at a time: folder → who has it and who waits. */
  private folders = new Map<string, { holder: string; queue: { taskId: string; grant: () => void; drop: () => void }[] }>()
  private waiting = new Map<string, string>()
  /** CLIs (by adapter id) that are out of usage until a given time; kept across restarts. */
  private limits: Record<string, LimitInfo> = {}
  /** Finishing off runs that were cut short by the last shutdown (tests wait for it). */
  recovering: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  readonly delegation: Delegation
  readonly committee: Committee
  private syncTimer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(
    private configFile: string,
    private emit: Emit,
    private runner: Runner = runCli,
    private home: string = homedir()
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    this.delegation = new Delegation({
      // the hive is replaced when the workspace folder changes, so always read the current one
      get hive(): Hive {
        return self.hive
      },
      me: () => self.config.memberName || 'me',
      catalog: () => self.catalog(),
      changed: () => self.changed(),
      notify: (title, body) => self.notify(title, body),
      escalate: (t, q) => self.escalateToCommittee(t, q),
      aptitude: (agentId, taskId, d) => self.noteAptitudeFor(agentId, taskId, d)
    })
    this.committee = new Committee({
      get hive(): Hive {
        return self.hive
      },
      me: () => self.config.memberName || 'me',
      changed: () => self.changed(),
      notify: (title, body) => self.notify(title, body)
    })
    this.config = loadConfig(configFile, this.home)
    mkdirSync(this.config.workspace, { recursive: true })
    this.hive = new Hive(this.config.workspace)
    this.loadLimits()
    this.recoverInterrupted()
    this.publishRoster()
    this.applyTimers()
  }

  /**
   * Tasks left "running" by a crash or by closing the app go back to todo. The run that was cut
   * short is kept as "interrupted" so the half-done changes can be seen and undone.
   */
  private recoverInterrupted(): void {
    const jobs: Promise<void>[] = []
    for (const t of this.hive.listTasks()) {
      if (t.status !== 'running' || !this.localAgent(t.assignee)) continue
      const run = this.hive.unfinishedRun(t.id)
      const note = run
        ? '앱이 닫혀 실행이 중단됐어요. 일부 변경이 폴더에 남았을 수 있어요 — 바뀐 파일을 확인하고 [되돌리기] 또는 다시 실행하세요.'
        : '앱이 닫혀 실행이 중단되어 다시 할 일로 돌려놨어요.'
      this.hive.updateTask(t.id, { status: 'todo', notes: [...t.notes, note], interruptedRun: run?.id })
      this.hive.addEvent(t.id, 'status', 'system', note, run?.id)
      if (run) {
        this.hive.addRun({ ...run, outcome: 'interrupted', finishedAt: new Date().toISOString(), error: '앱이 닫혀 중단됐어요.' })
        const cp = run.checkpoint
        if (cp) {
          jobs.push(
            diffSinceCheckpoint(this.hive, cp, this.excludesFor(cp.root)).then((diff) => {
              const cur = this.hive.getRun(t.id, run.id)
              if (cur) this.hive.addRun({ ...cur, diff })
            })
          )
        }
      }
    }
    this.recovering = Promise.all(jobs).then(() => this.changed())
  }

  /** Paths the change tracker ignores (its own staging folder, and the hive's data when it is the folder). */
  private excludesFor(root: string): string[] {
    return [STAGE_DIR, ...(normPath(root) === normPath(this.hive.root) ? SHARED_DIRS : [])]
  }

  // ---- usage limits (per CLI on this machine) ----
  private limitFile(): string {
    return join(this.hive.root, '.local', 'limits.json')
  }

  private loadLimits(): void {
    try {
      const raw = JSON.parse(readFileSync(this.limitFile(), 'utf8')) as Record<string, LimitInfo>
      const now = Date.now()
      this.limits = Object.fromEntries(Object.entries(raw).filter(([, v]) => new Date(v.until).getTime() > now))
    } catch {
      this.limits = {}
    }
  }

  private noteLimit(adapter: Agent['adapter'], info: LimitInfo): void {
    this.limits[adapter] = info
    try {
      writeFileSync(this.limitFile(), JSON.stringify(this.limits, null, 2), 'utf8')
    } catch {
      /* in-memory is enough for this session */
    }
    this.changed()
  }

  /** The active limit for a CLI, if any (expired ones are dropped). */
  limitFor(adapter: Agent['adapter']): LimitInfo | undefined {
    const l = this.limits[adapter]
    if (!l) return undefined
    if (new Date(l.until).getTime() <= Date.now()) {
      delete this.limits[adapter]
      return undefined
    }
    return l
  }

  /** Forget a limit (the human knows better, e.g. upgraded the plan). */
  clearLimit(adapter: Agent['adapter']): void {
    delete this.limits[adapter]
    try {
      writeFileSync(this.limitFile(), JSON.stringify(this.limits, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
    this.changed()
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

  /** A desktop notification (the main process shows it when the app allows). */
  notify(title: string, body: string): void {
    this.emit({ type: 'notify', title, body })
  }

  private seenAttention: Set<string> | null = null

  /** Tell the person about things that now wait for them (new approvals, questions, results, failures). */
  private notifyAttention(): void {
    let now: Map<string, [string, string]>
    try {
      now = new Map()
      for (const a of this.hive.listApprovals()) if (a.status === 'pending') now.set('a' + a.id, ['승인이 필요해요', a.reason.slice(0, 80)])
      for (const t of this.hive.listTasks()) {
        if (t.hidden) continue
        if (t.status === 'needs_input') now.set('i' + t.id, ['에이전트가 자료를 기다려요', t.title])
        else if (t.status === 'needs_review' && !t.parentId) now.set('r' + t.id, ['결과를 확인해 주세요', t.title])
        else if (t.status === 'failed') now.set('f' + t.id, ['작업이 실패했어요', t.title])
      }
    } catch {
      return
    }
    const seen = this.seenAttention
    this.seenAttention = new Set(now.keys())
    if (!seen) return
    for (const [k, [title, body]] of now) if (!seen.has(k)) this.notify(title, body)
  }

  private changed(): void {
    this.notifyAttention()
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
      live: Object.fromEntries([...this.liveRuns].map(([id, l]) => [id, l.summary()])),
      waiting: Object.fromEntries(this.waiting),
      company: {
        company: this.hive.getCompany(),
        units: this.hive.listUnits(),
        seats: this.hive.listSeats(),
        catalog: this.catalog(),
        availability: this.hive.availability(),
        aptitude: this.hive.listAptitude(),
        finals: this.hive.listFinals(),
        agendas: this.hive.listAgendas()
      },
      projects: this.hive.listProjects(),
      projectPaths: this.hive.projectPaths(),
      limits: Object.fromEntries(Object.keys(this.limits).flatMap((k) => (this.limitFor(k as Agent['adapter']) ? [[k, this.limits[k]]] : [])))
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
      this.loadLimits()
    }
    this.publishRoster()
    this.applyTimers()
    this.changed()
  }

  saveAgent(input: Partial<Agent> & { name: string; adapter: Agent['adapter'] }): Agent {
    const existingId = input.id
    if (input.modelRef) {
      const m = this.catalog().find((x) => x.id === input.modelRef!.id)
      if (!m) throw new Error('카탈로그에 없는 모델이에요: ' + input.modelRef.id)
      if (m.adapter !== input.adapter) {
        throw new Error(`${m.family} ${m.version}은(는) ${m.adapter}용 모델이라 ${input.adapter} 에이전트에는 쓸 수 없어요.`)
      }
      input = { ...input, model: resolveModelArg(m, input.modelRef.pin) }
    }
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
    projectId?: string
    /** Hand the job to the company: a manager plans it, workers do it, another model reviews it. */
    delegate?: boolean
    /** Hand it to the lead of this unit (implies delegate). */
    unitId?: string
  }): Task {
    let t = this.hive.createTask({ ...input, createdBy: this.config.memberName || 'me' })
    if (input.delegate || input.unitId) {
      try {
        t = this.delegation.begin(t, { unitId: input.unitId, delegate: true })
      } catch (e) {
        this.hive.deleteTask(t.id)
        throw e
      }
    }
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
    if (before) this.logTaskChanges(before, patch)
    this.changed()
    return t
  }

  /** Hand edits of a task are written to its timeline as events (append-only), so teammates see who changed what. */
  private logTaskChanges(before: Task, patch: Partial<Task>): void {
    const who = this.config.memberName || 'me'
    const show = (v: unknown): string => (v === undefined || v === null || v === '' ? '없음' : String(v))
    const fields: [keyof Task, string][] = [
      ['title', '제목'],
      ['assignee', '담당'],
      ['permission', '권한'],
      ['risky', '위험 표시'],
      ['projectId', '프로젝트'],
      ['maxMinutes', '최대 시간(분)']
    ]
    for (const [k, label] of fields) {
      if (!(k in patch) || patch[k] === before[k]) continue
      this.hive.addEvent(before.id, 'changed', who, `${label}을(를) 바꿨어요: ${show(before[k])} → ${show(patch[k])}`)
    }
    if (patch.description !== undefined && patch.description !== before.description) {
      this.hive.addEvent(before.id, 'changed', who, '설명을 고쳤어요')
    }
  }

  sharedRuns(id: string): RunShared[] {
    return this.hive.listSharedRuns(id)
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

  /** Wait until no other task is working in this folder. `false` = stopped while waiting. */
  private lockFolder(key: string, taskId: string, signal: AbortSignal): Promise<boolean> {
    const entry = this.folders.get(key)
    if (!entry) {
      this.folders.set(key, { holder: taskId, queue: [] })
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        taskId,
        grant: (): void => {
          signal.removeEventListener('abort', waiter.drop)
          this.waiting.delete(taskId)
          resolve(true)
        },
        drop: (): void => {
          entry.queue = entry.queue.filter((w) => w !== waiter)
          this.waiting.delete(taskId)
          this.changed()
          resolve(false)
        }
      }
      signal.addEventListener('abort', waiter.drop, { once: true })
      entry.queue.push(waiter)
      this.waiting.set(taskId, entry.holder)
      this.changed()
    })
  }

  private unlockFolder(key: string): void {
    const entry = this.folders.get(key)
    if (!entry) return
    const next = entry.queue.shift()
    if (!next) {
      this.folders.delete(key)
      return
    }
    entry.holder = next.taskId
    for (const w of entry.queue) this.waiting.set(w.taskId, entry.holder)
    next.grant()
  }

  /** Is another task working in (or waiting for) this agent's folder right now? */
  private cwdFor(agent: Agent, taskId: string): string {
    const t = this.hive.getTask(taskId)
    return resolveCwd(agent, this.config.workspace, this.hive.projectDir(t?.projectId))
  }

  private folderBusy(agent: Agent, taskId: string): boolean {
    return this.folders.has(normPath(this.cwdFor(agent, taskId)))
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
    // Two agents editing the same folder would overwrite each other and mix up their diffs.
    const key = normPath(this.cwdFor(agent, id))
    let locked = false
    try {
      locked = await this.lockFolder(key, id, ac.signal)
      if (!locked) return 'cancelled'
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
      // delegation: what a plan / review / work run produced decides what happens next
      if (!ac.signal.aborted) {
        this.delegation.onRunFinished(id)
        this.committee.onRunFinished(id)
      }
      return outcome
    } finally {
      if (locked) this.unlockFolder(key)
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
      machine: this.config.memberName,
      signal: ac.signal,
      watchMs: this.watchMs,
      humanReview: this.config.humanReview,
      onLimit: (adapter, info) => this.noteLimit(adapter, info),
      promptExtras: (task, a) => [...this.delegation.promptExtras(task, a), ...this.committee.promptExtras(task, a)],
      onRunEnd: ({ agent: a, taskId, ms, result }) =>
        this.noteAptitude(a, taskId, {
          runs: 1,
          ms,
          approved: result === 'approved' ? 1 : 0,
          failed: result === 'failed' ? 1 : 0
        }),
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
    const projDir = this.hive.projectDir(task.projectId)
    const proj = this.hive.getProject(task.projectId)
    if (proj && !projDir) {
      add('warn', `프로젝트 "${proj.name}"의 작업 폴더가 이 컴퓨터에 설정돼 있지 않아요(또는 폴더가 없어요). 프로젝트 화면에서 이 컴퓨터의 폴더를 지정하세요. 지금은 에이전트의 작업 폴더를 써요.`)
    }
    if (projDir) {
      cwd = projDir
      add('ok', `작업 폴더(프로젝트 "${proj?.name}"): ${cwd}`)
    } else if (agent.workDir) {
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

    // can we see what changed, and can it be undone?
    if (canRun) {
      if (await isInsideGit(cwd)) {
        add('ok', '변경한 파일을 줄 단위로 추적해요 (git). 실행 전 상태를 저장해 두니 [이 실행 되돌리기]로 되돌릴 수 있어요.')
      } else {
        add('warn', '이 폴더는 git 저장소가 아니라서 바뀐 파일 목록만 볼 수 있어요. 변경 추적을 켜면 줄 단위 diff도 볼 수 있어요.', 'git-init')
        add('warn', '되돌리기용으로 실행 전에 파일을 백업해 둬요. 폴더가 아주 크면(파일 5000개 또는 100MB 초과) 백업하지 않아요.')
      }
      if (this.folderBusy(agent, id)) add('warn', '다른 작업이 이 폴더에서 실행 중이에요. 그 작업이 끝나면 이어서 시작해요.')
    }
    const lim = this.limitFor(agent.adapter)
    if (lim) {
      add('warn', `이 CLI는 사용량 한도에 걸려 있어요 (${new Date(lim.until).toLocaleString('ko-KR', { hour12: false })}${lim.guessed ? '쯤 추정' : ''}까지). 지금 실행하면 다시 실패할 수 있어요.`)
    }

    // secrets and personal settings
    if (canRun) {
      const secrets = findSecrets(cwd)
      if (secrets.length) {
        const shown = secrets.slice(0, 3).join(', ') + (secrets.length > 3 ? ` 외 ${secrets.length - 3}개` : '')
        add(
          'warn',
          agent.adapter === 'claude' && !task.allowSecrets
            ? `작업 폴더에 비밀번호·키로 보이는 파일이 있어요 (${shown}). 파일 읽기 도구로는 열지 못하게 막아 뒀어요 (셸 명령까지는 막지 못해요).`
            : `작업 폴더에 비밀번호·키로 보이는 파일이 있어요 (${shown}). 에이전트가 읽어서 응답이나 기록에 남길 수 있어요.`
        )
      }
      if (agent.adapter === 'claude') {
        const mine = personalClaudeRules(cwd, this.home)
        if (mine.length) {
          add('warn', `Claude 개인 설정에 허용 규칙이 있어요: ${mine.join(' · ')}. 앱이 보내는 차단 규칙(삭제·참고 폴더 수정·비밀 파일)은 항상 우선하지만, 허용 규칙 때문에 권한 단계보다 더 많은 일을 할 수 있어요.`)
        }
      }
    }

    // permission level
    const level = effectivePermission(agent.adapter, task.permission ?? agent.permission)
    const enforced = acc.permission === 'flag'
    if (level === 'read') {
      if (enforced) add('ok', '권한: 읽기만 — CLI가 파일 수정과 명령 실행을 막아요.')
      else if (task.permission === undefined) {
        add('ok', '권한: 읽기만 (이 CLI의 기본값) — 이 CLI는 수정을 직접 막지 못해서 기본을 읽기만으로 둬요. 파일을 고치게 하려면 권한을 "작업 폴더 수정"으로 바꾸세요.')
      } else add('warn', '권한: 읽기만 — 이 CLI는 권한을 직접 강제하지 못해서 "수정하지 말라"고 지시로만 안내해요.')
    } else if (level === 'exec') {
      add('warn', agent.adapter === 'codex'
        ? '권한: 명령 실행 — 샌드박스 없이 실행해요(danger-full-access). 실행 전 승인이 필요해요.'
        : agent.adapter === 'agy'
          ? '권한: 명령 실행 — agy의 모든 도구 확인을 자동 승인해요(--dangerously-skip-permissions). 실행 전 승인이 필요해요.'
          : enforced
            ? '권한: 명령 실행 허용 — 실행 전 승인이 필요해요.'
            : '권한: 명령 실행 — 이 CLI의 명령 허용 설정은 에이전트의 추가 인자를 따라요. 실행 전 승인이 필요해요.')
    } else if (enforced) {
      add('ok', '권한: 작업 폴더 안 파일 수정. 삭제·이동 같은 파괴적 명령(rm, mv …)은 막혀 있어요 (명령 실행 권한에서만 허용).')
    } else {
      const it: PreflightItem = {
        level: 'warn',
        confirm: true,
        text: '권한: 파일 수정 — 이 CLI는 수정 범위를 직접 막지 못해요. 작업 폴더 밖 파일을 바꾸거나 파일을 지울 수도 있어요. 중요한 폴더는 git 저장소로 만들고(변경 추적), 실행 후 변경 목록을 꼭 확인하세요.'
      }
      items.push(it)
    }

    // materials
    for (const a of task.attachments ?? []) {
      if (!existsSync(this.hive.attachmentPath(a))) {
        add('warn', `첨부 파일이 이 컴퓨터에 없어요: ${a.name}${a.local ? ' (용량이 커서 만든 사람 컴퓨터에만 있어요)' : ''}`)
      }
    }
    if (task.attachments?.length) {
      add('ok', `첨부 ${task.attachments.length}개를 실행하는 동안 작업 폴더의 ${STAGE_DIR}/ 에 복사해 에이전트에게 알려줘요 (끝나면 지워요).`)
    }
    for (const d of task.refDirs ?? []) {
      if (!existsSync(d)) add('warn', `참고 폴더를 찾을 수 없어요 (이 컴퓨터에 없어요): ${d}`)
      else if (agent.adapter === 'claude') add('ok', `참고 폴더 열람 허용 (읽기만, 수정은 막아요): ${d}`)
      else add('warn', `참고 폴더: ${d} — 이 CLI는 폴더 접근을 직접 허용하지 못해서 경로만 알려줘요. 못 읽으면 에이전트 작업 폴더 안으로 옮기세요.`)
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
    const out: AttachResult = { notes: [], attached: [], folders: [], errors: [] }
    const by = this.config.memberName || 'me'
    for (const p of paths) {
      try {
        const st = statSync(p)
        if (st.isDirectory()) {
          const t = this.hive.getTask(id)
          if (t && !(t.refDirs ?? []).includes(p)) this.hive.updateTask(id, { refDirs: [...(t.refDirs ?? []), p] })
          out.folders.push(p)
        } else if (st.isFile()) {
          const att = this.hive.addAttachment(id, { path: p }, by, this.config.attachShareMaxMB)
          out.attached.push(att)
          const tip = attachmentAdvice(att.name)
          if (tip) out.notes.push(tip)
        } else out.errors.push(`${p}: 파일이 아니에요`)
      } catch (e) {
        out.errors.push(`${p}: ${(e as Error).message}`)
      }
    }
    this.changed()
    return out
  }

  attachData(id: string, name: string, data: Uint8Array): AttachResult {
    const out: AttachResult = { notes: [], attached: [], folders: [], errors: [] }
    try {
      out.attached.push(
        this.hive.addAttachment(id, { name, data: Buffer.from(data) }, this.config.memberName || 'me', this.config.attachShareMaxMB)
      )
      const tip = attachmentAdvice(name)
      if (tip) out.notes.push(tip)
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

  /** How many tasks are running right now (the app keeps the computer awake while this is > 0). */
  runningCount(): number {
    return this.running.size
  }

  // ---- CEO committee ----
  openAgenda(title: string, body: string): void {
    if (!title.trim()) return
    this.committee.open(title, body, this.config.memberName || 'me')
    this.changed()
  }

  decideAgenda(id: string, choice: number, note = ''): void {
    this.committee.decide(id, choice, note, this.config.memberName || 'me')
    this.changed()
  }

  private escalateToCommittee(t: Task, question: string): void {
    try {
      this.committee.open(`방향 확인: ${t.title}`, `${question}\n\n(업무: ${t.title}\n${t.description})`, 'manager', t.id)
      this.hive.updateTask(t.id, { status: 'needs_input', question: `방향이 불분명해서 CEO 위원회에 올렸어요: ${question}` })
      this.hive.addEvent(t.id, 'delegation', 'delegation', '방향이 불분명해서 CEO 위원회에 올렸어요.')
    } catch (e) {
      // no committee: the board answers directly
      this.hive.updateTask(t.id, { status: 'needs_input', question })
      this.hive.addEvent(t.id, 'delegation', 'delegation', `방향이 불분명해요: ${(e as Error).message}`)
      this.notify('방향을 정해 주세요', t.title)
    }
  }

  /** Move local agents of a job from one model to a better one (a recommendation from the aptitude board). */
  applyReassignment(domain: string, fromKey: string, toKey: string): number {
    if (!this.catalog().some((m) => m.id === toKey)) return 0
    const seats = this.hive.listSeats().filter((s) => (s.job || 'general') === domain && s.agentId)
    let n = 0
    for (const s of seats) {
      const a = this.config.agents.find((x) => x.id === s.agentId)
      if (!a || a.modelRef?.id !== fromKey) continue
      this.saveAgent({ ...a, modelRef: { id: toKey, pin: a.modelRef.pin } })
      n++
    }
    return n
  }

  /** The human looked at a finished run: accept it, or send it back with what to change. */
  reviewTask(id: string, decision: 'approve' | 'changes', text = ''): void {
    const t = this.hive.getTask(id)
    if (!t || t.status !== 'needs_review') return
    const by = this.config.memberName || 'me'
    if (decision === 'approve') {
      this.hive.updateTask(id, { status: 'done' })
      this.hive.addEvent(id, 'review', by, '확인했어요. 완료로 처리했어요.')
      this.noteTaskAptitude(t, { approved: 1 })
      this.delegation.recordDecision(id, true, by)
    } else {
      const body = text.trim()
      if (!body) return
      this.hive.updateTask(id, { status: 'todo', reply: body })
      this.hive.addEvent(id, 'review', by, `수정을 요청했어요: ${body}`)
      this.noteTaskAptitude(t, { changes: 1 })
      this.delegation.recordDecision(id, false, by, body)
      if (t.kind === 'integrate') this.delegation.reopenIntegration(id)
      if (this.localAgent(t.assignee)) void this.runTask(id)
    }
    this.changed()
  }

  /** Undo everything a run changed in its work folder (back to how it was just before the run). */
  async rollbackRun(taskId: string, runId: string): Promise<{ ok: boolean; message: string }> {
    const task = this.hive.getTask(taskId)
    const rec = this.hive.getRun(taskId, runId)
    if (!task || !rec) return { ok: false, message: '실행 기록을 찾을 수 없어요.' }
    if (!rec.checkpoint) return { ok: false, message: rec.checkpointNote ?? '이 실행은 되돌릴 수 없어요.' }
    if (rec.rolledBackAt) return { ok: false, message: '이미 되돌린 실행이에요.' }
    if (this.running.has(taskId) || this.folders.has(normPath(rec.checkpoint.root))) {
      return { ok: false, message: '이 폴더에서 다른 작업이 실행 중이에요. 끝난 뒤에 되돌려 주세요.' }
    }
    const by = this.config.memberName || 'me'
    const r = await rollback(this.hive, rec.checkpoint, this.excludesFor(rec.checkpoint.root))
    if (!r.ok) return { ok: false, message: r.message }
    this.hive.addRun({ ...rec, rolledBackAt: new Date().toISOString() })
    this.hive.addEvent(taskId, 'rollback', by, `이 실행을 되돌렸어요. ${r.message}`, runId)
    if (task.status === 'needs_review') this.noteTaskAptitude(task, { changes: 1 })
    const patch: Partial<Task> = { interruptedRun: undefined }
    if (task.status === 'done' || task.status === 'failed' || task.status === 'needs_review') {
      patch.status = 'todo'
      patch.notes = [...task.notes, '실행을 되돌려서 다시 할 일로 돌려놨어요.']
    }
    this.hive.updateTask(taskId, patch)
    this.changed()
    return r
  }

  decideApproval(id: string, decision: 'approved' | 'rejected', note?: string): void {
    const by = this.config.memberName || 'me'
    const a = this.hive.listApprovals().find((x) => x.id === id)
    this.hive.decideApproval(id, decision, by, note)
    if (a?.kind === 'plan' && a.status === 'pending') {
      if (decision === 'approved') this.delegation.approvePlan(a.taskId, by)
      else this.delegation.rejectPlan(a.taskId, note?.trim() || '이사회가 계획을 반려했어요.', by, true)
    }
    this.changed()
  }

  sendMessage(from: string, to: string, body: string): void {
    this.hive.sendMessage(from, to, body)
    this.changed()
  }

  addMemory(text: string, kind: 'fixed' | 'recent' = 'recent'): void {
    this.hive.addMemory(this.config.memberName || 'me', text, kind)
    this.changed()
  }

  setMemoryKind(id: string, kind: 'fixed' | 'recent'): void {
    this.hive.setMemoryKind(id, kind)
    this.changed()
  }

  // ---- model catalog: bundled defaults + the user's own file (<home>/models.json) ----
  private get catalogFile(): string {
    return join(this.home, 'models.json')
  }

  private userModels(): ModelEntry[] {
    try {
      if (!existsSync(this.catalogFile)) return []
      const raw = JSON.parse(readFileSync(this.catalogFile, 'utf8')) as unknown
      return Array.isArray(raw) ? raw.filter(isModelEntry) : []
    } catch {
      return []
    }
  }

  catalog(): ModelEntry[] {
    const acct = Object.entries(this.hive.accountModels()).flatMap(([ad, v]) => accountEntries(ad as Agent['adapter'], v.models, v.at))
    // the bundled entry of the same adapter + CLI name wins as the base (it has better notes), marked verified by the account
    const verifiedKeys = new Set(acct.map((m) => m.adapter + '|' + m.cliArg))
    const base = (DEFAULT_MODELS as ModelEntry[]).map((m) =>
      verifiedKeys.has(m.adapter + '|' + m.cliArg) ? { ...m, verified: { source: `${m.adapter} 계정 모델 목록`, at: this.hive.accountModels()[m.adapter].at.slice(0, 10) } } : m
    )
    const known = new Set(base.map((m) => m.adapter + '|' + m.cliArg))
    return mergeCatalog([...base, ...acct.filter((m) => !known.has(m.adapter + '|' + m.cliArg))], this.userModels())
  }

  /** Add or change a model in the user's own catalog file (a default with the same id is replaced). */
  saveModel(entry: ModelEntry): ModelEntry {
    if (!isModelEntry(entry)) throw new Error('모델 정보가 부족해요 (id, CLI 모델 인자, 사용할 CLI, 체급이 필요해요).')
    const weight = Number(entry.weight)
    const clean: ModelEntry = {
      ...entry,
      id: entry.id.trim(),
      cliArg: entry.cliArg.trim(),
      weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      domains: (entry.domains ?? []).filter(Boolean),
      custom: true
    }
    const mine = this.userModels().filter((m) => m.id !== clean.id)
    mkdirSync(dirname(this.catalogFile), { recursive: true })
    writeFileSync(this.catalogFile, JSON.stringify([...mine, clean], null, 2) + '\n', 'utf8')
    this.refreshModelArgs()
    this.changed()
    return clean
  }

  /** Remove one of the user's own entries (the bundled defaults cannot be removed, only replaced). */
  deleteModel(id: string): void {
    const mine = this.userModels().filter((m) => m.id !== id)
    writeFileSync(this.catalogFile, JSON.stringify(mine, null, 2) + '\n', 'utf8')
    this.changed()
  }

  /** Re-derive each agent's CLI model argument from the catalog (alias vs pinned). */
  private refreshModelArgs(): void {
    const cat = this.catalog()
    let changed = false
    const agents = this.config.agents.map((a) => {
      const m = a.modelRef ? cat.find((x) => x.id === a.modelRef!.id) : undefined
      if (!a.modelRef || !m) return a
      const arg = resolveModelArg(m, a.modelRef.pin)
      if (arg === a.model) return a
      changed = true
      return { ...a, model: arg }
    })
    if (changed) {
      this.config = { ...this.config, agents }
      saveConfig(this.configFile, this.config)
      this.publishRoster()
    }
  }

  /** Does this model really work with this account? Runs the CLI once with that model. */
  /** Ask the CLI which models this login can use (only CLIs that can list them). */
  async refreshAccountModels(adapter: Agent['adapter']): Promise<{ ok: boolean; count: number; message: string }> {
    const args = ADAPTERS[adapter]?.listModels
    if (!args) return { ok: false, count: 0, message: '이 CLI는 모델 목록 명령이 없어요. 카탈로그에서 고르고 [사용 확인]으로 확인하세요.' }
    const res = await this.runner(
      { command: ADAPTERS[adapter].command, args },
      { cwd: homedir(), prompt: '', timeoutMs: 60_000, env: cleanEnv(process.env, true) }
    )
    if (res.spawnError || res.code !== 0) {
      return { ok: false, count: 0, message: res.spawnError ?? `모델 목록을 받지 못했어요 (로그인이 필요할 수 있어요): ${(res.stderr || res.stdout).slice(-200)}` }
    }
    const models = parseModelList(res.stdout)
    if (!models.length) return { ok: false, count: 0, message: '모델 목록이 비어 있거나 읽을 수 없는 형식이에요.' }
    this.hive.setAccountModels(adapter, models)
    // models the account lists are usable by definition
    for (const m of this.catalog().filter((x) => x.adapter === adapter && models.some((y) => y.slug === x.cliArg))) {
      this.hive.setAvailability(m.id, { ok: true, at: new Date().toISOString(), message: '계정 모델 목록에 있어요.' })
    }
    this.changed()
    return { ok: true, count: models.length, message: `${models.length}개 모델을 불러왔어요.` }
  }

  async verifyModel(id: string): Promise<{ ok: boolean; message: string }> {
    const m = this.catalog().find((x) => x.id === id)
    if (!m) return { ok: false, message: '카탈로그에 없는 모델이에요.' }
    const r = await checkCli(m.adapter, this.runner, undefined, m.cliArg)
    const ok = r.ok
    this.hive.setAvailability(id, {
      ok,
      at: new Date().toISOString(),
      message: ok ? '이 계정에서 쓸 수 있어요.' : r.message.slice(0, 300)
    })
    this.changed()
    return { ok, message: ok ? '이 계정에서 쓸 수 있어요.' : r.message }
  }

  // ---- company: organization, ranks, seats ----
  applyTemplate(templateId: string, name: string, place = true): Company {
    const tpl = TEMPLATES.find((t) => t.id === templateId)
    if (!tpl) throw new Error('없는 템플릿이에요: ' + templateId)
    const built = buildFromTemplate(tpl, name.trim() || tpl.name, newId, new Date().toISOString())
    this.hive.clearOrg()
    this.hive.saveCompany(built.company)
    for (const u of built.units) this.hive.saveUnit(u)
    for (const st of built.seats) this.hive.saveSeat(st)
    if (place) this.placeModels(false)
    // agents that pointed at the old org lose the link
    this.config = { ...this.config, agents: this.config.agents.map((a) => ({ ...a, unitId: undefined, rankId: undefined })) }
    saveConfig(this.configFile, this.config)
    this.publishRoster()
    this.changed()
    return built.company
  }

  saveCompany(patch: Partial<Company>): Company {
    const cur = this.hive.getCompany()
    if (!cur) throw new Error('먼저 템플릿으로 회사를 만드세요.')
    const next: Company = {
      ...cur,
      ...patch,
      rules: { ...DEFAULT_RULES, ...cur.rules, ...(patch.rules ?? {}) },
      ranks: patch.ranks ? patch.ranks.map((r, i) => ({ ...r, level: i + 1 })) : cur.ranks
    }
    this.hive.saveCompany(next)
    this.changed()
    return next
  }

  saveUnit(input: Partial<OrgUnit> & { name: string }): OrgUnit {
    const units = this.hive.listUnits()
    const cur = input.id ? units.find((u) => u.id === input.id) : undefined
    if (input.parentId && input.id) {
      // no loops: a unit cannot move below itself
      let p: string | null = input.parentId
      while (p) {
        if (p === input.id) throw new Error('자기 아래 조직으로는 옮길 수 없어요.')
        p = units.find((u) => u.id === p)?.parentId ?? null
      }
    }
    const u: OrgUnit = {
      id: cur?.id ?? newId(),
      name: input.name.trim(),
      kind: input.kind ?? cur?.kind ?? '팀',
      parentId: input.parentId === undefined ? (cur?.parentId ?? null) : input.parentId,
      mission: input.mission ?? cur?.mission ?? '',
      folderName: input.folderName ?? cur?.folderName ?? '',
      order: input.order ?? cur?.order ?? units.length
    }
    this.hive.saveUnit(u)
    this.changed()
    return u
  }

  /** Delete a unit with everything below it (sub-units and seats); their agents stay, unassigned. */
  deleteUnit(id: string): void {
    const units = this.hive.listUnits()
    const gone = new Set<string>()
    const walk = (x: string): void => {
      gone.add(x)
      for (const u of units) if (u.parentId === x) walk(u.id)
    }
    walk(id)
    for (const x of gone) this.hive.deleteUnit(x)
    for (const st of this.hive.listSeats()) if (gone.has(st.unitId)) this.hive.deleteSeat(st.id)
    this.config = {
      ...this.config,
      agents: this.config.agents.map((a) => (a.unitId && gone.has(a.unitId) ? { ...a, unitId: undefined } : a))
    }
    saveConfig(this.configFile, this.config)
    this.publishRoster()
    this.changed()
  }

  saveSeat(input: Partial<Seat> & { unitId: string; title: string }): Seat {
    const cur = input.id ? this.hive.listSeats().find((x) => x.id === input.id) : undefined
    const company = this.hive.getCompany()
    const st: Seat = {
      id: cur?.id ?? newId(),
      unitId: input.unitId,
      title: input.title.trim(),
      rankId: input.rankId ?? cur?.rankId ?? company?.ranks[company.ranks.length - 1]?.id ?? '',
      job: input.job ?? cur?.job ?? 'build',
      difficulty: input.difficulty ?? cur?.difficulty ?? 'hard',
      order: cur?.order ?? input.order ?? this.hive.listSeats().length,
      ...(input.modelId !== undefined ? (input.modelId ? { modelId: input.modelId } : {}) : cur?.modelId ? { modelId: cur.modelId } : {}),
      ...(input.agentId !== undefined ? (input.agentId ? { agentId: input.agentId } : {}) : cur?.agentId ? { agentId: cur.agentId } : {})
    }
    this.hive.saveSeat(st)
    this.changed()
    return st
  }

  deleteSeat(id: string): void {
    this.hive.deleteSeat(id)
    this.changed()
  }

  /** Put an agent on a seat (or empty it). The agent takes over the seat's rank, unit and job. */
  assignSeat(seatId: string, agentId: string | null): void {
    const seats = this.hive.listSeats()
    const seat = seats.find((x) => x.id === seatId)
    if (!seat) return
    // one seat per agent
    for (const o of seats) if (agentId && o.agentId === agentId && o.id !== seatId) this.hive.saveSeat({ ...o, agentId: undefined })
    this.hive.saveSeat({ ...seat, agentId: agentId ?? undefined })
    const mine = this.config.agents.find((a) => a.id === agentId)
    if (mine) {
      this.saveAgent({ ...mine, unitId: seat.unitId, rankId: seat.rankId, job: seat.job })
    }
    this.changed()
  }

  /** Fill the recommended model of seats (only empty ones unless `onlyEmpty` is false). */
  placeModels(onlyEmpty = true): number {
    const company = this.hive.getCompany()
    if (!company) return 0
    const seats = this.hive.listSeats()
    const picks = autoPlace(
      {
        units: this.hive.listUnits(),
        seats,
        agents: this.hive.listRoster().map((r) => ({ id: r.id, adapter: r.adapter, modelId: r.modelId, model: r.model })),
        catalog: this.catalog()
      },
      company.rules,
      this.hive.availability(),
      onlyEmpty
    )
    for (const st of seats) if (picks[st.id]) this.hive.saveSeat({ ...st, modelId: picks[st.id] })
    this.changed()
    return Object.keys(picks).length
  }

  /** Same as noteAptitude, for an agent that may live on another computer (only the roster is known). */
  noteAptitudeFor(agentId: string | null, taskId: string, d: { approved?: number; changes?: number }): void {
    if (!agentId) return
    const local = this.localAgent(agentId)
    if (local) return this.noteAptitude(local, taskId, d)
    const r = this.hive.listRoster().find((x) => x.id === agentId)
    if (!r) return
    this.noteAptitude(
      { id: r.id, name: r.name, owner: r.owner, adapter: r.adapter, role: r.role, workDir: '', extraArgs: '', dailyRunLimit: 0, dailyMinuteLimit: 0, timeoutMinutes: 15, requireApproval: false, model: r.model, job: r.job, ...(r.modelId ? { modelRef: { id: r.modelId, pin: 'pinned' as const } } : {}) },
      taskId,
      d
    )
  }

  /** Review results count for the model that did the work (the task's assignee, if it is one of ours). */
  private noteTaskAptitude(t: Task, d: { approved?: number; changes?: number }): void {
    const a = this.localAgent(t.assignee)
    if (a) this.noteAptitude(a, t.id, d)
  }

  // ---- aptitude: how each model version does in each work area ----
  private aptitudeKey(agent: Agent): { key: string; label: string } {
    const cat = this.catalog()
    const m = agent.modelRef ? cat.find((x) => x.id === agent.modelRef!.id) : undefined
    if (m) return { key: m.id, label: modelLabel(m) }
    const arg = agent.model ?? 'default'
    return { key: `${agent.adapter}:${arg}`, label: `${agent.adapter} ${arg}` }
  }

  /** Add one event to the (task × model) record. */
  noteAptitude(
    agent: Agent,
    taskId: string,
    d: { runs?: number; ms?: number; approved?: number; changes?: number; failed?: number }
  ): void {
    const { key, label } = this.aptitudeKey(agent)
    const cur = this.hive.getAptitude(taskId)
    // a task can change hands: a different model starts its own record under the same task
    const base: AptitudeRecord =
      cur && cur.modelKey === key
        ? cur
        : { taskId, modelKey: key, modelLabel: label, domain: agent.job || 'general', runs: 0, ms: 0, approved: 0, changes: 0, failed: 0, updatedAt: '' }
    if (cur && cur.modelKey !== key) {
      this.hive.saveAptitude({ ...cur, taskId: `${taskId}~${cur.modelKey}` })
    }
    this.hive.saveAptitude({
      ...base,
      runs: base.runs + (d.runs ?? 0),
      ms: base.ms + (d.ms ?? 0),
      approved: base.approved + (d.approved ?? 0),
      changes: base.changes + (d.changes ?? 0),
      failed: base.failed + (d.failed ?? 0),
      updatedAt: new Date().toISOString()
    })
  }

  // ---- projects ----
  saveProject(input: Partial<Project> & { name: string }): Project {
    const p = this.hive.saveProject({ ...input, createdBy: this.config.memberName || 'me' })
    this.changed()
    return p
  }

  deleteProject(id: string): void {
    this.hive.deleteProject(id)
    this.hive.setProjectPath(id, '')
    this.changed()
  }

  setProjectPath(id: string, path: string): void {
    this.hive.setProjectPath(id, path)
    this.changed()
  }

  /** Remember the result of a connection check, so teammates see whether this computer's agents work. */
  recordCheck(adapter: Agent['adapter'], r: { ok: boolean; message: string }): void {
    const check: ConnectionCheck = { at: new Date().toISOString(), ok: r.ok, message: r.message.slice(0, 200) }
    // the check belongs to the connection (login), so agents created later on it show it as well
    this.hive.setConnectionCheck(adapter, check)
    for (const a of this.config.agents) if (a.adapter === adapter) this.hive.publishAgent(a, check)
    this.changed()
  }

  deleteMemory(id: string): void {
    this.hive.deleteMemory(id)
    this.changed()
  }

  // ---- auto-run ----
  /** Start ready tasks assigned to local agents, up to maxConcurrent. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const all = this.hive.listTasks()
      const busyAgents = new Set(
        [...this.running.keys()].map((id) => all.find((t) => t.id === id)?.assignee)
      )
      for (const t of all) {
        if (this.running.size >= this.config.maxConcurrent) break
        if (!this.config.autoRun && !t.auto) continue
        const agent = this.localAgent(t.assignee)
        if (!agent || busyAgents.has(agent.id) || !this.hive.isReady(t, all)) continue
        if (this.limitFor(agent.adapter) || this.folderBusy(agent, t.id)) continue
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
