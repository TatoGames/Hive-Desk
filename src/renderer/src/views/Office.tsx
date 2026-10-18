import Bundles, { useBundles } from './Bundles'
import { AutoSwitches, TaskControls } from './Controls'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LiveSummary, RosterEntry, Snapshot, Task, TaskStatus } from '@shared/types'
import type { OrgUnit, Seat } from '@shared/company'
import { modelLabel } from '@shared/company'
import { STATE_COLOR, STATE_LABEL, delegationTrees, employeeState, handoffs, progressOf, type EmployeeView, type TreeNode } from '@shared/office'
import { fmtTime } from '../store'
import TaskDetail from './TaskDetail'

type Zoom = 'summary' | 'unit' | 'person'

const STATUS: Record<TaskStatus, string> = {
  todo: '할 일',
  awaiting_approval: '승인 대기',
  needs_input: '자료 요청',
  running: '실행 중',
  needs_review: '사람 확인',
  in_review: '교차 검토',
  delegated: '위임 진행',
  done: '완료',
  failed: '실패',
  held: '보류',
  cancelled: '취소됨'
}
const KIND: Record<string, string> = { plan: '계획', review: '검토', integrate: '통합', work: '', committee: '위원회' }

const pct = (p: number): string => Math.round(p * 100) + '%'

function Bar({ p }: { p: number }): JSX.Element {
  return (
    <div className="pbar" title={pct(p)}>
      <div style={{ width: pct(Math.max(0, Math.min(1, p))) }} />
    </div>
  )
}

function elapsed(from?: string): string {
  if (!from) return ''
  const s = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000))
  return s < 60 ? `${s}초` : s < 3600 ? `${Math.floor(s / 60)}분` : `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`
}

interface Person {
  seat?: Seat
  agent?: RosterEntry
  view?: EmployeeView
  progress: number
}

export default function Office({
  snap,
  live,
  onGoAgents,
  view,
  setView
}: {
  snap: Snapshot
  live: Record<string, LiveSummary>
  onGoAgents?: () => void
  view: 'office' | 'list'
  setView: (v: 'office' | 'list') => void
}): JSX.Element {
  const [zoom, setZoom] = useState<Zoom>('person')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<string | null>(null)
  const [assign, setAssign] = useState<{ agent?: RosterEntry; unit?: OrgUnit } | null>(null)
  const [msg, setMsg] = useState('')
  const [boardTitle, setBoardTitle] = useState('')
  const [, setTick] = useState(0)
  const [feed, setFeed] = useState<{ at: string; taskId: string; taskTitle: string; actor: string; text: string }[]>([])
  const wrap = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<{ d: string; key: string }[]>([])

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 20_000)
    return () => clearInterval(t)
  }, [])

  const stamp = snap.tasks.reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), '')
  useEffect(() => {
    let live = true
    void window.hive.officeFeed().then((f) => live && setFeed(f))
    return () => {
      live = false
    }
  }, [stamp, snap.running.length])

  const company = snap.company
  const units = company.units
  const rankName = (id: string): string => company.company?.ranks.find((r) => r.id === id)?.name ?? ''

  const person = (agent: RosterEntry | undefined, seat?: Seat): Person => {
    if (!agent) return { seat, progress: 0 }
    const v = employeeState(agent.id, snap.tasks, snap.approvals, snap.running, !!snap.limits[agent.adapter])
    return { seat, agent, view: v, progress: v.task ? progressOf(v.task, snap.tasks, live) : 0 }
  }

  const seatsOf = (unitId: string): Seat[] => company.seats.filter((s) => s.unitId === unitId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const childrenOf = (id: string | null): OrgUnit[] => units.filter((u) => (u.parentId ?? null) === id).sort((a, b) => a.order - b.order)
  const seated = new Set(company.seats.map((s) => s.agentId).filter(Boolean))
  const unseated = snap.roster.filter((r) => !seated.has(r.id))

  const unitStats = (u: OrgUnit): { people: number; busy: number; progress: number | null } => {
    const all: OrgUnit[] = []
    const walk = (x: OrgUnit): void => {
      all.push(x)
      childrenOf(x.id).forEach(walk)
    }
    walk(u)
    const ps = all.flatMap((x) => seatsOf(x.id)).map((s) => person(snap.roster.find((r) => r.id === s.agentId), s))
    const withAgent = ps.filter((p) => p.agent)
    const open = withAgent.flatMap((p) => (p.view?.task ? [p.view.task] : []))
    return {
      people: withAgent.length,
      busy: withAgent.filter((p) => p.view && ['working', 'reviewing'].includes(p.view.state)).length,
      progress: open.length ? open.reduce((n, t) => n + progressOf(t, snap.tasks, live), 0) / open.length : null
    }
  }

  // lines from the one who handed work over to the one who got it
  const hand = useMemo(() => handoffs(snap.tasks), [snap.tasks])
  useLayoutEffect(() => {
    const root = wrap.current
    if (!root) return
    const draw = (): void => {
      const box = root.getBoundingClientRect()
      const pos = (id: string): { x: number; y: number } | null => {
        const el = root.querySelector(`[data-emp="${CSS.escape(id)}"]`)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 }
      }
      const next = hand.flatMap((h) => {
        const a = pos(h.from)
        const b = pos(h.to)
        if (!a || !b) return []
        const mx = (a.x + b.x) / 2
        return [{ key: h.taskId, d: `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}` }]
      })
      setLines(next)
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(root)
    return () => ro.disconnect()
  }, [hand, collapsed, zoom, snap.roster.length, snap.company.seats.length])

  const isOpen = (id: string): boolean => (zoom === 'summary' ? collapsed.has('open:' + id) : !collapsed.has(id))
  const toggle = (id: string): void => {
    const k = zoom === 'summary' ? 'open:' + id : id
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }

  const card = (p: Person, key: string): JSX.Element => {
    const { agent, seat, view: v } = p
    const state = v?.state ?? 'idle'
    const model = agent ? company.catalog.find((m) => m.id === agent.modelId) : undefined
    const startedAt = v?.task ? live[v.task.id]?.startedAt : undefined
    const local = agent ? snap.config.agents.find((a) => a.id === agent.id) : undefined
    const runs = agent ? snap.usage[agent.id]?.runs ?? 0 : 0
    if (zoom === 'unit') {
      return (
        <span
          key={key}
          data-emp={agent?.id}
          className="chip-emp"
          title={`${agent?.name ?? seat?.title} — ${STATE_LABEL[state]}${v?.task ? ': ' + v.task.title : ''}`}
          onClick={() => v?.task && setDetail(v.task.id)}
        >
          <i style={{ background: agent ? STATE_COLOR[state] : '#555' }} />
          {agent?.name ?? seat?.title}
        </span>
      )
    }
    return (
      <div
        key={key}
        data-emp={agent?.id}
        className={'emp' + (agent ? '' : ' vacant')}
        onDragOver={(e) => agent && e.dataTransfer.types.includes('text/task-id') && e.preventDefault()}
        onDrop={async (e) => {
          const id = e.dataTransfer.getData('text/task-id')
          if (!id || !agent) return
          e.preventDefault()
          try {
            await window.hive.reassignTask(id, agent.id)
            setMsg('')
          } catch (err) {
            setMsg(String((err as Error).message).replace(/^Error invoking remote method '[^']+': Error: /, ''))
          }
        }}
      >
        <div className="emp-top">
          <b>{agent?.name ?? seat?.title ?? '?'}</b>
          {agent && <span className="state" style={{ background: STATE_COLOR[state] }}>{STATE_LABEL[state]}</span>}
        </div>
        <div className="muted small">
          {seat ? `${rankName(seat.rankId)} · ${seat.title}` : agent?.role || ''}
        </div>
        <div className="small">
          {agent ? (
            <span className="tag" title={model ? model.company : agent.adapter}>
              <span className="ico">{(model?.company ?? agent.adapter).slice(0, 1).toUpperCase()}</span>{' '}
              {model ? modelLabel(model) : agent.model ?? 'CLI 기본값'}
            </span>
          ) : (
            <span className="muted">빈 자리</span>
          )}
        </div>
        {v?.task && (
          <div className="emp-task" onClick={() => setDetail(v.task!.id)} title="업무 열기">
            <div className="small">
              {KIND[v.task.kind ?? 'work'] && <span className="tag">{KIND[v.task.kind ?? 'work']}</span>} {v.task.title}
            </div>
            <Bar p={p.progress} />
            <div className="muted small">
              {pct(p.progress)}
              {startedAt && ` · ${elapsed(startedAt)} 경과`}
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <TaskControls task={v.task} compact />
            </div>
          </div>
        )}
        {!!v?.queued.length && (
          <div className="queue">
            {v.queued.slice(0, 3).map((t) => (
              <span key={t.id} className="qchip" draggable onDragStart={(e) => e.dataTransfer.setData('text/task-id', t.id)} title="다른 직원 카드로 끌어다 놓으면 다시 맡겨요">
                {t.title.slice(0, 18)}
              </span>
            ))}
            {v.queued.length > 3 && <span className="muted small">+{v.queued.length - 3}</span>}
          </div>
        )}
        {agent && (
          <div className="row between small">
            <span className="muted">
              오늘 {runs}회{local ? ` / ${local.dailyRunLimit}` : ''}
            </span>
            <button className="sm" onClick={() => setAssign({ agent })}>
              일 맡기기
            </button>
          </div>
        )}
      </div>
    )
  }

  const renderUnit = (u: OrgUnit, depth: number): JSX.Element => {
    const st = unitStats(u)
    const open = isOpen(u.id)
    const seats = seatsOf(u.id)
    const lead = seats.find((s) => s.job === 'lead')
    return (
      <div key={u.id} className="ofc-unit" style={{ marginLeft: depth ? 14 : 0 }}>
        <div className="ofc-head">
          <button className="ghost sm" onClick={() => toggle(u.id)}>
            {open ? '▼' : '▶'}
          </button>
          <b>{u.name}</b> <span className="muted small">{u.kind}</span>
          <span className="small">
            바쁜 {st.busy}/{st.people}명
          </span>
          {st.progress !== null && (
            <span className="grow">
              <Bar p={st.progress} />
            </span>
          )}
          {lead?.agentId && (
            <button className="sm ghost" onClick={() => setAssign({ unit: u })}>
              부서에 맡기기
            </button>
          )}
        </div>
        {open && (
          <>
            <div className={zoom === 'unit' ? 'chips' : 'emps'}>{seats.map((s) => card(person(snap.roster.find((r) => r.id === s.agentId), s), s.id))}</div>
            {childrenOf(u.id).map((c) => renderUnit(c, depth + 1))}
          </>
        )}
      </div>
    )
  }

  /** Management words ("전부 멈춰") are not jobs: ask before turning them into one. */
  const manage = async (): Promise<boolean> => {
    const c = await window.hive.classifyInput(boardTitle)
    if (c.kind === 'task') return false
    if (window.confirm(`"${c.command}" 은(는) 관리 명령 같아요.\n\n[확인] 모든 실행을 멈추고 자동 실행을 꺼요 (비상 정지)\n[취소] 그대로 두고 입력을 고쳐요`)) {
      await window.hive.emergencyStop()
      setBoardTitle(c.rest)
      setMsg('비상 정지했어요.' + (c.rest ? ' 남은 입력은 업무로 접수할 수 있어요.' : ''))
    }
    return true
  }

  const [qp, setQp] = useState<{ title: string; pv: Awaited<ReturnType<typeof window.hive.quickPreview>> } | null>(null)
  const [qWho, setQWho] = useState('')
  const bundles = useBundles(snap).filter((b) => b.remaining > 0)
  const [older, setOlder] = useState<string | null>(null)
  /** A new bundle while older ones still have work left: ask what to do with them first. */
  const toOrganisation = async (title: string, ignoreOlder = false): Promise<void> => {
    if (!ignoreOlder && bundles.length) {
      setOlder(title)
      return
    }
    await window.hive.createTask({ title, delegate: true })
    setBoardTitle('')
    setMsg('')
    setOlder(null)
  }
  const errText = (err: unknown): string => String((err as Error).message).replace(/^Error invoking remote method '[^']+': Error: /, '')

  /** Board input: management words first, then "small job → one employee" or "organisation". */
  const submitBoard = async (): Promise<void> => {
    if (!boardTitle.trim()) return
    if (await manage()) return
    try {
      const pv = await window.hive.quickPreview(boardTitle)
      if (pv.pick) {
        setQp({ title: boardTitle, pv })
        setQWho(pv.pick.agentId)
        return
      }
      await toOrganisation(boardTitle)
    } catch (err) {
      setMsg(errText(err))
    }
  }

  const tree = delegationTrees(snap.tasks, live)
  const nameOf = (id: string | null): string => snap.roster.find((r) => r.id === id)?.name ?? (id ? '?' : '미배정')
  const renderNode = (n: TreeNode, depth: number): JSX.Element => (
    <div key={n.task.id}>
      <div className="tnode" style={{ paddingLeft: depth * 14 }} onClick={() => setDetail(n.task.id)}>
        <div className="small">
          {KIND[n.task.kind ?? 'work'] && <span className="tag">{KIND[n.task.kind ?? 'work']}</span>} <b>{n.task.title}</b>
        </div>
        <div className="muted small">
          {nameOf(n.task.assignee)} · {STATUS[n.task.status]} · {pct(n.progress)}
        </div>
        <Bar p={n.progress} />
        <div onClick={(e) => e.stopPropagation()}>
          <TaskControls task={n.task} compact />
        </div>
      </div>
      {n.children.map((c) => renderNode(c, depth + 1))}
    </div>
  )

  const detailTask = detail ? snap.tasks.find((t) => t.id === detail) : undefined
  const topUnits = childrenOf(null)

  return (
    <div className="page office">
      <header className="page-head">
        <h1>오피스</h1>
        <div className="row">
          <div className="seg">
            <button className="on">오피스</button>
            <button onClick={() => setView('list')}>목록</button>
          </div>
          <select value={zoom} onChange={(e) => setZoom(e.target.value as Zoom)} title="확대 단계">
            <option value="summary">회사 요약</option>
            <option value="unit">부서</option>
            <option value="person">개인</option>
          </select>
          <AutoSwitches snap={snap} />
        </div>
      </header>

      <div className="boardbox row">
        <input
          className="grow"
          placeholder="이사회 입력창 — 일을 적으면 총괄 본부장이 받아 조직에 나눠요"
          value={boardTitle}
          onChange={(e) => setBoardTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && boardTitle.trim()) void submitBoard()
          }}
        />
        <button
          className="primary"
          disabled={!boardTitle.trim()}
          onClick={() => void submitBoard()}
        >
          접수
        </button>
      </div>
      {msg && <div className="warn-text small">{msg}</div>}
      {older && (
        <div className="panel quickbox">
          <div className="small">
            아직 끝나지 않은 묶음이 {bundles.length}개 있어요 (남은 작업 {bundles.reduce((n, b) => n + b.remaining, 0)}건). 새 일을 맡기면 이전 묶음의 남은 작업도 계속 돌 수 있어요.
          </div>
          <div className="row">
            <button className="primary" onClick={() => void toOrganisation(older, true).catch((e) => setMsg(errText(e)))}>
              이전 묶음은 그대로 두고 새로 시작
            </button>
            <button
              onClick={async () => {
                for (const b of bundles) await window.hive.cancelTask(b.root.id, { scope: 'pending', files: 'keep' })
                await toOrganisation(older, true).catch((e) => setMsg(errText(e)))
              }}
            >
              이전 묶음의 남은 일을 취소하고 시작
            </button>
            <button className="ghost" onClick={() => setOlder(null)}>닫기</button>
          </div>
        </div>
      )}
      {qp && (
        <div className="panel quickbox">
          <div className="small">{(qp.pv.options.find((o) => o.agentId === qWho) ?? qp.pv.pick!).line}</div>
          <div className="row">
            <button
              className="primary"
              onClick={async () => {
                try {
                  await window.hive.quickAssign({ title: qp.title, agentId: qWho })
                  setBoardTitle('')
                  setMsg('')
                  setQp(null)
                } catch (err) {
                  setMsg(errText(err))
                }
              }}
            >
              이대로 맡기기
            </button>
            <select value={qWho} onChange={(e) => setQWho(e.target.value)} title="다른 사원 고르기">
              {qp.pv.options.map((o) => (
                <option key={o.agentId} value={o.agentId}>
                  {o.name} · {o.label} · 예상 사용량 {o.expectedUsage.toFixed(1)}
                </option>
              ))}
            </select>
            <button
              onClick={async () => {
                try {
                  setQp(null)
                  await toOrganisation(qp.title)
                } catch (err) {
                  setMsg(errText(err))
                }
              }}
            >
              조직에 맡기기
            </button>
            <button className="ghost" onClick={() => setQp(null)}>닫기</button>
          </div>
        </div>
      )}

      <Bundles snap={snap} onOpen={setDetail} />

      <section className="ticker" aria-label="실시간 소식판">
        <b className="small">소식판</b>
        {!feed.length && <span className="muted small"> 아직 소식이 없어요.</span>}
        {feed.slice(0, 6).map((f, i) => (
          <div key={i} className="small" onClick={() => setDetail(f.taskId)}>
            <span className="muted">{fmtTime(f.at)}</span> <b>{f.actor}</b> · {f.taskTitle.slice(0, 24)} — {f.text.slice(0, 90)}
          </div>
        ))}
      </section>

      {!units.length && (
        <div className="panel empty">
          조직도가 아직 없어요. 회사 탭에서 템플릿으로 조직을 만들고 AI를 연결하면 직원 카드가 여기에 보여요.
          {!!snap.roster.length && ' (지금은 배치되지 않은 직원만 아래에 보여요.)'}
        </div>
      )}

      <div className="office-grid">
        <div className="floor" ref={wrap}>
          <svg className="lines" aria-hidden>
            <defs>
              <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
              </marker>
            </defs>
            {lines.map((l) => (
              <path key={l.key} d={l.d} markerEnd="url(#arr)" />
            ))}
          </svg>
          {topUnits.map((u) => renderUnit(u, 0))}
          {!!unseated.length && (
            <div className="ofc-unit">
              <div className="ofc-head">
                <b>자리 미배치 직원</b>
              </div>
              <div className="emps">{unseated.map((r) => card(person(r), r.id))}</div>
            </div>
          )}
          {!snap.roster.length && (
            <div className="panel empty">
              직원이 없어요. <button className="sm" onClick={onGoAgents}>AI 연결하러 가기</button>
            </div>
          )}
        </div>
        <aside className="tree panel">
          <h2>업무 분해 트리</h2>
          <div className="tnode root">
            <b>이사회</b> <span className="muted small">(나)</span>
          </div>
          {!tree.length && <div className="muted small">조직에 위임한 일이 여기에 트리로 보여요.</div>}
          {tree.map((n) => renderNode(n, 1))}
        </aside>
      </div>

      {assign && <AssignDialog snap={snap} target={assign} onClose={() => setAssign(null)} />}
      {detailTask && (
        <TaskDetail
          task={detailTask}
          assigneeName={nameOf(detailTask.assignee)}
          workDir={snap.config.agents.find((a) => a.id === detailTask.assignee)?.workDir || ''}
          adapter={snap.roster.find((r) => r.id === detailTask.assignee)?.adapter}
          onGoAgents={onGoAgents}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

function AssignDialog({ snap, target, onClose }: { snap: Snapshot; target: { agent?: RosterEntry; unit?: OrgUnit }; onClose: () => void }): JSX.Element {
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [project, setProject] = useState('')
  const [delegate, setDelegate] = useState(true)
  const [err, setErr] = useState('')
  const who = target.agent ? target.agent.name : `${target.unit?.name} (팀장·부서장이 나눠요)`
  const go = async (): Promise<void> => {
    try {
      await window.hive.createTask({
        title,
        description: desc,
        assignee: target.agent?.id ?? null,
        unitId: target.unit?.id,
        projectId: project || undefined,
        delegate: target.unit ? true : delegate
      })
      onClose()
    } catch (e) {
      setErr(String((e as Error).message).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>일 맡기기 — {who}</h2>
        <label className="full">
          무엇을 할까요?
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="full">
          자세한 설명 (목표, 완료 조건, 제약)
          <textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
        {!!snap.projects.length && (
          <label className="full">
            프로젝트
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">없음</option>
              {snap.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {target.agent && (
          <label className="toggle full">
            <input type="checkbox" checked={delegate} onChange={(e) => setDelegate(e.target.checked)} />
            조직 규칙대로 진행 (자동 실행, 다른 모델의 교차 검토, 보고서까지)
          </label>
        )}
        {err && <div className="warn-text small">{err}</div>}
        <div className="row end">
          <button onClick={onClose}>취소</button>
          <button className="primary" disabled={!title.trim()} onClick={() => void go()}>
            맡기기
          </button>
        </div>
      </div>
    </div>
  )
}
