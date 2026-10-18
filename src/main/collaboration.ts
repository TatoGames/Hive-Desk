import type { Task } from '../shared/types'
import {
  channelAllows,
  parseCollab,
  type CollabChannel,
  type CollabDirection,
  type CollabDuration,
  type CollabPermission,
  type CollabRequest,
  type CollabView,
  type CollabWhat,
  type ExternalKind,
  type ShareableRef,
  type Transfer,
  WHAT_LABEL
} from '../shared/collab'
import type { Hive } from './hive'
import type { CollabStore } from './collab'

export interface CollabCtx {
  store: CollabStore
  hive: (companyId: string) => Hive | undefined
  companyIds: () => string[]
  name: (companyId: string) => string
  /** Put a work request on the receiving company's board and hand it to the company (normal delegation). */
  createExternalTask: (h: Hive, title: string, body: string, external: NonNullable<Task['external']>) => Task
  notify: (title: string, body: string) => void
  changed: () => void
}

export interface ChannelInput {
  from: string
  to: string
  what: CollabWhat[]
  direction: CollabDirection
  permission: CollabPermission
  duration: CollabDuration
  note?: string
  requestId?: string
}

const MAX_BODY = 20000

/**
 * Permission-based collaboration. Nothing crosses between companies unless a channel the board opened
 * allows it; what crosses is always a copy with its source, and every transfer (also refused ones) is logged.
 */
export class Collaboration {
  constructor(private c: CollabCtx) {}

  view(): CollabView {
    return { channels: this.c.store.channels(), requests: this.c.store.requests(), audit: this.c.store.audit() }
  }

  pendingRequests(): CollabRequest[] {
    return this.c.store.requests().filter((r) => r.status === 'pending')
  }

  // ---- channels ----
  createChannel(input: ChannelInput, by: string): CollabChannel {
    const ids = this.c.companyIds()
    if (!ids.includes(input.from) || !ids.includes(input.to)) throw new Error('없는 회사예요.')
    if (input.from === input.to) throw new Error('서로 다른 두 회사 사이에만 채널을 만들 수 있어요.')
    if (!input.what.length) throw new Error('무엇을 주고받을지 하나 이상 골라 주세요.')
    if (input.what.includes('work') && input.permission !== 'request') throw new Error('업무 의뢰를 허가하려면 권한을 "의뢰 가능"으로 해야 해요.')
    if (input.duration.kind === 'until' && Number.isNaN(new Date(input.duration.date).getTime())) throw new Error('만료일이 올바르지 않아요.')
    const ch: CollabChannel = {
      id: this.c.store.newChannelId(),
      from: input.from,
      to: input.to,
      what: [...new Set(input.what)],
      direction: input.direction,
      permission: input.permission,
      duration: input.duration,
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: by,
      ...(input.note ? { note: input.note } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {})
    }
    this.c.store.saveChannel(ch)
    this.c.store.log('channel-created', `채널을 열었어요: ${this.c.name(ch.from)} ${ch.direction === 'both' ? '↔' : '→'} ${this.c.name(ch.to)} (${ch.what.map((w) => WHAT_LABEL[w]).join(', ')})`, { channelId: ch.id, from: ch.from, to: ch.to })
    this.c.changed()
    return ch
  }

  /** Close a channel: copies that already crossed are marked recalled and no AI gets them any more. */
  closeChannel(id: string, by: string): number {
    const ch = this.c.store.channel(id)
    if (!ch) throw new Error('채널을 찾을 수 없어요.')
    if (ch.status === 'closed') return 0
    this.c.store.saveChannel({ ...ch, status: 'closed', closedAt: new Date().toISOString() })
    let n = 0
    for (const cid of [ch.from, ch.to]) n += this.c.hive(cid)?.recallExternal(id) ?? 0
    this.c.store.log('channel-closed', `${by}이(가) 채널을 닫았어요 · 이미 건너간 복사본 ${n}개를 회수됨으로 표시했어요.`, { channelId: id, from: ch.from, to: ch.to })
    this.c.changed()
    return n
  }

  private gate(channelId: string, sender: string, receiver: string, kind: Transfer): CollabChannel {
    const ch = this.c.store.channel(channelId)
    const v = channelAllows(ch, sender, receiver, kind)
    if (!v.ok) {
      this.c.store.log('blocked', `막았어요 (${kind}): ${v.reason}`, { channelId, from: sender, to: receiver })
      throw new Error(v.reason)
    }
    return ch!
  }

  private markUsed(ch: CollabChannel): void {
    if (ch.duration.kind === 'once') this.c.store.saveChannel({ ...ch, usedAt: new Date().toISOString() })
  }

  // ---- what can be shared ----
  listShareable(companyId: string): ShareableRef[] {
    const h = this.c.hive(companyId)
    if (!h) return []
    const out: ShareableRef[] = []
    const prev = (t: string): string => t.replace(/\s+/g, ' ').slice(0, 120)
    for (const m of h.listMemory(200)) out.push({ ref: 'memory:' + m.id, kind: 'material', title: '메모리 · ' + prev(m.text).slice(0, 40), preview: prev(m.text) })
    for (const f of h.listFinals()) out.push({ ref: 'final:' + f.id, kind: 'material', title: '최종 보고서 · ' + f.title, preview: prev(f.summary) })
    for (const t of h.listTasks()) if (!t.hidden && t.status === 'done' && t.result) out.push({ ref: 'task:' + t.id, kind: 'material', title: '결과물 · ' + t.title, preview: prev(t.result) })
    for (const p of h.listProjects()) out.push({ ref: 'project:' + p.id, kind: 'summary', title: '프로젝트 요약 · ' + p.name, preview: prev(p.description || p.briefing || p.name) })
    return out
  }

  /** The text behind a ref, read on the sender's side only when the person picks it. */
  materialFrom(companyId: string, ref: string): { title: string; body: string; kind: 'material' | 'summary' } {
    const h = this.c.hive(companyId)
    if (!h) throw new Error('없는 회사예요.')
    const [type, id] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)]
    if (type === 'memory') {
      const m = h.listMemory(1000).find((x) => x.id === id)
      if (m) return { title: '메모리', body: m.text, kind: 'material' }
    } else if (type === 'final') {
      const f = h.getFinal(id)
      if (f) return { title: f.title, body: [f.summary, ...(f.verification.length ? ['', '확인한 것:', ...f.verification.map((x) => '- ' + x)] : []), ...(f.risks.length ? ['', '위험:', ...f.risks.map((x) => '- ' + x)] : [])].join('\n'), kind: 'material' }
    } else if (type === 'task') {
      const t = h.getTask(id)
      if (t?.result) return { title: t.title, body: t.result, kind: 'material' }
    } else if (type === 'project') {
      const p = h.getProject(id)
      if (p) return { title: p.name, body: [p.description, p.briefing].filter(Boolean).join('\n\n') || p.name, kind: 'summary' }
    }
    throw new Error('공유할 자료를 찾을 수 없어요.')
  }

  // ---- sending ----
  sendMaterial(channelId: string, sender: string, input: { ref: string }): void {
    const m = this.materialFrom(sender, input.ref)
    const ch0 = this.c.store.channel(channelId)
    const receiver = ch0 ? (ch0.from === sender ? ch0.to : ch0.from) : ''
    const ch = this.gate(channelId, sender, receiver, m.kind)
    this.deliver(ch, sender, receiver, m.kind, m.title, m.body)
    this.markUsed(ch)
    this.c.changed()
  }

  sendMessage(channelId: string, sender: string, text: string): void {
    const ch0 = this.c.store.channel(channelId)
    const receiver = ch0 ? (ch0.from === sender ? ch0.to : ch0.from) : ''
    const ch = this.gate(channelId, sender, receiver, 'message')
    this.deliver(ch, sender, receiver, 'message', '메시지', text)
    this.markUsed(ch)
    this.c.changed()
  }

  private deliver(ch: CollabChannel, sender: string, receiver: string, kind: ExternalKind, title: string, body: string): void {
    const rh = this.c.hive(receiver)
    if (!rh) throw new Error('받는 회사를 찾을 수 없어요.')
    rh.addExternal({ kind, title: title.slice(0, 200), body: body.slice(0, MAX_BODY), channelId: ch.id, fromCompanyId: sender, fromCompanyName: this.c.name(sender), approvedAt: ch.createdAt })
    this.c.store.log(kind === 'message' ? 'message-sent' : 'material-sent', `${this.c.name(sender)} → ${this.c.name(receiver)}: ${title}`, { channelId: ch.id, from: sender, to: receiver })
    this.c.notify('외부 자료가 도착했어요', `${this.c.name(receiver)}: ${title}`)
  }

  /** A work request from `sender` to the other company of the channel: lands on its board as an external request. */
  requestWork(channelId: string, sender: string, title: string, body: string): Task {
    const ch0 = this.c.store.channel(channelId)
    const receiver = ch0 ? (ch0.from === sender ? ch0.to : ch0.from) : ''
    const ch = this.gate(channelId, sender, receiver, 'work')
    const rh = this.c.hive(receiver)
    if (!rh) throw new Error('받는 회사를 찾을 수 없어요.')
    const fromName = this.c.name(sender)
    const t = this.c.createExternalTask(rh, `[외부 의뢰] ${title.trim()}`, body.slice(0, MAX_BODY), { channelId, fromCompanyId: sender, fromCompanyName: fromName })
    rh.addExternal({ kind: 'request', title: title.slice(0, 200), body: body.slice(0, MAX_BODY), channelId, fromCompanyId: sender, fromCompanyName: fromName, approvedAt: ch.createdAt, taskId: t.id })
    this.markUsed(ch)
    this.c.store.log('work-requested', `${fromName} → ${this.c.name(receiver)}: 업무 의뢰 "${title}"`, { channelId, from: sender, to: receiver })
    this.c.notify('외부 의뢰가 들어왔어요', `${this.c.name(receiver)}: ${title}`)
    this.c.changed()
    return t
  }

  /** Requests the company finished (and its board accepted) go back to the asking company as a result copy. */
  settle(): void {
    for (const cid of this.c.companyIds()) {
      const h = this.c.hive(cid)
      if (!h) continue
      for (const t of h.listTasks()) {
        const ext = t.external
        if (!ext || ext.returned || t.status !== 'done') continue
        const verdict = channelAllows(this.c.store.channel(ext.channelId), cid, ext.fromCompanyId, 'result')
        h.updateTask(t.id, { external: { ...ext, returned: true } })
        if (!verdict.ok) {
          this.c.store.log('blocked', `결과를 돌려주지 못했어요 (${t.title}): ${verdict.reason}`, { channelId: ext.channelId, from: cid, to: ext.fromCompanyId })
          continue
        }
        const fin = h.getFinal(t.id)
        const body = fin ? [fin.summary, ...(fin.risks.length ? ['', '남은 위험:', ...fin.risks.map((x) => '- ' + x)] : [])].join('\n') : t.result ?? '(결과 없음)'
        const ch = this.c.store.channel(ext.channelId)!
        const dest = this.c.hive(ext.fromCompanyId)
        dest?.addExternal({ kind: 'result', title: t.title.replace(/^\[외부 의뢰\]\s*/, ''), body: body.slice(0, MAX_BODY), channelId: ext.channelId, fromCompanyId: cid, fromCompanyName: this.c.name(cid), approvedAt: ch.createdAt, taskId: t.id })
        this.c.store.log('result-returned', `${this.c.name(cid)} → ${this.c.name(ext.fromCompanyId)}: 결과 "${t.title}"`, { channelId: ext.channelId, from: cid, to: ext.fromCompanyId })
        this.c.notify('외부 의뢰 결과가 돌아왔어요', t.title)
      }
    }
  }

  // ---- AI requests ----
  /** A manager's answer may ask for outside help with [[COLLAB: …]]; it waits for the board, who picks the company. */
  onTaskDone(companyId: string, t: Task): CollabRequest | null {
    const h = this.c.hive(companyId)
    const p = parseCollab(t.result ?? '')
    if (!h || !p) return null
    const manager = h.listSeats().some((s) => s.agentId === t.assignee && ['ceo', 'coo', 'lead'].includes(s.job))
    if (!manager) return null
    if (this.c.store.requests().some((r) => r.taskId === t.id && r.need === p.need)) return null
    const r: CollabRequest = { id: this.c.store.newRequestId(), fromCompanyId: companyId, taskId: t.id, need: p.need, why: p.why, hint: p.hint, status: 'pending', createdAt: new Date().toISOString() }
    this.c.store.saveRequest(r)
    this.c.store.log('ai-request', `${this.c.name(companyId)}의 AI가 외부 도움을 요청했어요: ${p.need}`, { from: companyId })
    this.c.notify('외부 도움 요청이 이사회에 올라왔어요', `${this.c.name(companyId)}: ${p.need}`)
    this.c.changed()
    return r
  }

  /** The board decides: approve with a target company and scope (the request is delivered if work is allowed), or reject. */
  decideRequest(id: string, decision: 'approved' | 'rejected', by: string, scope?: Omit<ChannelInput, 'from' | 'requestId'>): CollabChannel | null {
    const r = this.c.store.request(id)
    if (!r || r.status !== 'pending') throw new Error('이미 처리했거나 없는 요청이에요.')
    if (decision === 'rejected') {
      this.c.store.saveRequest({ ...r, status: 'rejected', decidedAt: new Date().toISOString() })
      this.c.store.log('request-decided', `외부 도움 요청을 반려했어요: ${r.need}`, { from: r.fromCompanyId })
      this.c.changed()
      return null
    }
    if (!scope) throw new Error('도와줄 회사와 범위를 골라 주세요.')
    const ch = this.createChannel({ ...scope, from: r.fromCompanyId, requestId: r.id }, by)
    this.c.store.saveRequest({ ...r, status: 'approved', decidedAt: new Date().toISOString(), channelId: ch.id })
    this.c.store.log('request-decided', `외부 도움 요청을 허가했어요: ${r.need} → ${this.c.name(ch.to)}`, { channelId: ch.id, from: r.fromCompanyId, to: ch.to })
    if (ch.what.includes('work')) {
      try {
        this.requestWork(ch.id, r.fromCompanyId, r.need, [r.need, r.why ? `\n이유: ${r.why}` : ''].join(''))
      } catch (e) {
        this.c.store.log('blocked', `요청을 전달하지 못했어요: ${(e as Error).message}`, { channelId: ch.id, from: r.fromCompanyId, to: ch.to })
        this.c.notify('외부 요청을 전달하지 못했어요', (e as Error).message)
      }
    }
    this.c.changed()
    return ch
  }
}
