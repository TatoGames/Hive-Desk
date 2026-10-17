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

export default function Reports({ snap }: { snap: Snapshot }): JSX.Element {
  const [note, setNote] = useState('')
  const finals = [...snap.company.finals].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    <div className="page">
      <header className="page-head">
        <h1>보고서함</h1>
      </header>
      <p className="muted small">조직이 끝낸 큰 일의 최종 보고서예요. 확인하면 완료, 고칠 점을 적으면 다시 통합해요.</p>
      {!finals.length && <div className="panel empty">아직 보고서가 없어요.</div>}
      {finals.map((r) => {
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
