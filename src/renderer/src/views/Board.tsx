import { useState } from 'react'
import type { AdapterId, LiveSummary, PermissionLevel, Snapshot, Task, TaskStatus } from '@shared/types'
import { fmtTime } from '../store'
import TaskDetail, { ReportView } from './TaskDetail'
import {
  ConfirmButton,
  DropMessages,
  DropZone,
  FailureHint,
  NeedBox,
  ReviewBox,
  PermissionSelect,
  PreflightDialog,
  ProgressStrip,
  sendDropped,
  type Dropped
} from './Materials'

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'todo', label: '할 일' },
  { id: 'awaiting_approval', label: '승인 대기' },
  { id: 'needs_input', label: '자료 요청' },
  { id: 'running', label: '실행 중' },
  { id: 'needs_review', label: '사람 확인' },
  { id: 'done', label: '완료' },
  { id: 'failed', label: '실패' }
]

export default function Board({
  snap,
  output,
  live,
  onGoAgents
}: {
  onGoAgents?: () => void
  snap: Snapshot
  output: Record<string, string>
  live: Record<string, LiveSummary>
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [pre, setPre] = useState<string | null>(null)
  /** The folder a task's agent works in (shown on the card, so it is clear where work happens). */
  const workDirOf = (t: Task): string => {
    const a = snap.config.agents.find((x) => x.id === t.assignee)
    return a?.workDir || snap.config.workspace
  }
  const localIds = new Set(snap.config.agents.map((a) => a.id))
  const nameOf = (id: string | null): string => {
    if (!id) return '미배정'
    const r = snap.roster.find((x) => x.id === id)
    return r ? `${r.name} (${r.owner})` : `${id} (삭제된 에이전트)`
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>태스크 보드</h1>
        <label className="toggle">
          <input
            type="checkbox"
            checked={snap.config.autoRun}
            onChange={(e) => void window.hive.saveSettings({ autoRun: e.target.checked })}
          />
          자동 실행 (내 에이전트에 배정된 준비된 태스크를 차례로 실행)
        </label>
      </header>

      <NewTask snap={snap} />

      <div className="board">
        {COLUMNS.map((col) => {
          const items = snap.tasks.filter((t) => t.status === col.id)
          return (
            <section key={col.id} className={'col col-' + col.id}>
              <h2>
                {col.label} <span className="count">{items.length}</span>
              </h2>
              {items.map((t) => (
                <Card
                  key={t.id}
                  task={t}
                  all={snap.tasks}
                  assigneeName={nameOf(t.assignee)}
                  isLocal={!!t.assignee && localIds.has(t.assignee)}
                  running={snap.running.includes(t.id)}
                  live={output[t.id]}
                  progress={live[t.id]}
                  workDir={workDirOf(t)}
                  waitingFor={snap.tasks.find((x) => x.id === snap.waiting[t.id])?.title}
                  limit={snap.limits[snap.roster.find((r) => r.id === t.assignee)?.adapter ?? '']}
                  adapter={snap.roster.find((r) => r.id === t.assignee)?.adapter}
                  onGoAgents={onGoAgents}
                  onRun={() => setPre(t.id)}
                  expanded={open === t.id}
                  onToggle={() => setOpen(open === t.id ? null : t.id)}
                  onDetail={() => setDetail(t.id)}
                />
              ))}
              {!items.length && <div className="empty">없음</div>}
            </section>
          )
        })}
      </div>

      {pre && snap.tasks.find((t) => t.id === pre) && (
        <PreflightDialog task={snap.tasks.find((t) => t.id === pre)!} onClose={() => setPre(null)} />
      )}

      {detail && snap.tasks.find((t) => t.id === detail) && (
        <TaskDetail
          task={snap.tasks.find((t) => t.id === detail)!}
          assigneeName={nameOf(snap.tasks.find((t) => t.id === detail)!.assignee)}
          workDir={workDirOf(snap.tasks.find((t) => t.id === detail)!)}
          adapter={snap.roster.find((r) => r.id === snap.tasks.find((t) => t.id === detail)!.assignee)?.adapter}
          onGoAgents={onGoAgents}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

function NewTask({ snap }: { snap: Snapshot }): JSX.Element {
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [assignee, setAssignee] = useState('')
  const [risky, setRisky] = useState(false)
  const [dep, setDep] = useState('')
  const [more, setMore] = useState(false)
  const [perm, setPerm] = useState<PermissionLevel | undefined>(undefined)
  const [items, setItems] = useState<Dropped[]>([])
  const [problems, setProblems] = useState<string[]>([])

  const submit = async (): Promise<void> => {
    if (!title.trim()) return
    const t = await window.hive.createTask({
      title,
      description: desc,
      assignee: assignee || null,
      risky,
      dependsOn: dep ? [dep] : [],
      permission: perm
    })
    // materials are copied into the new task's folder (folders become reference folders)
    const errs = items.length ? await sendDropped(t.id, items) : []
    setProblems(errs)
    setTitle('')
    setDesc('')
    setRisky(false)
    setDep('')
    setPerm('edit')
    setItems([])
  }

  return (
    <div className="new-task">
      <div className="row">
        <input
          className="grow"
          placeholder="새 태스크 제목 (예: 로그인 페이지 버그 고치기)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !more && void submit()}
        />
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">담당 에이전트 선택…</option>
          {snap.roster.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {r.owner}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={() => setMore(!more)}>
          {more ? '간단히' : '자세히'}
        </button>
        <button className="primary" onClick={() => void submit()} disabled={!title.trim()}>
          추가
        </button>
      </div>
      {more && (
        <div className="more">
          <textarea
            rows={4}
            placeholder="자세한 설명, 완료 조건, 참고할 파일 등"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="row">
            <span className="muted small">권한</span>
            <PermissionSelect
              value={perm}
              onChange={setPerm}
              adapter={snap.roster.find((r) => r.id === assignee)?.adapter}
            />
          </div>
          <DropZone compact onItems={(added) => setItems((cur) => [...cur, ...added])} />
          {!!items.length && (
            <ul className="mat-list">
              {items.map((it, i) => (
                <li key={i}>
                  <span>{it.path ? it.path.split(/[\\/]/).pop() : it.name}</span>
                  <span className="muted small">{it.path ?? '끌어다 놓은 파일'}</span>
                  <button className="sm ghost" onClick={() => setItems((cur) => cur.filter((_, k) => k !== i))}>
                    빼기
                  </button>
                </li>
              ))}
            </ul>
          )}
          <DropMessages items={problems} />
          <div className="row">
            <label className="toggle">
              <input type="checkbox" checked={risky} onChange={(e) => setRisky(e.target.checked)} />
              위험한 작업 (실행 전 사람 승인 필요)
            </label>
            <select value={dep} onChange={(e) => setDep(e.target.value)}>
              <option value="">선행 태스크 없음</option>
              {snap.tasks
                .filter((t) => t.status !== 'done')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    먼저 끝나야 함: {t.title}
                  </option>
                ))}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}

function Card(props: {
  task: Task
  all: Task[]
  assigneeName: string
  isLocal: boolean
  running: boolean
  live?: string
  progress?: LiveSummary
  workDir: string
  /** Title of the task this one waits for (same work folder). */
  waitingFor?: string
  limit?: { until: string; message: string; guessed: boolean }
  adapter?: AdapterId
  onGoAgents?: () => void
  onRun: () => void
  expanded: boolean
  onToggle: () => void
  onDetail: () => void
}): JSX.Element {
  const { task: t, all } = props
  const blockedBy = t.dependsOn
    .map((d) => all.find((x) => x.id === d))
    .filter((x): x is Task => !!x && x.status !== 'done')

  return (
    <article className={'card' + (props.expanded ? ' open' : '')}>
      <div className="card-top" onClick={props.onToggle}>
        <div className="title">
          {t.risky && <span className="tag warn">위험</span>}
          {t.title}
        </div>
        <div className="meta">
          {props.assigneeName}
          {!props.isLocal && t.assignee && !props.assigneeName.endsWith('(삭제된 에이전트)') && (
            <span className="tag">팀원</span>
          )}
        </div>
        {!!blockedBy.length && (
          <div className="meta small">⏳ 대기: {blockedBy.map((b) => b.title).join(', ')}</div>
        )}
        {props.running && props.progress && <ProgressStrip s={props.progress} />}
        {props.running && !props.progress && props.waitingFor && (
          <div className="meta small wait">⏳ 폴더 대기: "{props.waitingFor}" 작업이 같은 폴더에서 끝나길 기다려요</div>
        )}
        {t.interruptedRun && !props.running && (
          <div className="meta small warn-text">⚠ 중단됨: 일부 변경이 폴더에 남았을 수 있어요</div>
        )}
        {props.limit && t.status === 'todo' && !props.running && (
          <div className="meta small wait">
            ⏸ 한도 대기: {new Date(props.limit.until).toLocaleString('ko-KR', { hour12: false })}
            {props.limit.guessed ? '쯤(추정)' : ''}까지 자동 실행을 쉬어요
          </div>
        )}
        {t.status === 'needs_input' && t.question && <div className="meta small need-q">❓ {t.question}</div>}
      </div>

      {props.expanded && (
        <div className="card-body">
          {t.description && <p className="desc">{t.description}</p>}
          {!!t.notes.length && (
            <ul className="notes">
              {t.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <div className="meta small where">
            <span title={props.workDir}>📂 {props.workDir}</span>
            <button className="sm ghost" onClick={() => void window.hive.openPath(props.workDir)}>
              폴더 열기
            </button>
          </div>
          {t.status === 'needs_input' && <NeedBox task={t} />}
          {props.running && !props.progress && !props.waitingFor && <pre className="out live">{props.live || '시작하는 중…'}</pre>}
          {props.running && props.progress && props.live && <pre className="out live small-log">{props.live.slice(-1200)}</pre>}
          {!props.running && t.report && <ReportView report={t.report} />}
          {!props.running && t.result && <pre className="out">{t.result}</pre>}
          {t.status === 'needs_review' && <ReviewBox task={t} />}
          <FailureHint task={t} onGoAgents={props.onGoAgents} />
          <div className="muted small">
            만든 사람 {t.createdBy} · {fmtTime(t.createdAt)}
            {t.finishedAt && ` · 끝남 ${fmtTime(t.finishedAt)}`}
          </div>
        </div>
      )}

      <div className="card-actions">
        <button className="sm ghost" onClick={props.onDetail}>
          기록·변경
        </button>
        {props.isLocal && t.status === 'todo' && !props.running && (
          <button className="primary sm" onClick={props.onRun}>
            실행
          </button>
        )}
        {props.limit && props.adapter && t.status === 'todo' && !props.running && (
          <button className="sm ghost" onClick={() => void window.hive.clearLimit(props.adapter!)} title="한도가 풀렸다고 알려줘요">
            한도 해제
          </button>
        )}
        {t.interruptedRun && !props.running && (
          <ConfirmButton label="되돌리기" onConfirm={() => window.hive.rollbackRun(t.id, t.interruptedRun!)} />
        )}
        {props.running && (
          <button className="sm" onClick={() => void window.hive.stopTask(t.id)}>
            중지
          </button>
        )}
        {(t.status === 'failed' || t.status === 'done') && (
          <button
            className="sm"
            onClick={() => void window.hive.updateTask(t.id, { status: 'todo', error: undefined })}
          >
            다시 할 일로
          </button>
        )}
        {!props.running && <ConfirmButton label="삭제" onConfirm={() => window.hive.deleteTask(t.id)} />}
      </div>
    </article>
  )
}
