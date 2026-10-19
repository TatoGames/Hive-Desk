import { useCallback, useEffect, useState } from 'react'
import { TIER_LABEL } from '@shared/company'
import { CANDIDATE_FILTERS, LICENSE_NOTICE, REMOTE_NOTICE, SCOPE_LABEL, endpointProblem, endpointScope, normalizeUrl, filterCandidates, fitNote, fmtBytes, modelTier, needsEasyOnly, pcFit, recommendState, sizeTag, sortCandidates, type CandidateFilter, type CandidateSort, type CandidateView, type LocalModelInfo } from '@shared/localai'
import type { LocalStatus, LocalJob } from '../../../main/local'
import { ConfirmButton } from './Materials'
import OllamaEngineCard from './OllamaEngineCard'

const key = (ep: string, m: string): string => `${ep}|${m}`

/** v6 8-2/8-2b: models that run on this PC (Ollama, LM Studio, ...): connect, measure, install. */
export default function LocalAi(): JSX.Element {
  const [st, setSt] = useState<LocalStatus | null>(null)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** An address of another computer waiting for the person to confirm that what they send goes there. */
  const [remoteOk, setRemoteOk] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const [agreed, setAgreed] = useState<Record<string, boolean>>({})
  const [filters, setFilters] = useState<CandidateFilter[]>([])
  const [sort, setSort] = useState<CandidateSort>('recommend')
  const [showAllKinds, setShowAllKinds] = useState(false)

  const load = useCallback(async () => setSt(await window.hive.localStatus()), [])
  useEffect(() => {
    void window.hive.localRefresh().then(load)
  }, [load])
  useEffect(() => {
    let timer: number | undefined
    const off = window.hive.onEvent((e) => {
      if (e.type !== 'local' || timer) return
      timer = window.setTimeout(() => {
        timer = undefined
        void load()
      }, 200)
    })
    return () => {
      off()
      if (timer) window.clearTimeout(timer)
    }
  }, [load])

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
    await load()
  }
  /** Long jobs: start, show progress through the events, ignore the final result (the status has it). */
  const job = (fn: () => Promise<LocalJob>): void => {
    setErr(null)
    void fn()
      .catch((e: Error) => setErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
      .then(load)
    window.setTimeout(() => void load(), 80)
  }

  const add = (u: string, acceptRemote = false): void => {
    const norm = normalizeUrl(u)
    if (norm && endpointScope(norm) !== 'this-pc') {
      const problem = endpointProblem(norm, !!token.trim())
      if (problem) return setErr(problem)
      if (!acceptRemote) return setRemoteOk(u) // asked once, before the first connection to another computer
    }
    setRemoteOk(null)
    setBusy(true)
    void run(async () => {
      try {
        await window.hive.localAdd({ url: u, token: token.trim() || undefined, acceptRemote })
        setUrl('')
        setToken('')
      } finally {
        setBusy(false)
      }
    })
  }

  if (!st) return <div className="panel muted small">내 PC AI를 확인하는 중…</div>
  const installedAll = new Set(st.endpoints.flatMap((e) => (e.state?.models ?? []).map((m) => key(e.id, m.name))))
  const ollamaEp = st.endpoints.find((e) => (e.state?.kind ?? e.kind) === 'ollama' && e.state?.ok)
  const views: CandidateView[] = ollamaEp
    ? st.candidates.models.map((c) => ({
        c,
        installed: installedAll.has(key(ollamaEp.id, c.id)),
        fit: pcFit(c, st.advice),
        rec: recommendState(c, st.advice, st.bench[key(ollamaEp.id, c.id)])
      }))
    : []
  const shown = sortCandidates(filterCandidates(views, filters, showAllKinds), sort)
  const running = st.jobs.filter((j) => j.state === 'running')

  return (
    <div className="panel local-ai">
      <div className="panel-head">
        <h2>내 PC AI</h2>
      </div>
      <p className="muted small">
        Ollama나 LM Studio처럼 <b>이 PC(또는 같은 네트워크의 PC)에서 도는 AI</b>를 연결하면 챗에서 쓸 수 있어요. 키가 필요 없고 구독 한도도 쓰지 않아요. 대신 PC 성능만큼만 빨라요.
      </p>
      <p className="muted small">Ollama를 이미 설치했다면 아래에서 연결하고, 설치하지 않았다면 HiveDesk 폴더에 바로 받을 수 있어요.</p>

      <OllamaEngineCard onChanged={() => void load()} />

      <div className="local-pc">
        <b>이 PC</b>: 메모리 {st.pc.ramGB}GB · 코어 {st.pc.cores}개
        {st.pc.gpu ? ` · ${st.pc.gpu.name} ${st.pc.gpu.vramGB}GB` : st.pc.appleSilicon ? ' · Apple 칩' : ''}
        <div>
          추천 등급 <span className="chip">{TIER_LABEL[st.advice.tier]}</span> <span className="muted small">{st.advice.reasons.join(' · ')}</span>{' '}
          <button className="sm ghost" onClick={() => void run(async () => (await window.hive.localRefresh(), undefined))}>
            다시 확인
          </button>
        </div>
        <div className="muted small">등급은 PC 사양과 직접 잰 속도로 정해요. 아래 모델의 <b>속도 재기</b>를 해 보면 더 정확해져요.</div>
      </div>

      <div className="row local-add">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="주소 (예: localhost:11434)" onKeyDown={(e) => e.key === 'Enter' && url.trim() && add(url)} />
        <button className="primary" disabled={busy || !url.trim()} onClick={() => add(url)}>
          연결
        </button>
        <button className="sm primary" disabled={busy} onClick={() => add('localhost:11434')}>
          Ollama
        </button>
        <button className="sm ghost" disabled={busy} onClick={() => add('localhost:1234')}>
          LM Studio
        </button>
        <button className="sm ghost" onClick={() => setShowToken((v) => !v)}>
          다른 PC라면
        </button>
      </div>
      {showToken && (
        <div className="muted small">
          다른 PC의 주소(예: 192.168.0.5:11434)도 쓸 수 있어요. 그 PC가 토큰을 요구하면 아래에 넣어요(이 컴퓨터의 보안 저장소에 암호화해 저장해요). 같은 네트워크 밖이나 믿을 수 없는 곳의 주소는 쓰지 마세요.
          <div>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="토큰 (필요할 때만)" />
          </div>
        </div>
      )}
      {remoteOk && (
        <div className="warn-box small" role="alert">
          <b>{remoteOk}</b>는 이 PC가 아니에요. {REMOTE_NOTICE}
          <div className="row">
            <button className="sm primary" onClick={() => add(remoteOk, true)}>
              알겠어요, 연결
            </button>
            <button className="sm ghost" onClick={() => setRemoteOk(null)}>
              취소
            </button>
          </div>
        </div>
      )}
      {err && <div className="warn-text small">{err}</div>}

      {st.endpoints.map((e) => (
        <div key={e.id} className="local-ep">
          <div className="row">
            <b>{e.name}</b> <span className="chip">{SCOPE_LABEL[endpointScope(e.url)]}</span> <span className="muted small">{e.url}</span>
            <span className={'chip ' + (e.state?.ok ? 'ok' : 'bad')}>{e.state ? (e.state.ok ? `연결됨${e.state.version ? ' · ' + e.state.version : ''}` : '연결 안 됨') : '확인 중'}</span>
            <ConfirmButton label="연결 끊기" onConfirm={() => run(() => window.hive.localRemove(e.id))} />
          </div>
          {e.state && !e.state.ok && <div className="warn-text small">{e.state.error}</div>}
          {e.state?.ok && !e.state.models.length && <div className="muted small">설치된 모델이 없어요. 아래에서 설치해 보세요.</div>}
          {e.state?.models.map((m) => (
            <ModelRow key={m.name} m={m} ep={e.id} st={st} kind={e.state?.kind} onRun={run} onJob={job} installing={running.some((j) => j.model === m.name && j.endpointId === e.id)} />
          ))}
        </div>
      ))}

      {st.jobs.map((j) => (
        <div key={j.id} className="local-job small">
          <b>{j.kind === 'pull' ? '설치' : j.kind === 'bench' ? '실측' : '속도'}</b> {j.model} — {j.text}
          {j.state === 'running' && j.fraction !== undefined && (
            <div className="bar">
              <div className="fill" style={{ width: `${Math.round(j.fraction * 100)}%` }} />
            </div>
          )}
          {j.state === 'running' ? (
            <button className="sm" onClick={() => void window.hive.localStop(j.id)}>
              중지
            </button>
          ) : j.state === 'stopped' && j.kind === 'pull' ? (
            <button className="sm" onClick={() => job(() => window.hive.localPull(j.endpointId, j.model))}>
              이어받기
            </button>
          ) : null}
        </div>
      ))}

      <details className="local-install" open={!!ollamaEp && !installedAll.size}>
        <summary>
          <b>모델 설치 (Ollama)</b>
        </summary>
        {!ollamaEp && <div className="muted small">Ollama를 연결하면 여기서 모델을 내려받을 수 있어요. (LM Studio는 그 프로그램에서 설치해 주세요.)</div>}
        <div className="muted small license-note">{LICENSE_NOTICE}</div>
        {ollamaEp && (
          <div className="local-filters small">
            {CANDIDATE_FILTERS.map((f) => (
              <button key={f} className={'chip' + (filters.includes(f) ? ' on' : '')} aria-pressed={filters.includes(f)} onClick={() => setFilters(filters.includes(f) ? filters.filter((x) => x !== f) : [...filters, f])}>
                {f}
              </button>
            ))}{' '}
            <label>
              정렬{' '}
              <select value={sort} onChange={(e) => setSort(e.target.value as CandidateSort)}>
                <option value="recommend">추천순</option>
                <option value="size">크기순</option>
              </select>
            </label>{' '}
            <label>
              <input type="checkbox" checked={showAllKinds} onChange={(e) => setShowAllKinds(e.target.checked)} /> 검색용·사진 전용도 보기
            </label>
            <div className="muted">&quot;추천&quot;은 이 PC에서 잘 맞고 실측을 통과한 모델에만 붙어요. 실측 전에는 &quot;추천 후보&quot;로만 보여요.</div>
            {!shown.length && <div className="muted">조건에 맞는 모델이 없어요. 필터를 줄여 보세요.</div>}
          </div>
        )}
        {shown.map(({ c, installed: have, fit, rec }) => {
          const note = fitNote({ name: c.id, paramsB: c.paramsB }, st.advice)
          return (
            <div key={c.id} className="local-cand">
              <b>{c.label}</b> <span className="chip">{TIER_LABEL[c.tier]}</span> <span className="muted small">{c.approxGB ? `약 ${c.approxGB}GB` : '용량 미확인'} · {c.licenseName}</span>{' '}
              <span className="local-tags">
                <span className="chip">{sizeTag(c)}</span>
                {fit && <span className={'chip ' + (fit === '잘 맞아요' ? 'ok' : 'warn')}>{fit}</span>}
                {rec === 'recommended' && <span className="chip ok">추천</span>}
                {rec === 'candidate' && <span className="chip">추천 후보</span>}
                {have && <span className="chip">설치됨</span>}
                {c.tags.map((t) => (
                  <span key={t} className={'chip' + (t === '라이선스 확인 전' ? ' warn' : '')}>
                    {t}
                  </span>
                ))}
              </span>{' '}
              {c.licenseUrl && (
                <a href={c.licenseUrl} target="_blank" rel="noreferrer" className="small">
                  조건 보기
                </a>
              )}
              {c.note && <div className="muted small">{c.note}</div>}
              {needsEasyOnly(c) && <div className="muted small">쉬운 일만 범위에서만 직원으로 쓸 수 있어요</div>}
              {note && <div className="warn-text small">{note}</div>}
              {!have && (
                <>
                  <label className="small">
                    <input type="checkbox" checked={!!agreed[c.id]} onChange={(e) => setAgreed({ ...agreed, [c.id]: e.target.checked })} /> 조건을 직접 확인했어요
                  </label>{' '}
                  <button className="sm primary" disabled={!agreed[c.id]} onClick={() => job(() => window.hive.localPull(ollamaEp!.id, c.id))}>
                    설치
                  </button>
                </>
              )}
            </div>
          )
        })}
        {ollamaEp && (
          <div className="row">
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="다른 모델 이름 (예: gemma2:9b)" />
            <label className="small">
              <input type="checkbox" checked={!!agreed['_custom']} onChange={(e) => setAgreed({ ...agreed, _custom: e.target.checked })} /> 조건을 직접 확인했어요
            </label>
            <button className="sm primary" disabled={!custom.trim() || !agreed['_custom']} onClick={() => (job(() => window.hive.localPull(ollamaEp.id, custom.trim())), setCustom(''))}>
              설치
            </button>
          </div>
        )}
      </details>
    </div>
  )
}

function ModelRow({
  m,
  ep,
  st,
  kind,
  onRun,
  onJob,
  installing
}: {
  m: LocalModelInfo
  ep: string
  st: LocalStatus
  kind?: string
  onRun: (fn: () => Promise<unknown>) => Promise<void>
  onJob: (fn: () => Promise<LocalJob>) => void
  installing: boolean
}): JSX.Element {
  const k = key(ep, m.name)
  const sp = st.speed[k]
  const bn = st.bench[k]
  const fit = fitNote(m, st.advice)
  const [open, setOpen] = useState(false)
  return (
    <div className="local-model">
      <b>{m.name}</b> <span className="chip">{TIER_LABEL[modelTier(m)]}</span>{' '}
      <span className="muted small">
        {m.sizeBytes ? fmtBytes(m.sizeBytes) : ''}
        {m.paramsB ? ` · ${m.paramsB}B` : ''}
        {m.quant ? ` · ${m.quant}` : ''}
      </span>
      {sp && <span className="small"> · 초당 {sp.perSec.toFixed(1)}토큰{sp.estimated ? '(추정)' : ''}</span>}
      {bn && (
        <span className="small">
          {' '}
          · 실측 {bn.passed}/{bn.total}개 통과 (중간 {(bn.medianMs / 1000).toFixed(0)}초)
        </span>
      )}
      {bn && (
        <button className="sm ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '결과 접기' : '결과 보기'}
        </button>
      )}
      {bn && open && (
        <ul className="bench-rows small">
          {bn.rows.map((r) => (
            <li key={r.id} className={r.ok ? 'muted' : 'warn-text'}>
              {r.ok ? '통과' : '실패'} · {r.title} ({(r.ms / 1000).toFixed(0)}초)
              {!r.ok && r.reason ? ` — ${r.reason}` : ''}
            </li>
          ))}
        </ul>
      )}
      {fit && <div className="warn-text small">{fit}</div>}
      <div className="row">
        <button className="sm" disabled={installing} onClick={() => onJob(() => window.hive.localSpeed(ep, m.name))}>
          속도 재기
        </button>
        <button className="sm" disabled={installing} title="작은 수정 10개를 시켜 시간과 통과 수를 재요 (몇 분 걸려요)" onClick={() => onJob(() => window.hive.localBench(ep, m.name))}>
          실측(10개)
        </button>
        {kind === 'ollama' && (
          <>
            <button className="sm" disabled={installing} title="새 버전이 있으면 받아요" onClick={() => onJob(() => window.hive.localPull(ep, m.name))}>
              업데이트
            </button>
            <ConfirmButton label="지우기" onConfirm={() => onRun(() => window.hive.localDeleteModel(ep, m.name))} />
          </>
        )}
      </div>
    </div>
  )
}
