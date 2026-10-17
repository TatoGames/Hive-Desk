import type { ApprovalKind, Snapshot } from '@shared/types'
import { fmtTime } from '../store'

const KIND: Record<ApprovalKind, string> = {
  'risky-task': '위험 태스크',
  budget: '예산 초과',
  'agent-request': '에이전트 요청'
}

export default function Approvals({ snap }: { snap: Snapshot }): JSX.Element {
  const pending = snap.approvals.filter((a) => a.status === 'pending')
  const past = snap.approvals.filter((a) => a.status !== 'pending').slice(0, 30)
  const task = (id: string) => snap.tasks.find((t) => t.id === id)
  const agent = (id: string) => snap.roster.find((r) => r.id === id)?.name ?? id

  return (
    <div className="page">
      <header className="page-head">
        <h1>승인 대기</h1>
      </header>
      <p className="muted">
        위험한 작업, 예산 초과, 에이전트가 직접 멈추고 물어본 일은 여기서 사람이 결정해요. 승인하면 태스크가 다시
        &lsquo;할 일&rsquo;로 돌아가요.
      </p>
      {!pending.length && <div className="panel empty">대기 중인 승인이 없어요.</div>}
      {pending.map((a) => {
        const t = task(a.taskId)
        return (
          <div key={a.id} className="panel approval">
            <div>
              <span className={'tag ' + (a.kind === 'budget' ? '' : 'warn')}>{KIND[a.kind]}</span>{' '}
              <b>{t?.title ?? '(삭제된 태스크)'}</b>
            </div>
            <div className="muted small">
              {agent(a.agentId)} · {fmtTime(a.createdAt)}
            </div>
            <p>{a.reason}</p>
            {t?.result && <pre className="out">{t.result}</pre>}
            <div className="row">
              <button className="primary" onClick={() => void window.hive.decideApproval(a.id, 'approved')}>
                승인
              </button>
              <button className="danger" onClick={() => void window.hive.decideApproval(a.id, 'rejected')}>
                거절
              </button>
            </div>
          </div>
        )
      })}
      {!!past.length && (
        <section className="panel">
          <h2>최근 결정</h2>
          {past.map((a) => (
            <div key={a.id} className="small past">
              {a.status === 'approved' ? '✓ 승인' : '✕ 거절'} · {KIND[a.kind]} · {task(a.taskId)?.title ?? '-'} ·{' '}
              {a.decidedBy} · {fmtTime(a.decidedAt)}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
