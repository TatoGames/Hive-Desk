import type { AptitudeRecord } from './aptitude'
import type { Company, ModelAvailability, ModelEntry, ModelRef, OrgUnit, Seat } from './company'

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
  // ---- company model (stage 2) ----
  /** Rank id in the company's rank list. */
  rankId?: string
  /** Org unit the agent belongs to. */
  unitId?: string
  /** Work area (see JOBS): plan / build / review ... */
  job?: string
  /** Catalog model + how it is pinned. `model` holds the resulting CLI argument. */
  modelRef?: ModelRef
  /** The permission level tasks get when they do not set their own. */
  permission?: PermissionLevel
}

/** What other team members see of an agent (no local paths). */
export interface RosterEntry {
  id: string
  name: string
  owner: string
  adapter: AdapterId
  role: string
  /** Result of the owner's latest connection check (login / CLI works). */
  check?: ConnectionCheck
  rankId?: string
  unitId?: string
  job?: string
  /** Catalog id of the agent's model, and the CLI argument it runs with. */
  modelId?: string
  model?: string
}

export interface ConnectionCheck {
  at: string
  ok: boolean
  message: string
}

/** A body of work shared by the team: a briefing every run reads, and a work folder name. */
export interface Project {
  id: string
  name: string
  description: string
  /** Fixed briefing: goals, rules, conventions. Put into every prompt of this project. */
  briefing: string
  /** Shared name of the work folder. Each computer maps it to its own path (see Snapshot.projectPaths). */
  folderName: string
  createdBy: string
  createdAt: string
}

/** Shared, size-limited summary of a run: teammates on other computers see this (the full record stays local). */
export interface RunShared {
  id: string
  taskId: string
  agentId: string
  machine: string
  adapter: AdapterId
  model?: string
  startedAt: string
  finishedAt: string
  durationMs: number
  outcome: RunResultKind
  report?: Report
  diffStat: { available: boolean; files: number; additions: number; deletions: number }
  files: DiffFile[]
  /** Only when small enough (see SHARED_PATCH_MAX). */
  patch?: string
  response?: string
  error?: string
}

export type TaskStatus =
  | 'todo'
  | 'awaiting_approval'
  /** The agent asked the human for a file, info or decision and stopped. */
  | 'needs_input'
  | 'running'
  /** The run finished and changed things; a human looks at the result before it counts as done. */
  | 'needs_review'
  | 'done'
  | 'failed'

/** What the agent may do in this task. `edit` is the default (the agent's own settings apply). */
export type PermissionLevel = 'read' | 'edit' | 'exec'

/** A file the human handed to the task. Stored in the hive, so teammates get it too. */
export interface Attachment {
  name: string
  /** Path relative to the hive folder. */
  rel: string
  size: number
  /** Too big to share: kept on this machine only (`.local/`). */
  local: boolean
  addedBy: string
  addedAt: string
}

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
  attachments?: Attachment[]
  /** Extra folders (outside the work folder) the agent may read. Absolute paths on the runner's machine. */
  refDirs?: string[]
  permission?: PermissionLevel
  /** CLI session of the latest run, so a follow-up can continue the same conversation. */
  sessionId?: string
  /** What the agent is waiting for (status `needs_input`). */
  question?: string
  /** The human's answer, consumed by the next run. */
  reply?: string
  /** Extra instructions added while a run was in progress; applied when the step ends. */
  followups?: string[]
  /** Id of the latest run record (kept on the machine that ran it). */
  lastRunId?: string
  /** The app closed during this run; some changes may be left in the work folder. */
  interruptedRun?: string
  /** Upper limit for the total run time of this task (minutes). Default 240. */
  maxMinutes?: number
  /** What kind of failure `error` is, so the UI can offer the right fix. */
  errorKind?: FailureKind
  /** Let the agent read secret-looking files (.env, keys). Off by default. */
  allowSecrets?: boolean
  projectId?: string
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

export type FailureKind = 'login' | 'limit' | 'permission' | 'not_found' | 'network' | 'timeout' | 'unknown'

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
  /** The agent asked for material / a decision. */
  | 'need'
  | 'reply'
  | 'instruction'
  /** A human undid a run. */
  | 'rollback'
  /** A field of the task was changed by hand (assignee, title, permission ...). */
  | 'changed'

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

export type RunResultKind =
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'awaiting_approval'
  | 'needs_input'
  /** Written when a run starts; replaced by the real outcome when it ends. */
  | 'running'
  /** The app closed (or crashed) in the middle of the run: some changes may be left behind. */
  | 'interrupted'
  /** The CLI said the usage limit is used up. */
  | 'limit'

/** How the work folder can be put back the way it was before a run. */
export interface Checkpoint {
  /** `git` = a hidden ref in the repo; `copy` = files backed up under the hive's `.local/checkpoints`. */
  kind: 'git' | 'copy'
  /** git: the commit that holds the pre-run state (kept as `refs/hivedesk/<run>`). */
  ref?: string
  tree?: string
  /** git: repository root. copy: the work folder that was backed up. */
  root: string
  /** copy: backup folder, relative to the hive. */
  dir?: string
  files?: number
  bytes?: number
}

/** One human-readable line of what the agent is doing right now. */
export type ActivityKind =
  | 'read'
  | 'edit'
  | 'write'
  | 'command'
  | 'search'
  | 'message'
  | 'plan'
  | 'tool'
  | 'error'
  | 'note'

export interface ActivityEvent {
  /** Increasing per run. */
  n: number
  at: string
  kind: ActivityKind
  text: string
  path?: string
  /** Lines added / removed, as reported by the agent (the diff is the ground truth). */
  add?: number
  del?: number
}

export interface PlanItem {
  text: string
  done: boolean
}

export type TrackMode = 'git' | 'scan' | 'none'

/** Cheap progress numbers for a running task (sent with every update). */
export interface LiveSummary {
  taskId: string
  runId: string
  cwd: string
  startedAt: string
  steps: number
  files: number
  add: number
  del: number
  plan: PlanItem[]
  tracking: TrackMode
  /** Last thing the agent did, for the card. */
  last?: string
}

/** Everything the detail panel shows for a running task. */
export interface LiveState extends LiveSummary {
  events: ActivityEvent[]
  changes: DiffFile[]
  patch: string
  /** `scan` mode lists files but cannot count lines. */
  lines: boolean
  /** Folder `changes[].path` is relative to. */
  root: string
}

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
  /** Why there is no diff (git failed, folder too big, ...), or a caveat when `lines` is false. */
  reason?: string
  /** false = file list only (folder is not a git repo), so additions/deletions are not counted. */
  lines?: boolean
  /** Folder the file paths are relative to (the git root, which may sit above the work folder). */
  root?: string
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
  /** The work folder the CLI ran in. */
  cwd: string
  permission?: PermissionLevel
  sessionId?: string
  /** Step-by-step feed (read / edit / command ...), as the agent reported it. */
  activity: ActivityEvent[]
  /** How to undo this run; absent when the folder could not be saved (see `checkpointNote`). */
  checkpoint?: Checkpoint
  checkpointNote?: string
  /** Set when a human undid this run. */
  rolledBackAt?: string
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
  /** `fixed` entries go into every prompt; the others only the most recent ones. */
  kind?: 'fixed' | 'recent'
}

export interface Usage {
  runs: number
  ms: number
}

/** When a finished run waits for a human check before it counts as done. */
export type HumanReview = 'off' | 'changes' | 'always'

export interface AppConfig {
  /** `changes` (default): check results that changed files. */
  humanReview: HumanReview
  /** Attachments above this size (MB) stay on this machine instead of syncing to the team. */
  attachShareMaxMB: number
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
  /** Progress of tasks that are running right now (this machine). */
  live: Record<string, LiveSummary>
  /** Tasks waiting for another task that works in the same folder: taskId → the task they wait for. */
  waiting: Record<string, string>
  /** CLIs whose usage limit is used up on this machine, until when (key = adapter id). */
  limits: Record<string, { until: string; message: string; guessed: boolean }>
  projects: Project[]
  company: CompanySnapshot
  /** This computer's folder for each project (project id → absolute path). */
  projectPaths: Record<string, string>
}

export interface EngineEvent {
  type: 'changed' | 'output' | 'setup' | 'activity'
  taskId?: string
  /** For `activity`: new feed lines and the up-to-date numbers. */
  events?: ActivityEvent[]
  summary?: LiveSummary
  /** For `setup`: which CLI the installer output belongs to. */
  adapter?: AdapterId
  chunk?: string
}

export interface SetupCheck {
  ok: boolean
  needsLogin: boolean
  message: string
}

export interface PreflightItem {
  level: 'ok' | 'warn' | 'error'
  text: string
  /** A one-click fix the UI can offer. */
  fix?: 'git-init'
  /** The human must tick a box before the run can start (the risk cannot be enforced away). */
  confirm?: boolean
}

/** The "before you run" screen: what the agent will touch and what could go wrong. */
export interface Preflight {
  workDir: string
  items: PreflightItem[]
  /** false when something blocks the run (e.g. the work folder is gone). */
  canRun: boolean
}

export interface AttachResult {
  /** Hints about formats the AI may not be able to read (see attachAdvice). */
  notes: string[]
  attached: Attachment[]
  /** Dropped folders become reference folders. */
  folders: string[]
  errors: string[]
}

/** The company model as the screens see it. */
export interface CompanySnapshot {
  company: Company | null
  units: OrgUnit[]
  seats: Seat[]
  /** Defaults + the user's own entries. */
  catalog: ModelEntry[]
  /** [사용 확인] results on this computer (model id → result). */
  availability: Record<string, ModelAvailability>
  aptitude: AptitudeRecord[]
}
