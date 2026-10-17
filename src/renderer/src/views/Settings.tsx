import { useState } from 'react'
import type { HumanReview, Snapshot, SyncResult } from '@shared/types'

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
  const [review, setReview] = useState<HumanReview>(c.humanReview)
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
      humanReview: review,
      syncIntervalMinutes: Math.max(0, interval)
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
