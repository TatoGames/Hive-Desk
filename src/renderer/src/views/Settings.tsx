import { useEffect, useState } from 'react'
import type { AutoApprove, HandoffSettings, HumanReview, ReviewSettings, Snapshot, SyncResult } from '@shared/types'
import { DEFAULT_AUTO_APPROVE, DEFAULT_HANDOFF, DEFAULT_REVIEW } from '@shared/types'
import { LOCAL_SCOPE_HELP, LOCAL_SCOPE_LABEL, localScopeOf, type LocalScope } from '@shared/localbenefit'
import HomeFolder from './HomeFolder'
import { Glossary, resetHints } from './Help'

export default function Settings({
  snap,
  firstRun,
  onSaved
}: {
  snap: Snapshot
  firstRun: boolean
  onSaved: () => Promise<void>
}): JSX.Element {
  const c = snap.config
  const [name, setName] = useState(c.memberName)
  const [ws, setWs] = useState(c.workspace)
  const [maxC, setMaxC] = useState(c.maxConcurrent)
  const [strip, setStrip] = useState(c.stripApiKeys)
  const [notif, setNotif] = useState(c.notifications !== false)
  const [review, setReview] = useState<HumanReview>(c.humanReview)
  const [trial, setTrial] = useState(Math.round((c.quickTrialRate ?? 0.1) * 100))
  const [liveIn, setLiveIn] = useState(c.liveInstructions !== false)
  const [autoDesign, setAutoDesign] = useState(c.autoDesign !== false)
  const [worktrees, setWorktrees] = useState(firstRun ? true : !!c.parallelWorktrees)
  const [auto, setAuto] = useState<AutoApprove>({ ...DEFAULT_AUTO_APPROVE, ...(c.autoApprove ?? {}) })
  const [hand, setHand] = useState<HandoffSettings>({ ...DEFAULT_HANDOFF, ...(c.handoff ?? {}) })
  const [collect, setCollect] = useState(!!c.collectExamples)
  const [snapOn, setSnapOn] = useState(c.projectSnapshot !== false)
  const [rv, setRv] = useState<ReviewSettings>({ ...DEFAULT_REVIEW, ...(c.review ?? {}) })
  const [samples, setSamples] = useState<{ at: string; adapter: string; text: string }[]>([])
  useEffect(() => {
    if (!firstRun) void window.hive.limitSamples().then(setSamples)
  }, [firstRun])
  const [stale, setStale] = useState(c.staleBundleHours ?? 24)
  const [timeout, setTimeoutH] = useState(c.approvalTimeoutHours ?? 0)
  const [discord, setDiscord] = useState(c.discordWebhook ?? '')
  const [tgToken, setTgToken] = useState(c.telegram?.token ?? '')
  const [tgChat, setTgChat] = useState(c.telegram?.chatId ?? '')
  const [interval, setIntervalMin] = useState(c.syncIntervalMinutes)
  const [remote, setRemote] = useState('')
  const [msg, setMsg] = useState<SyncResult | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (!name.trim()) return setMsg({ ok: false, message: '이름을 입력하세요.' })
    await window.hive.saveSettings({
      memberName: name.trim(),
      workspace: ws.trim() || c.workspace,
      maxConcurrent: Math.max(1, maxC),
      stripApiKeys: strip,
      notifications: notif,
      humanReview: review,
      syncIntervalMinutes: Math.max(0, interval),
      quickTrialRate: Math.min(1, Math.max(0, trial / 100)),
      parallelWorktrees: worktrees,
      autoDesign,
      liveInstructions: liveIn,
      autoApprove: auto,
      handoff: hand,
      review: rv,
      projectSnapshot: snapOn,
      collectExamples: collect,
      staleBundleHours: Math.max(0, stale),
      approvalTimeoutHours: Math.max(0, timeout),
      discordWebhook: discord.trim() || undefined,
      telegram: tgToken.trim() && tgChat.trim() ? { token: tgToken.trim(), chatId: tgChat.trim() } : undefined,
      // someone new starts with the everyday menus; the sidebar switch shows the rest
      ...(firstRun ? { uiMode: 'basic' as const } : {})
    })
    await onSaved()
    setMsg({ ok: true, message: '저장했어요.' })
  }

  const run = async (fn: () => Promise<SyncResult>): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      setMsg(await fn())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>{firstRun ? 'HiveDesk 시작하기' : '설정'}</h1>
      </header>
      {firstRun && (
        <p className="muted">
          이름과 작업공간 폴더만 정하면 바로 시작할 수 있어요. 작업공간에는 태스크, 메시지, 메모리가 작은 파일로
          저장돼요.
        </p>
      )}

      {!firstRun && <HomeFolder />}
      <section className="panel form">
        <label>
          내 이름 (팀원에게 보이는 이름, 에이전트 ID에 들어가요)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: minwoo" />
        </label>
        <label className="full">
          작업공간(hive) 폴더
          <div className="row">
            <input className="grow" value={ws} onChange={(e) => setWs(e.target.value)} />
            <button
              className="sm"
              onClick={async () => {
                const p = await window.hive.pickFolder()
                if (p) setWs(p)
              }}
            >
              찾기
            </button>
            {!firstRun && (
              <button className="sm ghost" onClick={() => void window.hive.openPath(c.workspace)}>
                열기
              </button>
            )}
          </div>
        </label>
        <label>
          동시에 실행할 최대 태스크 수
          <input type="number" min={1} value={maxC} onChange={(e) => setMaxC(Number(e.target.value) || 1)} />
        </label>
        <label title="파일을 바꾸지 않는 작은 일 중 이 비율은 더 가벼운 모델에게 시험 삼아 맡겨 기록을 쌓아요">
          빠른 배정 시험 비율(%)
          <input type="number" min={0} max={100} value={trial} onChange={(e) => setTrial(Number(e.target.value) || 0)} />
        </label>
        <label className="full toggle" title="끄면 예전 방식으로 돌아가요: 지시는 이번 실행이 끝난 뒤에만 반영되고, 일시 정지는 쓸 수 없어요.">
          <input type="checkbox" checked={liveIn} onChange={(e) => setLiveIn(e.target.checked)} />
          실행 중인 Claude에게 지시를 바로 전달하고 일시 정지 사용 (Claude Code 전용)
        </label>
        <label className="full toggle" title="git 폴더의 프로젝트에서는 하위 작업마다 별도 작업 폴더와 브랜치를 만들어 동시에 실행하고, 통합할 때 합쳐요. 충돌이 나면 멈추고 물어봐요.">
          <input type="checkbox" checked={worktrees} onChange={(e) => setWorktrees(e.target.checked)} />
          하위 작업을 별도 작업 폴더(git 작업 트리)에서 동시에 실행 (실험 기능)
        </label>
        <label className="full toggle" title="디자인 지침이 없는 프로젝트의 화면 관련 업무가 처음 실행될 때, 프로젝트 소개에 어울리고 같은 회사의 다른 프로젝트와 겹치지 않는 지침(콘셉트·색·글꼴·구성)을 프로젝트 설명에 넣어요. 프로젝트 화면에서 고치거나 지울 수 있어요.">
          <input type="checkbox" checked={autoDesign} onChange={(e) => setAutoDesign(e.target.checked)} />
          화면 업무에 프로젝트마다 다른 디자인 지침을 자동으로 넣기
        </label>
        <fieldset className="full">
          <legend>결재 자동 승인 (삭제·배포·외부 전송·명령 실행은 절대 자동 승인하지 않아요)</legend>
          <label className="toggle">
            <input type="checkbox" checked={auto.readToEdit} onChange={(e) => setAuto({ ...auto, readToEdit: e.target.checked })} />
            읽기 전용 업무가 작업 폴더에 파일을 쓰려 하면 &lsquo;파일 수정&rsquo;으로 올려 승인
          </label>
          <label>
            계획의 예상 실행이 기준을 이 비율(%) 안에서 넘으면 승인 (0 = 끔)
            <input type="number" min={0} max={100} value={auto.planOverPercent} onChange={(e) => setAuto({ ...auto, planOverPercent: Number(e.target.value) || 0 })} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={auto.planSmaller} onChange={(e) => setAuto({ ...auto, planSmaller: e.target.checked })} />
            반려한 계획이 더 적은 실행 수로 다시 오면 승인
          </label>
        </fieldset>
        <fieldset className="full">
          <legend>한도 이어받기 — 연결(계정)의 사용 한도가 차면 다른 연결의 직원이 마지막 단계부터 이어서 해요</legend>
          <label className="toggle">
            <input type="checkbox" checked={hand.auto} onChange={(e) => setHand({ ...hand, auto: e.target.checked })} />
            한도가 차면 자동으로 이어받기 (끄면 한도가 풀릴 때까지 기다려요)
          </label>
          <label className="toggle">
            <input type="checkbox" checked={hand.up} onChange={(e) => setHand({ ...hand, up: e.target.checked })} />
            같은 체급이 없으면 위 체급 직원에게도 넘기기
          </label>
          <label>
            한 단계 위 체급으로 넘기면서 사용량 가중치가 이 배수 이상 오르면 결재함에 물어요 (같은 체급은 그냥 넘겨요) (0 = 묻지 않음)
            <input type="number" min={0} step={0.5} value={hand.confirmAtCostX} onChange={(e) => setHand({ ...hand, confirmAtCostX: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
          <label>
            한도가 이 시간(분) 안에 풀리면 넘기지 않고 기다려요 (풀리는 시각을 알 때만)
            <input type="number" min={0} value={hand.waitMinutes} onChange={(e) => setHand({ ...hand, waitMinutes: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={hand.rollbackStep} onChange={(e) => setHand({ ...hand, rollbackStep: e.target.checked })} />
            진행 중이던 단계는 그 단계 시작 상태로 되돌리고 넘기기 (git 폴더)
          </label>
          <label>
            내 PC AI 사용 범위
            <select aria-label="내 PC AI 사용 범위" value={localScopeOf(hand)} onChange={(e) => setHand({ ...hand, localScope: e.target.value as LocalScope, allowLocal: e.target.value !== 'off' })}>
              {(['off', 'easy', 'limit-only'] as LocalScope[]).map((k) => (
                <option key={k} value={k}>
                  {LOCAL_SCOPE_LABEL[k]}{k === 'easy' ? ' (기본)' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">{LOCAL_SCOPE_HELP[localScopeOf(hand)]} 이력이 쌓인 만큼 따져서, 이득이 없는 일은 넘기지 않아요.</p>
          <p className="muted small">같은 연결의 직원은 같은 한도를 쓰기 때문에 언제나 제외해요. 이미 거쳐 간 연결로는 되돌아가지 않아요.</p>
          {!!samples.length && (
            <details>
              <summary className="small">한도처럼 보였지만 알아보지 못한 실패 {samples.length}건 (감지 규칙을 고치는 데 써요)</summary>
              {samples
                .slice()
                .reverse()
                .map((x, i) => (
                  <pre key={i} className="out small-log">
                    {x.at.slice(0, 16).replace('T', ' ')} · {x.adapter}
                    {'\n'}
                    {x.text}
                  </pre>
                ))}
            </details>
          )}
        </fieldset>
        <fieldset className="full">
          <legend>자동 검사와 AI 검토 — 앱이 먼저 공짜로 확인하고, AI 검토는 필요할 때만 해요</legend>
          <label className="toggle">
            <input type="checkbox" checked={rv.checks} onChange={(e) => setRv({ ...rv, checks: e.target.checked })} />
            작업이 끝나면 프로젝트의 테스트·타입 검사·린트를 앱이 직접 돌려요 (실패하면 AI 검토 없이 바로 담당자에게 돌려보내요)
          </label>
          <label className="toggle">
            <input type="checkbox" checked={rv.appCheck} onChange={(e) => setRv({ ...rv, appCheck: e.target.checked })} />
            Electron 앱이면 직접 띄워서 오류를 보고 화면을 찍어요 (찍은 화면은 검토자에게 보여 줘요)
          </label>
          <label className="toggle">
            <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} />
            직원이 일을 시작할 때 프로젝트 요약(폴더 구조·실행 스크립트·README·최근 끝낸 일)을 앱이 먼저 보여 줘요 — 매번 폴더를 훑는 토큰을 아껴요
          </label>
          <label className="toggle">
            <input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} />
            내 PC AI가 한 일을 예시로 모아 둬요 (기본은 꺼짐)
          </label>
          <div className="muted small">
            켜면 내 PC AI 직원이 한 일마다 &quot;요청, 준 파일, 받은 수정본, 검사 결과, 시도 횟수, 사람이 승인했는지&quot;를 회사 폴더의 .local/examples/날짜.jsonl에 한 줄씩 저장해요. 비밀번호·키처럼 보이는 글자는 ***로 바꿔서 저장하고, 이 컴퓨터 밖으로는 보내지 않아요. 나중에 모델을 더 잘 쓰게 다듬을 때 쓸 준비일 뿐, 지금은 학습하지 않아요.
            {snap.companyRoot && (
              <>
                {' '}
                <button className="sm ghost" onClick={() => void window.hive.openPath(snap.companyRoot.replace(/[\\/]+$/, '') + (snap.companyRoot.includes('\\') ? '\\.local\\examples' : '/.local/examples'))}>
                  예시 폴더 열기
                </button>
              </>
            )}
          </div>
          <label>
            AI 검토
            <select value={rv.policy} onChange={(e) => setRv({ ...rv, policy: e.target.value as ReviewSettings['policy'] })}>
              <option value="risk">필요할 때만 — 작고 안전한 변경이 검사를 통과하면 생략 (추천)</option>
              <option value="always">언제나 — 모든 변경을 다른 모델이 검토</option>
            </select>
          </label>
          <label>
            큰 일(묶음)의 하위 작업 검토
            <select value={rv.bundle} disabled={rv.policy === 'always'} onChange={(e) => setRv({ ...rv, bundle: e.target.value as ReviewSettings['bundle'] })}>
              <option value="once">통합한 뒤 한 번에 — 하위 작업마다 하지 않아요 (추천)</option>
              <option value="each">하위 작업마다 따로</option>
            </select>
          </label>
          <label>
            같은 담당자에게 돌려보내는 횟수 (넘으면 윗 직책에게 올려요)
            <select value={rv.maxRounds} onChange={(e) => setRv({ ...rv, maxRounds: Number(e.target.value) })}>
              <option value={1}>1번</option>
              <option value={2}>2번</option>
              <option value={3}>3번</option>
            </select>
          </label>
          <p className="muted small">민감한 파일(로그인·토큰·결제·설정·배포), 많이 지우는 변경, 큰 변경은 "필요할 때만"이어도 언제나 검토해요.</p>
        </fieldset>
        {!firstRun && (
          <fieldset className="full">
            <legend>도움말</legend>
            <p className="muted small">처음 쓰는 말은 화면의 작은 <b>?</b>를 누르면 설명이 나와요. 화면마다 처음 한 번 뜨는 안내는 아래 버튼으로 다시 볼 수 있어요.</p>
            <div className="row">
              <button type="button" className="sm" onClick={() => (resetHints(), setMsg({ ok: true, message: '화면 안내를 다시 보여 줄게요.' }))}>
                화면 안내 다시 보기
              </button>
            </div>
            <details>
              <summary className="small">용어 풀이</summary>
              <Glossary />
            </details>
          </fieldset>
        )}
        <label>
          손대지 않은 묶음은 이 시간(시간) 뒤 다시 시작하기 전에 물어요 (0 = 안 물어봄)
          <input type="number" min={0} value={stale} onChange={(e) => setStale(Number(e.target.value) || 0)} />
        </label>
        <label>
          결재를 이 시간(시간) 동안 못 받으면 기본 처리해요 (0 = 계속 기다림)
          <input type="number" min={0} value={timeout} onChange={(e) => setTimeoutH(Number(e.target.value) || 0)} />
        </label>
        <fieldset className="full">
          <legend>휴대폰 알림 (선택)</legend>
          <label>
            Discord 웹훅 주소
            <input value={discord} placeholder="https://discord.com/api/webhooks/…" onChange={(e) => setDiscord(e.target.value)} />
          </label>
          <label>
            Telegram 봇 토큰
            <input value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
          </label>
          <label>
            Telegram 채팅 ID
            <input value={tgChat} onChange={(e) => setTgChat(e.target.value)} />
          </label>
        </fieldset>
        <label className="full">
          결과 확인 (완료로 처리하기 전에 사람이 보는 단계)
          <select value={review} onChange={(e) => setReview(e.target.value as HumanReview)}>
            <option value="changes">파일을 바꾼 작업만 확인 (권장)</option>
            <option value="always">모든 작업 확인 (읽기만 하는 작업 제외)</option>
            <option value="off">확인 없이 바로 완료</option>
          </select>
        </label>
        <label className="toggle full">
          <input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} />
          API 키 환경변수 숨기기 (권장) — CLI가 API 과금 대신 내 로그인 계정을 쓰도록 해요
        </label>
        <label className="toggle full">
          <input type="checkbox" checked={notif} onChange={(e) => setNotif(e.target.checked)} />
          데스크톱 알림 — 승인·자료 요청·결과 확인·실패·보고서가 생기면 알려줘요
        </label>
        <div className="row end full">
          <button className="primary" onClick={() => void save()}>
            {firstRun ? '시작하기' : '저장'}
          </button>
        </div>
      </section>

      {!firstRun && (
        <section className="panel form">
          <h2 className="full">팀 공유 (선택)</h2>
          <p className="muted small full">
            작업공간을 GitHub 비공개 저장소로 동기화하면 팀원끼리 태스크·메시지·메모리를 함께 봐요. 각자의 AI
            계정과 예산 기록은 공유되지 않아요. 컴퓨터에 git이 설치되어 있고 GitHub에 로그인돼 있어야 해요.
          </p>
          {!snap.gitEnabled ? (
            <>
              <label className="full">
                공유 저장소 주소 (팀원 모두 같은 주소)
                <input
                  value={remote}
                  onChange={(e) => setRemote(e.target.value)}
                  placeholder="https://github.com/우리팀/our-hive.git"
                />
              </label>
              <div className="row end full">
                <button
                  className="primary"
                  disabled={busy || !remote.trim()}
                  onClick={() => void run(() => window.hive.enableSharing(remote))}
                >
                  공유 켜기
                </button>
              </div>
            </>
          ) : (
            <>
              <label>
                자동 동기화 간격(분, 0 = 수동)
                <input
                  type="number"
                  min={0}
                  value={interval}
                  onChange={(e) => setIntervalMin(Number(e.target.value) || 0)}
                />
              </label>
              <div className="row end full">
                <button className="ghost" onClick={() => void save()}>
                  간격 저장
                </button>
                <button className="primary" disabled={busy} onClick={() => void run(() => window.hive.sync())}>
                  {busy ? '동기화 중…' : '지금 동기화'}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {msg && <div className={msg.ok ? 'ok-text' : 'err-text'}>{msg.message}</div>}
    </div>
  )
}
