import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type {
  Agent,
  AppConfig,
  EngineEvent,
  Snapshot,
  SyncResult,
  Task
} from '../shared/types'
import { runCli, type Runner } from './adapters'
import { loadConfig, makeAgent, saveConfig } from './config'
import { Hive } from './hive'
import { runTask } from './runner'
import { initSync, isGitRepo, syncNow } from './sync'

export type Emit = (e: EngineEvent) => void

/** Owns config + hive, runs tasks (manually or via auto-run), and schedules git sync. */
export class Engine {
  config: AppConfig
  hive: Hive
  private running = new Map<string, AbortController>()
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
      gitEnabled: isGitRepo(this.config.workspace)
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
  }): Task {
    const t = this.hive.createTask({ ...input, createdBy: this.config.memberName || 'me' })
    this.changed()
    return t
  }

  updateTask(id: string, patch: Partial<Task>): Task {
    const t = this.hive.updateTask(id, patch)
    this.changed()
    return t
  }

  deleteTask(id: string): void {
    this.stopTask(id)
    this.hive.deleteTask(id)
    this.changed()
  }

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
      return await runTask(agent, id, {
        hive: this.hive,
        stripApiKeys: this.config.stripApiKeys,
        runner: this.runner,
        defaultCwd: this.config.workspace,
        signal: ac.signal,
        onOutput: (taskId, chunk) => this.emit({ type: 'output', taskId, chunk })
      })
    } finally {
      this.running.delete(id)
      this.changed()
    }
  }

  stopTask(id: string): void {
    this.running.get(id)?.abort()
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
