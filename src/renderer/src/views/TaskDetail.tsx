import { useEffect, useState } from 'react'
import type {
  Report,
  RunRecord,
  RunResultKind,
  RunSummary,
  Task,
  TaskEvent,
  TaskEventKind,
  TaskHistory
} from '@shared/types'
import { fmtTime } from '../store'

const EVENT_LABEL: Record<TaskEventKind, string> = {
  created: '생성',
  check: '점검',
  approval_requested: '결재 요청',
  approval_decided: '결재',
  run_started: '실행',
  run_finished: '실행 결과',
  review: '검토',
  status: '상태'
}

const OUTCOME_LABEL: Record<RunResultKind, string> = {
  done: '완료',
  failed: '실패',
  cancelled: '중지됨',
  awaiting_approval: '승인 대기'
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

/** Full history of one task: report, what changed, timeline and every run. */
export default function TaskDetail({
  task,
  assigneeName,
  onClose
}: {
  task: Task
  assigneeName: string
  onClose: () => void
}): JSX.Element {
  const [history, setHistory] = useState<TaskHistory | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [record, setRecord] = useState<RunRecord | null>(null)

  // Reload whenever the task changes on disk (updatedAt moves on every status/result change).
  useEffect(() => {
    let alive = true
    void window.hive.taskHistory(task.id).then((h) => alive && setHistory(h))
    return () => {
      alive = false
    }
  }, [task.id, task.updatedAt])

  // Default to the latest run's diff.
  const latest = history?.runs[history.runs.length - 1]
  const focus = openRun ?? latest?.id ?? null
  useEffect(() => {
    let alive = true
    setRecord(null)
    if (focus) void window.hive.runDetail(task.id, focus).then((r) => alive && setRecord(r))
    return () => {
      alive = false
    }
  }, [task.id, focus])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <h1>{task.title}</h1>
            <div className="muted small">
              {assigneeName} · 만든 사람 {task.createdBy} · {fmtTime(task.createdAt)}
            </div>
          </div>
          <button onClick={onClose}>닫기</button>
        </div>

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
        {task.error && <pre className="out err">{task.error}</pre>}

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

        {record && <RunBody record={record} />}
      </div>
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

function RunBody({ record }: { record: RunRecord }): JSX.Element {
  const [tab, setTab] = useState<'diff' | 'prompt' | 'response'>('diff')
  return (
    <div className="run-body">
      <div className="row">
        {(
          [
            ['diff', '변경 파일'],
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
        </span>
      </div>
      {tab === 'diff' && <DiffView record={record} />}
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

function DiffView({ record }: { record: RunRecord }): JSX.Element {
  const d = record.diff
  if (!d.available) return <div className="empty">{d.reason ?? '변경 내용을 비교할 수 없어요.'}</div>
  if (!d.files.length) return <div className="empty">이 실행에서 바뀐 파일이 없어요.</div>
  return (
    <>
      <ul className="files">
        {d.files.map((f) => (
          <li key={f.path}>
            <span className={'fs fs-' + f.status}>{f.status}</span>
            <code>{f.path}</code>
            <span className="muted small">{f.binary ? '바이너리' : `+${f.additions} −${f.deletions}`}</span>
          </li>
        ))}
      </ul>
      <pre className="out tall patch">
        {d.patch.split('\n').map((line, i) => (
          <span key={i} className={lineClass(line)}>
            {line + '\n'}
          </span>
        ))}
      </pre>
      {d.truncated && <div className="muted small">변경이 커서 일부만 보여줘요.</div>}
      <div className="muted small">같은 폴더에서 다른 에이전트가 동시에 일했다면 그 변경도 함께 보일 수 있어요.</div>
    </>
  )
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) return 'd-meta'
  if (line.startsWith('@@')) return 'd-hunk'
  if (line.startsWith('+')) return 'd-add'
  if (line.startsWith('-')) return 'd-del'
  return ''
}
