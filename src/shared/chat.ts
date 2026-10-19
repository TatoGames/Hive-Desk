import type { AdapterId } from './types'

/**
 * v6 챗-1: a plain conversation with a model the person picks. It never changes files (the work folder is an empty
 * chat folder, the permission is read-only); a change is made by handing the idea to a task.
 */

/** Which model answers: a CLI login's model, or a model of a local (OpenAI-compatible) engine. */
export type ChatModel =
  | { kind: 'cli'; adapter: AdapterId; modelId: string }
  | { kind: 'local'; endpointId: string; model: string }

export type ChatStatus = 'done' | 'streaming' | 'stopped' | 'failed' | 'limit'

export interface ChatMessage {
  id: string
  /** `system` = a mark in the conversation (model changed, earlier part left out), never sent to the model as a person's words. */
  role: 'user' | 'assistant' | 'system'
  text: string
  at: string
  model?: ChatModel
  status: ChatStatus
  /** Known usage of this answer (what is not known stays empty). */
  usage?: { ms: number }
  /** For `limit`: when the connection can be used again. */
  limitUntil?: string
  /** For `failed`: why, in one line. */
  error?: string
}

export interface Chat {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  model: ChatModel
  /** Claude only: the CLI session to continue (empty after a model change). */
  sessionId?: string
  /** Folders read (never written) to answer. */
  folderRefs: string[]
  /** The chat was opened from this task ("이 업무에 대해 물어보기"). */
  aboutTask?: string
  /** Tasks the person handed over from this conversation (after confirming a draft). */
  madeTasks?: string[]
  messages: ChatMessage[]
}

export interface ChatSummary {
  id: string
  title: string
  updatedAt: string
  model: ChatModel
  messages: number
  /** The start of the last message, for the list. */
  last: string
  streaming: boolean
}

export function summarizeChat(c: Chat): ChatSummary {
  const last = [...c.messages].reverse().find((m) => m.role !== 'system')
  return {
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    model: c.model,
    messages: c.messages.filter((m) => m.role !== 'system').length,
    last: (last?.text ?? '').replace(/\s+/g, ' ').slice(0, 60),
    streaming: c.messages.some((m) => m.status === 'streaming')
  }
}

export const sameModel = (a: ChatModel, b: ChatModel): boolean =>
  a.kind === b.kind && (a.kind === 'cli' ? a.adapter === (b as typeof a).adapter && a.modelId === (b as typeof a).modelId : a.endpointId === (b as typeof a).endpointId && a.model === (b as typeof a).model)

/** The title of a new conversation: the start of the first question (no AI is asked). */
export function chatTitle(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 40 ? one.slice(0, 39) + '…' : one || '새 대화'
}

/** How much of the earlier conversation is sent again to a model that cannot continue a session. */
export const REPLAY_CHARS = 24_000

const PREAMBLE = [
  'You are a helpful AI assistant in the chat of the HiveDesk app. Answer in the language of the person\'s last message.',
  'This is a conversation only: you cannot create, change or delete files here, and you must not try. If the person wants files changed, tell them to hand it to a task (the "업무" screen).',
  'Be direct and concise; use short paragraphs or lists when they help. If you are not sure, say so.',
  'If "Task material" is given below, answer from that material only; if it does not cover the question, say you do not know instead of guessing.'
].join('\n')

export interface ChatPromptOptions {
  /** The CLI continues its own session: only the new message is sent. */
  resumed?: boolean
  /** Characters of earlier conversation to send again (default `REPLAY_CHARS`). */
  budget?: number
  /** Folders the model may read (told to it in words; the CLI enforces it where it can). */
  folders?: string[]
  /** The material of the task this chat is about (a first turn, or a turn of a model that does not continue a session). */
  taskContext?: string
  /** One short line with the task's state now (every turn, also when the session continues). */
  taskStatus?: string
}

export interface ChatPrompt {
  text: string
  /** How many earlier messages did not fit (they are left out, oldest first). */
  omitted: number
}

/**
 * What is sent for one turn. `history` holds the earlier messages (without the new one); `text` is the new message.
 * Marks (`system`), failed and empty answers are not sent. The newest messages are kept; the oldest are left out.
 */
export function chatPrompt(history: ChatMessage[], text: string, o: ChatPromptOptions = {}): ChatPrompt {
  const lines: string[] = []
  const folders = (o.folders ?? []).filter(Boolean)
  if (o.resumed) {
    // the session already knows the rest
    if (folders.length) lines.push(`(Folders you may read: ${folders.join(', ')} — read only.)`, '')
    if (o.taskContext) lines.push(o.taskContext, '')
    if (o.taskStatus) lines.push(o.taskStatus, '')
    lines.push(text)
    return { text: lines.join('\n'), omitted: 0 }
  }
  lines.push(PREAMBLE)
  if (folders.length) lines.push('', 'Folders you may read to answer (read only, never change anything there):', ...folders.map((f) => `- ${f}`))
  const usable = history.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim() && m.status !== 'failed' && m.status !== 'streaming')
  if (o.taskContext) lines.push('', o.taskContext)
  if (o.taskStatus) lines.push('', o.taskStatus)
  let budget = o.budget ?? REPLAY_CHARS
  const kept: ChatMessage[] = []
  for (let i = usable.length - 1; i >= 0; i--) {
    const cost = usable[i].text.length + 20
    if (cost > budget && kept.length) break
    budget -= cost
    kept.push(usable[i])
  }
  kept.reverse()
  const omitted = usable.length - kept.length
  if (kept.length) {
    lines.push('', 'The conversation so far' + (omitted ? ` (the ${omitted} oldest message${omitted > 1 ? 's' : ''} left out)` : '') + ':')
    for (const m of kept) lines.push('', `${m.role === 'user' ? 'Person' : 'You'}: ${m.text.trim()}`)
  }
  lines.push('', 'The person now writes:', text)
  return { text: lines.join('\n'), omitted }
}

/** The conversation as a markdown file. */
export function chatMarkdown(c: Chat, modelLabel: (m: ChatModel) => string): string {
  const out = [`# ${c.title}`, '', `${new Date(c.createdAt).toLocaleString('ko-KR')} · ${modelLabel(c.model)}`, '']
  for (const m of c.messages) {
    if (m.role === 'system') out.push(`> ${m.text}`, '')
    else out.push(`## ${m.role === 'user' ? '나' : 'AI'}${m.model && m.role === 'assistant' ? ` (${modelLabel(m.model)})` : ''}`, '', m.text.trim() || (m.status === 'stopped' ? '(중지함)' : ''), '')
  }
  return out.join('\n')
}

/** What a turn of this model costs against the limit, for the "this will cost N× more" question (1 = the same). */
export function costFactor(from: number, to: number): number {
  return from > 0 ? to / from : 1
}
