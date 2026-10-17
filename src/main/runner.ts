import { existsSync } from 'node:fs'
import type {
  ActivityEvent,
  Agent,
  HumanReview,
  PermissionLevel,
  Report,
  RunDiff,
  RunRecord,
  RunResultKind,
  Task
} from '../shared/types'
import { createParser, LiveRun } from './activity'
import { adapterAccess, buildCommand, cleanEnv, effectivePermission, type Runner } from './adapters'
import { createCheckpoint } from './checkpoint'
import { classifyFailure, failureMessage } from './failure'
import { detectLimit, type LimitInfo } from './limits'
import { diffStat, trackChanges, unavailable } from './gitdiff'
import { Hive, newId } from './hive'
import { stageAttachments } from './staging'

export interface ParsedMarkers {
  clean: string
  memory: string[]
  messages: { to: string; body: string }[]
  approvals: string[]
  /** What the agent needs from the human to continue (`[[NEED: …]]`). */
  needs: string[]
  /** Present when the agent used at least one report marker (DID/FILES/VERIFY/RISK/NEXT). */
  report?: Report
}

const REPORT_KEYS: Record<string, keyof Report> = {
  DID: 'did',
  FILES: 'files',
  VERIFY: 'verify',
  RISK: 'risks',
  NEXT: 'next'
}

/** Agents talk back to the hive with marker lines, e.g. `[[MEMORY: we use pnpm]]`. */
export function parseMarkers(text: string): ParsedMarkers {
  const memory: string[] = []
  const messages: { to: string; body: string }[] = []
  const approvals: string[] = []
  const needs: string[] = []
  const parts: Partial<Record<keyof Report, string[]>> = {}
  const re =
    /^[ \t]*\[\[(MEMORY|MSG|APPROVAL|NEED|PLAN|STEP|DID|FILES|VERIFY|RISK|NEXT)(?:[ \t]+to=([^\s:\]]+))?[ \t]*:[ \t]*([\s\S]*?)\]\][ \t]*$/gm
  const clean = text.replace(re, (_m, kind: string, to: string | undefined, body: string) => {
    const b = body.trim()
    if (!b) return ''
    if (kind === 'MEMORY') memory.push(b)
    else if (kind === 'MSG' && to) messages.push({ to, body: b })
    else if (kind === 'APPROVAL') approvals.push(b)
    else if (kind === 'NEED') needs.push(b)
    else if (REPORT_KEYS[kind]) (parts[REPORT_KEYS[kind]] ??= []).push(b)
    // PLAN / STEP only drive the live progress bar; they are dropped from the result
    return ''
  })
  const report = Object.keys(parts).length
    ? {
        did: (parts.did ?? []).join('\n'),
        files: (parts.files ?? []).join('\n'),
        verify: (parts.verify ?? []).join('\n'),
        risks: (parts.risks ?? []).join('\n'),
        next: (parts.next ?? []).join('\n')
      }
    : undefined
  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), memory, messages, approvals, needs, report }
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}

const PERMISSION_TEXT: Record<PermissionLevel, string | null> = {
  edit: null,
  read:
    'Permission level for this task: READ-ONLY. Do not create, modify, move or delete any file, and do not run commands that change anything. Read, analyse and report only.',
  exec:
    'Permission level for this task: COMMANDS ALLOWED. You may run the shell commands the task needs (build, test, install). Avoid anything destructive outside the task.'
}

/** Attachments and reference folders, as the agent should see them. */
function materialLines(task: Task, hive: Hive, staged?: Map<string, string>): string[] {
  const lines: string[] = []
  const atts = task.attachments ?? []
  if (atts.length) {
    lines.push('', '## Materials the human attached (read these first)')
    for (const a of atts) {
      const abs = staged?.get(a.rel) ?? hive.attachmentPath(a)
      lines.push(
        existsSync(abs)
          ? `- ${abs} (${fmtSize(a.size)})`
          : `- ${a.name}: not available on this machine${a.local ? ' (too large to share)' : ''}`
      )
    }
  }
  const dirs = (task.refDirs ?? []).filter((d) => existsSync(d))
  if (dirs.length) {
    lines.push('', '## Reference folders you may read (outside your work folder)')
    for (const d of dirs) lines.push(`- ${d}`)
    lines.push('Only read from them; put your changes in the work folder.')
  }
  return lines
}

export function buildPrompt(opts: {
  agent: Agent
  task: Task
  hive: Hive
  maxMemory?: number
  /** Where the attachments were copied for this run (see staging.ts). */
  staged?: Map<string, string>
}): string {
  const { agent, task, hive } = opts
  const mem = hive.listMemory(opts.maxMemory ?? 20)
  const inbox = hive.listInbox(agent.id).filter((m) => !m.read)
  const roster = hive.listRoster().filter((r) => r.id !== agent.id)
  const deps = task.dependsOn
    .map((d) => hive.getTask(d))
    .filter((t): t is Task => !!t && t.status === 'done' && !!t.result)

  const lines: string[] = []
  lines.push(`You are "${agent.name}", an AI teammate. Role: ${agent.role || 'general helper'}.`)
  lines.push(
    'You work in a small team coordinated through shared files by the HiveDesk app. A human reviews your result.'
  )
  lines.push('', '## Your task', task.title)
  if (task.description) lines.push('', task.description)
  if (task.notes.length) lines.push('', 'Notes on this task:', ...task.notes.map((n) => `- ${n}`))
  const perm = PERMISSION_TEXT[effectivePermission(agent.adapter, task.permission)]
  if (perm) lines.push('', perm)
  lines.push(...materialLines(task, hive, opts.staged))

  // The human answered an earlier question: tell this fresh run what happened so far.
  if (task.reply !== undefined) {
    lines.push('', '## Earlier in this task')
    if (task.question) lines.push('You asked the human:', task.question)
    if (task.result) lines.push('Your earlier output:', task.result.slice(0, 4000))
    lines.push('', 'The human replied:', task.reply, '', 'Continue the task with this answer.')
  }
  if (deps.length) {
    lines.push('', '## Results from tasks this depends on')
    for (const d of deps) lines.push(`### ${d.title}`, (d.result ?? '').slice(0, 4000))
  }
  if (mem.length) {
    lines.push('', '## Shared team memory (most recent last)')
    for (const m of mem) lines.push(`- (${m.author}) ${m.text}`)
  }
  if (inbox.length) {
    lines.push('', '## Unread messages for you')
    for (const m of inbox) lines.push(`- from ${m.from}: ${m.body}`)
  }
  if (roster.length) {
    lines.push('', '## Teammates you can message')
    for (const r of roster) lines.push(`- ${r.id} (${r.role || r.adapter})`)
  }
  lines.push(
    '',
    '## Reply protocol',
    'Reply in the same language as the task.',
    'Before you start, write your plan on ONE line: [[PLAN: first step | second step | third step]]. After finishing each step write [[STEP: n]] on its own line (n = the step number). The human watches this progress live.',
    'Give your result, then end with a short structured report using these markers.',
    'Each marker starts at the beginning of a line; a part may span several lines and ends with ]] at the end of a line:',
    '[[DID: what you did]]',
    '[[FILES: files you changed or created, one per line, or "none"]]',
    '[[VERIFY: how a human can check that it works]]',
    '[[RISK: remaining risks or open questions, or "none"]]',
    '[[NEXT: what should happen next, or "none"]]',
    'You may also use these lines, each alone on its own line:',
    '[[MEMORY: a durable fact the whole team should remember]]',
    '[[MSG to=<teammate-id>: a short message to a teammate]]',
    '[[NEED: the exact file, information or decision you need from the human]]',
    '[[APPROVAL: why a human must approve before you continue]]',
    'Use NEED when you cannot continue without something only the human can give (a file, a path, an answer); then stop and wait.',
    'Use APPROVAL before anything destructive, irreversible, expensive, or outside the task scope, then stop and wait.'
  )
  return lines.join('\n')
}

/** The human's answer, sent into an existing CLI session (the CLI already remembers the rest). */
export function buildFollowUp(task: Task, hive: Hive, staged?: Map<string, string>): string {
  const lines: string[] = ['The human replied:', task.reply ?? '']
  lines.push(...materialLines(task, hive, staged))
  lines.push('', 'Continue the task. Keep using the same [[PLAN]]/[[STEP]], report and NEED/APPROVAL markers.')
  return lines.join('\n')
}

export interface RunnerDeps {
  hive: Hive
  stripApiKeys: boolean
  runner: Runner
  /** Where to run when the agent has no workDir. */
  defaultCwd: string
  /** Raw text from CLIs that print plain text. */
  onOutput?: (taskId: string, chunk: string) => void
  /** Called once when a run starts, with the object that tracks it. */
  onLive?: (live: LiveRun) => void
  /** New feed lines and/or refreshed numbers. */
  onActivity?: (taskId: string, events: ActivityEvent[], live: LiveRun) => void
  /** How often to look at the work folder while a run is in progress (ms). */
  watchMs?: number
  /** When a finished run waits for a human check. Default: never (the engine passes the setting). */
  humanReview?: HumanReview
  /** The CLI reported that its usage limit is used up. */
  onLimit?: (adapter: Agent['adapter'], info: LimitInfo) => void
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

export type RunOutcome =
  | 'done'
  | 'failed'
  | 'awaiting_approval'
  | 'needs_input'
  | 'not_ready'
  | 'cancelled'
  /** Stopped by the usage limit; the task is ready again once it resets. */
  | 'limited'

/** Total time cap per run when the task does not set one. */
export const DEFAULT_MAX_MINUTES = 240

/** The folder an agent's runs happen in. */
export function resolveCwd(agent: Agent, defaultCwd: string): string {
  return agent.workDir && existsSync(agent.workDir) ? agent.workDir : defaultCwd
}

export function budgetProblem(hive: Hive, agent: Agent, d: Date): string | null {
  const u = hive.usageToday(d)[agent.id] ?? { runs: 0, ms: 0 }
  if (agent.dailyRunLimit > 0 && u.runs >= agent.dailyRunLimit) {
    return `오늘 실행 한도에 도달했어요 (${u.runs}/${agent.dailyRunLimit}회).`
  }
  const mins = u.ms / 60000
  if (agent.dailyMinuteLimit > 0 && mins >= agent.dailyMinuteLimit) {
    return `오늘 시간 한도에 도달했어요 (${mins.toFixed(1)}/${agent.dailyMinuteLimit}분).`
  }
  return null
}

/** Run one task with its agent: approval gate → budget gate → CLI (watched) → parse → record. */
export async function runTask(agent: Agent, taskId: string, deps: RunnerDeps): Promise<RunOutcome> {
  const { hive } = deps
  const nowFn = deps.now ?? (() => new Date())
  const task = hive.getTask(taskId)
  if (!task || task.assignee !== agent.id) return 'not_ready'
  if (task.status !== 'todo') return 'not_ready'
  const level: PermissionLevel = effectivePermission(agent.adapter, task.permission)

  // Gate 1: human approval for risky tasks / cautious agents / command-running tasks.
  if ((task.risky || agent.requireApproval || level === 'exec') && !task.cleared.includes('risky-task')) {
    if (!hive.hasPendingApproval(task.id, 'risky-task')) {
      hive.createApproval({
        kind: 'risky-task',
        taskId: task.id,
        agentId: agent.id,
        reason: task.risky
          ? '위험한 태스크로 표시되어 실행 전 승인이 필요해요.'
          : agent.requireApproval
            ? `${agent.name} 에이전트는 모든 태스크에 승인이 필요하도록 설정돼 있어요.`
            : '이 태스크는 "명령 실행" 권한이라 실행 전 승인이 필요해요.'
      })
    }
    hive.updateTask(task.id, { status: 'awaiting_approval' })
    return 'awaiting_approval'
  }

  // Gate 2: budget. A human can approve a one-time override.
  const problem = budgetProblem(hive, agent, nowFn())
  if (problem && !task.cleared.includes('budget')) {
    if (!hive.hasPendingApproval(task.id, 'budget')) {
      hive.createApproval({ kind: 'budget', taskId: task.id, agentId: agent.id, reason: problem })
    }
    hive.updateTask(task.id, { status: 'awaiting_approval' })
    return 'awaiting_approval'
  }

  const cwd = resolveCwd(agent, deps.defaultCwd)
  const started = nowFn()
  const runId = newId()
  const answering = task.reply !== undefined
  // Same conversation when the CLI can continue it; otherwise the prompt retells what happened.
  const resumeSession =
    answering && task.sessionId && adapterAccess(agent.adapter).resume === 'session'
      ? task.sessionId
      : undefined
  hive.updateTask(task.id, {
    status: 'running',
    startedAt: started.toISOString(),
    error: undefined,
    result: undefined,
    report: undefined,
    reply: undefined, // consumed by this run (the prompt was built from the snapshot above)
    question: undefined
  })
  hive.addEvent(
    task.id,
    'run_started',
    agent.id,
    `${agent.name} 실행 시작${resumeSession ? ' (이전 대화를 이어서)' : answering ? ' (답변을 반영해 다시)' : ''}`,
    runId
  )

  const staged = stageAttachments(task, hive, cwd)
  const prompt = resumeSession
    ? buildFollowUp(task, hive, staged.paths)
    : buildPrompt({ agent, task, hive, staged: staged.paths })
  const unread = hive.listInbox(agent.id).filter((m) => !m.read)

  let built
  try {
    built = buildCommand(agent, {
      stream: true,
      permission: level,
      refDirs: (task.refDirs ?? []).filter((d) => existsSync(d)),
      resumeSession,
      allowSecrets: task.allowSecrets
    })
  } catch (e) {
    staged.cleanup()
    const finishedAt = nowFn().toISOString()
    hive.addEvent(task.id, 'run_finished', agent.id, '실패 · ' + (e as Error).message, runId)
    hive.updateTask(task.id, { status: 'failed', error: (e as Error).message, finishedAt })
    return 'failed'
  }

  // Remember how the work folder looked, so we can show exactly what this run changed — also live.
  const tracker = await trackChanges(cwd, { hiveRoot: hive.root })
  // ...and keep that state so the whole run can be undone later.
  const cp = await createCheckpoint(hive, runId, tracker.source)
  // Written now and replaced when the run ends: if the app dies in between, this is what is left.
  hive.addRun({
    id: runId,
    taskId: task.id,
    agentId: agent.id,
    adapter: agent.adapter,
    model: agent.model,
    startedAt: started.toISOString(),
    finishedAt: '',
    durationMs: 0,
    outcome: 'running',
    exitCode: null,
    prompt: cap(prompt, 100_000),
    response: '',
    stderr: '',
    diff: unavailable('실행 중이에요.'),
    cwd,
    permission: level,
    activity: [],
    checkpoint: cp.checkpoint,
    checkpointNote: cp.note
  })
  if (task.interruptedRun) hive.updateTask(task.id, { interruptedRun: undefined })
  const live = new LiveRun(task.id, runId, cwd, started.toISOString())
  live.setTracking(tracker.mode)
  deps.onLive?.(live)
  const parser = createParser(built.stream ?? 'text', nowFn)
  const push = (evs: ActivityEvent[]): void => {
    live.add(evs)
    live.setPlan(parser.plan())
    deps.onActivity?.(task.id, evs, live)
  }

  const watchMs = deps.watchMs ?? 3000
  let touch: (() => void) | undefined
  let lastSig = ''
  let watching = true
  let watchTimer: NodeJS.Timeout | undefined
  const poll = async (): Promise<void> => {
    if (!watching) return
    const t0 = Date.now()
    const d = await tracker.finish()
    if (!watching) return
    live.setDiff(d)
    live.setPlan(parser.plan())
    // files changing means the agent is alive even if the CLI prints nothing
    const sig = d.files.map((f) => `${f.path}:${f.status}:${f.additions}:${f.deletions}`).join('|')
    if (sig !== lastSig) {
      lastSig = sig
      touch?.()
    }
    deps.onActivity?.(task.id, [], live)
    // big folders: look less often so watching never slows the agent down
    watchTimer = setTimeout(() => void poll(), Math.max(watchMs, (Date.now() - t0) * 3))
  }
  watchTimer = setTimeout(() => void poll(), watchMs)

  let res
  try {
    res = await deps.runner(built, {
      cwd,
      prompt,
      // the agent's setting = how long it may stay silent; the task's setting = how long it may take in all
      idleTimeoutMs: Math.max(1, agent.timeoutMinutes) * 60_000,
      timeoutMs: Math.max(1, task.maxMinutes ?? DEFAULT_MAX_MINUTES) * 60_000,
      onTouchReady: (t) => (touch = t),
      env: cleanEnv(deps.env ?? process.env, deps.stripApiKeys),
      onOutput: (c) => {
        push(parser.push(c))
        if (!built.stream) deps.onOutput?.(task.id, c)
      },
      signal: deps.signal
    })
  } finally {
    watching = false
    if (watchTimer) clearTimeout(watchTimer)
    staged.cleanup()
  }
  push(parser.end())

  const stdout = parser.finalText(res.stdout)
  const sessionId = parser.sessionId() ?? resumeSession
  const elapsed = nowFn().getTime() - started.getTime()
  hive.recordUsage(agent.id, elapsed, nowFn())
  const finishedAt = nowFn().toISOString()
  const diff = await tracker.finish()
  live.setDiff(diff)

  // Things the CLI refused because of the permission level: tell the human what to change.
  const denied = parser.denials()
  if (denied.length) {
    push([
      {
        n: live.all().length + 1,
        at: nowFn().toISOString(),
        kind: 'error',
        text: `권한 때문에 거부된 작업 ${denied.length}건: ${denied.join(', ')}`
      }
    ])
    const cur = hive.getTask(task.id)
    hive.updateTask(task.id, {
      notes: [
        ...(cur?.notes ?? task.notes),
        `권한 때문에 거부된 작업이 있어요 (${denied.join(', ')}). 필요하면 권한 단계를 올리거나 참고 폴더를 추가하고 다시 실행하세요.`
      ]
    })
  }

  /** Save the full record of this execution (never overwritten) and log it on the timeline. */
  const saveRun = (outcome: RunResultKind, extra: { error?: string; report?: Report } = {}): string => {
    const rec: RunRecord = {
      id: runId,
      taskId: task.id,
      agentId: agent.id,
      adapter: agent.adapter,
      model: agent.model,
      startedAt: started.toISOString(),
      finishedAt,
      durationMs: elapsed,
      outcome,
      exitCode: res.code,
      prompt: cap(prompt, 100_000),
      response: cap(stdout, 300_000),
      stderr: cap(res.stderr, 20_000),
      error: extra.error,
      report: extra.report,
      diff,
      cwd,
      permission: level,
      sessionId,
      activity: live.all().slice(-1000),
      checkpoint: cp.checkpoint,
      checkpointNote: cp.note
    }
    hive.addRun(rec)
    hive.addEvent(task.id, 'run_finished', agent.id, runLine(outcome, elapsed, diff), runId)
    return runId
  }
  const lastError = [...live.all()].reverse().find((e) => e.kind === 'error')?.text

  if (res.aborted) {
    const error = '사용자가 중지했어요.'
    hive.updateTask(task.id, {
      status: 'todo',
      error,
      finishedAt,
      sessionId,
      lastRunId: saveRun('cancelled', { error })
    })
    return 'cancelled'
  }
  if (res.spawnError) {
    const f = classifyFailure(res.spawnError)
    const kind = f.kind
    const error = failureMessage(f, res.spawnError)
    hive.updateTask(task.id, { status: 'failed', error, errorKind: kind, finishedAt, lastRunId: saveRun('failed', { error }) })
    return 'failed'
  }
  if (res.timedOut) {
    const kindOfTimeout = res.timeoutKind ?? 'total'
    const minutes = kindOfTimeout === 'idle' ? agent.timeoutMinutes : (task.maxMinutes ?? DEFAULT_MAX_MINUTES)
    const error = failureMessage(classifyFailure('', { timeout: kindOfTimeout, minutes }), '')
    hive.updateTask(task.id, {
      status: 'failed',
      error,
      errorKind: 'timeout',
      result: stdout.trim() || undefined,
      finishedAt,
      sessionId,
      lastRunId: saveRun('failed', { error })
    })
    return 'failed'
  }
  // The usage limit looks like a plain failure; recognise it so auto-run can wait instead of failing on.
  if (res.code !== 0 || stdout.trim().length < 400) {
    const lim = detectLimit([res.stderr, stdout.slice(-2000), lastError ?? ''].join('\n'), nowFn())
    if (lim) {
      deps.onLimit?.(agent.adapter, lim)
      const when = new Date(lim.until).toLocaleString('ko-KR', { hour12: false })
      const error = `사용량 한도에 도달했어요 (${lim.message}). ${when}${lim.guessed ? '쯤(추정)' : ''}까지 자동 실행을 쉬어요.`
      hive.updateTask(task.id, {
        status: 'todo',
        error,
        finishedAt,
        sessionId,
        lastRunId: saveRun('limit', { error })
      })
      return 'limited'
    }
  }
  if (res.code !== 0) {
    const detail = (res.stderr.trim() || stdout.trim() || lastError || '').slice(-1500)
    const f = classifyFailure([res.stderr, stdout.slice(-3000), lastError ?? ''].join('\n'))
    const error = failureMessage(f, `(오류 코드 ${res.code})${detail ? '\n' + detail : ''}`)
    hive.updateTask(task.id, { status: 'failed', error, errorKind: f.kind, finishedAt, lastRunId: saveRun('failed', { error }) })
    return 'failed'
  }

  const parsed = parseMarkers(stdout)
  for (const m of unread) hive.markRead(agent.id, m.id)
  const known = new Set(hive.listMemory(1000).map((m) => m.text.trim().toLowerCase()))
  for (const text of parsed.memory) {
    const key = text.trim().toLowerCase()
    if (known.has(key)) continue // agents often repeat what they read; keep memory clean
    known.add(key)
    hive.addMemory(agent.id, text)
  }
  for (const m of parsed.messages) hive.sendMessage(agent.id, m.to, m.body)

  if (parsed.approvals.length) {
    const reason = parsed.approvals.join(' / ')
    const lastRunId = saveRun('awaiting_approval', { report: parsed.report })
    hive.createApproval({ kind: 'agent-request', taskId: task.id, agentId: agent.id, reason })
    const cur = hive.getTask(task.id)
    hive.updateTask(task.id, {
      status: 'awaiting_approval',
      notes: [...(cur?.notes ?? task.notes), `${agent.name}이(가) 멈추고 승인을 요청했어요: ${reason}`],
      result: parsed.clean || undefined,
      report: parsed.report,
      finishedAt,
      sessionId,
      lastRunId
    })
    return 'awaiting_approval'
  }

  if (parsed.needs.length) {
    const question = parsed.needs.join('\n')
    const lastRunId = saveRun('needs_input', { report: parsed.report })
    hive.addEvent(task.id, 'need', agent.id, `자료 요청: ${question}`, runId)
    hive.updateTask(task.id, {
      status: 'needs_input',
      question,
      result: parsed.clean || undefined,
      report: parsed.report,
      finishedAt,
      sessionId,
      lastRunId
    })
    return 'needs_input'
  }

  const review = needsReview(deps.humanReview ?? 'off', level, diff)
  const lastRunId = saveRun('done', { report: parsed.report })
  if (review) {
    hive.addEvent(task.id, 'review', 'system', `사람 확인을 기다려요: ${reviewReason(diff)}`, runId)
  }
  hive.updateTask(task.id, {
    status: review ? 'needs_review' : 'done',
    result: parsed.clean,
    report: parsed.report,
    error: undefined,
    errorKind: undefined,
    question: undefined,
    finishedAt,
    sessionId,
    lastRunId
  })
  return 'done'
}

/** Should a finished run wait for a human to look at it before it counts as done? */
export function needsReview(mode: HumanReview, level: PermissionLevel, diff: RunDiff): boolean {
  if (mode === 'off' || level === 'read') return false
  if (mode === 'always') return true
  // "changes": anything that touched files — and anything we could not check
  return !diff.available || diff.files.length > 0
}

function reviewReason(diff: RunDiff): string {
  if (!diff.available) return '바뀐 내용을 비교하지 못해서 직접 확인이 필요해요.'
  return diff.files.length ? `파일 ${diff.files.length}개가 바뀌었어요.` : '설정에 따라 확인이 필요해요.'
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…(${s.length - n}자 생략)` : s
}

const OUTCOME_LABEL: Record<RunResultKind, string> = {
  done: '완료',
  failed: '실패',
  cancelled: '중지됨',
  awaiting_approval: '승인 대기',
  needs_input: '자료 요청',
  running: '실행 중',
  interrupted: '중단됨',
  limit: '한도 도달'
}

export function runLine(outcome: RunResultKind, ms: number, diff: RunDiff): string {
  const sec = Math.max(1, Math.round(ms / 1000))
  const time = sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`
  const st = diffStat(diff)
  const change = !st.available
    ? '변경 비교 불가'
    : st.files === 0
      ? '파일 변경 없음'
      : diff.lines === false
        ? `파일 ${st.files}개 변경`
        : `파일 ${st.files}개 변경 (+${st.additions} −${st.deletions})`
  return `${OUTCOME_LABEL[outcome]} · ${time} · ${change}`
}
