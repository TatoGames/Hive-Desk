import { useState } from 'react'
import type { Agenda, Snapshot } from '@shared/types'
import { PHASE_LABEL } from '@shared/committee'
import { fmtTime } from '../store'

function AgendaCard({ a, snap }: { a: Agenda; snap: Snapshot }): JSX.Element {
  const [note, setNote] = useState('')
  const name = (id: string) => snap.roster.find((r) => r.id === id)?.name ?? id
  const rec = a.recommendation
  return (
    <section className="panel">
      <div>
        <b>{a.title}</b> <span className={'tag' + (a.phase === 'board' ? ' warn' : '')}>{PHASE_LABEL[a.phase]}</span>
      </div>
      <div className="muted small">
        {fmtTime(a.createdAt)} · 위원 {a.members.map(name).join(', ')}
      </div>
      {a.body && <p>{a.body}</p>}
      {a.note && <p className="warn-text small">{a.note}</p>}
      {a.proposals.map((p, i) => {
        const votes = a.votes.filter((v) => v.choice === i + 1)
        return (
          <details key={i} open={a.phase === 'board'}>
            <summary>
              제안 {i + 1} — {name(p.agentId)}
              {rec && <span className="tag">{rec.tally[i]}표</span>}
              {rec?.choice === i + 1 && <span className="tag warn">위원회 추천</span>}
            </summary>
            <pre className="out">{p.text}</pre>
            {votes.map((v) => (
              <div key={v.agentId} className="small muted">
                {name(v.agentId)}: {v.reason || '(이유 없음)'}
              </div>
            ))}
          </details>
        )
      })}
      {!!rec?.minority.length && (
        <div className="small">
          <b>소수 의견</b>
          {rec.minority.map((m) => (
            <div key={m.agentId}>
              {name(m.agentId)} → 제안 {m.choice}: {m.reason || '(이유 없음)'}
            </div>
          ))}
        </div>
      )}
      {a.phase === 'board' && (
        <div className="row">
          <input className="grow" placeholder="이사회 메모 (선택)" value={note} onChange={(e) => setNote(e.target.value)} />
          {a.proposals.map((_, i) => (
            <button
              key={i}
              className={rec?.choice === i + 1 ? 'primary' : ''}
              onClick={() => void window.hive.decideAgenda(a.id, i + 1, note)}
            >
              제안 {i + 1}로 결정
            </button>
          ))}
        </div>
      )}
      {a.decision && (
        <div className="small">
          ✓ 제안 {a.decision.choice}로 결정 · {a.decision.by} · {fmtTime(a.decision.at)}
          {a.decision.note && ` · ${a.decision.note}`} (고정 메모리에 저장됨)
        </div>
      )}
    </section>
  )
}

export default function Committee({ snap }: { snap: Snapshot }): JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [err, setErr] = useState('')
  const [deep, setDeep] = useState(false)
  const members = new Set(snap.company.seats.filter((x) => x.job === 'ceo' && x.agentId).map((x) => x.agentId)).size
  const open = async (): Promise<void> => {
    try {
      setErr('')
      await window.hive.openAgenda(title, body, deep)
      setTitle('')
      setBody('')
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }
  return (
    <div className="page">
      <header className="page-head">
        <h1>CEO 위원회</h1>
      </header>
      <p className="muted small">
        CEO 자리의 에이전트들이 각자 제안하고 추천 이유를 적어요 (기본 1라운드). ‘깊게 토론’을 켜면 서로 한 번 비판하고 이유와 함께 투표해요. 위원회는 추천만 하고 최종 결정은
        이사회(나)가 해요. 결정은 고정 메모리로 저장돼 이후 모든 에이전트가 따라요.
      </p>
      <div className="new-task">
        <div className="row">
          <input className="grow" placeholder="안건 제목 (예: 다음 분기 우선순위)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <label className="small row" title="끄면 위원마다 한 번만 실행해 제안을 나란히 보여 줘요. 켜면 제안 → 비판 → 투표를 모두 해요.">
            <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
            깊게 토론
          </label>
          <button className="primary" disabled={!title.trim()} onClick={() => void open()}>
            안건 올리기
          </button>
        </div>
        <textarea rows={3} placeholder="배경과 선택지를 적어 주세요" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="muted small">예상 AI 실행: {deep ? members * 3 : members}회 {deep ? '(제안·비판·투표 3라운드)' : '(1라운드)'}</div>
        {err && <div className="warn-text small">{err}</div>}
      </div>
      {!snap.company.agendas.length && <div className="panel empty">아직 안건이 없어요.</div>}
      {snap.company.agendas.map((a) => (
        <AgendaCard key={a.id} a={a} snap={snap} />
      ))}
    </div>
  )
}
