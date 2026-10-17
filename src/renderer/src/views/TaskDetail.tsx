import { useEffect, useState } from 'react'
import type {
  AdapterId,
  Report,
  RunRecord,
  RunResultKind,
  RunSummary,
  LiveState,
  Task,
  TaskEvent,
  TaskEventKind,
  TaskHistory
} from '@shared/types'
import { fmtTime } from '../store'
import {
  ActivityFeed,
  ConfirmButton,
  ChangedFiles,
  FailureHint,
  MaterialsPanel,
  NeedBox,
  ProgressStrip,
  ReviewBox
} from './Materials'

const EVENT_LABEL: Record<TaskEventKind, string> = {
  created: '생성',
  check: '점검',
  approval_requested: '결재 요청',
  approval_decided: '결재',
  run_started: '실행',
  run_finished: '실행 결과',
  review: '검토',
  status: '상태',
  need: '자료 요청',
  reply: '답변',
  instruction: '추가 지시',
  rollback: '되돌리기',
  changed: '변경'
}

const OUTCOME_LABEL: Record<RunResultKind, string> = {
  done: '완료',
  failed: '실패',
  cancelled: '중지됨',
  awaiting_approval: '승인 대기',
  needs_input: '자료 요청',
  running: '실행 중',
  interrupted: '중단됨',
  limit: '한도 도달'
}

const REPORT_ROWS: { key: keyof Report; label: string }[] = [
  { key: 'did', label: '한 일' },
  { key: 'files', label: '바꾼 파일 (에이전트 보고)' },
  { key: 'verify', label: '확인 방법' },
  { key: 'risks', label: '남은 위험' },
  { key: 'next', label: '다음 할 일' }
]

export function ReportView({ report }: { report: Report }): JSX.Element {
  return (
    <dl className="report">
      {REPORT_ROWS.map(({ key, label }) => (
        <div key={key} className="report-row">
          <dt>{label}</dt>
          <dd>{report[key] || <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

function fmtDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`
}

/** Full picture of one task: live progress, feed, changed files, materials, report, timeline, runs. */
export default function TaskDetail({
  task,
  assigneeName,
  workDir,
  adapter,
  onGoAgents,
  onClose
}: {
  onGoAgents?: () => void
  task: Task
  assigneeName: string
  workDir: string
  adapter?: AdapterId
  onClose: () => void
}): JSX.Element {
  const [history, setHistory] = useState<TaskHistory | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [record, setRecord] = useState<RunRecord | null>(null)
  const [live, setLive] = useState<LiveState | null>(null)
  const [extra, setExtra] = useState('')
  const running = task.status === 'running'

  // Reload whenever the task changes on disk (updatedAt moves on every status/result change).
  useEffect(() => {
    let alive = true
    void window.hive.taskHistory(task.id).then((h) => alive && setHistory(h))
    return () => {
      alive = false
    }
  }, [task.id, task.updatedAt])

  // While it runs, look at the live state every second and a half.
  useEffect(() => {
    if (!running) {
      setLive(null)
      return
    }
    let alive = true
    const pull = (): void => {
      void window.hive.liveState(task.id).then((l) => alive && setLive(l))
    }
    pull()
    const t = window.setInterval(pull, 1500)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [task.id, running])

  // Default to the latest run's record.
  const latest = history?.runs[history.runs.length - 1]
  const focus = openRun ?? latest?.id ?? null
  useEffect(() => {
    let alive = true
    setRecord(null)
    if (focus) void window.hive.runDetail(task.id, focus).then((r) => alive && setRecord(r))
    return () => {
      alive = false
    }
  }, [task.id, focus, task.updatedAt])

  const cwd = live?.cwd ?? record?.cwd ?? workDir
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <h1>{task.title}</h1>
            <div className="muted small">
              {assigneeName} · 만든 사람 {task.createdBy} · {fmtTime(task.createdAt)}
            </div>
            <div className="muted small where">
              <span title={cwd}>📂 {cwd}</span>
              <button className="sm ghost" onClick={() => void window.hive.openPath(cwd)}>
                폴더 열기
              </button>
            </div>
          </div>
          <button onClick={onClose}>닫기</button>
        </div>

        {task.status === 'needs_input' && (
          <>
            <h2 className="sec">에이전트가 기다리고 있어요</h2>
            <NeedBox task={task} />
          </>
        )}
        {task.status === 'needs_review' && (
          <>
            <h2 className="sec">결과 확인</h2>
            <ReviewBox task={task} />
          </>
        )}

        {running && (
          <>
            <h2 className="sec">지금 하는 일</h2>
            {live ? <ProgressStrip s={live} /> : <div className="empty">시작하는 중…</div>}
            {!!live?.plan.length && (
              <ul className="plan">
                {live.plan.map((p, i) => (
                  <li key={i} className={p.done ? 'done' : ''}>
                    {p.done ? '☑' : '☐'} {p.text}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <h2 className="sec">활동 피드 {running ? '(실시간)' : record ? `(${fmtTime(record.startedAt)} 실행)` : ''}</h2>
        {running ? (
          <ActivityFeed events={live?.events ?? []} follow />
        ) : record ? (
          <ActivityFeed events={record.activity ?? []} />
        ) : (
          <div className="empty">이 컴퓨터에서 실행한 기록이 없어요.</div>
        )}
        <div className="muted small">
          활동 피드는 AI가 스스로 알려 주는 내용이에요. 실제로 바뀐 파일은 아래에서 확인하세요.
        </div>

        <h2 className="sec">바뀐 파일 {running ? '(작업 폴더를 직접 확인한 결과)' : ''}</h2>
        {running ? (
          live?.tracking === 'none' ? (
            <div className="empty">이 폴더는 변경을 추적할 수 없어요.</div>
          ) : (
            <ChangedFiles
              files={live?.changes ?? []}
              patch={live?.patch ?? ''}
              root={live?.root ?? cwd}
              lines={live?.lines ?? true}
              note={live && !live.lines ? '줄 단위 비교는 폴더를 git 저장소로 만들면 볼 수 있어요 (실행 버튼 → 변경 추적 켜기).' : undefined}
            />
          )
        ) : record ? (
          record.diff.available ? (
            <>
              <ChangedFiles
                files={record.diff.files}
                patch={record.diff.patch}
                root={record.diff.root ?? record.cwd}
                lines={record.diff.lines !== false}
                note={record.diff.lines === false ? record.diff.reason : undefined}
              />
              {record.diff.truncated && <div className="muted small">변경이 커서 일부만 보여줘요.</div>}
              <div className="muted small">같은 폴더에서 다른 에이전트가 동시에 일했다면 그 변경도 함께 보일 수 있어요.</div>
            </>
          ) : (
            <div className="empty">{record.diff.reason ?? '변경 내용을 비교할 수 없어요.'}</div>
          )
        ) : (
          <div className="empty">아직 기록이 없어요.</div>
        )}

        <h2 className="sec">자료와 권한</h2>
        <MaterialsPanel task={task} adapter={adapter} />

        {(running || task.status === 'todo' || task.status === 'awaiting_approval') && (
          <>
            <h2 className="sec">추가 지시</h2>
            <div className="row">
              <input
                className="grow"
                placeholder={running ? '지금 단계가 끝나면 반영돼요' : '다음 실행에 반영돼요'}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && extra.trim()) {
                    void window.hive.addInstruction(task.id, extra)
                    setExtra('')
                  }
                }}
              />
              <button
                disabled={!extra.trim()}
                onClick={() => {
                  void window.hive.addInstruction(task.id, extra)
                  setExtra('')
                }}
              >
                보내기
              </button>
            </div>
            {!!task.followups?.length && (
              <div className="muted small">대기 중인 추가 지시: {task.followups.join(' / ')}</div>
            )}
          </>
        )}

        <h2 className="sec">보고서</h2>
        {task.report ? (
          <ReportView report={task.report} />
        ) : (
          <div className="empty">
            {task.result
              ? '에이전트가 정해진 보고 형식을 쓰지 않았어요. 아래 결과를 확인하세요.'
              : '아직 보고서가 없어요.'}
          </div>
        )}
        {task.result && (
          <details className="fold">
            <summary>결과 전문</summary>
            <pre className="out">{task.result}</pre>
          </details>
        )}
        <FailureHint task={task} onGoAgents={onGoAgents} />

        <h2 className="sec">타임라인</h2>
        {!history ? (
          <div className="empty">불러오는 중…</div>
        ) : !history.events.length ? (
          <div className="empty">이 태스크는 기록을 남기기 전에 만들어졌어요.</div>
        ) : (
          <ol className="timeline">
            {history.events.map((e) => (
              <Event key={e.id} e={e} />
            ))}
          </ol>
        )}

        <h2 className="sec">실행 기록</h2>
        {!history?.runs.length ? (
          <div className="empty">
            이 컴퓨터에서 실행한 기록이 없어요. (실행 기록은 실행한 컴퓨터에만 저장돼요.)
          </div>
        ) : (
          <div className="runs">
            {[...history.runs].reverse().map((r) => (
              <RunRow key={r.id} r={r} on={focus === r.id} onPick={() => setOpenRun(r.id)} />
            ))}
          </div>
        )}

        {record && <UndoBar task={task} record={record} />}
        {record && <RunBody record={record} />}
      </div>
    </div>
  )
}

/** Undo a run: put the work folder back the way it was just before it. */
function UndoBar({ task, record }: { task: Task; record: RunRecord }): JSX.Element | null {
  const [msg, setMsg] = useState('')
  const running = task.status === 'running'
  if (record.outcome === 'running') return null
  if (record.rolledBackAt) {
    return <div className="muted small">↩ 이 실행은 {fmtTime(record.rolledBackAt)}에 되돌렸어요.</div>
  }
  if (!record.checkpoint) {
    return record.checkpointNote ? <div className="muted small">되돌리기 불가: {record.checkpointNote}</div> : null
  }
  const cp = record.checkpoint
  return (
    <div className="undo">
      <ConfirmButton
        label="이 실행 되돌리기"
        onConfirm={async () => setMsg((await window.hive.rollbackRun(task.id, record.id)).message)}
      />
      <span className="muted small">
        {running
          ? '실행이 끝난 뒤에 되돌릴 수 있어요.'
          : cp.kind === 'git'
            ? '실행 전 상태가 git 안에 저장돼 있어요. 이 실행 이후 직접 고친 내용도 함께 되돌려져요.'
            : `실행 전 파일 ${cp.files}개를 백업해 뒀어요. 이 실행 이후 직접 고친 내용도 함께 되돌려져요.`}
      </span>
      {msg && <span className="small">{msg}</span>}
    </div>
  )
}

function Event({ e }: { e: TaskEvent }): JSX.Element {
  return (
    <li className={'ev ev-' + e.kind}>
      <span className="ev-time">{fmtTime(e.at)}</span>
      <span className="tag">{EVENT_LABEL[e.kind]}</span>
      <span className="ev-text">
        {e.text} <span className="muted small">· {e.actor}</span>
      </span>
    </li>
  )
}

function RunRow({
  r,
  on,
  onPick
}: {
  r: RunSummary
  on: boolean
  onPick: () => void
}): JSX.Element {
  const st = r.diffStat
  return (
    <button className={'run' + (on ? ' on' : '')} onClick={onPick}>
      <span className={'run-outcome ' + r.outcome}>{OUTCOME_LABEL[r.outcome]}</span>
      <span>{fmtTime(r.startedAt)}</span>
      <span className="muted">{fmtDuration(r.durationMs)}</span>
      <span className="muted">
        {r.adapter}
        {r.model ? ` · ${r.model}` : ''}
      </span>
      <span className="muted">
        {!st.available ? '변경 비교 불가' : st.files ? `파일 ${st.files}개 +${st.additions} −${st.deletions}` : '파일 변경 없음'}
      </span>
    </button>
  )
}

/** Raw material of one run: the instruction that was sent and the answer that came back. */
function RunBody({ record }: { record: RunRecord }): JSX.Element {
  const [tab, setTab] = useState<'prompt' | 'response'>('prompt')
  return (
    <div className="run-body">
      <div className="row">
        {(
          [
            ['prompt', '보낸 지시'],
            ['response', '응답']
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={'sm' + (tab === id ? ' primary' : ' ghost')} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <span className="muted small">
          {fmtTime(record.startedAt)} · {fmtDuration(record.durationMs)} · 종료 코드 {record.exitCode ?? '—'}
          {record.permission && record.permission !== 'edit' ? ` · 권한 ${record.permission}` : ''}
        </span>
      </div>
      {tab === 'prompt' && <pre className="out tall">{record.prompt}</pre>}
      {tab === 'response' && (
        <>
          <pre className="out tall">{record.response || '(응답 없음)'}</pre>
          {record.stderr && <pre className="out err">{record.stderr}</pre>}
        </>
      )}
    </div>
  )
}
