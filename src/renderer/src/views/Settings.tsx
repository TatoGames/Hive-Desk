import { useState } from 'react'
import type { AutoApprove, HumanReview, Snapshot, SyncResult } from '@shared/types'
import { DEFAULT_AUTO_APPROVE } from '@shared/types'

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
  const [worktrees, setWorktrees] = useState(!!c.parallelWorktrees)
  const [auto, setAuto] = useState<AutoApprove>({ ...DEFAULT_AUTO_APPROVE, ...(c.autoApprove ?? {}) })
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
      liveInstructions: liveIn,
      autoApprove: auto,
      staleBundleHours: Math.max(0, stale),
      approvalTimeoutHours: Math.max(0, timeout),
      discordWebhook: discord.trim() || undefined,
      telegram: tgToken.trim() && tgChat.trim() ? { token: tgToken.trim(), chatId: tgChat.trim() } : undefined
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
