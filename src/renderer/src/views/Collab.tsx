import { useEffect, useState } from 'react'
import type { Snapshot } from '@shared/types'
import { describeChannel, WHAT_LABEL, type CollabChannel, type CollabWhat, type ShareableRef } from '@shared/collab'
import { ConfirmButton } from './Materials'

const WHATS: CollabWhat[] = ['material', 'summary', 'message', 'work']
const KIND_LABEL = { material: '자료', summary: '요약', message: '메시지', result: '의뢰 결과', request: '의뢰' } as const

interface Scope {
  to: string
  what: CollabWhat[]
  direction: 'oneway' | 'both'
  permission: 'read' | 'request'
  durKind: 'once' | 'until' | 'open'
  date: string
}

function ScopeForm({ snap, from, value, onChange, fixedTo }: { snap: Snapshot; from: string; value: Scope; onChange: (s: Scope) => void; fixedTo?: boolean }): JSX.Element {
  const others = snap.companies.filter((c) => c.id !== from)
  const set = (p: Partial<Scope>): void => onChange({ ...value, ...p })
  const toggle = (w: CollabWhat): void => {
    const what = value.what.includes(w) ? value.what.filter((x) => x !== w) : [...value.what, w]
    set({ what, ...(w === 'work' && !value.what.includes('work') ? { permission: 'request' as const } : {}) })
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      {!fixedTo && (
        <label className="row">
          <span className="small muted">어느 회사와</span>
          <select value={value.to} onChange={(e) => set({ to: e.target.value })}>
            <option value="">회사 고르기…</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="row">
        <span className="small muted">무엇을</span>
        {WHATS.map((w) => (
          <label key={w} className="row small">
            <input type="checkbox" checked={value.what.includes(w)} onChange={() => toggle(w)} />
            {WHAT_LABEL[w]}
          </label>
        ))}
      </div>
      <div className="row">
        <span className="small muted">방향</span>
        <select value={value.direction} onChange={(e) => set({ direction: e.target.value as Scope['direction'] })}>
          <option value="oneway">보내는 쪽 → 받는 쪽만</option>
          <option value="both">양방향</option>
        </select>
        <span className="small muted">권한</span>
        <select value={value.permission} onChange={(e) => set({ permission: e.target.value as Scope['permission'] })}>
          <option value="read">읽기만</option>
          <option value="request">의뢰 가능</option>
        </select>
        <span className="small muted">기간</span>
        <select value={value.durKind} onChange={(e) => set({ durKind: e.target.value as Scope['durKind'] })}>
          <option value="once">1회</option>
          <option value="until">만료일까지</option>
          <option value="open">직접 종료할 때까지</option>
        </select>
        {value.durKind === 'until' && <input type="date" value={value.date} onChange={(e) => set({ date: e.target.value })} />}
      </div>
    </div>
  )
}

const blank = (): Scope => ({ to: '', what: ['material'], direction: 'oneway', permission: 'read', durKind: 'open', date: '' })
const toInput = (s: Scope): Record<string, unknown> => ({
  to: s.to, what: s.what, direction: s.direction, permission: s.permission,
  duration: s.durKind === 'until' ? { kind: 'until', date: s.date ? new Date(s.date + 'T23:59:59').toISOString() : '' } : { kind: s.durKind }
})

function ReqCard({ snap, r }: { snap: Snapshot; r: Snapshot['collab']['requests'][number] }): JSX.Element {
  const [scope, setScope] = useState<Scope>({ ...blank(), what: ['work'], permission: 'request', durKind: 'once' })
  const [err, setErr] = useState('')
  const name = snap.companies.find((c) => c.id === r.fromCompanyId)?.name ?? '?'
  const go = async (decision: 'approved' | 'rejected'): Promise<void> => {
    try {
      if (decision === 'approved' && !scope.to) return setErr('도와줄 회사를 골라 주세요.')
      await window.hive.collabDecide(r.id, decision, decision === 'approved' ? toInput(scope) : undefined)
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }
  return (
    <div className="card">
      <div className="title">
        {name}의 AI가 외부 도움을 요청했어요: {r.need}
      </div>
      {r.why && <div className="small muted">이유: {r.why}</div>}
      <p className="small muted">AI는 다른 회사를 모르기 때문에, 누구에게 맡길지와 범위는 이사회가 정해요.</p>
      <ScopeForm snap={snap} from={r.fromCompanyId} value={scope} onChange={setScope} />
      {err && <div className="error small">{err}</div>}
      <div className="row end">
        <button className="ghost" onClick={() => go('rejected')}>
          반려
        </button>
        <button className="primary" onClick={() => go('approved')}>
          허가하고 전달
        </button>
      </div>
    </div>
  )
}

function SendBox({ snap, ch }: { snap: Snapshot; ch: CollabChannel }): JSX.Element {
  const senders = ch.direction === 'both' ? [ch.from, ch.to] : [ch.from]
  const [sender, setSender] = useState(ch.from)
  const [items, setItems] = useState<ShareableRef[]>([])
  const [ref, setRef] = useState('')
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => {
    void window.hive.collabShareable(sender).then(setItems)
  }, [sender, snap.collab.channels.length])
  const name = (id: string): string => snap.companies.find((c) => c.id === id)?.name ?? '?'
  const run = async (f: () => Promise<void>, ok: string): Promise<void> => {
    try {
      await f()
      setMsg(ok)
      setText('')
      setTitle('')
    } catch (e) {
      setMsg('⚠ ' + String((e as Error).message ?? e))
    }
  }
  const canWork = ch.what.includes('work') && ch.permission === 'request'
  return (
    <div className="stack" style={{ gap: 6, marginTop: 6 }}>
      <div className="row">
        <span className="small muted">보내는 회사</span>
        <select value={sender} onChange={(e) => setSender(e.target.value)}>
          {senders.map((s) => (
            <option key={s} value={s}>
              {name(s)}
            </option>
          ))}
        </select>
      </div>
      {(ch.what.includes('material') || ch.what.includes('summary')) && (
        <div className="row">
          <select value={ref} onChange={(e) => setRef(e.target.value)} style={{ maxWidth: 360 }}>
            <option value="">보낼 자료 고르기…</option>
            {items.filter((i) => ch.what.includes(i.kind)).map((i) => (
              <option key={i.ref} value={i.ref}>
                {i.title}
              </option>
            ))}
          </select>
          <button disabled={!ref} onClick={() => run(() => window.hive.collabSendMaterial(ch.id, sender, ref), '복사본을 보냈어요.')}>
            복사본 보내기
          </button>
        </div>
      )}
      {(ch.what.includes('message') || canWork) && (
        <div className="stack" style={{ gap: 4 }}>
          {canWork && <input placeholder="의뢰 제목" value={title} onChange={(e) => setTitle(e.target.value)} />}
          <textarea rows={2} placeholder="메시지 또는 의뢰 내용" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            {ch.what.includes('message') && (
              <button disabled={!text.trim()} onClick={() => run(() => window.hive.collabSendMessage(ch.id, sender, text), '메시지를 보냈어요.')}>
                메시지 보내기
              </button>
            )}
            {canWork && (
              <button disabled={!text.trim() || !title.trim()} onClick={() => run(() => window.hive.collabRequestWork(ch.id, sender, title, text), '의뢰를 상대 보드에 올렸어요.')}>
                업무 의뢰하기
              </button>
            )}
          </div>
        </div>
      )}
      {msg && <div className="small muted">{msg}</div>}
    </div>
  )
}

export default function Collab({ snap }: { snap: Snapshot }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState(snap.companies.find((c) => c.active)?.id ?? '')
  const [scope, setScope] = useState<Scope>(blank())
  const [err, setErr] = useState('')
  const name = (id: string): string => snap.companies.find((c) => c.id === id)?.name ?? '(없어진 회사)'
  const pending = snap.collab.requests.filter((r) => r.status === 'pending')
  const channels = snap.collab.channels
  const active = snap.companies.find((c) => c.active)

  const create = async (): Promise<void> => {
    try {
      if (!scope.to) return setErr('어느 회사와 연결할지 골라 주세요.')
      if (!scope.what.length) return setErr('무엇을 주고받을지 하나 이상 골라 주세요.')
      await window.hive.collabCreate({ ...toInput(scope), from })
      setOpen(false)
      setScope(blank())
      setErr('')
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }

  if (snap.companies.length < 2)
    return (
      <div className="page">
        <header className="page-head">
          <h1>협업</h1>
        </header>
        <div className="empty">회사가 하나뿐이에요. 회사를 하나 더 만들면 이사회가 허가한 범위 안에서 서로 자료를 주고받을 수 있어요.</div>
      </div>
    )

  return (
    <div className="page">
      <header className="page-head">
        <h1>협업</h1>
        <button className="primary" onClick={() => setOpen(!open)}>
          + 협업 채널 열기
        </button>
      </header>
      <p className="muted small">
        기본값은 <b>모두 꺼짐</b>이에요. 이사회(나)가 채널을 열어야만 회사 사이에 자료가 건너가고, 건너간 것은 항상 <b>복사본 + 출처</b>예요. 상대 회사 폴더를 직접 볼 수는 없어요. 채널을 닫으면 건너간 복사본은 &quot;회수됨&quot;이 되어 AI에게 더는 전달되지 않아요.
      </p>

      {open && (
        <div className="card">
          <div className="title">새 협업 채널</div>
          <label className="row">
            <span className="small muted">보내는 회사</span>
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {snap.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <ScopeForm snap={snap} from={from} value={scope} onChange={setScope} />
          {err && <div className="error small">{err}</div>}
          <div className="row end">
            <button className="ghost" onClick={() => setOpen(false)}>
              취소
            </button>
            <button className="primary" onClick={create}>
              허가하고 열기
            </button>
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <>
          <h3>이사회 결재 대기 · AI의 외부 도움 요청 ({pending.length})</h3>
          {pending.map((r) => (
            <ReqCard key={r.id} snap={snap} r={r} />
          ))}
        </>
      )}

      <h3>채널</h3>
      {!channels.length && <div className="empty">열린 채널이 없어요. 지금은 회사끼리 아무것도 주고받지 않아요.</div>}
      {channels.map((ch) => {
        const closed = ch.status === 'closed'
        const expired = ch.duration.kind === 'until' && new Date(ch.duration.date).getTime() < Date.now()
        const used = ch.duration.kind === 'once' && !!ch.usedAt
        return (
          <div key={ch.id} className="card" style={closed ? { opacity: 0.6 } : undefined}>
            <div className="row between">
              <div className="title">{describeChannel(ch, name)}</div>
              <span className="badge">{closed ? '종료됨' : expired ? '기간 지남' : used ? '사용 완료' : '열림'}</span>
            </div>
            {!closed && !expired && !used && <SendBox snap={snap} ch={ch} />}
            {!closed && (
              <div className="row end">
                <ConfirmButton label="채널 닫기·회수" onConfirm={() => void window.hive.collabClose(ch.id)} />
              </div>
            )}
          </div>
        )
      })}

      <h3>{active?.name}의 외부 자료함</h3>
      {!snap.external.length && <div className="empty">다른 회사에서 건너온 자료가 없어요.</div>}
      {snap.external.map((x) => (
        <div key={x.id} className="card" style={x.recalledAt ? { opacity: 0.55 } : undefined}>
          <div className="row between">
            <div className="title">
              {x.title} <span className="chip">{KIND_LABEL[x.kind]}</span>
            </div>
            {x.recalledAt && <span className="badge warn">회수됨 · AI에게 전달 안 함</span>}
          </div>
          <div className="small muted">
            출처: {x.fromCompanyName} · 승인 {localTime(x.approvedAt, false)} · 받은 때 {localTime(x.receivedAt)}
          </div>
          <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight: 140, overflow: 'auto' }}>
            {x.body}
          </pre>
        </div>
      ))}

      <h3>감사 기록</h3>
      {!snap.collab.audit.length && <div className="empty">아직 기록이 없어요.</div>}
      <div className="stack" style={{ gap: 2 }}>
        {snap.collab.audit.slice(0, 80).map((e) => (
          <div key={e.id} className={'small' + (e.action === 'blocked' ? ' error' : '')}>
            <span className="muted">{localTime(e.at)}</span> {e.text}
          </div>
        ))}
      </div>
    </div>
  )
}

/** ISO (UTC) → the viewer's local 'YYYY-MM-DD HH:mm' (or date only). */
function localTime(iso: string, withTime = true): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day
}
