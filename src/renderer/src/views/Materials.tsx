import { useEffect, useRef, useState } from 'react'
import type {
  ActivityEvent,
  ActivityKind,
  DiffFile,
  LiveSummary,
  PermissionLevel,
  Preflight,
  Task
} from '@shared/types'
import { fmtElapsed, fmtSize, useNow } from '../store'

// ---------------------------------------------------------------- live progress

/** Elapsed time, steps, touched files and plan progress of a running task. */
export function ProgressStrip({ s }: { s: LiveSummary }): JSX.Element {
  const now = useNow(true)
  const done = s.plan.filter((p) => p.done).length
  const pct = s.plan.length ? Math.round((done / s.plan.length) * 100) : 0
  return (
    <div className="progress">
      <div className="progress-nums">
        <span title="경과 시간">⏱ {fmtElapsed(now - new Date(s.startedAt).getTime())}</span>
        <span title="읽기·수정·명령 등 작업 단계">단계 {s.steps}</span>
        <span title="작업 폴더에서 실제로 바뀐 파일">
          파일 {s.files}
          {s.tracking === 'git' && (
            <>
              {' '}
              <b className="add">+{s.add}</b> <b className="del">−{s.del}</b>
            </>
          )}
        </span>
        {!!s.plan.length && (
          <span>
            계획 {done}/{s.plan.length}
          </span>
        )}
      </div>
      {!!s.plan.length && (
        <div className="bar">
          <div className="fill" style={{ width: pct + '%' }} />
        </div>
      )}
      {s.last && <div className="muted small progress-last">{s.last}</div>}
    </div>
  )
}

const KIND_LABEL: Record<ActivityKind, string> = {
  read: '읽기',
  edit: '수정',
  write: '작성',
  command: '명령',
  search: '검색',
  message: 'AI',
  plan: '계획',
  tool: '도구',
  error: '오류',
  note: '메모'
}

/** The step-by-step feed: what the agent says it is doing. */
export function ActivityFeed({
  events,
  follow = false
}: {
  events: ActivityEvent[]
  follow?: boolean
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [events.length, follow])
  if (!events.length) return <div className="empty">아직 활동이 없어요.</div>
  return (
    <div className="feed" ref={box}>
      {events.map((e) => (
        <div key={e.n} className={'feed-row act-' + e.kind}>
          <span className="feed-kind">{KIND_LABEL[e.kind]}</span>
          <span className="feed-text">{e.text}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- changed files

function patchFor(patch: string, path: string): string {
  const parts = patch.split(/^(?=diff --git )/m)
  return parts.find((p) => p.startsWith('diff --git ') && p.split('\n')[0].endsWith(' b/' + path)) ?? ''
}

function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep)
}

/** Files that really changed in the work folder (ground truth), with an inline diff when available. */
export function ChangedFiles({
  files,
  patch,
  root,
  lines,
  note
}: {
  files: DiffFile[]
  patch: string
  root: string
  lines: boolean
  note?: string
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  if (!files.length) return <div className="empty">아직 바뀐 파일이 없어요.</div>
  return (
    <>
      <ul className="files">
        {files.map((f) => {
          const p = lines && !f.binary ? patchFor(patch, f.path) : ''
          return (
            <li key={f.path}>
              <div className="file-row">
                <span className={'fs fs-' + f.status}>{f.status}</span>
                <code>{f.path}</code>
                {lines && (
                  <span className="muted small">{f.binary ? '바이너리' : `+${f.additions} −${f.deletions}`}</span>
                )}
                {p && (
                  <button className="sm ghost" onClick={() => setOpen(open === f.path ? null : f.path)}>
                    {open === f.path ? '접기' : '변경 보기'}
                  </button>
                )}
                {f.status !== 'D' && root && (
                  <button className="sm ghost" onClick={() => void window.hive.openPath(joinPath(root, f.path))}>
                    열기
                  </button>
                )}
              </div>
              {open === f.path && p && (
                <pre className="out tall patch">
                  {p.split('\n').map((line, i) => (
                    <span key={i} className={lineClass(line)}>
                      {line + '\n'}
                    </span>
                  ))}
                </pre>
              )}
            </li>
          )
        })}
      </ul>
      {note && <div className="muted small">{note}</div>}
    </>
  )
}

export function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) return 'd-meta'
  if (line.startsWith('@@')) return 'd-hunk'
  if (line.startsWith('+')) return 'd-add'
  if (line.startsWith('-')) return 'd-del'
  return ''
}

// ---------------------------------------------------------------- materials (drop zone etc.)

export interface Dropped {
  name: string
  path?: string
  data?: Uint8Array
}

const MAX_INLINE = 50 * 1024 * 1024

export async function collectDropped(dt: DataTransfer): Promise<Dropped[]> {
  const out: Dropped[] = []
  for (const f of Array.from(dt.files)) {
    const path = window.hive.pathForFile(f)
    if (path) {
      out.push({ name: f.name, path })
      continue
    }
    if (f.size > 0 && f.size <= MAX_INLINE) {
      try {
        out.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })
      } catch {
        /* unreadable (e.g. a folder without a path): skip */
      }
    }
  }
  return out
}

/** Hand dropped/picked items to a task. Returns problems to show. */
export async function sendDropped(taskId: string, items: Dropped[]): Promise<string[]> {
  const errors: string[] = []
  const paths = items.filter((i) => i.path).map((i) => i.path as string)
  if (paths.length) errors.push(...(await window.hive.attachPaths(taskId, paths)).errors)
  for (const i of items) {
    if (!i.path && i.data) errors.push(...(await window.hive.attachData(taskId, i.name, i.data)).errors)
  }
  return errors
}

export function DropZone({
  onItems,
  compact
}: {
  onItems: (items: Dropped[]) => void | Promise<void>
  compact?: boolean
}): JSX.Element {
  const [over, setOver] = useState(false)
  return (
    <div
      className={'drop' + (over ? ' over' : '') + (compact ? ' compact' : '')}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        void collectDropped(e.dataTransfer).then((items) => items.length && onItems(items))
      }}
    >
      <span className="muted small">파일·이미지·폴더를 여기에 끌어다 놓거나</span>
      <button
        className="sm"
        onClick={() =>
          void window.hive.pickFiles().then((ps) => ps.length && onItems(ps.map((p) => ({ name: p, path: p }))))
        }
      >
        파일 선택
      </button>
      <button
        className="sm"
        onClick={() =>
          void window.hive.pickFolder().then((p) => p && onItems([{ name: p, path: p }]))
        }
      >
        참고 폴더 추가
      </button>
    </div>
  )
}

const PERM_LABEL: Record<PermissionLevel, string> = {
  read: '읽기만 (파일을 바꾸지 못해요)',
  edit: '파일 수정 (기본, 에이전트 설정대로)',
  exec: '명령 실행 허용 (위험 · 실행 전 승인)'
}

export function PermissionSelect({
  value,
  onChange
}: {
  value: PermissionLevel
  onChange: (v: PermissionLevel) => void
}): JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as PermissionLevel)}>
      {(Object.keys(PERM_LABEL) as PermissionLevel[]).map((k) => (
        <option key={k} value={k}>
          {PERM_LABEL[k]}
        </option>
      ))}
    </select>
  )
}

/** Attachments, reference folders and permission level of an existing task. */
export function MaterialsPanel({ task }: { task: Task }): JSX.Element {
  const [errors, setErrors] = useState<string[]>([])
  const atts = task.attachments ?? []
  const dirs = task.refDirs ?? []
  const running = task.status === 'running'
  return (
    <div className="materials">
      <div className="row">
        <span className="muted small">권한</span>
        <PermissionSelect
          value={task.permission ?? 'edit'}
          onChange={(v) => void window.hive.updateTask(task.id, { permission: v })}
        />
        {running && <span className="muted small">바꾼 내용은 다음 실행부터 적용돼요.</span>}
      </div>
      {!!atts.length && (
        <ul className="mat-list">
          {atts.map((a) => (
            <li key={a.rel}>
              <span>📎 {a.name}</span>
              <span className="muted small">
                {fmtSize(a.size)}
                {a.local && ' · 이 컴퓨터에만 보관'}
              </span>
              <button className="sm ghost" onClick={() => void window.hive.removeAttachment(task.id, a.rel)}>
                빼기
              </button>
            </li>
          ))}
        </ul>
      )}
      {!!dirs.length && (
        <ul className="mat-list">
          {dirs.map((d) => (
            <li key={d}>
              <span>📁 {d}</span>
              <span className="muted small">참고 폴더</span>
              <button
                className="sm ghost"
                onClick={() => void window.hive.updateTask(task.id, { refDirs: dirs.filter((x) => x !== d) })}
              >
                빼기
              </button>
            </li>
          ))}
        </ul>
      )}
      <DropZone onItems={async (items) => setErrors(await sendDropped(task.id, items))} compact />
      {errors.map((e, i) => (
        <div key={i} className="err-text small">
          {e}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- the agent asked for something

export function NeedBox({ task }: { task: Task }): JSX.Element {
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  return (
    <div className="need">
      <div>
        <span className="tag warn">자료 요청</span> <b>{task.question}</b>
      </div>
      <textarea
        rows={3}
        placeholder="답이나 결정을 적어 주세요. 파일은 아래에 끌어다 놓으면 에이전트에게 전달돼요."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <DropZone onItems={async (items) => setErrors(await sendDropped(task.id, items))} compact />
      {!!(task.attachments ?? []).length && (
        <div className="muted small">첨부된 자료: {(task.attachments ?? []).map((a) => a.name).join(', ')}</div>
      )}
      {errors.map((e, i) => (
        <div key={i} className="err-text small">
          {e}
        </div>
      ))}
      <div className="row end">
        <button
          className="primary"
          disabled={!text.trim() && !(task.attachments ?? []).length}
          onClick={() => {
            void window.hive.replyToTask(task.id, text.trim() || '(첨부한 자료를 확인해 주세요)')
            setText('')
          }}
        >
          보내고 계속
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- before running

export function PreflightDialog({
  task,
  onClose
}: {
  task: Task
  onClose: () => void
}): JSX.Element {
  const [pf, setPf] = useState<Preflight | null>(null)
  const [msg, setMsg] = useState('')
  const load = (): void => {
    void window.hive.preflight(task.id).then(setPf)
  }
  useEffect(load, [task.id])

  const ICON = { ok: '✓', warn: '!', error: '✕' } as const
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h1>실행 전 점검</h1>
        <div className="muted small">{task.title}</div>
        {!pf ? (
          <div className="empty">확인하는 중…</div>
        ) : (
          <ul className="pre-list">
            {pf.items.map((it, i) => (
              <li key={i} className={'pre-' + it.level}>
                <span className="pre-icon">{ICON[it.level]}</span>
                <span>{it.text}</span>
                {it.fix === 'git-init' && (
                  <button
                    className="sm"
                    onClick={() =>
                      void window.hive.enableTracking(task.id).then((r) => {
                        setMsg(r.message)
                        load()
                      })
                    }
                  >
                    변경 추적 켜기
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {msg && <div className="muted small">{msg}</div>}
        <div className="row end">
          <button onClick={onClose}>취소</button>
          <button
            className="primary"
            disabled={!pf?.canRun}
            onClick={() => {
              onClose()
              void window.hive.runTask(task.id)
            }}
          >
            실행
          </button>
        </div>
      </div>
    </div>
  )
}
