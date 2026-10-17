import { useState } from 'react'
import type { ApprovalKind, Snapshot } from '@shared/types'
import { FLAG_LABEL } from '@shared/delegation'
import { fmtTime } from '../store'
import { NeedBox, ReviewBox } from './Materials'

const KIND: Record<ApprovalKind, string> = {
  'risky-task': '위험 태스크',
  budget: '예산 초과',
  'agent-request': '에이전트 요청',
  plan: '분배 계획'
}

export default function Approvals({ snap }: { snap: Snapshot }): JSX.Element {
  const pending = snap.approvals.filter((a) => a.status === 'pending')
  const asking = snap.tasks.filter((t) => t.status === 'needs_input')
  const reviewing = snap.tasks.filter((t) => t.status === 'needs_review')
  const past = snap.approvals.filter((a) => a.status !== 'pending').slice(0, 30)
  const task = (id: string) => snap.tasks.find((t) => t.id === id)
  const agent = (id: string) => snap.roster.find((r) => r.id === id)?.name ?? id

  return (
    <div className="page">
      <header className="page-head">
        <h1>승인·확인·자료 요청</h1>
      </header>
      <p className="muted">
        위험한 작업, 예산 초과, 에이전트가 직접 멈추고 물어본 일은 여기서 사람이 결정해요. 승인하면 태스크가 다시
        &lsquo;할 일&rsquo;로 돌아가요. 에이전트가 파일이나 정보를 요청하면 답하거나 파일을 넣어 주세요. 같은 대화를
        이어서 계속해요. 파일을 바꾼 작업은 결과를 확인해야 완료로 처리돼요.
      </p>
      {!!asking.length && <h2 className="sec">에이전트가 자료를 기다려요</h2>}
      {asking.map((t) => (
        <div key={t.id} className="panel">
          <div>
            <b>{t.title}</b>
          </div>
          <div className="muted small">
            {snap.roster.find((r) => r.id === t.assignee)?.name ?? t.assignee} · {fmtTime(t.finishedAt)}
          </div>
          <NeedBox task={t} />
        </div>
      ))}
      {!!reviewing.length && <h2 className="sec">결과를 확인해 주세요</h2>}
      {reviewing.map((t) => (
        <div key={t.id} className="panel">
          <div>
            <b>{t.title}</b>
          </div>
          <div className="muted small">
            {snap.roster.find((r) => r.id === t.assignee)?.name ?? t.assignee} · {fmtTime(t.finishedAt)}
          </div>
          <ReviewBox task={t} />
        </div>
      ))}
      {!pending.length && !asking.length && !reviewing.length && (
        <div className="panel empty">대기 중인 승인, 확인, 자료 요청이 없어요.</div>
      )}
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
            {a.kind === 'plan' && t?.plan ? (
              <PlanBox snap={snap} id={a.id} task={t} />
            ) : (
              <>
                {t?.result && <pre className="out">{t.result}</pre>}
                <div className="row">
                  <button className="primary" onClick={() => void window.hive.decideApproval(a.id, 'approved')}>
                    승인
                  </button>
                  <button className="danger" onClick={() => void window.hive.decideApproval(a.id, 'rejected')}>
                    거절
                  </button>
                </div>
              </>
            )}
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

function PlanBox({ snap, id, task }: { snap: Snapshot; id: string; task: Snapshot['tasks'][number] }): JSX.Element {
  const [note, setNote] = useState('')
  const plan = task.plan!
  const who = (aid: string) => snap.roster.find((r) => r.id === aid)?.name ?? aid
  return (
    <div>
      <div className="small">
        예상 AI 실행 <b>{plan.estimateRuns}회</b>
        {plan.flags.map((f) => (
          <span key={f} className="tag warn" style={{ marginLeft: 6 }}>
            {FLAG_LABEL[f] ?? f}
          </span>
        ))}
      </div>
      {!!plan.boardReasons.length && (
        <ul className="small">
          {plan.boardReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <ol className="plan-items">
        {plan.items.map((it, i) => (
          <li key={i}>
            <b>{it.title}</b> — {who(it.assignee)}
            <div className="muted small">
              완료 조건: {it.done || '-'}
              {!!it.after.length && ` · 먼저 끝나야 함: ${it.after.join(', ')}번`}
            </div>
          </li>
        ))}
      </ol>
      <input
        className="grow"
        placeholder="반려할 때 이유 (담당 관리자에게 전달돼요)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="row">
        <button className="primary" onClick={() => void window.hive.decideApproval(id, 'approved')}>
          계획대로 진행
        </button>
        <button className="danger" disabled={!note.trim()} onClick={() => void window.hive.decideApproval(id, 'rejected', note)}>
          반려 (다시 계획)
        </button>
      </div>
    </div>
  )
}
