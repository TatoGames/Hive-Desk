import { existsSync } from 'node:fs'
import type { Agent, Task } from '../shared/types'
import { buildCommand, cleanEnv, type Runner } from './adapters'
import { Hive } from './hive'

export interface ParsedMarkers {
  clean: string
  memory: string[]
  messages: { to: string; body: string }[]
  approvals: string[]
}

/** Agents talk back to the hive with marker lines, e.g. `[[MEMORY: we use pnpm]]`. */
export function parseMarkers(text: string): ParsedMarkers {
  const memory: string[] = []
  const messages: { to: string; body: string }[] = []
  const approvals: string[] = []
  const re = /^[ \t]*\[\[(MEMORY|MSG|APPROVAL)(?:[ \t]+to=([^\s:\]]+))?[ \t]*:[ \t]*([\s\S]*?)\]\][ \t]*$/gm
  const clean = text.replace(re, (_m, kind: string, to: string | undefined, body: string) => {
    const b = body.trim()
    if (!b) return ''
    if (kind === 'MEMORY') memory.push(b)
    else if (kind === 'MSG' && to) messages.push({ to, body: b })
    else if (kind === 'APPROVAL') approvals.push(b)
    return ''
  })
  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), memory, messages, approvals }
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
    'Reply in the same language as the task. Finish with a concise result. You may also use these lines, each alone on its own line:',
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
  hive.updateTask(task.id, {
    status: 'running',
    startedAt: started.toISOString(),
    error: undefined,
    result: undefined
  })

  const prompt = buildPrompt({ agent, task, hive })
  const unread = hive.listInbox(agent.id).filter((m) => !m.read)

  let built
  try {
    built = buildCommand(agent)
  } catch (e) {
    hive.updateTask(task.id, {
      status: 'failed',
      error: (e as Error).message,
      finishedAt: nowFn().toISOString()
    })
    return 'failed'
  }

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

  if (res.aborted) {
    hive.updateTask(task.id, { status: 'todo', error: '사용자가 중지했어요.', finishedAt })
    return 'cancelled'
  }
  if (res.spawnError) {
    hive.updateTask(task.id, { status: 'failed', error: res.spawnError, finishedAt })
    return 'failed'
  }
  if (res.timedOut) {
    hive.updateTask(task.id, {
      status: 'failed',
      error: `제한 시간 ${agent.timeoutMinutes}분을 넘겨 중지했어요.`,
      result: res.stdout.trim() || undefined,
      finishedAt
    })
    return 'failed'
  }
  if (res.code !== 0) {
    const detail = (res.stderr.trim() || res.stdout.trim()).slice(-1500)
    hive.updateTask(task.id, {
      status: 'failed',
      error: `CLI가 오류 코드 ${res.code}로 끝났어요.${detail ? '\n' + detail : ''}`,
      finishedAt
    })
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
    hive.createApproval({ kind: 'agent-request', taskId: task.id, agentId: agent.id, reason })
    hive.updateTask(task.id, {
      status: 'awaiting_approval',
      notes: [...task.notes, `${agent.name}이(가) 멈추고 승인을 요청했어요: ${reason}`],
      result: parsed.clean || undefined,
      finishedAt
    })
    return 'awaiting_approval'
  }

  hive.updateTask(task.id, { status: 'done', result: parsed.clean, error: undefined, finishedAt })
  return 'done'
}
