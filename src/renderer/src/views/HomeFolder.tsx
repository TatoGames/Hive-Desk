import { useEffect, useState } from 'react'

type Info = { active: boolean; homeDir: string; oldDataDir: string; bootstrapFile: string; portable?: boolean; portableNotice?: string }

/** One-folder mode: keep settings and temp files in a single HiveDesk folder. Off by default. */
export default function HomeFolder(): JSX.Element | null {
  const [info, setInfo] = useState<Info | null>(null)
  const [on, setOn] = useState(false)
  const [dir, setDir] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void Promise.resolve(window.hive.homeGet?.())
      .then((i) => {
        if (!i) return
        setInfo(i)
        setOn(i.active)
        setDir(i.homeDir)
      })
      .catch(() => undefined)
  }, [])
  if (!info) return null
  if (info.portable)
    return (
      <section className="panel form">
        <div className="full">{info.portableNotice ?? `휴대용 모드예요: 데이터는 ${info.homeDir}에만 있어요`}</div>
        <label className="full toggle">
          <input type="checkbox" checked disabled />
          한 폴더 모드 (휴대용 모드에서는 항상 켜져 있어요)
        </label>
      </section>
    )

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.hive.homeSet(on, dir.trim() || info.homeDir)
      setMsg(r.message + (r.ok && on ? ` 옛 위치에 남아 있어요: ${r.leftBehind}` : '') + (r.skipped.length ? ` (이미 있어서 건너뛴 파일: ${r.skipped.join(', ')})` : ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel form">
      <label className="full toggle">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        한 폴더 모드: 설정과 임시 파일을 HiveDesk 폴더 하나에 모아요 (다음 실행부터 적용)
      </label>
      <label className="full">
        HiveDesk 폴더
        <div className="row">
          <input className="grow" value={dir} onChange={(e) => setDir(e.target.value)} />
          <button
            className="sm"
            onClick={async () => {
              const p = await window.hive.pickFolder()
              if (p) setDir(p)
            }}
          >
            찾기
          </button>
        </div>
      </label>
      <div className="muted small full">
        <div>설정은 <code>data</code>, 임시 파일은 <code>tmp</code> 폴더에 둬요. 회사 데이터는 위의 작업공간 폴더 설정을 그대로 따라요(옮기지 않아요).</div>
        <div>켤 때 설정 파일을 복사해요(이동이 아니에요). 복사가 확인된 뒤에만 새 위치를 쓰고, 옛 파일은 지우지 않아요.</div>
        <div>폴더 밖에 한 개가 남아요: <code>{info.bootstrapFile}</code> (모드와 폴더 위치를 적은 작은 파일)</div>
        <div>폴더 밖에 남는 것: Claude·Codex·Antigravity 로그인 정보(각 프로그램이 관리해요), OS 보안 저장소의 암호화 키(토큰 자체는 폴더 안에 있어요), 프로젝트 옆 병렬 작업 폴더(.hive-worktrees), 앱 본체.</div>
      </div>
      <div className="row full">
        <button className="sm primary" disabled={busy} onClick={() => void apply()}>
          적용
        </button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </section>
  )
}
