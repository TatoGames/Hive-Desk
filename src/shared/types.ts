import type { AptitudeRecord } from './aptitude'
import type { Company, ModelAvailability, ModelEntry, ModelRef, OrgUnit, Seat } from './company'

/** (`gemini` was removed in v4: Google accounts use Antigravity. Old configs may still name it — shown as unknown.) */
export type AdapterId = 'claude' | 'codex' | 'agy' | 'custom'

/** An agent that runs on THIS machine, using the owner's own logged-in CLI. */
export interface Agent {
  /** Globally unique: `<member>-<name>` (slugged). Used as task assignee. */
  id: string
  /** The company this employee works for (absent = the first company). */
  companyId?: string
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
  /** Most AI runs the project may use (0 = no limit). */
  runBudget?: number
  /** The GitHub repository of the project's code (`owner/repo`) and its default branch. */
  github?: { repo: string; base: string }
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
  sources?: string[]
  /** Things done outside through a connection that cannot be undone. */
  externalWrites?: number
}

export type TaskStatus =
  | 'todo'
  | 'awaiting_approval'
  /** The agent asked the human for a file, info or decision and stopped. */
  | 'needs_input'
  | 'running'
  /** The run finished and changed things; a human looks at the result before it counts as done. */
  | 'needs_review'
  /** Delegated work waits for another agent (on a different model) to check it. */
  | 'in_review'
  /** A manager split the task up; it finishes when its sub-tasks are done. */
  | 'delegated'
  | 'done'
  | 'failed'
  /** A person stopped it. It never starts again by itself; a person resumes it. */
  | 'held'
  /** A person cancelled it. Kept with its record; can be reopened. */
  | 'cancelled'

/** One instruction a person gave to a task, tracked until the AI has applied it. */
export type InstructionMode = 'live' | 'interrupt' | 'after'
export type InstructionState = 'queued' | 'sent' | 'seen' | 'applied' | 'dropped'
export interface QuickInfo {
  size: import('./quick').JobSize
  kind: import('./quick').JobKind
  writes: boolean
  /** A lighter model tried on purpose to build up records. */
  trial: boolean
  /** The person picked the employee (not the app). */
  chosen?: boolean
  expectedRuns: number
  expectedUsage: number
  /** Times the job was handed to a higher tier; two, and it goes to the organisation. */
  escalations: number
  /** Why it moved up, oldest first. */
  trail: string[]
}

export interface Instruction {
  id: string
  text: string
  by: string
  at: string
  mode: InstructionMode
  state: InstructionState
  runId?: string
  /** The AI's one-line [[ACK: …]] when it applied the instruction. */
  ack?: string
  /** When the state last changed. */
  stateAt?: string
}

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
  /** What kind of job this is (set by quick assignment; also used to sort the aptitude records). */
  jobKind?: import('./quick').JobKind
  /** Handed straight to one employee (6-0.5) instead of through the organisation. */
  quick?: QuickInfo
  /** Time spent waiting for another task to leave the work folder. */
  folderWaitMs?: number
  /** How hard the model thinks for this task (Claude only). Quick assignment sets `low` for small jobs. */
  effort?: 'low' | 'medium' | 'high'
  /** A separate folder + branch this task works in (so tasks of one project can run at the same time). */
  worktree?: { path: string; branch: string; base: string; merged?: boolean }
  /** When the person last confirmed a stale bundle should go on. */
  /** A live run is interrupted and waiting for the person's next message. */
  paused?: boolean
  /** Where an interrupted run stopped, for the run that continues it (restart with a summary). */
  restartNote?: string
  /** The running AI takes messages right now (live mode). */
  liveInput?: boolean
  staleOkAt?: string
  /** The readable report file, relative to the company folder (`보고서/2026-10-18_…md`). */
  reportFile?: string
  attachments?: Attachment[]
  /** Extra folders (outside the work folder) the agent may read. Absolute paths on the runner's machine. */
  refDirs?: string[]
  permission?: PermissionLevel
  /** CLI session of the latest run, so a follow-up can continue the same conversation. */
  sessionId?: string
  /** What the agent is waiting for (status `needs_input`). */
  question?: string
  /** Questions the agent asked and what the human answered: pinned so they are never asked again. */
  answered?: { q: string; a: string; at: string }[]
  /** The human's answer, consumed by the next run. */
  reply?: string
  /** Old field (before v4): migrated into `instructions` when read. */
  followups?: string[]
  /** What people told this task to do differently; queued ones go into the next run's first input. */
  instructions?: Instruction[]
  /** Who it went from and to when a connection ran out of usage (v5). */
  handoffs?: Handoff[]
  /** The last step saving point of the running (or last) run. */
  stepSave?: StepSave
  /** v5.1: what the app checked by itself after the last work run (tests, types, lint, app start). */
  checks?: CheckRun
  /** Waits for its connection's usage limit (set when the run hit it; cleared when it runs again). */
  limitWait?: { adapter: AdapterId; since: string }
  /** External connections this task may use (ids). Absent = whatever the employee may use. */
  connections?: string[]
  /** The running AI waits for this approval (a live tool request): shown as "결재 대기" on its card. */
  waitingExternal?: string
  /** GitHub link of the task: the issue it came from, its branch and pull request. */
  github?: {
    repo: string
    issue?: { number: number; url: string; commented?: boolean }
    branch?: string
    pr?: { number: number; url: string; state: 'open' | 'merged' | 'closed' }
    /** Latest checks of the pull request. */
    checks?: { state: 'pending' | 'pass' | 'fail' | 'none'; at: string; failing: string[] }
    /** Review comments already turned into instructions (ids). */
    seen?: string[]
  }
  /** A person stopped / cancelled this task: nothing but a person may restart it. */
  stoppedBy?: { by: string; at: string; kind: 'hold' | 'cancel' | 'emergency' }
  /** Waits for a failed task it depends on (v4 failure propagation). */
  blocked?: { by: string; reason: string }
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
  /** This task is a work request from another company (v3 stage 5-4). */
  external?: { channelId: string; fromCompanyId: string; fromCompanyName: string; returned?: boolean }
  // ---- delegation (stage 3) ----
  /** What this task is in the delegation flow. Missing = a plain task. */
  kind?: TaskKind
  parentId?: string
  /** 0 = what the board handed over; each split adds one. */
  depth?: number
  /** Runs without the global auto-run switch (the delegation tree drives itself). */
  auto?: boolean
  /** The board named this manager itself: its first plan goes to the board. */
  directed?: boolean
  /** Completion criteria the planner wrote for this sub-task. */
  criteria?: string
  plan?: Plan
  /** For a review task: the task (work or plan) being checked. */
  reviewOf?: string
  /** For a work task: how its cross review stands. */
  reviewState?: ReviewState
  /** Planning attempts rejected for form/size (before a plan is accepted). */
  planTries?: number
  /** Not shown on the board (committee runs). */
  hidden?: boolean
  /** The agenda a committee run belongs to. */
  agendaId?: string
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

export type TaskKind = 'work' | 'plan' | 'review' | 'integrate' | 'committee'

/** One sub-task a manager proposes. */
export interface SubtaskSpec {
  title: string
  /** Agent id (from the team list the manager was given). */
  assignee: string
  /** Completion criteria. */
  done: string
  /** 1-based numbers of sub-tasks that must finish first. */
  after: number[]
  /** What the worker may do: `read` for analysis, `edit` when the result is files (default), `exec` when commands are needed. */
  access?: PermissionLevel
  /** The planner's guess of AI runs this sub-task needs (see estimates). */
  est?: number
  /** Folders/files this sub-task works on (lets non-overlapping ones run at the same time). */
  files?: string[]
}

export type PlanStatus = 'awaiting_board' | 'awaiting_superior' | 'approved' | 'rejected'

export interface Plan {
  items: SubtaskSpec[]
  /** Expected number of AI runs (work + reviews + planning). */
  estimateRuns: number
  /** What the number is made of (shown on the approval screen). */
  estimateParts?: { plan: number; work: number; review: number; buffer: number; basis: string[] }
  /** Sub-tasks that cannot be done as written (no GitHub, web off, read-only but must write). */
  issues?: { index: number; kind: 'github' | 'web' | 'readonly'; text: string; fix?: { access: PermissionLevel } }[]
  /** The estimate of the plan this one replaced (after a rejection). */
  prevEstimate?: number
  /** The board approved "at most N runs": the bundle stops and asks when it reaches this. */
  runCap?: number
  flags: string[]
  status: PlanStatus
  approver: 'board' | 'superior' | 'auto'
  /** Why the board has to decide ("큰 일" reasons). */
  boardReasons: string[]
  /** How often a plan for this task was sent back. */
  rejections: number
  childIds?: string[]
  note?: string
}

export interface ReviewState {
  status: 'pending' | 'passed' | 'changes' | 'skipped'
  /** How many times the reviewer sent it back to the same worker. */
  round: number
  /** After repeated rejections the task moved up to the unit's lead. */
  escalations: number
  /** Left to the review of the whole bundle after integration (v0.6.1). */
  deferred?: boolean
  by?: string
  note?: string
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
  /** The delegation engine did something (plan, review, escalation ...). */
  | 'delegation'

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
  /** What kind of thing that was (the speech bubble of the work-status view is made from it). */
  lastKind?: ActivityKind
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
  /** Web pages the AI read (shown as the report's sources). */
  sources?: string[]
  /** What the run did outside through a connection (sent, changed): HiveDesk cannot undo these. */
  external?: import('./external').ExtLogEntry[]
}

/** A run without the heavy fields, for lists. */
export type RunSummary = Omit<RunRecord, 'prompt' | 'response' | 'stderr' | 'diff'> & {
  diffStat: { available: boolean; files: number; additions: number; deletions: number }
}

export interface TaskHistory {
  events: TaskEvent[]
  runs: RunSummary[]
  approvals: Approval[]
}

export type ApprovalKind = 'risky-task' | 'budget' | 'agent-request' | 'plan' | 'failure' | 'bundle-cap' | 'stale-bundle' | 'external' | 'github' | 'handoff'

/** One time a task changed hands because its employee's connection ran out of usage (or a person moved it on). */
export interface Handoff {
  from: string
  to: string
  fromAdapter: AdapterId
  toAdapter: AdapterId
  reason: 'limit' | 'manual'
  at: string
  /** Usage weight of the new model ÷ the old one (2 = about twice as expensive per run). */
  costX: number
}

/** Where a run stood at its last finished step, kept so another employee can carry on from there. */
export interface StepSave {
  runId: string
  plan: string[]
  /** Steps finished (the step in progress is `done + 1`). */
  done: number
  /** Files changed so far (relative paths, at most 30). */
  files: string[]
  /** The AI's last words, a line or two. */
  last: string
  at: string
  /** git only: the work folder exactly as it was when this step ended. */
  checkpoint?: Checkpoint
}

/** A GitHub step the app does for a task once a person says yes (pushing, opening a PR, merging, commenting on the issue). */
export interface GithubAction {
  action: 'push-pr' | 'merge' | 'comment'
  repo: string
  branch?: string
  pr?: number
  issue?: number
  /** The pull request / comment text the app will send (the person may change it). */
  title?: string
  body?: string
}
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
  /** The decider's comment (a rejected plan's reason). */
  note?: string
  /** A live tool request of a running AI (external connection): the run waits for this answer. */
  external?: import('./external').ExtRequest
  github?: GithubAction
  /** A hand-over that waits for a yes because the new model costs much more. */
  handoff?: { to: string; costX: number; reason: 'limit' | 'manual' }
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

export type AgendaPhase = 'proposals' | 'critique' | 'votes' | 'board' | 'decided' | 'failed'

/** A question the CEO committee works through before the board decides. */
export interface Agenda {
  id: string
  title: string
  body: string
  createdAt: string
  createdBy: string
  phase: AgendaPhase
  /** `quick` (default): one round, every member proposes and recommends in one run. `deep`: proposals → critique → votes. */
  mode?: 'quick' | 'deep'
  /** Roster ids of the committee (agents on CEO seats), frozen when the agenda opens. */
  members: string[]
  /** Hidden tasks of the phase that is running. */
  taskIds: string[]
  proposals: { agentId: string; text: string }[]
  critiques: { agentId: string; text: string }[]
  votes: { agentId: string; choice: number; reason: string }[]
  recommendation?: {
    /** 1-based proposal number, 0 when there is no clear winner. */
    choice: number
    tally: number[]
    minority: { agentId: string; choice: number; reason: string }[]
  }
  decision?: { at: string; by: string; choice: number; note: string }
  /** The task that was waiting for this decision ("direction unclear"). */
  fromTaskId?: string
  note?: string
}

/** One company as the switcher and the board dashboard show it. */
export interface CompanySummary {
  id: string
  name: string
  active: boolean
  /** Tasks that are not done yet. */
  open: number
  running: number
  /** Approvals, questions and results that wait for the board. */
  waiting: number
  members: number
  runsToday: number
  minutesToday: number
}

export interface AutoApprove {
  /** A read-only task asks to write files in its work folder → allow `edit`. */
  readToEdit: boolean
  /** A plan whose only reason for the board is an estimate over the limit by at most this many percent (0 = off). */
  planOverPercent: number
  /** A plan sent back and re-submitted with fewer expected runs. */
  planSmaller: boolean
}

export interface HandoffSettings {
  /** Hand over when the limit is hit (default on). */
  auto: boolean
  /** Also to a stronger (usually more expensive) tier when nobody of the same tier can (default on). */
  up: boolean
  /** Ask first when the usage weight goes up by this factor or more (0 = never ask; default 2). */
  confirmAtCostX: number
  /** Wait instead when the limit resets within this many minutes (only when the reset time is known; default 20). */
  waitMinutes: number
  /** Put the step that was in progress back to how it was when it started (git folders; default on). */
  rollbackStep: boolean
}

/** One check the app ran in the work folder (no AI, no tokens). */
export interface CheckItem {
  /** `test`, `typecheck`, `lint`, `build`, `app` (the app was started) */
  name: string
  /** The command line, or what was started. */
  cmd: string
  ok: boolean
  ms: number
  /** The end of what it printed (failures: the part that says why). */
  tail: string
  /** `app` check: a picture of the first window. */
  screenshot?: string
  /** Skipped (e.g. nothing to start the app with); not a failure. */
  skipped?: string
}

export interface CheckRun {
  at: string
  ok: boolean
  items: CheckItem[]
}

export type ReviewPolicy = 'risk' | 'always'

/** Sub-tasks of a bundle: `once` (default) = reviewed together after integration; `each` = every one on its own. Only with policy `risk`. */
export type BundleReview = 'once' | 'each'

export interface ReviewSettings {
  /** Run the project's own checks before an AI looks at the work (default on). */
  checks: boolean
  /** Start an Electron app the work built and look at it (default on). */
  appCheck: boolean
  /** `risk` (default): small, safe changes that pass the checks need no AI review. `always`: every change is reviewed. */
  policy: ReviewPolicy
  /** How many times work goes back to the same worker before it moves up (1–3, default 2). */
  maxRounds: number
  /** Bundles: one review of the whole after integration instead of one per sub-task (risky sub-tasks are still reviewed on their own). */
  bundle: BundleReview
}

export const DEFAULT_REVIEW: ReviewSettings = { checks: true, appCheck: true, policy: 'risk', maxRounds: 2, bundle: 'once' }

export const DEFAULT_HANDOFF: HandoffSettings = { auto: true, up: true, confirmAtCostX: 2, waitMinutes: 20, rollbackStep: true }

export const DEFAULT_AUTO_APPROVE: AutoApprove = { readToEdit: true, planOverPercent: 20, planSmaller: true }

export interface AppConfig {
  /** Share of low-risk quick jobs given to a lighter model on trial (0..1). */
  /** Keep Claude's input open so instructions reach a running task (default on; off = old one-shot mode). */
  liveInstructions?: boolean
  quickTrialRate?: number
  /** Company priority for shared usage limits (highest first); companies not listed follow in creation order. */
  companyOrder?: string[]
  /** The same per connection (CLI), overriding `companyOrder`. */
  connectionOrder?: Record<string, string[]>
  /** The company shown on screen. */
  activeCompanyId?: string
  /** Desktop notifications for approvals, reports and failures (default on). */
  notifications?: boolean
  /** `changes` (default): check results that changed files. */
  humanReview: HumanReview
  /** Attachments above this size (MB) stay on this machine instead of syncing to the team. */
  attachShareMaxMB: number
  memberName: string
  workspace: string
  agents: Agent[]
  /** Remove API-key env vars from CLI processes so the CLI uses your login, not paid API. */
  stripApiKeys: boolean
  /** Start the tasks people gave to an agent by themselves. */
  autoRun: boolean
  /** Let the organisation drive itself: planning, review, integration, committee (default on). */
  autoRunOrg?: boolean
  /** Hours a failed bundle waits for the board's decision before it is held (default 3). */
  failureHoldHours?: number
  /** A bundle nobody touched for this many hours asks before its waiting tasks start by themselves (0 = never ask). */
  staleBundleHours?: number
  /** Also send notifications to a phone: a Discord webhook address and/or a Telegram bot. */
  discordWebhook?: string
  telegram?: { token: string; chatId: string }
  /** Hours after which an unanswered approval gets its default answer (0 = wait for ever). */
  approvalTimeoutHours?: number
  /** Approvals the app may answer itself (never deletes, deploys, sending data out, or commands). */
  autoApprove?: AutoApprove
  /** Sub-tasks of a project in a git folder work in their own work trees and run at the same time (off by default). */
  parallelWorktrees?: boolean
  /** Minutes a running AI waits for a person to answer a live tool request before it is declined (default 30). */
  externalApprovalMinutes?: number
  /** v5: when a connection runs out of usage, another connection's employee carries the task on. */
  handoff?: HandoffSettings
  /** v6 챗: the model of the last conversation (a new one starts with it). */
  chatModel?: import('./chat').ChatModel
  /** v5.1: the app's own checks and when an AI review is needed. */
  review?: Partial<ReviewSettings>
  /** v0.6.1: put a snapshot of the work folder (structure, scripts, README, recent work) at the top of each prompt (default on). */
  projectSnapshot?: boolean
  /** v0.6: `basic` shows the everyday menus only; `advanced` (default for configs from before v0.6) shows everything. */
  uiMode?: 'basic' | 'advanced'
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
  companies: CompanySummary[]
  /** Folder of the company being viewed — where runs happen when no project/agent folder is set. */
  companyRoot: string
  collab: import('./collab').CollabView
  external: import('./collab').ExternalItem[]
  connections: import('./connections').ConnectionView[]
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
  /** External connections of the company on screen (web, GitHub, apps) and their log. */
  ext: import('./external').ExtView
}

export interface EngineEvent {
  type: 'changed' | 'output' | 'setup' | 'activity' | 'notify' | 'chat'
  taskId?: string
  /** For `chat`: the conversation that changed (the open screen reads it again). */
  chatId?: string
  /** For `activity`: new feed lines and the up-to-date numbers. */
  events?: ActivityEvent[]
  summary?: LiveSummary
  /** For `setup`: which CLI the installer output belongs to. */
  adapter?: AdapterId
  chunk?: string
  /** For `notify`: a desktop notification. */
  title?: string
  body?: string
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
  finals: FinalReport[]
  agendas: Agenda[]
}

export interface ReportNode {
  taskId: string
  title: string
  kind: TaskKind | 'work'
  agentId: string | null
  agentName: string
  job?: string
  model: string
  status: TaskStatus
  runs: number
  minutes: number
  files: DiffFile[]
  report?: Report
  /** Cross review result in one line. */
  review?: string
  children: ReportNode[]
}

/** What the board reads at the end of a delegated job. */
export interface FinalReport {
  id: string
  title: string
  createdAt: string
  summary: string
  tree: ReportNode
  totals: { runs: number; minutes: number; files: number; additions: number; deletions: number; tasks: number }
  verification: string[]
  risks: string[]
  next: string[]
  /** The board's decision on the report. */
  decision?: { at: string; by: string; accepted: boolean; note?: string }
}
