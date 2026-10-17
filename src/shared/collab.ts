/** Permission-based collaboration between companies (v3 stage 5-4). Everything here is pure. */

export type CollabWhat = 'material' | 'summary' | 'message' | 'work'
export type CollabDirection = 'oneway' | 'both'
export type CollabPermission = 'read' | 'request'
export type CollabDuration = { kind: 'once' } | { kind: 'until'; date: string } | { kind: 'open' }
export type CollabStatus = 'active' | 'closed'

export const WHAT_LABEL: Record<CollabWhat, string> = {
  material: '자료(메모리·보고서·결과물)',
  summary: '프로젝트 요약',
  message: '메시지 교환',
  work: '업무 의뢰'
}

export interface CollabChannel {
  id: string
  /** The company that gives (and, for a request, asks). For `both`, either side may send. */
  from: string
  to: string
  what: CollabWhat[]
  direction: CollabDirection
  permission: CollabPermission
  duration: CollabDuration
  status: CollabStatus
  createdAt: string
  createdBy: string
  closedAt?: string
  /** `once` channels: set when the single transfer happened. */
  usedAt?: string
  note?: string
  /** The AI request this channel was made from. */
  requestId?: string
}

export type ExternalKind = 'material' | 'summary' | 'message' | 'result' | 'request'

/** A copy that arrived in a company's external box. It never links back to the sender's folder. */
export interface ExternalItem {
  id: string
  kind: ExternalKind
  title: string
  body: string
  channelId: string
  fromCompanyId: string
  fromCompanyName: string
  approvedAt: string
  receivedAt: string
  /** Set when the channel was closed or the item recalled: the AI never sees it again. */
  recalledAt?: string
  /** `request` items: the task created on this company's board. */
  taskId?: string
}

export interface CollabRequest {
  id: string
  fromCompanyId: string
  taskId: string
  need: string
  why: string
  /** What the AI wrote as target (ignored for routing: only the person picks the company). */
  hint: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  decidedAt?: string
  channelId?: string
}

export type AuditAction =
  | 'channel-created'
  | 'channel-closed'
  | 'material-sent'
  | 'message-sent'
  | 'work-requested'
  | 'result-returned'
  | 'recalled'
  | 'blocked'
  | 'ai-request'
  | 'request-decided'

export interface AuditEntry {
  id: string
  at: string
  action: AuditAction
  channelId?: string
  from?: string
  to?: string
  text: string
}

export function isExpired(ch: CollabChannel, now = new Date()): boolean {
  return ch.duration.kind === 'until' && new Date(ch.duration.date).getTime() < now.getTime()
}

export type Transfer = 'material' | 'summary' | 'message' | 'work' | 'result'

export interface Verdict {
  ok: boolean
  reason: string
}

/**
 * May `sender` send something of this kind to `receiver` over the channel right now?
 * Default is no: the channel must exist, be open, unexpired, unused (for once), point the right way,
 * name this kind, and for work requests grant the `request` permission.
 * A `result` (the answer to a request that came in over this channel) travels back the opposite way and is always allowed while open.
 */
export function channelAllows(ch: CollabChannel | undefined, sender: string, receiver: string, kind: Transfer, now = new Date()): Verdict {
  if (!ch) return { ok: false, reason: '협업 채널이 없어요.' }
  if (ch.status !== 'active') return { ok: false, reason: '종료된 채널이에요.' }
  if (isExpired(ch, now)) return { ok: false, reason: '기간이 지난 채널이에요.' }
  if (ch.duration.kind === 'once' && ch.usedAt && kind !== 'result') return { ok: false, reason: '1회용 채널이라 이미 사용했어요.' }
  const forward = ch.from === sender && ch.to === receiver
  const backward = ch.to === sender && ch.from === receiver
  if (kind === 'result') {
    if (!backward && !forward) return { ok: false, reason: '이 채널의 회사가 아니에요.' }
    return { ok: true, reason: '' }
  }
  if (!(forward || (backward && ch.direction === 'both'))) return { ok: false, reason: '이 방향으로는 허가되지 않았어요.' }
  if (!ch.what.includes(kind)) return { ok: false, reason: `이 채널은 "${WHAT_LABEL[kind]}"을(를) 허가하지 않았어요.` }
  if (kind === 'work' && ch.permission !== 'request') return { ok: false, reason: '읽기만 허가된 채널이라 업무를 의뢰할 수 없어요.' }
  return { ok: true, reason: '' }
}

/** `[[COLLAB: 대상 | 필요한 것 | 이유]]` in an answer. Only the first one counts. */
export function parseCollab(text: string): { hint: string; need: string; why: string } | null {
  const m = /\[\[COLLAB:\s*([\s\S]*?)\]\]/i.exec(text)
  if (!m) return null
  const parts = m[1].split('|').map((s) => s.trim())
  const need = parts[1] || parts[0]
  if (!need) return null
  return { hint: parts.length > 1 ? parts[0] : '', need, why: parts.slice(2).join(' | ') }
}

export function describeChannel(ch: CollabChannel, name: (id: string) => string): string {
  const dir = ch.direction === 'both' ? '↔' : '→'
  const dur = ch.duration.kind === 'once' ? '1회' : ch.duration.kind === 'until' ? `${ch.duration.date.slice(0, 10)}까지` : '종료할 때까지'
  return `${name(ch.from)} ${dir} ${name(ch.to)} · ${ch.what.map((w) => WHAT_LABEL[w]).join(', ')} · ${ch.permission === 'request' ? '의뢰 가능' : '읽기만'} · ${dur}`
}

export interface ShareableRef {
  ref: string
  kind: 'material' | 'summary'
  title: string
  preview: string
}

export interface CollabView {
  channels: CollabChannel[]
  requests: CollabRequest[]
  audit: AuditEntry[]
}
