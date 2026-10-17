export type AdapterId = 'claude' | 'codex' | 'gemini' | 'agy' | 'custom'

/** An agent that runs on THIS machine, using the owner's own logged-in CLI. */
export interface Agent {
  /** Globally unique: `<member>-<name>` (slugged). Used as task assignee. */
  id: string
  name: string
  owner: string
  adapter: AdapterId
  role: string
  /** Folder the CLI runs in (your project). Empty = the hive folder. */
  workDir: string
  model?: string
  /** Extra CLI args, space separated (quotes allowed). */
  extraArgs: string
  /** For adapter "custom": the executable to run. */
  command?: string
  /** Budget: max runs per day (0 = unlimited). */
  dailyRunLimit: number
  /** Budget: max minutes of CLI time per day (0 = unlimited). */
  dailyMinuteLimit: number
  /** Per-run timeout in minutes. */
  timeoutMinutes: number
  /** If true, every task for this agent needs human approval first. */
  requireApproval: boolean
}

/** What other team members see of an agent (no local paths). */
export interface RosterEntry {
  id: string
  name: string
  owner: string
  adapter: AdapterId
  role: string
}

export type TaskStatus = 'todo' | 'awaiting_approval' | 'running' | 'done' | 'failed'

export interface Task {
  id: string
  title: string
  description: string
  assignee: string | null
  status: TaskStatus
  /** Needs human approval before it runs. */
  risky: boolean
  dependsOn: string[]
  createdBy: string
  createdAt: string
  updatedAt: string
  /** Approval kinds a human already cleared for this task. */
  cleared: ApprovalKind[]
  notes: string[]
  result?: string
  /** Structured report from the latest run (the agent's own account). */
  report?: Report
  /** Id of the latest run record (kept on the machine that ran it). */
  lastRunId?: string
  error?: string
  startedAt?: string
  finishedAt?: string
}

/** Standard report format: what was done / files changed / how to verify / risks / next. */
export interface Report {
  did: string
  files: string
  verify: string
  risks: string
  next: string
}

export type TaskEventKind =
  | 'created'
  /** Reserved for the delegation engine (stage 3): requirement check, review. */
  | 'check'
  | 'approval_requested'
  | 'approval_decided'
  | 'run_started'
  | 'run_finished'
  | 'review'
  | 'status'

/** One line of a task's timeline. Append-only: events are never rewritten. */
export interface TaskEvent {
  id: string
  taskId: string
  at: string
  kind: TaskEventKind
  /** Who/what caused it: a member name, an agent id, or "system". */
  actor: string
  text: string
  runId?: string
}

export type RunResultKind = 'done' | 'failed' | 'cancelled' | 'awaiting_approval'

export interface DiffFile {
  path: string
  /** A(dded) M(odified) D(eleted) T(ype changed) */
  status: string
  additions: number
  deletions: number
  binary: boolean
}

/** What a run changed in the agent's work folder (only when it is a git repo). */
export interface RunDiff {
  available: boolean
  /** Why there is no diff (not a git repo, git failed, ...). */
  reason?: string
  files: DiffFile[]
  patch: string
  truncated: boolean
}

/** Everything about one execution. Stored per machine under `.local/runs`; never overwritten. */
export interface RunRecord {
  id: string
  taskId: string
  agentId: string
  adapter: AdapterId
  model?: string
  startedAt: string
  finishedAt: string
  durationMs: number
  outcome: RunResultKind
  exitCode: number | null
  /** The exact instruction sent to the CLI. */
  prompt: string
  /** The CLI's raw answer (markers included). */
  response: string
  stderr: string
  error?: string
  report?: Report
  diff: RunDiff
}

/** A run without the heavy fields, for lists. */
export type RunSummary = Omit<RunRecord, 'prompt' | 'response' | 'stderr' | 'diff'> & {
  diffStat: { available: boolean; files: number; additions: number; deletions: number }
}

export interface TaskHistory {
  events: TaskEvent[]
  runs: RunSummary[]
}

export type ApprovalKind = 'risky-task' | 'budget' | 'agent-request'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface Approval {
  id: string
  kind: ApprovalKind
  taskId: string
  agentId: string
  reason: string
  status: ApprovalStatus
  createdAt: string
  decidedAt?: string
  decidedBy?: string
}

export interface Message {
  id: string
  from: string
  to: string
  body: string
  createdAt: string
  read: boolean
}

export interface MemoryEntry {
  id: string
  author: string
  text: string
  createdAt: string
}

export interface Usage {
  runs: number
  ms: number
}

export interface AppConfig {
  memberName: string
  workspace: string
  agents: Agent[]
  /** Remove API-key env vars from CLI processes so the CLI uses your login, not paid API. */
  stripApiKeys: boolean
  autoRun: boolean
  maxConcurrent: number
  syncIntervalMinutes: number
}

export interface AdapterInfo {
  id: AdapterId
  label: string
  command: string
  found: boolean
  version?: string
  install: string
  login: string
  note?: string
  /** One-click install is available on this OS. */
  canInstall?: boolean
}

export interface SyncResult {
  ok: boolean
  message: string
}

export interface Snapshot {
  config: AppConfig
  tasks: Task[]
  approvals: Approval[]
  roster: RosterEntry[]
  messages: Message[]
  memory: MemoryEntry[]
  usage: Record<string, Usage>
  running: string[]
  gitEnabled: boolean
}

export interface EngineEvent {
  type: 'changed' | 'output' | 'setup'
  taskId?: string
  /** For `setup`: which CLI the installer output belongs to. */
  adapter?: AdapterId
  chunk?: string
}

export interface SetupCheck {
  ok: boolean
  needsLogin: boolean
  message: string
}
