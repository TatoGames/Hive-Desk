import { useEffect, useState } from 'react'
import type { Snapshot } from '@shared/types'
import type { TeamSummary } from '@shared/team'
import { TEMPLATES } from '@shared/templates'
import { fmtTime } from '../store'
import { ConfirmButton } from './Materials'

/** v0.6: a whole team in one click, saved teams to set up again, and employees copied from another company. */
export function QuickTeam({ snap, compact }: { snap: Snapshot; compact?: boolean }): JSX.Element {
  const [tpl, setTpl] = useState('team-project')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const connected = snap.connections.filter((c) => c.check?.ok)
  const go = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.hive.quickTeam(tpl)
      setMsg({ ok: true, text: `자리 ${r.seats}개 중 ${r.hired}개에 AI를 앉혔어요.${r.missing ? ` 빈 자리 ${r.missing}개는 연결된 AI가 맞지 않아 비워 뒀어요.` : ''}` })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel quick-team">
      <h2>{compact ? '팀 다시 꾸리기' : '한 번에 팀 꾸리기'}</h2>
      <p className="muted small">
        연결된 AI({connected.length ? connected.map((c) => c.adapter).join(', ') : '아직 없음'})로 조직도와 직원을 한 번에 만들어요. 계획·검토는 강한 모델, 구현은 실속 모델, 검토자는
        만든 사람과 다른 모델로 자동 배치해요.{compact ? ' 지금 조직도는 새 것으로 바뀌어요 (기존 직원과 업무는 남아요).' : ''}
      </p>
      <div className="row">
        <select value={tpl} onChange={(e) => setTpl(e.target.value)}>
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button className="primary" disabled={busy} onClick={() => void go()}>
          {busy ? '꾸리는 중…' : '팀 꾸리기'}
        </button>
      </div>
      <p className="muted small">{TEMPLATES.find((t) => t.id === tpl)?.description}</p>
      {msg && <div className={msg.ok ? 'ok-text small' : 'warn-text small'}>{msg.text}</div>}
    </section>
  )
}

export function SavedTeams({ snap }: { snap: Snapshot }): JSX.Element {
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const load = (): void => void window.hive.listTeams().then(setTeams)
  useEffect(load, [snap])
  const hasOrg = !!snap.company.company
  return (
    <section className="panel">
      <h2>저장한 팀</h2>
      <p className="muted small">조직도와 직원 구성을 저장해 두고 다른 회사에서 그대로 꾸릴 수 있어요. 작업 폴더는 저장하지 않아요 (회사 폴더를 써요).</p>
      {!teams.length && <div className="empty small">아직 저장한 팀이 없어요.</div>}
      {teams.map((t) => (
        <div key={t.id} className="row between team-row">
          <div>
            <b>{t.name}</b>
            <div className="muted small">
              {t.from}에서 저장 · {fmtTime(t.savedAt)} · 조직 {t.units} · 자리 {t.seats} · 직원 {t.members}
              {t.adapters ? ` (${t.adapters})` : ''}
            </div>
          </div>
          <div className="row">
            <ConfirmButton
              label="이 회사에 꾸리기"
              onConfirm={async () => {
                const r = await window.hive.applyTeam(t.id)
                setMsg(`직원 ${r.hired}명을 꾸렸어요.${r.skipped.length ? ` 빠진 직원: ${r.skipped.join(', ')}` : ''}`)
              }}
            />
            <ConfirmButton label="삭제" onConfirm={async () => (await window.hive.deleteTeam(t.id), load())} />
          </div>
        </div>
      ))}
      {hasOrg && (
        <div className="row">
          <input className="grow" placeholder="저장할 팀 이름 (예: 기본 개발팀)" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            onClick={async () => {
              const t = await window.hive.saveTeam(name)
              setName('')
              setMsg(`"${t.name}" 팀을 저장했어요 (직원 ${t.members}명).`)
              load()
            }}
          >
            지금 팀 저장
          </button>
        </div>
      )}
      {msg && <div className="ok-text small">{msg}</div>}
    </section>
  )
}

/** Employees of another company, copied into this one (same settings, no seat). */
export function CopyAgents({ snap }: { snap: Snapshot }): JSX.Element | null {
  const others = snap.companies.filter((c) => !c.active)
  const [from, setFrom] = useState(others[0]?.id ?? '')
  const [list, setList] = useState<{ id: string; name: string; adapter: string; model: string }[]>([])
  const [pick, setPick] = useState<string[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    if (from) void window.hive.agentsOf(from).then((l) => (setList(l), setPick([])))
  }, [from])
  if (!others.length) return null
  return (
    <section className="panel">
      <h2>다른 회사 직원 데려오기</h2>
      <div className="row">
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          {others.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          disabled={!pick.length}
          onClick={async () => {
            const n = await window.hive.copyAgents(from, pick)
            setMsg(`${n}명을 데려왔어요. 회사 탭에서 자리에 앉혀 주세요.`)
            setPick([])
          }}
        >
          {pick.length ? `${pick.length}명 데려오기` : '데려올 직원을 고르세요'}
        </button>
      </div>
      <div className="chips">
        {list.map((a) => (
          <label key={a.id} className={'chip' + (pick.includes(a.id) ? ' on' : '')}>
            <input type="checkbox" checked={pick.includes(a.id)} onChange={(e) => setPick(e.target.checked ? [...pick, a.id] : pick.filter((x) => x !== a.id))} /> {a.name}
            <span className="muted small"> {a.adapter}{a.model ? ` · ${a.model}` : ''}</span>
          </label>
        ))}
        {!list.length && <span className="muted small">이 회사에는 직원이 없어요.</span>}
      </div>
      {msg && <div className="ok-text small">{msg}</div>}
    </section>
  )
}
