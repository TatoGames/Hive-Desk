import type { ChatMessage } from './chat'
import type { CheckRun, DiffFile, Report, TaskStatus } from './types'

/**
 * v6 챗-2: between a conversation and a task.
 * - a conversation becomes a task DRAFT by plain rules (no AI); the person edits and confirms it;
 * - a conversation about a task gets the task's material, put together by the app (not by the model).
 */

// ---- conversation -> task draft ----
export const DRAFT_TITLE_MAX = 60
export const DRAFT_REQUEST_MAX = 1200
export const DRAFT_ANSWER_MAX = 600
export const DRAFT_TOTAL_MAX = 2000

export interface TaskDraft {
  title: string
  description: string
  /** Nothing in the conversation to build a task from. */
  empty: boolean
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

/** The first sentence or line of a request, as a task title. */
function titleOf(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const sentence = line.match(/^(.+?[.!?。？！])(\s|$)/)?.[1] ?? line
  return clip(sentence.replace(/\s+/g, ' ').trim(), DRAFT_TITLE_MAX)
}

/**
 * The draft of a task from a conversation: the last request of the person is the title and the request; the last answer
 * is added in short as "what the chat said". With `pickedIds` only those messages are used (the person chose them).
 * Plain rules, no AI. The person always sees and edits the result before anything is handed over.
 */
export function draftFromChat(messages: ChatMessage[], pickedIds?: string[]): TaskDraft {
  const usable = messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim() && m.status !== 'failed' && m.status !== 'streaming' && (!pickedIds?.length || pickedIds.includes(m.id))
  )
  const users = usable.filter((m) => m.role === 'user')
  if (!users.length) return { title: '', description: '', empty: true }
  const last = users[users.length - 1]
  // picked messages: every picked request counts (oldest first); otherwise only the last one
  const requests = pickedIds?.length ? users : [last]
  const request = clip(requests.map((m) => m.text.trim()).join('\n\n'), DRAFT_REQUEST_MAX)
  // the answer to the last request; without one, the last answer there is
  const idx = usable.indexOf(last)
  const answer = usable.slice(idx + 1).find((m) => m.role === 'assistant') ?? [...usable.slice(0, idx)].reverse().find((m) => m.role === 'assistant')
  const parts = [`요청\n${request}`]
  if (answer) parts.push(`챗에서 나온 답변 (요약)\n${clip(answer.text.trim(), DRAFT_ANSWER_MAX)}`)
  return { title: titleOf(last.text), description: clip(parts.join('\n\n'), DRAFT_TOTAL_MAX), empty: false }
}

/** Parse the answer of "AI로 정리하기": a first line `제목: …` (or any first line) and the rest as the description. */
export function parsePolished(text: string): { title: string; description: string } | null {
  const lines = text.trim().split('\n')
  const first = lines.findIndex((l) => l.trim())
  if (first < 0) return null
  const title = clip(lines[first].replace(/^\s*(제목|title)\s*[:：]\s*/i, '').replace(/^[#*\s]+|[*\s]+$/g, ''), DRAFT_TITLE_MAX)
  const description = clip(
    lines.slice(first + 1).join('\n').replace(/^\s*(설명|description)\s*[:：]\s*/i, '').trim(),
    DRAFT_TOTAL_MAX
  )
  return title ? { title, description } : null
}

export const POLISH_PROMPT = [
  'Rewrite the conversation below as ONE task for an AI coworker. Answer in the language of the person\'s messages.',
  'Output exactly this form and nothing else:',
  '제목: <one line, at most 60 characters>',
  '<then the description: what to do, where, and how to tell it is done; at most 10 short lines>',
  'Do not add facts that are not in the conversation. You cannot do the task here.'
].join('\n')

// ---- task material for a chat about a task ----
/** All material of a task, about this many characters (the diff gets what is left). */
export const TASK_CONTEXT_CHARS = 12_000
const REQUEST_MAX = 1500
const FIELD_MAX = 700
const FILES_MAX = 60
const EVENTS_MAX = 6
const EVENT_TEXT_MAX = 160
const CHECK_TAIL_MAX = 300
/** Below this much room the diff is left out (the file list stays). */
const MIN_PATCH_ROOM = 600

export interface TaskContextInput {
  title: string
  description: string
  status: TaskStatus
  updatedAt: string
  error?: string
  result?: string
  report?: Report
  checks?: CheckRun
  events: { at: string; text: string }[]
  /** The newest run's change list; absent = no run yet. */
  diff?: { available: boolean; reason?: string; files: DiffFile[]; patch: string }
}

export interface TaskContext {
  text: string
  /** Part of the material did not fit (shown to the person as "잘렸어요"). */
  truncated: boolean
}

export const TASK_GONE_CONTEXT =
  'Task material: NOT AVAILABLE. The task this chat is about was deleted or cannot be read. Tell the person plainly that you cannot see it and do not guess what it contained.'

/** One short line with the task's state now, sent on every turn so a continued session notices a change. */
export function taskStatusLine(t: { status: TaskStatus; updatedAt: string; title: string } | null): string {
  return t ? `(Task "${clip(t.title, 80)}" now: status=${t.status}, last change ${t.updatedAt}.)` : '(The task of this chat can no longer be read; say so if asked.)'
}

/** The material the model answers from, put together by the app. Never longer than about `limit` characters. */
export function buildTaskContext(i: TaskContextInput, limit = TASK_CONTEXT_CHARS): TaskContext {
  let truncated = false
  const cut = (s: string, n: number): string => {
    if (s.length > n) truncated = true
    return clip(s.trim(), n)
  }
  const out: string[] = ['Task material (put together by the app; answer from it):', '', `Title: ${cut(i.title, 200)}`, `Status: ${i.status}  (last change ${i.updatedAt})`]
  if (i.description.trim()) out.push('', 'Request:', cut(i.description, REQUEST_MAX))
  if (i.error) out.push('', `Error: ${cut(i.error, FIELD_MAX)}`)
  const r = i.report
  if (r) {
    out.push('', 'Final report:')
    for (const [k, label] of [['did', 'Did'], ['files', 'Files'], ['verify', 'How to verify'], ['risks', 'Risks'], ['next', 'Next']] as const) {
      if (r[k]?.trim() && r[k] !== 'none') out.push(`- ${label}: ${cut(r[k], FIELD_MAX)}`)
    }
  } else if (i.result?.trim()) out.push('', 'Result text:', cut(i.result, FIELD_MAX * 2))
  const ran = i.checks?.items.filter((c) => !c.skipped) ?? []
  if (ran.length) {
    out.push('', `Automatic checks (${i.checks!.ok ? 'all passed' : 'some failed'}):`)
    for (const c of ran) out.push(`- ${c.name}: ${c.ok ? 'ok' : 'FAILED'}${c.ok ? '' : ` — ${cut(c.tail.replace(/\s+/g, ' '), CHECK_TAIL_MAX)}`}`)
  }
  const ev = i.events.slice(-EVENTS_MAX)
  if (ev.length) {
    out.push('', 'Recent events:')
    for (const e of ev) out.push(`- ${e.at.slice(0, 16).replace('T', ' ')} ${cut(e.text.replace(/\s+/g, ' '), EVENT_TEXT_MAX)}`)
  }
  const d = i.diff
  if (!d) out.push('', 'Changed files: no run has finished yet, so there are none.')
  else if (!d.available) out.push('', `Changed files: not known${d.reason ? ` (${cut(d.reason, 160)})` : ''}.`)
  else if (!d.files.length) out.push('', 'Changed files: none.')
  else {
    out.push('', `Changed files (${d.files.length}):`)
    for (const f of d.files.slice(0, FILES_MAX)) out.push(`- ${f.status} ${f.path}${f.binary ? ' (binary)' : ` (+${f.additions} -${f.deletions})`}`)
    if (d.files.length > FILES_MAX) {
      truncated = true
      out.push(`- … and ${d.files.length - FILES_MAX} more files (list cut)`)
    }
  }
  const used = out.join('\n').length
  if (d?.available && d.patch.trim()) {
    const room = limit - used - 120
    if (room < MIN_PATCH_ROOM) {
      truncated = true
      out.push('', 'Diff: left out (no room); only the file list is shown.')
    } else {
      const patch = d.patch.length > room ? d.patch.slice(0, room) : d.patch
      out.push('', 'Diff (patch):', patch)
      if (patch.length < d.patch.length) {
        truncated = true
        out.push(`[… cut: ${d.patch.length - patch.length} more characters of the diff are not shown]`)
      }
    }
  }
  if (truncated) out.push('', 'Note: some of the material above was cut because of its size. Say so if the answer may depend on the missing part.')
  return { text: out.join('\n'), truncated }
}
