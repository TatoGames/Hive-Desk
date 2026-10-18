import { useEffect, useState } from 'react'
import type { Instruction, Snapshot, Task } from '../../../shared/types'

const STATE_LABEL: Record<Instruction['state'], string> = {
  queued: '대기 중',
  sent: '전달됨',
  seen: '확인함',
  applied: '반영됨',
  dropped: '취소함'
}

/** Stop / continue / cancel for one task. Shown wherever a task can be acted on. */
export function TaskControls({ task, compact }: { task: Task; compact?: boolean }): JSX.Element | null {
  const [cancelOpen, setCancelOpen] = useState(false)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [text, setText] = useState('')
  const s = task.status
  const live = s === 'running' || s === 'todo' || s === 'awaiting_approval' || s === 'needs_input'
  const cls = compact ? 'sm' : ''
  if (s === 'done' || s === 'cancelled') {
    return s === 'cancelled' ? (
      <button className={cls + ' ghost'} onClick={() => void window.hive.resumeTask(task.id)} title="취소한 업무를 다시 열어요">
        다시 열기
      </button>
    ) : null
  }
  return (
    <>
      <span className="row ctl">
        {live && (
          <button className={cls} onClick={() => void window.hive.stopTask(task.id, 'hold')} title="멈추고 보류해요. 이어서 하기를 누르기 전에는 시작하지 않아요">
            ⏸ 중지
          </button>
        )}
        {task.paused && <span className="tag warn">일시 정지됨</span>}
        {s === 'running' && task.liveInput && !task.paused && (
          <button className={cls} onClick={() => void window.hive.pauseTask(task.id)} title="AI가 하던 단계를 멈추고, 지시를 적어 이어가요 (대화는 그대로 유지돼요)">
            ⏯ 일시 정지
          </button>
        )}
        {s === 'held' && (
          <button className={cls + ' primary'} onClick={() => (compact ? void window.hive.resumeTask(task.id) : setResumeOpen(true))}>
            ▶ 이어서 하기
          </button>
        )}
        {(live || s === 'held') && (
          <button className={cls + ' danger'} onClick={() => setCancelOpen(true)}>
            ✕ 취소
          </button>
        )}
      </span>
      {resumeOpen && (
        <div className="overlay" onClick={() => setResumeOpen(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>이어서 하기</h2>
            <p className="muted small">멈췄던 곳에서 이어서 해요. 새로 전할 지시가 있으면 적어 주세요 (없어도 돼요).</p>
            <input className="grow" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="예: 표로 정리해줘" />
            <div className="row end">
              <button onClick={() => setResumeOpen(false)}>닫기</button>
              <button
                className="primary"
                onClick={() => {
                  void window.hive.resumeTask(task.id, text.trim() || undefined)
                  setResumeOpen(false)
                  setText('')
                }}
              >
                이어서 하기
              </button>
            </div>
          </div>
        </div>
      )}
      {cancelOpen && <CancelDialog task={task} onClose={() => setCancelOpen(false)} />}
    </>
  )
}

type Scope = 'this' | 'tree' | 'pending'

/** What a cancel will touch, shown before it happens; files are only reverted when the person says so. */
export function CancelDialog({ task, onClose }: { task: Task; onClose: () => void }): JSX.Element {
  const hasTree = !!task.parentId || !!task.kind
  const [scope, setScope] = useState<Scope>('this')
  const [files, setFiles] = useState<'keep' | 'run' | 'task'>('keep')
  const [prev, setPrev] = useState<Awaited<ReturnType<typeof window.hive.cancelPreview>> | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void window.hive.cancelPreview(task.id, scope).then((p) => alive && setPrev(p))
    return () => {
      alive = false
    }
  }, [task.id, scope])
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>업무를 취소할까요?</h2>
        {hasTree && (
          <div className="stack">
            {(
              [
                ['this', '이 업무만'],
                ['tree', '이 업무와 아래 하위 업무 전부'],
                ['pending', '아직 시작 안 한 하위 업무만']
              ] as [Scope, string][]
            ).map(([v, l]) => (
              <label key={v} className="radio">
                <input type="radio" checked={scope === v} onChange={() => setScope(v)} /> {l}
              </label>
            ))}
          </div>
        )}
        <div className="muted small">
          {prev
            ? `실행 중 ${prev.running}건 · 대기 ${prev.waiting}건을 취소해요${prev.done ? ` (끝난 ${prev.done}건은 그대로)` : ''}${prev.files ? ` · 바뀐 파일 ${prev.files}개 (+${prev.additions} −${prev.deletions})` : ''}.`
            : '확인하는 중…'}
        </div>
        {!!prev?.files && (
          <div className="stack">
            <div className="small">이미 바뀐 파일은 어떻게 할까요?</div>
            {(
              [
                ['keep', '그대로 둬요 (기본)'],
                ['run', '마지막 실행이 바꾼 것만 되돌려요'],
                ['task', '이 업무가 바꾼 것 전부 되돌려요']
              ] as ['keep' | 'run' | 'task', string][]
            ).map(([v, l]) => (
              <label key={v} className="radio">
                <input type="radio" checked={files === v} onChange={() => setFiles(v)} /> {l}
              </label>
            ))}
          </div>
        )}
        <div className="row end">
          <button onClick={onClose}>닫기</button>
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await window.hive.cancelTask(task.id, { scope, files })
              onClose()
            }}
          >
            취소하기
          </button>
        </div>
      </div>
    </div>
  )
}

/** The instructions given to a task and where each one stands. */
export function InstructionList({ task }: { task: Task }): JSX.Element | null {
  const list = (task.instructions ?? []).filter((i) => i.state !== 'dropped')
  if (!list.length) return null
  return (
    <ul className="instr">
      {list.map((i) => (
        <li key={i.id} className="row between">
          <span>
            <span className={'chip ' + i.state}>{STATE_LABEL[i.state]}</span> {i.text}
          </span>
          {i.state === 'queued' && (
            <button className="sm ghost" onClick={() => void window.hive.dropInstruction(task.id, i.id)}>
              빼기
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The two auto-run switches (mine / organisation) and the red button that stops everything. */
export function AutoSwitches({ snap }: { snap: Snapshot }): JSX.Element {
  const orgOn = snap.config.autoRunOrg !== false
  return (
    <div className="auto-switches">
      <label className="toggle" title="내가 직접 만든 업무 중 내 에이전트에 배정된 준비된 업무를 차례로 실행해요">
        <input type="checkbox" checked={snap.config.autoRun} onChange={(e) => void window.hive.saveSettings({ autoRun: e.target.checked })} />
        내 업무 자동 실행
      </label>
      <label className="toggle" title="조직에 위임한 업무(계획·하위 업무·검토)를 저절로 이어서 진행해요">
        <input type="checkbox" checked={orgOn} onChange={(e) => void window.hive.saveSettings({ autoRunOrg: e.target.checked })} />
        조직 자동 진행
      </label>
      {!snap.config.autoRun && orgOn && <span className="muted small">내 자동 실행은 꺼져 있어도 위임 업무는 계속 돌아요</span>}
      {snap.running.length > 0 && (
        <button
          className="danger sm"
          title="모든 회사의 실행 중인 업무를 멈추고 자동 실행을 모두 꺼요"
          onClick={() => {
            if (window.confirm(`실행 중인 ${snap.running.length}건을 모두 멈추고 자동 실행을 꺼요. 계속할까요?`)) void window.hive.emergencyStop()
          }}
        >
          ⛔ 비상 정지
        </button>
      )}
    </div>
  )
}


/** A running delegation: instruct the whole tree, skip a step, add a step, or have the planner start over. */
export function PlanAdjust({ snap, task }: { snap: Snapshot; task: Task }): JSX.Element | null {
  const [text, setText] = useState('')
  const [down, setDown] = useState(true)
  const [replan, setReplan] = useState(false)
  const [stepTitle, setStepTitle] = useState('')
  const [stepWho, setStepWho] = useState('')
  const [msg, setMsg] = useState('')
  if (task.status !== 'delegated' || !task.plan) return null
  const kids = snap.tasks.filter((t) => t.parentId === task.id && t.kind !== 'review')
  const who = snap.roster
  const nameOf = (id: string | null): string => snap.roster.find((r) => r.id === id)?.name ?? '미배정'
  return (
    <>
      <h2 className="sec">진행 중인 계획 조정</h2>
      <div className="row">
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="이 일 전체에 대한 새 지시" />
        <button
          className="primary"
          disabled={!text.trim()}
          onClick={() => {
            if (replan && !window.confirm('끝나지 않은 하위 작업을 모두 취소하고 계획을 처음부터 다시 세워요. 이미 끝난 작업은 그대로 둬요. 계속할까요?')) return
            void window.hive.instructTree(task.id, text, { down, replan }).then(() => setMsg(replan ? '계획을 다시 세우는 중이에요.' : '전달했어요.'))
            setText('')
          }}
        >
          보내기
        </button>
      </div>
      <div className="row small">
        <label className="toggle"><input type="checkbox" checked={down} disabled={replan} onChange={(e) => setDown(e.target.checked)} /> 아래 업무에도 전달</label>
        <label className="toggle"><input type="checkbox" checked={replan} onChange={(e) => setReplan(e.target.checked)} /> 다시 계획 (끝나지 않은 하위 작업은 취소해요)</label>
      </div>
      {msg && <div className="muted small">{msg}</div>}
      <div className="steps">
        {kids.map((k) => (
          <div key={k.id} className="row small">
            <span className="grow">{k.title} <span className="muted">· {nameOf(k.assignee)} · {k.status}</span></span>
            {k.status !== 'done' && k.status !== 'cancelled' && k.status !== 'running' && (
              <button className="sm" onClick={() => void window.hive.skipStep(k.id)} title="이 단계를 건너뛰어요. 이 단계를 기다리던 작업은 계속 진행해요">
                건너뛰기
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="row">
        <input className="grow" value={stepTitle} onChange={(e) => setStepTitle(e.target.value)} placeholder="단계 더하기: 할 일" />
        <select value={stepWho} onChange={(e) => setStepWho(e.target.value)}>
          <option value="">담당자</option>
          {who.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button
          disabled={!stepTitle.trim() || !stepWho}
          onClick={() => {
            void window.hive.addStep(task.id, { title: stepTitle, assignee: stepWho }).then(() => setMsg('단계를 더했어요.')).catch((e: Error) => setMsg(e.message))
            setStepTitle('')
          }}
        >
          더하기
        </button>
      </div>
    </>
  )
}
