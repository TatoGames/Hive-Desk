import { useEffect, useMemo, useState } from 'react'
import type { Snapshot } from '@shared/types'
import {
  JOBS,
  TIER_LABEL,
  jobLabel,
  modelLabel,
  type ModelEntry,
  type OrgUnit,
  type Seat,
  type Tier
} from '@shared/company'
import { MIN_SAMPLES, aptitudeBoard, recommendReassignments } from '@shared/aptitude'
import { checkPlacement, seatModelKey, type PlacementInput } from '@shared/placement'
import { TEMPLATES } from '@shared/templates'
import { fmtTime } from '../store'
import { ConfirmButton } from './Materials'
import { CopyAgents, QuickTeam, SavedTeams } from './Teams'

type Section = 'org' | 'models' | 'perf'

export default function Company({ snap }: { snap: Snapshot }): JSX.Element {
  const [section, setSection] = useState<Section>('org')
  const c = snap.company
  return (
    <div className="page">
      <header className="page-head">
        <h1>회사{c.company ? ` · ${c.company.name}` : ''}</h1>
        <div className="seg">
          {(
            [
              ['org', '조직도'],
              ['models', '모델 카탈로그'],
              ['perf', '성과·적성']
            ] as [Section, string][]
          ).map(([id, label]) => (
            <button key={id} className={section === id ? 'on' : ''} onClick={() => setSection(id)}>
              {label}
            </button>
          ))}
        </div>
      </header>
      {section === 'org' && <Org snap={snap} />}
      {section === 'models' && <Models snap={snap} />}
      {section === 'perf' && <Perf snap={snap} />}
    </div>
  )
}

function modelOf(snap: Snapshot, id?: string): ModelEntry | undefined {
  return id ? snap.company.catalog.find((m) => m.id === id) : undefined
}

function ModelBadge({ snap, seat }: { snap: Snapshot; seat: Seat }): JSX.Element {
  const agent = seat.agentId ? snap.roster.find((r) => r.id === seat.agentId) : undefined
  const id = agent ? agent.modelId : seat.modelId
  const m = modelOf(snap, id)
  if (agent && !m) return <span className="tag">{agent.model ?? 'CLI 기본값'}</span>
  if (!m) return <span className="tag">모델 미정</span>
  const bad = snap.company.availability[m.id]?.ok === false
  return (
    <span className={'tag' + (bad ? ' warn' : '')} title={TIER_LABEL[m.tier]}>
      {modelLabel(m)}
      {agent ? '' : ' (추천)'}
    </span>
  )
}

function Org({ snap }: { snap: Snapshot }): JSX.Element {
  const c = snap.company
  const [tpl, setTpl] = useState('game-studio')
  const [name, setName] = useState('')
  const [editUnit, setEditUnit] = useState<(Partial<OrgUnit> & { name: string }) | null>(null)
  const [editSeat, setEditSeat] = useState<(Partial<Seat> & { unitId: string; title: string }) | null>(null)
  const [auto, setAuto] = useState(false)

  const input: PlacementInput = useMemo(
    () => ({
      units: c.units,
      seats: c.seats,
      agents: snap.roster.map((r) => ({ id: r.id, adapter: r.adapter, modelId: r.modelId, model: r.model })),
      catalog: c.catalog
    }),
    [c, snap.roster]
  )
  const findings = useMemo(() => (c.company ? checkPlacement(c.company, input) : []), [c.company, input])

  if (!c.company) {
    return (
      <>
      <QuickTeam snap={snap} />
      <SavedTeams snap={snap} />
      <section className="panel">
        <h2>직접 만들기</h2>
        <p className="muted small">템플릿을 고르면 조직도, 직급, 자리별 추천 모델이 한 번에 만들어져요. 나중에 모두 고칠 수 있어요.</p>
        <div className="tpl-list">
          {TEMPLATES.map((t) => (
            <label key={t.id} className={'tpl' + (tpl === t.id ? ' on' : '')}>
              <input type="radio" name="tpl" checked={tpl === t.id} onChange={() => setTpl(t.id)} />
              <div>
                <div className="title">{t.name}</div>
                <div className="muted small">{t.description}</div>
                <div className="muted small">직급: {t.ranks.join(' > ')}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="row">
          <input className="grow" placeholder="회사 이름" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" onClick={() => void window.hive.applyTemplate(tpl, name, true)}>
            만들기
          </button>
        </div>
      </section>
      </>
    )
  }

  const company = c.company
  const rankName = (id: string): string => company.ranks.find((r) => r.id === id)?.name ?? ''
  const children = (parent: string | null): OrgUnit[] => c.units.filter((u) => u.parentId === parent)

  const renderUnit = (u: OrgUnit, depth: number): JSX.Element => {
    const seats = c.seats.filter((s) => s.unitId === u.id)
    const unitFindings = findings.filter((f) => f.unitId === u.id)
    return (
      <div key={u.id} className="unit" style={{ marginLeft: depth ? 18 : 0 }}>
        <div className="row between">
          <div className="title">
            {u.name} <span className="tag">{u.kind}</span>
            {u.mission && <span className="muted small"> {u.mission}</span>}
          </div>
          <div className="row">
            <button className="sm ghost" onClick={() => setEditSeat({ unitId: u.id, title: '', job: 'build' })}>
              + 자리
            </button>
            <button className="sm ghost" onClick={() => setEditUnit({ name: '', kind: '팀', parentId: u.id })}>
              + 하위 조직
            </button>
            <button className="sm ghost" onClick={() => setEditUnit({ ...u })}>
              수정
            </button>
            <ConfirmButton label="삭제" onConfirm={() => window.hive.deleteUnit(u.id)} />
          </div>
        </div>
        {unitFindings.map((f, i) => (
          <div key={i} className={f.level === 'warn' ? 'warn-text small' : 'muted small'}>
            {f.level === 'warn' ? '⚠ ' : 'ℹ '}
            {f.text}
          </div>
        ))}
        <div className="seats">
          {seats.map((s) => {
            const agent = s.agentId ? snap.roster.find((r) => r.id === s.agentId) : undefined
            return (
              <div
                key={s.id}
                className="seat"
                onDragOver={(e) => e.dataTransfer.types.includes('text/model-agent') && e.preventDefault()}
                onDrop={(e) => {
                  const ma = e.dataTransfer.getData('text/model-agent')
                  if (ma && (!s.agentId || window.confirm('이 자리에 이미 직원이 있어요. 새 직원을 채용해 자리를 바꿀까요? (기존 직원은 남아 있어요)'))) {
                    e.preventDefault()
                    void window.hive.hireToSeat(s.id, ma)
                  }
                }}
              >
                <div>
                  <b>{s.title}</b> <span className="muted small">{rankName(s.rankId)} · {jobLabel(s.job)}</span>
                </div>
                <div className="row">
                  <ModelBadge snap={snap} seat={s} />
                  <select
                    value={s.agentId ?? ''}
                    onChange={(e) => void window.hive.assignSeat(s.id, e.target.value || null)}
                  >
                    <option value="">{agent ? '자리 비우기' : '(비어 있음) 에이전트 배치…'}</option>
                    {snap.roster.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} · {r.owner}
                      </option>
                    ))}
                  </select>
                  <button className="sm ghost" onClick={() => setEditSeat({ ...s })}>
                    수정
                  </button>
                  <ConfirmButton label="삭제" onConfirm={() => window.hive.deleteSeat(s.id)} />
                </div>
              </div>
            )
          })}
        </div>
        {children(u.id).map((ch) => renderUnit(ch, depth + 1))}
      </div>
    )
  }

  const ceoFindings = findings.filter((f) => !f.unitId)

  return (
    <>
      <section className="panel">
        <div className="row between">
          <h2>{company.name}</h2>
          <div className="row">
            <button className="primary" onClick={() => setAuto(true)}>추천 AI 자동 연결…</button>
            <button onClick={() => void window.hive.placeModels(true)}>빈 자리 모델 추천 채우기</button>
            <button onClick={() => void window.hive.placeModels(false)}>모든 자리 모델 다시 추천</button>
            <button className="primary" onClick={() => setEditUnit({ name: '', kind: '본부', parentId: null })}>
              + 최상위 조직
            </button>
          </div>
        </div>
        <p className="muted small">
          직급: {company.ranks.map((r) => r.name).join(' > ')} · 추천 모델은 &lsquo;(추천)&rsquo;으로 표시돼요. 에이전트를 자리에 배치하면 그
          에이전트의 실제 모델이 기준이 돼요.
        </p>
        {ceoFindings.map((f, i) => (
          <div key={i} className={f.level === 'warn' ? 'warn-text small' : 'muted small'}>
            {f.level === 'warn' ? '⚠ ' : 'ℹ '}
            {f.text}
          </div>
        ))}
        {children(null).map((u) => renderUnit(u, 0))}
        {!c.units.length && <div className="empty">조직이 비어 있어요. [+ 최상위 조직]으로 시작하세요.</div>}
      </section>

      <RulesAndRanks snap={snap} />

      <SavedTeams snap={snap} />
      <CopyAgents snap={snap} />
      <QuickTeam snap={snap} compact />

      <section className="panel">
        <h2>회사 다시 만들기 (빈 자리로)</h2>
        <p className="muted small">다른 템플릿을 적용하면 지금의 조직도와 자리가 새 것으로 바뀌어요 (에이전트와 태스크는 그대로예요).</p>
        <div className="row">
          <select value={tpl} onChange={(e) => setTpl(e.target.value)}>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <ConfirmButton label="이 템플릿으로 교체" onConfirm={() => window.hive.applyTemplate(tpl, company.name, true)} />
        </div>
      </section>

      {auto && <AutoConnect onClose={() => setAuto(false)} />}
      {editUnit && <UnitDialog snap={snap} draft={editUnit} onClose={() => setEditUnit(null)} />}
      {editSeat && <SeatDialog snap={snap} draft={editSeat} onClose={() => setEditSeat(null)} />}
    </>
  )
}

function RulesAndRanks({ snap }: { snap: Snapshot }): JSX.Element | null {
  const company = snap.company.company
  const [ranks, setRanks] = useState(company?.ranks.map((r) => r.name) ?? [])
  if (!company) return null
  const rules = company.rules
  const set = (k: keyof typeof rules, v: boolean): void => void window.hive.saveCompany({ rules: { ...rules, [k]: v } })
  const saveRanks = (): void =>
    void window.hive.saveCompany({
      ranks: ranks
        .map((n) => n.trim())
        .filter(Boolean)
        .map((name, i) => ({ id: company.ranks[i]?.id ?? 'rank-' + Date.now() + i, name, level: i + 1 }))
    })
  return (
    <div className="two-col">
      <section className="panel">
        <h2>모델 배치 규칙</h2>
        <label className="toggle">
          <input type="checkbox" checked={rules.minModelsPerTeam} onChange={(e) => set('minModelsPerTeam', e.target.checked)} />
          팀 안에 모델 2개 이상
        </label>
        <label className="toggle">
          <input type="checkbox" checked={rules.reviewerDiffers} onChange={(e) => set('reviewerDiffers', e.target.checked)} />
          검토자는 작업자와 다른 모델 (같거나 높은 체급)
        </label>
        <label className="toggle">
          <input type="checkbox" checked={rules.ceoTrioDiffers} onChange={(e) => set('ceoTrioDiffers', e.target.checked)} />
          CEO들은 서로 다른 모델
        </label>
        <label className="small">
          &ldquo;큰 일&rdquo;로 보는 예상 AI 실행 횟수 (위임 기능에서 쓰여요)
          <input
            type="number"
            value={company.bigJobRuns}
            onChange={(e) => void window.hive.saveCompany({ bigJobRuns: Math.max(1, Number(e.target.value) || 20) })}
          />
        </label>
      </section>
      <section className="panel">
        <h2>직급</h2>
        <p className="muted small">위에서 아래 순서예요. 이름을 고치거나 줄을 추가·삭제할 수 있어요.</p>
        {ranks.map((r, i) => (
          <div key={i} className="row">
            <span className="muted small">{i + 1}단계</span>
            <input className="grow" value={r} onChange={(e) => setRanks(ranks.map((x, k) => (k === i ? e.target.value : x)))} />
            <button className="sm ghost" disabled={ranks.length <= 1} onClick={() => setRanks(ranks.filter((_, k) => k !== i))}>
              빼기
            </button>
          </div>
        ))}
        <div className="row">
          <button className="sm" onClick={() => setRanks([...ranks, ''])}>
            + 직급 추가
          </button>
          <button className="sm primary" onClick={saveRanks}>
            저장
          </button>
        </div>
      </section>
    </div>
  )
}

function UnitDialog({ snap, draft, onClose }: { snap: Snapshot; draft: Partial<OrgUnit> & { name: string }; onClose: () => void }): JSX.Element {
  const [d, setD] = useState(draft)
  const [err, setErr] = useState('')
  const save = async (): Promise<void> => {
    if (!d.name.trim()) return setErr('이름을 입력하세요.')
    try {
      await window.hive.saveUnit(d)
      onClose()
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{d.id ? '조직 수정' : '조직 추가'}</h2>
        <div className="form">
          <label>
            이름
            <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </label>
          <label>
            종류 (본부 / 실 / 팀 / 파트 …)
            <input value={d.kind ?? ''} onChange={(e) => setD({ ...d, kind: e.target.value })} />
          </label>
          <label className="full">
            상위 조직
            <select value={d.parentId ?? ''} onChange={(e) => setD({ ...d, parentId: e.target.value || null })}>
              <option value="">(최상위)</option>
              {snap.company.units
                .filter((u) => u.id !== d.id)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="full">
            미션
            <input value={d.mission ?? ''} onChange={(e) => setD({ ...d, mission: e.target.value })} />
          </label>
          <label className="full">
            작업 폴더 이름 (팀 공통 이름)
            <input value={d.folderName ?? ''} onChange={(e) => setD({ ...d, folderName: e.target.value })} />
          </label>
        </div>
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

function SeatDialog({ snap, draft, onClose }: { snap: Snapshot; draft: Partial<Seat> & { unitId: string; title: string }; onClose: () => void }): JSX.Element {
  const [d, setD] = useState(draft)
  const company = snap.company.company
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{d.id ? '자리 수정' : '자리 추가'}</h2>
        <div className="form">
          <label className="full">
            자리 이름
            <input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="예: 서버 개발자" />
          </label>
          <label>
            직급
            <select value={d.rankId ?? company?.ranks[company.ranks.length - 1]?.id} onChange={(e) => setD({ ...d, rankId: e.target.value })}>
              {company?.ranks.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            직무
            <select value={d.job ?? 'build'} onChange={(e) => setD({ ...d, job: e.target.value })}>
              {JOBS.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            일의 성격
            <select value={d.difficulty ?? 'hard'} onChange={(e) => setD({ ...d, difficulty: e.target.value as Seat['difficulty'] })}>
              <option value="hard">어려운 구현·설계 (균형 체급 추천)</option>
              <option value="routine">반복·요약·정리 (경량 체급 추천)</option>
            </select>
          </label>
          <label>
            모델 (직접 고르기)
            <select value={d.modelId ?? ''} onChange={(e) => setD({ ...d, modelId: e.target.value })}>
              <option value="">추천에 맡기기</option>
              {snap.company.catalog.map((m) => (
                <option key={m.id} value={m.id}>
                  {modelLabel(m)} · {TIER_LABEL[m.tier]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row end">
          <button className="ghost" onClick={onClose}>
            취소
          </button>
          <button
            className="primary"
            disabled={!d.title.trim()}
            onClick={async () => {
              await window.hive.saveSeat(d)
              onClose()
            }}
          >
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

function Models({ snap }: { snap: Snapshot }): JSX.Element {
  const [edit, setEdit] = useState<ModelEntry | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<Record<string, string>>({})
  const cat = snap.company.catalog
  const verify = async (id: string): Promise<void> => {
    setBusy(id)
    const r = await window.hive.verifyModel(id)
    setMsg((m) => ({ ...m, [id]: r.message }))
    setBusy('')
  }
  return (
    <section className="panel">
      <div className="row between">
        <h2>모델 카탈로그</h2>
        <button
          className="ghost"
          disabled={busy === 'refresh'}
          title="Antigravity(agy) 로그인 계정이 쓸 수 있는 모델을 CLI에서 직접 받아 와요"
          onClick={async () => {
            setBusy('refresh')
            const r = await window.hive.refreshAccountModels('agy')
            setMsg((m) => ({ ...m, refresh: r.message }))
            setBusy('')
          }}
        >
          {busy === 'refresh' ? '불러오는 중…' : 'agy 계정 모델 불러오기'}
        </button>
        <button
          className="primary"
          onClick={() =>
            setEdit({ id: '', company: '', family: '', version: '', adapter: 'claude', cliArg: '', tier: 'balanced', weight: 1, domains: [] })
          }
        >
          + 모델 추가
        </button>
      </div>
      <p className="muted small">
        체급·한도 무게·잘하는 분야는 참고용 값이에요 (직접 고칠 수 있어요). [사용 확인]은 이 컴퓨터의 로그인 계정으로 그 모델을 한 번
        불러 보고, 되는지 알려 줘요. 사용량이 조금 들어요. <b>미확인</b> 표시는 이름을 아직 확인하지 못한 모델이에요 — 계정 모델
        불러오기나 [사용 확인]으로 확인해 주세요.
      </p>
      {msg.refresh && <div className="small">{msg.refresh}</div>}
      <table className="tbl">
        <thead>
          <tr>
            <th>모델</th>
            <th>CLI</th>
            <th>체급</th>
            <th>한도 무게</th>
            <th>분야</th>
            <th>이 계정</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cat.map((m) => {
            const av = snap.company.availability[m.id]
            return (
              <tr key={m.id}>
                <td>
                  <b>{modelLabel(m)}</b> <span className="muted small">{m.company}</span>{' '}
                  {m.verified ? (
                    <span className="tag" title={`${m.verified.source} · ${m.verified.at}`}>확인됨</span>
                  ) : av?.ok ? null : (
                    <span className="tag warn">미확인</span>
                  )}
                  <div className="muted small">
                    {m.cliArg}
                    {m.aliasArg ? ` · 별칭 ${m.aliasArg}` : ''}
                  </div>
                  {m.note && <div className="muted small">{m.note}</div>}
                </td>
                <td>{m.adapter}</td>
                <td>{TIER_LABEL[m.tier]}</td>
                <td>{m.weight}</td>
                <td className="small">{m.domains.map(jobLabel).join(', ')}</td>
                <td className="small">
                  {av ? (
                    <span className={av.ok ? '' : 'warn-text'}>
                      {av.ok ? '✓ 됨' : '✗ 안 됨'} <span className="muted">{fmtTime(av.at)}</span>
                    </span>
                  ) : (
                    <span className="muted">확인 전</span>
                  )}
                  {msg[m.id] && !av?.ok && <div className="warn-text small">{msg[m.id].slice(0, 120)}</div>}
                </td>
                <td>
                  <div className="row">
                    <button className="sm" disabled={busy === m.id} onClick={() => void verify(m.id)}>
                      {busy === m.id ? '확인 중…' : '사용 확인'}
                    </button>
                    <button className="sm ghost" onClick={() => setEdit({ ...m })}>
                      {m.custom ? '수정' : '고쳐 쓰기'}
                    </button>
                    {m.custom && <ConfirmButton label="삭제" onConfirm={() => window.hive.deleteModel(m.id)} />}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {edit && <ModelDialog draft={edit} onClose={() => setEdit(null)} />}
    </section>
  )
}

function ModelDialog({ draft, onClose }: { draft: ModelEntry; onClose: () => void }): JSX.Element {
  const [d, setD] = useState(draft)
  const [err, setErr] = useState('')
  const save = async (): Promise<void> => {
    try {
      await window.hive.saveModel({ ...d, id: d.id.trim() || `${d.company}-${d.family}-${d.version}`.toLowerCase().replace(/[^a-z0-9]+/g, '-') })
      onClose()
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{draft.id ? '모델 수정' : '모델 추가'}</h2>
        <div className="form">
          <label>
            회사
            <input value={d.company} onChange={(e) => setD({ ...d, company: e.target.value })} />
          </label>
          <label>
            계열
            <input value={d.family} onChange={(e) => setD({ ...d, family: e.target.value })} />
          </label>
          <label>
            버전
            <input value={d.version} onChange={(e) => setD({ ...d, version: e.target.value })} />
          </label>
          <label>
            사용할 CLI
            <select value={d.adapter} onChange={(e) => setD({ ...d, adapter: e.target.value as ModelEntry['adapter'] })}>
              {['claude', 'codex', 'agy', 'custom'].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <label>
            CLI 모델 인자 (정확한 버전)
            <input value={d.cliArg} onChange={(e) => setD({ ...d, cliArg: e.target.value })} />
          </label>
          <label>
            별칭 인자 (최신을 따라감, 없으면 비움)
            <input value={d.aliasArg ?? ''} onChange={(e) => setD({ ...d, aliasArg: e.target.value || undefined })} />
          </label>
          <label>
            체급
            <select value={d.tier} onChange={(e) => setD({ ...d, tier: e.target.value as Tier })}>
              {(Object.keys(TIER_LABEL) as Tier[]).map((t) => (
                <option key={t} value={t}>
                  {TIER_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            한도 무게 (1 = 가장 가벼움)
            <input type="number" value={d.weight} onChange={(e) => setD({ ...d, weight: Number(e.target.value) })} />
          </label>
          <label className="full">
            잘하는 분야
            <div className="row">
              {JOBS.filter((j) => !['ceo', 'coo', 'lead'].includes(j.id)).map((j) => (
                <label key={j.id} className="toggle small">
                  <input
                    type="checkbox"
                    checked={d.domains.includes(j.id)}
                    onChange={(e) =>
                      setD({ ...d, domains: e.target.checked ? [...d.domains, j.id] : d.domains.filter((x) => x !== j.id) })
                    }
                  />
                  {j.label}
                </label>
              ))}
            </div>
          </label>
        </div>
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

function Perf({ snap }: { snap: Snapshot }): JSX.Element {
  const rows = useMemo(() => aptitudeBoard(snap.company.aptitude), [snap.company.aptitude])
  const input = {
    units: snap.company.units,
    seats: snap.company.seats,
    agents: snap.roster.map((r) => ({ id: r.id, adapter: r.adapter, modelId: r.modelId, model: r.model })),
    catalog: snap.company.catalog
  }
  const current = snap.company.seats.flatMap((s) => {
    const key = seatModelKey(s, input)
    const m = modelOf(snap, key ?? undefined)
    return key ? [{ domain: s.job, modelKey: key, modelLabel: m ? modelLabel(m) : key }] : []
  })
  const recs = recommendReassignments(rows, current)
  return (
    <section className="panel">
      <h2>모델 버전 × 분야 적성</h2>
      <p className="muted small">
        태스크가 끝날 때마다 쌓여요: 사람이 확인해 준 비율, 수정 요청 횟수, 걸린 시간. 점수는 통과율을 기준으로 수정 요청이 많거나 오래
        걸리면 깎여요. 태스크가 {MIN_SAMPLES}개 미만이면 참고만 하세요. 새 버전은 기록을 새로 쌓아서 이전 버전과 비교할 수 있어요.
      </p>
      {!!recs.length && (
        <div className="recs">
          <b>재배치 추천</b>
          {recs.map((r, i) => (
            <div key={i} className="small row">
              <span>{r.text}</span>
              <button
                className="sm"
                onClick={() => void window.hive.applyReassignment(r.domain, r.fromKey, r.toKey)}
                title="이 컴퓨터의 해당 분야 에이전트 모델을 바꿔요"
              >
                적용
              </button>
            </div>
          ))}
        </div>
      )}
      {!rows.length && <div className="empty">아직 기록이 없어요. 에이전트에게 직무를 지정하고 태스크를 끝내 보세요.</div>}
      {!!rows.length && (
        <table className="tbl">
          <thead>
            <tr>
              <th>분야</th>
              <th>모델 (버전)</th>
              <th>태스크</th>
              <th>통과율</th>
              <th>수정 요청</th>
              <th>평균 시간</th>
              <th>사용</th>
              <th>점수</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.modelKey + r.domain} className={r.enough ? '' : 'faint'}>
                <td>{jobLabel(r.domain)}</td>
                <td>{r.modelLabel}</td>
                <td>{r.tasks}</td>
                <td>{Math.round(r.passRate * 100)}%</td>
                <td>{r.avgChanges.toFixed(1)}</td>
                <td>{r.avgMinutes.toFixed(1)}분</td>
                <td>
                  {r.runs}회 · {r.minutes}분
                </td>
                <td>
                  <b>{r.score}</b>
                  {!r.enough && <span className="muted small"> 기록 부족</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function AutoConnect({ onClose }: { onClose: () => void }): JSX.Element {
  const [rows, setRows] = useState<import('@shared/connections').AutoRow[] | null>(null)
  const [done, setDone] = useState<number | null>(null)
  useEffect(() => {
    void window.hive.autoConnectPreview().then(setRows)
  }, [])
  const ready = rows?.filter((r) => r.modelAgentId) ?? []
  const total = ready.reduce((n, r) => n + r.weight, 0)
  /** Swap one seat to the closest lighter model (the preview is only changed here; nothing is hired yet). */
  const lighten = (seatId: string): void =>
    setRows((rs) =>
      (rs ?? []).map((r) =>
        r.seatId === seatId && r.lighter
          ? { ...r, chosen: r.lighter.modelId, chosenLabel: r.lighter.label, modelAgentId: r.lighter.modelAgentId, weight: r.lighter.weight, substituted: true, lighter: undefined, note: '직접 가벼운 모델로 바꿨어요.' }
          : r
      )
    )
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <h2>추천 AI 자동 연결</h2>
        <p className="muted small">
          자리마다 추천 모델과, 지금 연결된 AI로 가능한 모델을 보여 드려요. 추천 모델을 쓸 수 없으면 같은 체급의 다른 모델로 대체하고
          표시해요. 확인하면 그 모델을 직원으로 채용해 자리에 앉혀요.
        </p>
        {!rows && <div className="empty">계산하는 중…</div>}
        {rows && !rows.length && <div className="empty">연결할 빈 자리가 없어요.</div>}
        {!!rows?.length && (
          <table className="tbl">
            <thead>
              <tr>
                <th>자리</th>
                <th>추천 모델</th>
                <th>사용 가능</th>
                <th>연결할 모델</th>
                <th title="실행 한 번이 사용 한도를 얼마나 쓰는지 (클수록 빨리 씀)">사용량 가중치</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.seatId}>
                  <td>
                    {r.seatTitle} <span className="muted small">{r.unitName} · {jobLabel(r.job)}</span>
                  </td>
                  <td>{r.recommendedLabel}</td>
                  <td>{r.usable ? '✓' : <span className="warn-text">✗</span>}</td>
                  <td>
                    <b>{r.chosenLabel}</b> {r.substituted && <span className="tag warn">대체</span>}
                    {r.note && <div className="muted small">{r.note}</div>}
                  </td>
                  <td>
                    {r.modelAgentId ? r.weight : '—'}
                    {r.lighter && (
                      <div>
                        <button className="sm" title={`${r.lighter.label} · 가중치 ${r.lighter.weight}`} onClick={() => lighten(r.seatId)}>
                          가벼운 모델로
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="muted small">
                  모든 자리가 한 번씩 실행할 때 쓰는 양 (가중치 합계)
                </td>
                <td>
                  <b>{total}</b>
                </td>
              </tr>
            </tfoot>
          </table>
        )}
        {done !== null && <div className="small">{done}명을 채용해 자리에 앉혔어요.</div>}
        <div className="row end">
          <button onClick={onClose}>닫기</button>
          <button
            className="primary"
            disabled={!ready.length || done !== null}
            onClick={async () => setDone(await window.hive.autoConnectApply(ready.map((r) => ({ seatId: r.seatId, modelAgentId: r.modelAgentId! }))))}
          >
            {ready.length}자리 연결
          </button>
        </div>
      </div>
    </div>
  )
}
