import { useState } from 'react'
import type { RunRecord, Snapshot, Task } from '@shared/types'

/** Web page by address: the app reads it and attaches the text (any AI can use it). */
export function UrlAttach({ task }: { task: Task }): JSX.Element {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const go = async (): Promise<void> => {
    if (!url.trim()) return
    setBusy(true)
    setMsg('')
    try {
      const r = await window.hive.attachUrl(task.id, url.trim())
      setMsg(r.errors.length ? r.errors.join(' / ') : `첨부했어요: ${r.attached.map((a) => a.name).join(', ')}`)
      if (!r.errors.length) setUrl('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="row">
      <input className="grow" placeholder="웹페이지 주소를 붙이면 앱이 읽어서 글만 첨부해요 (https://…)" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void go()} />
      <button disabled={busy || !url.trim()} onClick={() => void go()}>
        {busy ? '가져오는 중…' : '웹페이지 가져오기'}
      </button>
      {msg && <span className="small">{msg}</span>}
    </div>
  )
}

const CHECKS = { pending: '검사 중', pass: '통과', fail: '실패', none: '검사 없음' } as const

/** External connections of one task: which ones it may use, a request it waits for, and its GitHub branch / PR. */
export function TaskExternal({ snap, task, goApprovals }: { snap: Snapshot; task: Task; goApprovals?: () => void }): JSX.Element | null {
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const conns = snap.ext.connections.filter((c) => c.kind !== 'github')
  const gh = task.github
  const project = snap.projects.find((p) => p.id === task.projectId)
  const waiting = task.waitingExternal ? snap.approvals.find((a) => a.id === task.waitingExternal) : undefined
  if (!conns.length && !gh && !project?.github && !waiting) return null
  const run = async (key: string, fn: () => Promise<string>): Promise<void> => {
    setBusy(key)
    setMsg('')
    try {
      setMsg(await fn())
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const chosen = task.connections ?? conns.map((c) => c.id)
  const toggle = (id: string, on: boolean): void => {
    const next = on ? [...new Set([...chosen, id])] : chosen.filter((x) => x !== id)
    void window.hive.updateTask(task.id, { connections: next.length === conns.length ? undefined : next })
  }
  return (
    <>
      <h2 className="sec">외부 연결</h2>
      {waiting && (
        <div className="panel warn-box">
          <b>결재 대기</b> · {waiting.reason}
          <div className="row">
            <span className="muted small">AI가 답을 기다리며 멈춰 있어요.</span>
            {goApprovals && (
              <button className="sm primary" onClick={goApprovals}>
                결재함 열기
              </button>
            )}
          </div>
        </div>
      )}
      {!!conns.length && (
        <div className="row">
          <span className="muted small">이번 업무에 쓸 연결</span>
          {conns.map((c) => (
            <label key={c.id} className="toggle">
              <input type="checkbox" checked={chosen.includes(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} /> {c.name}
            </label>
          ))}
          <span className="muted small">(직원 권한 안에서만 써요)</span>
        </div>
      )}
      {(gh || project?.github) && (
        <div className="panel">
          <div className="small">
            <b>GitHub</b> {gh?.repo ?? project?.github?.repo}
            {gh?.branch && (
              <>
                {' '}
                · 브랜치 <code>{gh.branch}</code>
              </>
            )}
            {gh?.issue && (
              <>
                {' '}
                ·{' '}
                <a href="#" onClick={(e) => (e.preventDefault(), void window.hive.openUrl(gh.issue!.url))}>
                  이슈 #{gh.issue.number}
                </a>
              </>
            )}
          </div>
          {!gh?.branch && <div className="muted small">실행하면 이 업무의 브랜치를 만들어 그 안에서 일해요.</div>}
          {gh?.pr && (
            <div className="small">
              <a href="#" onClick={(e) => (e.preventDefault(), void window.hive.openUrl(gh.pr!.url))}>
                PR #{gh.pr.number}
              </a>{' '}
              · {gh.pr.state === 'open' ? '열림' : gh.pr.state === 'merged' ? '합쳐짐' : '닫힘'}
              {gh.checks && (
                <>
                  {' '}
                  · CI <span className={gh.checks.state === 'fail' ? 'warn-text' : ''}>{CHECKS[gh.checks.state]}</span>
                  {!!gh.checks.failing.length && ` (${gh.checks.failing.join(', ')})`}
                </>
              )}
            </div>
          )}
          <div className="row">
            {gh?.branch && !gh.pr && task.status === 'done' && (
              <button disabled={busy === 'pr'} onClick={() => void run('pr', async () => ((await window.hive.openTaskPr(task.id)) ? 'PR을 만들었어요.' : 'PR을 만들지 못했어요. 타임라인을 보세요.'))}>
                브랜치 올리고 PR 만들기
              </button>
            )}
            {gh?.pr?.state === 'open' && (
              <button
                className="primary"
                disabled={busy === 'merge' || (gh.checks?.state !== 'pass' && gh.checks?.state !== 'none')}
                title={gh.checks?.state === 'pass' || gh.checks?.state === 'none' ? '' : 'CI 검사가 통과해야 합칠 수 있어요'}
                onClick={() => confirm(`PR #${gh.pr!.number}을 ${project?.github?.base ?? 'main'}에 합칠까요?`) && void run('merge', async () => (await window.hive.mergeTaskPr(task.id)).message)}
              >
                머지
              </button>
            )}
            {gh?.checks?.state === 'fail' && gh.pr?.state === 'open' && (
              <button onClick={() => void run('fix', async () => ((await window.hive.fixCi(task.id)) ? '실패한 검사를 지시로 넣고 다시 실행해요.' : '고칠 실패가 없어요.'))}>실패 고치기</button>
            )}
            {gh?.pr && (
              <button className="ghost" disabled={busy === 'poll'} onClick={() => void run('poll', async () => (await window.hive.githubPoll(), '새로 고쳤어요.'))}>
                PR 상태 새로 고침
              </button>
            )}
          </div>
          {msg && <div className="small">{msg}</div>}
        </div>
      )}
    </>
  )
}

/** What a run read on the web and did in other apps (the latter cannot be undone by HiveDesk). */
export function RunExternal({ record }: { record: RunRecord }): JSX.Element | null {
  const [saved, setSaved] = useState<string[]>([])
  if (!record.sources?.length && !record.external?.length) return null
  return (
    <div className="panel">
      {!!record.sources?.length && (
        <>
          <h3>참고한 출처</h3>
          <ul className="mat-list">
            {record.sources.map((u) => (
              <li key={u}>
                <a href="#" onClick={(e) => (e.preventDefault(), void window.hive.openUrl(u))}>
                  {u}
                </a>
                <button className="sm ghost" disabled={saved.includes(u)} onClick={() => void window.hive.saveSource(u).then(() => setSaved([...saved, u]))}>
                  {saved.includes(u) ? '저장함' : '메모리로 저장'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!!record.external?.length && (
        <>
          <h3>외부 작업 {record.external.length}건 (되돌릴 수 없어요)</h3>
          <ul className="mat-list">
            {record.external.map((e) => (
              <li key={e.id}>
                <span>
                  {e.connectionName} · {e.summary}
                </span>
                <span className="muted small">{e.outcome === 'auto' ? '자동' : `승인: ${e.by ?? ''}`}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** v5: who the task went through when connections ran out, and [다른 직원에게 넘기기] for a person. */
export function HandoffPanel({ snap, task }: { snap?: Snapshot; task: Task }): JSX.Element | null {
  const [opts, setOpts] = useState<Awaited<ReturnType<typeof window.hive.handoffOptions>> | null>(null)
  const [msg, setMsg] = useState('')
  const name = (id: string): string => snap?.roster.find((r) => r.id === id)?.name ?? id
  const movable = !['running', 'done', 'cancelled', 'delegated', 'in_review'].includes(task.status)
  const lim = task.limitWait && snap?.limits[task.limitWait.adapter]
  if (!task.handoffs?.length && !movable && !lim) return null
  return (
    <>
      <h2 className="sec">담당 넘기기</h2>
      {lim && (
        <div className="warn-text small">
          한도 대기 — {task.limitWait!.adapter} 연결이 {new Date(lim.until).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          {lim.guessed ? '쯤(추정)' : ''}에 풀려요. 이어받을 다른 연결의 직원이 생기면 넘겨요.
        </div>
      )}
      {!!task.handoffs?.length && (
        <ul className="mat-list">
          {task.handoffs.map((h, i) => (
            <li key={i}>
              <span>
                {name(h.from)} → {name(h.to)} ({h.reason === 'limit' ? '한도' : '사람이 넘김'})
              </span>
              <span className="muted small">
                {new Date(h.at).toLocaleString('ko-KR', { hour12: false })}
                {Math.abs(h.costX - 1) >= 0.15 ? ` · 사용량 약 ${h.costX}배` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {movable && (
        <div className="row">
          {!opts ? (
            <button onClick={() => void window.hive.handoffOptions(task.id).then(setOpts)}>다른 직원에게 넘기기</button>
          ) : (
            <>
              {opts.map((o) => (
                <button
                  key={o.agentId}
                  className="sm"
                  disabled={!!o.why}
                  title={o.why ?? ''}
                  onClick={async () => {
                    setMsg('')
                    try {
                      await window.hive.handOver(task.id, o.agentId)
                      setOpts(null)
                      setMsg(`${o.name}에게 넘겼어요. 지금까지 한 것을 요약해 넘겨요.`)
                    } catch (e) {
                      setMsg((e as Error).message)
                    }
                  }}
                >
                  {o.name} · {o.label}
                  {Math.abs(o.costX - 1) >= 0.15 ? ` · 약 ${Math.round(o.costX * 10) / 10}배` : ''}
                  {o.why ? ` (${o.why})` : ''}
                </button>
              ))}
              {!opts.length && <span className="muted small">넘길 수 있는 직원이 없어요.</span>}
              <button className="sm ghost" onClick={() => setOpts(null)}>
                닫기
              </button>
            </>
          )}
        </div>
      )}
      {msg && <div className="small">{msg}</div>}
    </>
  )
}
