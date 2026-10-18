import { Hint } from './Help'
import { useMemo, useRef, useState } from 'react'
import type { LiveSummary, Snapshot, Task } from '@shared/types'
import { BubbleHold, bubbleFor, type Bubble } from '@shared/bubble'
import { employeeState, progressOf, STATE_LABEL, type EmployeeState } from '@shared/office'
import { jobLabel } from '@shared/company'
import { fmtElapsed, useNow } from '../store'
import TaskDetail from './TaskDetail'

export type BoardView = 'office' | 'status' | 'list'

const JOB_FACE: Record<string, string> = {
  ceo: '🎩',
  coo: '👔',
  lead: '🧑‍💼',
  plan: '🧭',
  build: '🧑‍💻',
  review: '🧐',
  qa: '🔍',
  docs: '📝',
  research: '🔬',
  ops: '🛠️'
}

/** A stable colour per person (from the name). */
function colorOf(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return `hsl(${h} 55% 55%)`
}

/** States that are shown on the floor: working, and the stops a person should know about. */
const SHOWN: EmployeeState[] = ['working', 'reviewing', 'waiting-approval', 'waiting-input', 'limit', 'error']

type Sel = { kind: 'task'; id: string } | null

export function ViewSwitch({ view, setView }: { view: BoardView; setView: (v: BoardView) => void }): JSX.Element {
  const b = (v: BoardView, label: string): JSX.Element => (
    <button className={view === v ? 'on' : ''} onClick={() => setView(v)}>
      {label}
    </button>
  )
  return (
    <div className="seg">
      {b('office', '오피스')}
      {b('status', '작업 현황')}
      {b('list', '목록')}
    </div>
  )
}

/** v5: who is working right now, saying what they do in a speech bubble; the progress of the work on the right. */
export default function WorkStatus({
  snap,
  live,
  onGoAgents,
  view,
  setView
}: {
  snap: Snapshot
  live: Record<string, LiveSummary>
  onGoAgents?: () => void
  view: BoardView
  setView: (v: BoardView) => void
}): JSX.Element {
  const now = useNow(true)
  const hold = useRef(new BubbleHold(1500))
  const [sel, setSel] = useState<Sel>(null)
  const [showIdle, setShowIdle] = useState(false)
  const nameOf = (id: string | null): string => (id ? snap.roster.find((r) => r.id === id)?.name ?? id : '미배정')
  const tasks = snap.tasks
  const people = useMemo(
    () =>
      snap.roster.map((r) => {
        const v = employeeState(r.id, tasks, snap.approvals, snap.running, !!snap.limits[r.adapter])
        return { r, v }
      }),
    [snap, tasks]
  )
  const shown = people.filter((p) => SHOWN.includes(p.v.state))
  const resting = people.filter((p) => !SHOWN.includes(p.v.state))

  const bubbleOf = (p: (typeof people)[number]): Bubble => {
    const t = p.v.task
    const sum = t ? live[t.id] ?? snap.live[t.id] : undefined
    const b = bubbleFor({
      state: p.v.state,
      task: t,
      lastKind: sum?.lastKind,
      last: sum?.last,
      nameOf: (id) => nameOf(id),
      limitUntil: snap.limits[p.r.adapter]?.until,
      now
    })
    return { ...b, text: hold.current.next(p.r.id, b.text, now) }
  }

  // the empty floor says why it is empty
  const emptyLine = (): string => {
    const limited = people.filter((p) => snap.limits[p.r.adapter])
    if (people.length && limited.length === people.length) {
      const first = Object.values(snap.limits)
        .map((l) => l.until)
        .sort()[0]
      return `모두 한도 대기 — 가장 빠른 복귀 ${first ? new Date(first).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '-'}`
    }
    const todo = tasks.filter((t) => t.status === 'todo' && !t.hidden).length
    if (todo && !snap.config.autoRun) return `일하는 직원 없음 — 할 일 ${todo}건 (내 업무 자동 실행 꺼짐)`
    if (todo) return `일하는 직원 없음 — 할 일 ${todo}건이 차례를 기다려요`
    return '일하는 직원 없음 — 이사회 입력이나 목록에서 일을 맡겨 보세요'
  }

  // the progress side bar: working → waiting (approval, question, limit) → just finished (10 minutes, faded)
  const rows = useMemo(() => {
    const visible = tasks.filter((t) => !t.hidden)
    const group = (t: Task): number => {
      if (t.status === 'running' || snap.running.includes(t.id) || t.status === 'in_review' || (t.status === 'delegated' && !t.parentId)) return 0
      if (t.status === 'awaiting_approval' || t.status === 'needs_input' || t.limitWait || snap.approvals.some((a) => a.status === 'pending' && a.taskId === t.id)) return 1
      if ((t.status === 'done' || t.status === 'needs_review') && t.finishedAt && now - new Date(t.finishedAt).getTime() < 10 * 60_000) return 2
      return -1
    }
    return visible
      .map((t) => ({ t, g: group(t) }))
      .filter((x) => x.g >= 0)
      .sort((a, b) => a.g - b.g || (b.t.startedAt ?? '').localeCompare(a.t.startedAt ?? ''))
  }, [tasks, snap.running, snap.approvals, now])

  const selected = sel?.kind === 'task' ? tasks.find((t) => t.id === sel.id) : undefined

  return (
    <div className="page work-status">
      <header className="page-head">
        <h1>작업 현황</h1>
        <ViewSwitch view={view} setView={setView} />
      </header>
      <Hint id="board">맡긴 일은 여기서 봐요. <b>오피스</b>는 직원들의 모습, <b>작업 현황</b>은 지금 하는 일과 진행 막대, <b>목록</b>은 상태별 카드예요. 새 일은 입력칸에 평소 말하듯 적으면 누구에게 맡길지 앱이 정해요.</Hint>
      <div className="ws-grid">
        <section className="ws-floor">
          {!shown.length && <div className="ws-empty">{emptyLine()}</div>}
          <div className="ws-people">
            {shown.map((p) => {
              const b = bubbleOf(p)
              return (
                <button
                  key={p.r.id}
                  className={`ws-person st-${p.v.state}`}
                  onClick={() => p.v.task && setSel({ kind: 'task', id: p.v.task.id })}
                  title={`${p.r.name} · ${STATE_LABEL[p.v.state]}${p.v.task ? ` · ${p.v.task.title}` : ''}`}
                >
                  <div className={`ws-bubble tone-${b.tone}`} key={b.text}>
                    {b.text}
                  </div>
                  <div className="ws-avatar" style={{ background: colorOf(p.r.name) }}>
                    <span className="ws-face">{JOB_FACE[p.r.job ?? ''] ?? '🙂'}</span>
                    <span className="ws-prop" aria-hidden>
                      {p.v.state === 'reviewing' ? '🔎' : p.v.state === 'waiting-approval' || p.v.state === 'waiting-input' ? '✋' : p.v.state === 'limit' ? 'z z' : p.v.state === 'error' ? '!' : '⌨'}
                    </span>
                  </div>
                  <div className="ws-name">
                    {p.r.name}
                    <span className="muted small"> {jobLabel(p.r.job)}</span>
                  </div>
                </button>
              )
            })}
          </div>
          {!!resting.length && (
            <div className="ws-rest">
              <button className="sm ghost" onClick={() => setShowIdle(!showIdle)}>
                쉬는 직원 {resting.length}명 {showIdle ? '접기' : '펼치기'}
              </button>
              {showIdle && (
                <div className="chips">
                  {resting.map((p) => (
                    <span key={p.r.id} className="chip">
                      {JOB_FACE[p.r.job ?? ''] ?? '🙂'} {p.r.name} · {STATE_LABEL[p.v.state]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
        <aside className="ws-side">
          {selected ? (
            <TaskDetail
              embedded
              snap={snap}
              task={selected}
              assigneeName={nameOf(selected.assignee)}
              workDir={snap.config.agents.find((a) => a.id === selected.assignee)?.workDir || ''}
              adapter={snap.roster.find((r) => r.id === selected.assignee)?.adapter}
              onGoAgents={onGoAgents}
              onClose={() => setSel(null)}
            />
          ) : (
            <>
              <h2 className="sec">진행 상황</h2>
              {!rows.length && <div className="empty">진행 중인 일이 없어요.</div>}
              {rows.map(({ t, g }) => {
                const pr = progressOf(t, tasks, { ...snap.live, ...live })
                const kids = tasks.filter((x) => x.parentId === t.id && !x.hidden)
                const ho = t.handoffs?.length ? t.handoffs[t.handoffs.length - 1] : undefined
                return (
                  <button key={t.id} className={'ws-row' + (g === 2 ? ' faded' : '')} onClick={() => setSel({ kind: 'task', id: t.id })}>
                    <div className="ws-row-top">
                      <b>{t.title}</b>
                      <span className="muted small">{t.startedAt && g === 0 ? fmtElapsed(now - new Date(t.startedAt).getTime()) : ''}</span>
                    </div>
                    <div className="muted small">
                      {nameOf(t.assignee)}
                      {ho && ` · ${nameOf(ho.from)} → ${nameOf(ho.to)} (${ho.reason === 'limit' ? '한도' : '넘김'})`}
                      {g === 1 && (t.limitWait ? ' · 한도 대기' : t.status === 'needs_input' ? ' · 자료 대기' : ' · 결재 대기')}
                      {g === 2 && ' · 방금 끝남'}
                    </div>
                    <div className="ws-bar" title={kids.length ? `하위 업무 ${kids.filter((k) => k.status === 'done').length}/${kids.length}` : `${Math.round(pr * 100)}%`}>
                      <i style={{ width: `${Math.round(pr * 100)}%` }} />
                    </div>
                    {kids.length > 0 && (
                      <div className="muted small">
                        하위 업무 {kids.filter((k) => k.status === 'done').length}/{kids.length}
                      </div>
                    )}
                  </button>
                )
              })}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
