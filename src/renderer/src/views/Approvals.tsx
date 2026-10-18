import { useState } from 'react'
import type { ApprovalKind, Snapshot, SubtaskSpec } from '@shared/types'
import { moveItem, removeItem } from '@shared/planedit'
import { FLAG_LABEL } from '@shared/delegation'
import { fmtTime } from '../store'
import { NeedBox, ReviewBox } from './Materials'

const KIND: Record<ApprovalKind, string> = {
  'risky-task': '위험 태스크',
  budget: '예산 초과',
  'agent-request': '에이전트 요청',
  plan: '분배 계획',
  failure: '작업 실패',
  'bundle-cap': '실행 상한',
  'stale-bundle': '오래된 묶음'
}

const ACCESS = { read: '읽기만', edit: '파일 수정', exec: '명령 실행' } as const

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
            ) : a.kind === 'failure' ? (
              <div className="row">
                <button className="primary" onClick={() => void window.hive.resolveFailure(a.id, 'retry')}>
                  다른 모델로 다시 시도
                </button>
                <button onClick={() => void window.hive.resolveFailure(a.id, 'skip')}>이 일은 건너뛰고 계속</button>
                <button className="danger" onClick={() => void window.hive.resolveFailure(a.id, 'cancel-all')}>
                  묶음 전체 취소
                </button>
              </div>
            ) : a.kind === 'stale-bundle' ? (
              <div className="row">
                <button className="primary" onClick={() => void window.hive.decideApproval(a.id, 'approved')}>
                  계속 진행
                </button>
                <button className="danger" onClick={() => void window.hive.decideApproval(a.id, 'rejected')}>
                  남은 일 보류
                </button>
              </div>
            ) : a.kind === 'bundle-cap' ? (
              <div className="row">
                <button className="primary" onClick={() => void window.hive.decideApproval(a.id, 'approved')}>
                  상한을 늘려서 계속
                </button>
                <button className="danger" onClick={() => void window.hive.decideApproval(a.id, 'rejected')}>
                  여기서 보류
                </button>
              </div>
            ) : (
              <>
                {t?.result && <pre className="out">{t.result}</pre>}
                <div className="row">
                  {a.kind === 'agent-request' && t?.permission !== 'exec' && (
                    <>
                      {t?.permission !== 'edit' && (
                        <button className="primary" onClick={() => void window.hive.decideApproval(a.id, 'approved', undefined, 'edit')}>
                          권한을 &apos;파일 수정&apos;으로 올리고 이어서
                        </button>
                      )}
                      <button onClick={() => void window.hive.decideApproval(a.id, 'approved', undefined, 'exec')}>
                        &apos;명령 실행&apos;으로 올리고 이어서
                      </button>
                    </>
                  )}
                  <button className={a.kind === 'agent-request' ? '' : 'primary'} onClick={() => void window.hive.decideApproval(a.id, 'approved')}>
                    {a.kind === 'agent-request' ? '권한은 그대로 승인' : '승인'}
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
  const [items, setItems] = useState<SubtaskSpec[]>(plan.items)
  const [human, setHuman] = useState<Set<number>>(new Set())
  const [err, setErr] = useState('')
  const who = (aid: string) => snap.roster.find((r) => r.id === aid)?.name ?? aid
  const edited = JSON.stringify(items) !== JSON.stringify(plan.items) || human.size > 0
  const cap = Math.ceil(plan.estimateRuns * 1.5) + 2
  const set = (i: number, patch: Partial<SubtaskSpec>): void => setItems(items.map((it, k) => (k === i ? { ...it, ...patch } : it)))
  const issues = plan.issues ?? []
  const apply = async (): Promise<void> => {
    try {
      setErr('')
      await window.hive.editPlanApprove(id, items, [...human])
    } catch (e) {
      setErr(String((e as Error).message).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }
  return (
    <div>
      <div className="small">
        예상 AI 실행 <b>{plan.estimateRuns}회</b>
        {plan.estimateParts && (
          <span className="muted">
            {' '}
            (계획·통합 {plan.estimateParts.plan} + 작업 {plan.estimateParts.work} + 검토 {plan.estimateParts.review} + 여유 {plan.estimateParts.buffer})
          </span>
        )}
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
        {items.map((it, i) => {
          const mine = issues.filter((x) => x.index === i && JSON.stringify(plan.items[i]) === JSON.stringify(it))
          return (
            <li key={i} className={human.has(i) ? 'muted' : ''}>
              <div className="row">
                <b className="grow">{it.title}</b>
                <button className="sm ghost" disabled={i === 0} onClick={() => setItems(moveItem(items, i, -1))} title="위로">↑</button>
                <button className="sm ghost" disabled={i === items.length - 1} onClick={() => setItems(moveItem(items, i, 1))} title="아래로">↓</button>
                <button className="sm ghost" onClick={() => { setItems(removeItem(items, i)); setHuman(new Set()) }} title="이 작업 빼기">빼기</button>
                <label className="small row" title="계획에서 빼고 담당 없는 업무로 만들어요">
                  <input type="checkbox" checked={human.has(i)} onChange={(e) => setHuman(new Set(e.target.checked ? [...human, i] : [...human].filter((x) => x !== i)))} />
                  사람이 할 일
                </label>
              </div>
              <div className="row small">
                <select value={it.assignee} onChange={(e) => set(i, { assignee: e.target.value })}>
                  {snap.roster.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                <select value={it.access ?? 'edit'} onChange={(e) => set(i, { access: e.target.value as SubtaskSpec['access'] })}>
                  <option value="read">읽기만</option>
                  <option value="edit">파일 수정</option>
                  <option value="exec">명령 실행</option>
                </select>
                <input className="grow" value={it.done} placeholder="완료 조건" onChange={(e) => set(i, { done: e.target.value })} />
                {it.est ? <span className="muted">약 {it.est}회</span> : null}
              </div>
              {!!it.after.length && <div className="muted small">먼저 끝나야 함: {it.after.join(', ')}번</div>}
              {mine.map((x) => (
                <div key={x.text} className="warn-text small">
                  ⚠ {x.text}{' '}
                  {x.fix && <button className="sm" onClick={() => set(i, { access: x.fix!.access })}>{ACCESS[x.fix.access]}로 바꾸기</button>}
                </div>
              ))}
              <div className="muted small">담당: {who(it.assignee)} · {ACCESS[it.access ?? 'edit']}</div>
            </li>
          )
        })}
      </ol>
      {err && <div className="warn-text small">{err}</div>}
      <input
        className="grow"
        placeholder="반려할 때 이유 (담당 관리자에게 전달돼요)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="row">
        {edited ? (
          <button className="primary" onClick={() => void apply()}>
            고쳐서 승인 (AI 재실행 없음)
          </button>
        ) : (
          <>
            <button className="primary" disabled={issues.length > 0} title={issues.length ? '할 수 없는 작업이 있어요. 빼거나 고쳐 주세요' : ''} onClick={() => void window.hive.decideApproval(id, 'approved', undefined, undefined, cap)}>
              {`최대 ${cap}회로 승인`}
            </button>
            <button disabled={issues.length > 0} onClick={() => void window.hive.decideApproval(id, 'approved')}>상한 없이 진행</button>
          </>
        )}
        <button className="danger" disabled={!note.trim()} onClick={() => void window.hive.decideApproval(id, 'rejected', note)}>
          반려 (다시 계획)
        </button>
      </div>
    </div>
  )
}
