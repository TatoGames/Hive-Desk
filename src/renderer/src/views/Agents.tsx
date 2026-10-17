import { useEffect, useState } from 'react'
import type { AdapterId, AdapterInfo, Agent, Snapshot } from '@shared/types'
import { ConfirmButton } from './Board'

const ADAPTER_LABEL: Record<AdapterId, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  gemini: 'Gemini CLI',
  agy: 'Antigravity (agy)',
  custom: '직접 지정'
}

const DEFAULT_ARGS: Record<AdapterId, string> = {
  claude: '--permission-mode acceptEdits',
  codex: '--sandbox workspace-write',
  gemini: '',
  agy: '',
  custom: ''
}

type Draft = Partial<Agent> & { name: string; adapter: AdapterId }

const EMPTY: Draft = {
  name: '',
  adapter: 'claude',
  role: '',
  workDir: '',
  model: '',
  extraArgs: DEFAULT_ARGS.claude,
  command: '',
  dailyRunLimit: 20,
  dailyMinuteLimit: 120,
  timeoutMinutes: 15,
  requireApproval: false
}

export default function Agents({ snap, goBoard }: { snap: Snapshot; goBoard: () => void }): JSX.Element {
  const [detected, setDetected] = useState<AdapterInfo[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  const detect = async (): Promise<void> => {
    setDetected(null)
    setDetected(await window.hive.detectAdapters())
  }
  useEffect(() => {
    void detect()
  }, [])

  const test = async (a: Agent): Promise<void> => {
    const t = await window.hive.createTask({
      title: `연결 테스트: ${a.name}`,
      description: '한국어 한 문장으로 자기소개만 해 주세요. 파일은 건드리지 마세요.',
      assignee: a.id
    })
    goBoard()
    void window.hive.runTask(t.id)
  }

  const others = snap.roster.filter((r) => !snap.config.agents.some((a) => a.id === r.id))

  return (
    <div className="page">
      <header className="page-head">
        <h1>에이전트</h1>
        <button className="primary" onClick={() => setDraft({ ...EMPTY })}>
          + 에이전트 추가
        </button>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>이 PC에 설치된 AI CLI</h2>
          <button className="sm ghost" onClick={() => void detect()}>
            다시 확인
          </button>
        </div>
        <p className="muted small">
          HiveDesk는 API 키를 쓰지 않아요. 각자 설치한 CLI에 각자 계정(무료·구독)으로 로그인해 두면, 그 CLI를
          대신 실행해요.
        </p>
        <div className="cli-grid">
          {!detected && <div className="muted">확인 중…</div>}
          {detected?.map((d) => (
            <div key={d.id} className={'cli ' + (d.found ? 'ok' : 'no')}>
              <div className="cli-name">
                {d.found ? '●' : '○'} {d.label}
              </div>
              <div className="small">{d.found ? d.version || '설치됨' : '설치 안 됨'}</div>
              {!d.found && d.install && <code className="small">{d.install}</code>}
              <div className="small muted">{d.login}</div>
              {d.note && <div className="small note">{d.note}</div>}
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>내 에이전트</h2>
        {!snap.config.agents.length && <div className="empty">아직 없어요. 오른쪽 위에서 추가하세요.</div>}
        <div className="agent-list">
          {snap.config.agents.map((a) => {
            const u = snap.usage[a.id] ?? { runs: 0, ms: 0 }
            const mins = Math.round(u.ms / 60000)
            return (
              <div key={a.id} className="agent">
                <div>
                  <div className="title">
                    {a.name} <span className="tag">{ADAPTER_LABEL[a.adapter]}</span>
                    {a.requireApproval && <span className="tag warn">항상 승인</span>}
                  </div>
                  <div className="muted small">{a.role || '역할 미지정'}</div>
                  <div className="muted small">작업 폴더: {a.workDir || '(hive 폴더)'}</div>
                </div>
                <div className="usage">
                  <Meter label="오늘 실행" value={u.runs} max={a.dailyRunLimit} unit="회" />
                  <Meter label="오늘 시간" value={mins} max={a.dailyMinuteLimit} unit="분" />
                </div>
                <div className="row">
                  <button className="sm" onClick={() => void test(a)}>
                    테스트
                  </button>
                  <button className="sm" onClick={() => setDraft({ ...a, model: a.model ?? '' })}>
                    수정
                  </button>
                  <ConfirmButton label="삭제" onConfirm={() => window.hive.deleteAgent(a.id)} />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {!!others.length && (
        <section className="panel">
          <h2>팀원의 에이전트</h2>
          <p className="muted small">태스크를 배정할 수 있어요. 실행은 그 팀원의 PC에서 일어나요.</p>
          <div className="agent-list">
            {others.map((r) => (
              <div key={r.id} className="agent compact">
                <div className="title">
                  {r.name} <span className="tag">{ADAPTER_LABEL[r.adapter]}</span>
                </div>
                <div className="muted small">
                  {r.owner} · {r.role || '역할 미지정'}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {draft && <AgentDialog draft={draft} onClose={() => setDraft(null)} />}
    </div>
  )
}

function Meter({ label, value, max, unit }: { label: string; value: number; max: number; unit: string }): JSX.Element {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="meter">
      <div className="small">
        {label} {value}
        {max > 0 ? ` / ${max}` : ''}
        {unit}
      </div>
      {max > 0 && (
        <div className="bar">
          <div className={'fill' + (pct >= 100 ? ' full' : '')} style={{ width: pct + '%' }} />
        </div>
      )}
    </div>
  )
}

function AgentDialog({ draft, onClose }: { draft: Draft; onClose: () => void }): JSX.Element {
  const [d, setD] = useState<Draft>(draft)
  const [err, setErr] = useState('')
  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void => setD((x) => ({ ...x, [k]: v }))
  const num = (v: string): number => Math.max(0, Number(v) || 0)

  const save = async (): Promise<void> => {
    if (!d.name.trim()) return setErr('이름을 입력하세요.')
    if (d.adapter === 'custom' && !d.command?.trim()) return setErr('실행할 명령을 입력하세요.')
    await window.hive.saveAgent({ ...d, model: d.model?.trim() || undefined })
    onClose()
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{draft.id ? '에이전트 수정' : '에이전트 추가'}</h2>
        <div className="form">
          <label>
            이름
            <input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="예: 백엔드 개발자" />
          </label>
          <label>
            사용할 AI
            <select
              value={d.adapter}
              onChange={(e) => {
                const a = e.target.value as AdapterId
                setD((x) => ({ ...x, adapter: a, extraArgs: DEFAULT_ARGS[a] }))
              }}
            >
              {(Object.keys(ADAPTER_LABEL) as AdapterId[]).map((k) => (
                <option key={k} value={k}>
                  {ADAPTER_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="full">
            역할 (에이전트에게 매번 알려 줄 설명)
            <textarea
              rows={2}
              value={d.role}
              onChange={(e) => set('role', e.target.value)}
              placeholder="예: Unity C# 게임플레이 코드를 담당. 변경 전 기존 코드 스타일을 따른다."
            />
          </label>
          <label className="full">
            작업 폴더 (이 에이전트가 일할 프로젝트)
            <div className="row">
              <input className="grow" value={d.workDir} onChange={(e) => set('workDir', e.target.value)} />
              <button
                className="sm"
                onClick={async () => {
                  const p = await window.hive.pickFolder()
                  if (p) set('workDir', p)
                }}
              >
                찾기
              </button>
            </div>
          </label>
          {d.adapter === 'custom' && (
            <label className="full">
              실행할 명령 (프롬프트는 stdin으로 전달)
              <input value={d.command} onChange={(e) => set('command', e.target.value)} placeholder="예: ollama" />
            </label>
          )}
          {d.adapter !== 'custom' && d.adapter !== 'agy' && (
            <label>
              모델 (비우면 CLI 기본값)
              <input value={d.model} onChange={(e) => set('model', e.target.value)} />
            </label>
          )}
          <label className={d.adapter === 'custom' || d.adapter === 'agy' ? 'full' : ''}>
            {d.adapter === 'custom' ? '명령 인자' : '추가 인자'}
            <input value={d.extraArgs} onChange={(e) => set('extraArgs', e.target.value)} />
          </label>
          <label>
            하루 최대 실행 (0 = 무제한)
            <input type="number" value={d.dailyRunLimit} onChange={(e) => set('dailyRunLimit', num(e.target.value))} />
          </label>
          <label>
            하루 최대 시간(분)
            <input
              type="number"
              value={d.dailyMinuteLimit}
              onChange={(e) => set('dailyMinuteLimit', num(e.target.value))}
            />
          </label>
          <label>
            1회 제한 시간(분)
            <input
              type="number"
              value={d.timeoutMinutes}
              onChange={(e) => set('timeoutMinutes', Math.max(1, num(e.target.value)))}
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={d.requireApproval}
              onChange={(e) => set('requireApproval', e.target.checked)}
            />
            모든 태스크 실행 전 승인 받기
          </label>
        </div>
        <p className="muted small">
          구독 요금제의 사용량 한도는 각 서비스가 관리해요. 여기 예산은 HiveDesk가 너무 많이 돌리지 않도록 막는
          안전장치예요.
        </p>
        {err && <div className="err-text">{err}</div>}
        <div className="row end">
          <button className="ghost" onClick={onClose}>
            취소
          </button>
          <button className="primary" onClick={() => void save()}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
