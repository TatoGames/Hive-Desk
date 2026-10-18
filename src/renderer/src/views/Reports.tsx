import { useState } from 'react'
import type { FinalReport, ReportNode, Snapshot } from '@shared/types'
import { finalReportMarkdown } from '@shared/delegation'
import { fmtTime } from '../store'

function Node({ n, depth }: { n: ReportNode; depth: number }): JSX.Element {
  return (
    <div style={{ marginLeft: depth * 16 }} className="report-node">
      <div>
        <b>{n.title}</b> <span className="muted small">{n.agentName} · {n.model}</span>
        {n.review && <span className="tag">{n.review}</span>}
        {n.status !== 'done' && <span className="tag warn">{n.status}</span>}
      </div>
      {!!n.files.length && (
        <div className="muted small">
          파일 {n.files.length}개: {n.files.slice(0, 5).map((f) => f.path).join(', ')}
          {n.files.length > 5 ? ' …' : ''}
        </div>
      )}
      {n.children.map((c) => (
        <Node key={c.taskId} n={c} depth={depth + 1} />
      ))}
    </div>
  )
}

function download(r: FinalReport): void {
  const url = URL.createObjectURL(new Blob([finalReportMarkdown(r)], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${r.title.replace(/[^\w가-힣-]+/g, '_')}.md`
  a.click()
  URL.revokeObjectURL(url)
}

/** Reports of single tasks (not the big organisation bundles): searchable, each is also a markdown file in the company folder. */
function TaskReports({ snap }: { snap: Snapshot }): JSX.Element {
  const [q, setQ] = useState('')
  const [who, setWho] = useState('')
  const finalIds = new Set(snap.company.finals.map((f) => f.id))
  const list = snap.tasks
    .filter((t) => !t.hidden && !finalIds.has(t.id) && (t.status === 'done' || t.status === 'needs_review') && (t.report || t.result))
    .filter((t) => (!who || t.assignee === who) && (!q.trim() || (t.title + (t.report?.did ?? '')).toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
  const root = snap.companyRoot
  return (
    <>
      <div className="row filters">
        <input className="grow" placeholder="제목·내용 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">모든 담당</option>
          {snap.roster.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        {root && (
          <button onClick={() => void window.hive.openPath(root + '/보고서')} title="보고서 파일이 모인 폴더를 열어요">
            폴더에서 보기
          </button>
        )}
      </div>
      {!list.length && <div className="panel empty">아직 업무 보고서가 없어요. 업무가 끝나면 보고서 파일이 자동으로 만들어져요.</div>}
      {list.map((t) => (
        <section key={t.id} className="panel">
          <div>
            <b>{t.title}</b> {t.status === 'needs_review' && <span className="tag warn">확인 대기</span>}
          </div>
          <div className="muted small">
            {snap.roster.find((r) => r.id === t.assignee)?.name ?? t.assignee} · {fmtTime(t.finishedAt)}
          </div>
          {t.report ? <p className="small">{t.report.did}</p> : <pre className="out">{t.result}</pre>}
          {t.reportFile && root && (
            <div className="row">
              <button className="sm" onClick={() => void window.hive.openPath(root + '/' + t.reportFile!.replace(/\\/g, '/'))}>
                문서로 열기 ({t.reportFile.replace(/^.*[\\/]/, '')})
              </button>
            </div>
          )}
        </section>
      ))}
    </>
  )
}

export default function Reports({ snap }: { snap: Snapshot }): JSX.Element {
  const [tab, setTab] = useState<'final' | 'task'>('final')
  const [note, setNote] = useState('')
  const finals = [...snap.company.finals].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    <div className="page">
      <header className="page-head">
        <h1>보고서함</h1>
        <div className="seg">
          <button className={tab === 'final' ? 'on' : ''} onClick={() => setTab('final')}>최종 보고서</button>
          <button className={tab === 'task' ? 'on' : ''} onClick={() => setTab('task')}>업무 보고서</button>
        </div>
      </header>
      {tab === 'task' && <TaskReports snap={snap} />}
      {tab === 'final' && <p className="muted small">조직이 끝낸 큰 일의 최종 보고서예요. 확인하면 완료, 고칠 점을 적으면 다시 통합해요.</p>}
      {tab === 'final' && !finals.length && <div className="panel empty">아직 보고서가 없어요.</div>}
      {tab === 'final' && finals.map((r) => {
        const task = snap.tasks.find((t) => t.id === r.id)
        const waiting = task?.status === 'needs_review'
        return (
          <section key={r.id} className="panel">
            <div>
              <b>{r.title}</b>{' '}
              {r.decision ? (
                <span className="tag">{r.decision.accepted ? '확인 완료' : '수정 요청'}</span>
              ) : waiting ? (
                <span className="tag warn">확인 대기</span>
              ) : null}
            </div>
            <div className="muted small">
              {fmtTime(r.createdAt)} · 업무 {r.totals.tasks}개 · AI 실행 {r.totals.runs}회 · 파일 {r.totals.files}개
            </div>
            <p>{r.summary}</p>
            <Node n={r.tree} depth={0} />
            {!!r.verification.length && (
              <>
                <h3>확인한 것</h3>
                <ul className="small">{r.verification.map((v, i) => <li key={i}>{v}</li>)}</ul>
              </>
            )}
            {!!r.risks.length && (
              <>
                <h3>남은 위험</h3>
                <ul className="small">{r.risks.map((v, i) => <li key={i}>{v}</li>)}</ul>
              </>
            )}
            <div className="row">
              <button onClick={() => download(r)}>마크다운으로 내보내기</button>
              {waiting && (
                <>
                  <button className="primary" onClick={() => void window.hive.reviewTask(r.id, 'approve')}>
                    확인했어요
                  </button>
                  <input className="grow" placeholder="고칠 점" value={note} onChange={(e) => setNote(e.target.value)} />
                  <button
                    disabled={!note.trim()}
                    onClick={() => {
                      void window.hive.reviewTask(r.id, 'changes', note)
                      setNote('')
                    }}
                  >
                    수정 요청
                  </button>
                </>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
