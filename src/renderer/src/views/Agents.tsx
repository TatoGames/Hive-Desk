import { useEffect, useState } from 'react'
import type { AdapterId, AdapterInfo, Agent, Snapshot } from '@shared/types'
import { JOBS, TIER_LABEL, modelLabel } from '@shared/company'
import { fmtTime } from '../store'
import { ConfirmButton } from './Materials'

const ADAPTER_LABEL: Record<AdapterId, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  agy: 'Antigravity (agy)',
  custom: '직접 지정'
}

const DEFAULT_ARGS: Record<AdapterId, string> = {
  claude: '--permission-mode acceptEdits',
  codex: '--sandbox workspace-write',
  agy: '',
  custom: ''
}

type Draft = Partial<Agent> & { name: string; adapter: AdapterId }

const SHORT_NAME: Record<AdapterId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity',
  custom: '에이전트'
}

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

      <CliSetup detected={detected} agents={snap.config.agents} onRedetect={detect} />

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
                    {a.name} <span className="tag">{ADAPTER_LABEL[a.adapter] ?? '알 수 없는 AI (' + a.adapter + ')'}</span>
                    {a.requireApproval && <span className="tag warn">항상 승인</span>}
                  </div>
                  <div className="muted small">{a.role || '역할 미지정'}</div>
                  <div className="muted small">작업 폴더: {a.workDir || '(hive 폴더)'}</div>
                  <CheckLine check={snap.roster.find((r) => r.id === a.id)?.check} />
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
                  {r.name} <span className="tag">{ADAPTER_LABEL[r.adapter] ?? '알 수 없는 AI (' + r.adapter + ')'}</span>
                </div>
                <div className="muted small">
                  {r.owner} · {r.role || '역할 미지정'}
                </div>
                <CheckLine check={r.check} />
              </div>
            ))}
          </div>
        </section>
      )}

      {draft && <AgentDialog draft={draft} snap={snap} onClose={() => setDraft(null)} />}
    </div>
  )
}

/** Last connection check of an agent's CLI: when, and whether it worked. */
export function CheckLine({ check }: { check?: { at: string; ok: boolean; message: string } }): JSX.Element {
  if (!check) return <div className="muted small">연결 확인 기록 없음</div>
  return (
    <div className={'small ' + (check.ok ? 'muted' : 'warn-text')}>
      연결 확인 {fmtTime(check.at)} · {check.ok ? '정상' : '문제 있음 — ' + check.message}
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

function AgentDialog({ draft, snap, onClose }: { draft: Draft; snap: Snapshot; onClose: () => void }): JSX.Element {
  const [d, setD] = useState<Draft>(draft)
  const [err, setErr] = useState('')
  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void => setD((x) => ({ ...x, [k]: v }))
  const num = (v: string): number => Math.max(0, Number(v) || 0)

  const save = async (): Promise<void> => {
    if (!d.name.trim()) return setErr('이름을 입력하세요.')
    if (d.adapter === 'custom' && !d.command?.trim()) return setErr('실행할 명령을 입력하세요.')
    await window.hive.saveAgent({ ...d, model: d.modelRef ? undefined : d.model?.trim() || undefined })
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
                setD((x) => ({ ...x, adapter: a, extraArgs: DEFAULT_ARGS[a], modelRef: undefined, model: '' }))
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
              모델 (카탈로그에서 고르면 버전을 정확히 지정할 수 있어요)
              <select
                value={d.modelRef?.id ?? (d.model ? '__custom' : '')}
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) setD((x) => ({ ...x, modelRef: undefined, model: '' }))
                  else if (v === '__custom') setD((x) => ({ ...x, modelRef: undefined }))
                  else setD((x) => ({ ...x, modelRef: { id: v, pin: x.modelRef?.pin ?? 'pinned' }, model: '' }))
                }}
              >
                <option value="">CLI 기본값</option>
                {snap.company.catalog
                  .filter((m) => m.adapter === d.adapter)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {modelLabel(m)} · {TIER_LABEL[m.tier]}
                      {snap.company.availability[m.id]?.ok === false ? ' (이 계정에서 안 됨)' : ''}
                    </option>
                  ))}
                <option value="__custom">직접 입력…</option>
              </select>
            </label>
          )}
          {d.modelRef && (
            <label>
              버전
              <select
                value={d.modelRef.pin}
                onChange={(e) => set('modelRef', { id: d.modelRef!.id, pin: e.target.value as 'alias' | 'pinned' })}
              >
                <option value="pinned">이 버전으로 고정</option>
                <option value="alias">최신 버전을 따라가기 (별칭)</option>
              </select>
            </label>
          )}
          {!d.modelRef && d.adapter !== 'custom' && d.adapter !== 'agy' && !!d.model && (
            <label>
              모델 이름 직접 입력
              <input value={d.model} onChange={(e) => set('model', e.target.value)} />
            </label>
          )}
          <label>
            직무
            <select value={d.job ?? ''} onChange={(e) => set('job', e.target.value || undefined)}>
              <option value="">미지정</option>
              {JOBS.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            기본 권한 (태스크가 따로 정하지 않을 때)
            <select
              value={d.permission ?? ''}
              onChange={(e) => set('permission', (e.target.value || undefined) as Draft['permission'])}
            >
              <option value="">기본 (CLI에 따라)</option>
              <option value="read">읽기만</option>
              <option value="edit">파일 수정</option>
              <option value="exec">명령 실행</option>
            </select>
          </label>
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
            무응답 제한(분) — 이 시간 동안 아무 반응이 없으면 중지
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

type CardState = { busy?: 'install' | 'check' | 'login'; log?: string; msg?: string; ok?: boolean; needsLogin?: boolean }

/** ① 설치 → ② 로그인 → ③ 연결 확인, all from inside the app. */
export function CliSetup({
  detected,
  agents,
  onRedetect
}: {
  detected: AdapterInfo[] | null
  agents: Agent[]
  onRedetect: () => Promise<void>
}): JSX.Element {
  const [st, setSt] = useState<Partial<Record<AdapterId, CardState>>>({})
  const patch = (id: AdapterId, p: CardState): void =>
    setSt((s) => ({ ...s, [id]: { ...s[id], ...p } }))

  useEffect(
    () =>
      window.hive.onEvent((e) => {
        if (e.type !== 'setup' || !e.adapter) return
        const id = e.adapter
        setSt((s) => ({ ...s, [id]: { ...s[id], log: ((s[id]?.log ?? '') + (e.chunk ?? '')).slice(-4000) } }))
      }),
    []
  )

  const install = async (id: AdapterId): Promise<void> => {
    patch(id, { busy: 'install', log: '', msg: '설치하는 중이에요. 1~2분 걸릴 수 있어요…', ok: undefined })
    const r = await window.hive.installCli(id)
    patch(id, { busy: undefined, msg: r.ok ? '설치했어요. 이제 "로그인"을 눌러 주세요.' : r.message, ok: r.ok ? undefined : false })
    await onRedetect()
  }

  const login = async (id: AdapterId): Promise<void> => {
    const r = await window.hive.openLogin(id)
    patch(id, { msg: r.message, ok: r.ok ? undefined : false })
  }

  const check = async (id: AdapterId): Promise<void> => {
    patch(id, { busy: 'check', msg: '확인하는 중이에요…', ok: undefined })
    const r = await window.hive.checkCli(id)
    let msg = r.message
    if (r.ok && !agents.some((a) => a.adapter === id)) {
      await window.hive.saveAgent({ name: SHORT_NAME[id], adapter: id, role: '' })
      msg = `연결됐어요! "${SHORT_NAME[id]}" 에이전트를 만들었어요. 태스크 보드에서 바로 일을 맡길 수 있어요.`
    }
    patch(id, { busy: undefined, ok: r.ok, needsLogin: r.needsLogin, msg })
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>AI 연결하기</h2>
        <button className="sm ghost" onClick={() => void onRedetect()}>
          다시 확인
        </button>
      </div>
      <p className="muted small">
        ① 설치 → ② 로그인 → ③ 연결 확인. 연결되면 에이전트가 자동으로 만들어져요. API 키는 필요 없어요. 각자
        계정(무료·구독)으로 로그인해요.
      </p>
      <div className="cli-grid">
        {!detected && <div className="muted">확인 중…</div>}
        {detected?.map((d) => {
          const s = st[d.id] ?? {}
          const connected = s.ok === true || (agents.some((a) => a.adapter === d.id) && s.ok !== false)
          return (
            <div key={d.id} className={'cli ' + (connected ? 'ok' : d.found ? 'half' : 'no')}>
              <div className="cli-name">
                {d.found ? '●' : '○'} {d.label}
              </div>
              <div className="small muted">
                {connected ? '연결됨' : d.found ? `설치됨 ${d.version ?? ''} · 로그인 확인 필요` : '설치 안 됨'}
              </div>
              <div className="row">
                {!d.found && d.canInstall && (
                  <button className="primary sm" disabled={!!s.busy} onClick={() => void install(d.id)}>
                    {s.busy === 'install' ? '설치 중…' : '① 설치'}
                  </button>
                )}
                {d.found && (
                  <>
                    <button className={'sm' + (s.needsLogin ? ' primary' : '')} disabled={!!s.busy} onClick={() => void login(d.id)}>
                      ② 로그인
                    </button>
                    <button className={'sm' + (!connected && !s.needsLogin ? ' primary' : '')} disabled={!!s.busy} onClick={() => void check(d.id)}>
                      {s.busy === 'check' ? '확인 중…' : '③ 연결 확인'}
                    </button>
                  </>
                )}
              </div>
              {!d.found && !d.canInstall && d.install && <code className="small">{d.install}</code>}
              {s.msg && <div className={'small ' + (s.ok === false ? 'err-text' : s.ok ? 'ok-inline' : '')}>{s.msg}</div>}
              {s.busy === 'install' && s.log && <pre className="out small-log">{s.log}</pre>}
              {s.ok === false && s.log && !s.busy && <pre className="out small-log">{s.log}</pre>}
              {d.note && <div className="small note">{d.note}</div>}
            </div>
          )
        })}
      </div>
    </section>
  )
}
