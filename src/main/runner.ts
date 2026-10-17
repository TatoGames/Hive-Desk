import { existsSync } from 'node:fs'
import type { Agent, Report, RunDiff, RunRecord, RunResultKind, Task } from '../shared/types'
import { buildCommand, cleanEnv, type Runner } from './adapters'
import { diffStat, trackChanges } from './gitdiff'
import { Hive, newId } from './hive'

export interface ParsedMarkers {
  clean: string
  memory: string[]
  messages: { to: string; body: string }[]
  approvals: string[]
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
  const parts: Partial<Record<keyof Report, string[]>> = {}
  const re =
    /^[ \t]*\[\[(MEMORY|MSG|APPROVAL|DID|FILES|VERIFY|RISK|NEXT)(?:[ \t]+to=([^\s:\]]+))?[ \t]*:[ \t]*([\s\S]*?)\]\][ \t]*$/gm
  const clean = text.replace(re, (_m, kind: string, to: string | undefined, body: string) => {
    const b = body.trim()
    if (!b) return ''
    if (kind === 'MEMORY') memory.push(b)
    else if (kind === 'MSG' && to) messages.push({ to, body: b })
    else if (kind === 'APPROVAL') approvals.push(b)
    else if (REPORT_KEYS[kind]) (parts[REPORT_KEYS[kind]] ??= []).push(b)
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
  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), memory, messages, approvals, report }
}

export function buildPrompt(opts: {
  agent: Agent
  task: Task
  hive: Hive
  maxMemory?: number
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
    'Reply in the same language as the task. Give your result first, then end with a short structured report using these markers.',
    'Each marker starts at the beginning of a line; a part may span several lines and ends with ]] at the end of a line:',
    '[[DID: what you did]]',
    '[[FILES: files you changed or created, one per line, or "none"]]',
    '[[VERIFY: how a human can check that it works]]',
    '[[RISK: remaining risks or open questions, or "none"]]',
    '[[NEXT: what should happen next, or "none"]]',
    'You may also use these lines, each alone on its own line:',
    '[[MEMORY: a durable fact the whole team should remember]]',
    '[[MSG to=<teammate-id>: a short message to a teammate]]',
    '[[APPROVAL: why a human must approve before you continue]]',
    'Use APPROVAL before anything destructive, irreversible, expensive, or outside the task scope, then stop and wait.'
  )
  return lines.join('\n')
}

export interface RunnerDeps {
  hive: Hive
  stripApiKeys: boolean
  runner: Runner
  /** Where to run when the agent has no workDir. */
  defaultCwd: string
  onOutput?: (taskId: string, chunk: string) => void
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

export type RunOutcome =
  | 'done'
  | 'failed'
  | 'awaiting_approval'
  | 'not_ready'
  | 'cancelled'

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

/** Run one task with its agent: budget gate → approval gate → CLI → parse → record. */
export async function runTask(agent: Agent, taskId: string, deps: RunnerDeps): Promise<RunOutcome> {
  const { hive } = deps
  const nowFn = deps.now ?? (() => new Date())
  const task = hive.getTask(taskId)
  if (!task || task.assignee !== agent.id) return 'not_ready'
  if (task.status !== 'todo') return 'not_ready'

  // Gate 1: human approval for risky tasks / cautious agents.
  if ((task.risky || agent.requireApproval) && !task.cleared.includes('risky-task')) {
    if (!hive.hasPendingApproval(task.id, 'risky-task')) {
      hive.createApproval({
        kind: 'risky-task',
        taskId: task.id,
        agentId: agent.id,
        reason: task.risky
          ? '위험한 태스크로 표시되어 실행 전 승인이 필요해요.'
          : `${agent.name} 에이전트는 모든 태스크에 승인이 필요하도록 설정돼 있어요.`
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

  const cwd = agent.workDir && existsSync(agent.workDir) ? agent.workDir : deps.defaultCwd
  const started = nowFn()
  const runId = newId()
  hive.updateTask(task.id, {
    status: 'running',
    startedAt: started.toISOString(),
    error: undefined,
    result: undefined,
    report: undefined
  })
  hive.addEvent(task.id, 'run_started', agent.id, `${agent.name} 실행 시작`, runId)

  const prompt = buildPrompt({ agent, task, hive })
  const unread = hive.listInbox(agent.id).filter((m) => !m.read)

  let built
  try {
    built = buildCommand(agent)
  } catch (e) {
    const finishedAt = nowFn().toISOString()
    hive.addEvent(task.id, 'run_finished', agent.id, '실패 · ' + (e as Error).message, runId)
    hive.updateTask(task.id, { status: 'failed', error: (e as Error).message, finishedAt })
    return 'failed'
  }

  // Remember how the work folder looked, so we can show exactly what this run changed.
  const tracker = await trackChanges(cwd, { hiveRoot: hive.root })

  const res = await deps.runner(built, {
    cwd,
    prompt,
    timeoutMs: Math.max(1, agent.timeoutMinutes) * 60_000,
    env: cleanEnv(deps.env ?? process.env, deps.stripApiKeys),
    onOutput: deps.onOutput ? (c) => deps.onOutput?.(task.id, c) : undefined,
    signal: deps.signal
  })

  const elapsed = nowFn().getTime() - started.getTime()
  hive.recordUsage(agent.id, elapsed, nowFn())
  const finishedAt = nowFn().toISOString()
  const diff = await tracker.finish()

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
      response: cap(res.stdout, 300_000),
      stderr: cap(res.stderr, 20_000),
      error: extra.error,
      report: extra.report,
      diff
    }
    hive.addRun(rec)
    hive.addEvent(task.id, 'run_finished', agent.id, runLine(outcome, elapsed, diff), runId)
    return runId
  }

  if (res.aborted) {
    const error = '사용자가 중지했어요.'
    hive.updateTask(task.id, { status: 'todo', error, finishedAt, lastRunId: saveRun('cancelled', { error }) })
    return 'cancelled'
  }
  if (res.spawnError) {
    const error = res.spawnError
    hive.updateTask(task.id, { status: 'failed', error, finishedAt, lastRunId: saveRun('failed', { error }) })
    return 'failed'
  }
  if (res.timedOut) {
    const error = `제한 시간 ${agent.timeoutMinutes}분을 넘겨 중지했어요.`
    hive.updateTask(task.id, {
      status: 'failed',
      error,
      result: res.stdout.trim() || undefined,
      finishedAt,
      lastRunId: saveRun('failed', { error })
    })
    return 'failed'
  }
  if (res.code !== 0) {
    const detail = (res.stderr.trim() || res.stdout.trim()).slice(-1500)
    const error = `CLI가 오류 코드 ${res.code}로 끝났어요.${detail ? '\n' + detail : ''}`
    hive.updateTask(task.id, { status: 'failed', error, finishedAt, lastRunId: saveRun('failed', { error }) })
    return 'failed'
  }

  const parsed = parseMarkers(res.stdout)
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
    hive.updateTask(task.id, {
      status: 'awaiting_approval',
      notes: [...task.notes, `${agent.name}이(가) 멈추고 승인을 요청했어요: ${reason}`],
      result: parsed.clean || undefined,
      report: parsed.report,
      finishedAt,
      lastRunId
    })
    return 'awaiting_approval'
  }

  hive.updateTask(task.id, {
    status: 'done',
    result: parsed.clean,
    report: parsed.report,
    error: undefined,
    finishedAt,
    lastRunId: saveRun('done', { report: parsed.report })
  })
  return 'done'
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…(${s.length - n}자 생략)` : s
}

const OUTCOME_LABEL: Record<RunResultKind, string> = {
  done: '완료',
  failed: '실패',
  cancelled: '중지됨',
  awaiting_approval: '승인 대기'
}

export function runLine(outcome: RunResultKind, ms: number, diff: RunDiff): string {
  const sec = Math.max(1, Math.round(ms / 1000))
  const time = sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`
  const st = diffStat(diff)
  const change = !st.available
    ? '변경 비교 불가'
    : st.files === 0
      ? '파일 변경 없음'
      : `파일 ${st.files}개 변경 (+${st.additions} −${st.deletions})`
  return `${OUTCOME_LABEL[outcome]} · ${time} · ${change}`
}
