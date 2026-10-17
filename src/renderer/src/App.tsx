import { useEffect, useRef, useState } from 'react'
import { useHive } from './store'
import Board from './views/Board'
import Agents from './views/Agents'
import Projects from './views/Projects'
import Company from './views/Company'
import Inbox from './views/Inbox'
import Approvals from './views/Approvals'
import Settings from './views/Settings'

/** Ask GitHub once at start (and every few hours) whether a newer release exists. */
function useUpdateNotice(): {
  info: { available: boolean; current: string; version?: string; url?: string } | null
  hidden: boolean
  dismiss: () => void
} {
  const [info, setInfo] = useState<{ available: boolean; current: string; version?: string; url?: string } | null>(null)
  const [skipped, setSkipped] = useState<string | null>(() => {
    try {
      return localStorage.getItem('hivedesk.skipUpdate')
    } catch {
      return null
    }
  })
  useEffect(() => {
    let alive = true
    const check = (): void => {
      void window.hive.checkUpdate().then((r) => alive && setInfo(r.available ? r : null))
    }
    check()
    const t = window.setInterval(check, 6 * 60 * 60 * 1000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])
  return {
    info,
    hidden: !info || skipped === info.version,
    dismiss: () => {
      if (!info?.version) return
      setSkipped(info.version)
      try {
        localStorage.setItem('hivedesk.skipUpdate', info.version)
      } catch {
        /* a per-session dismissal is fine */
      }
    }
  }
}

type Tab = 'board' | 'company' | 'projects' | 'agents' | 'inbox' | 'approvals' | 'settings'

export default function App(): JSX.Element {
  const { snap, output, live, refresh } = useHive()
  const [tab, setTab] = useState<Tab>('board')
  const routed = useRef(false)
  const update = useUpdateNotice()

  // No AI connected yet → open the setup screen first.
  useEffect(() => {
    if (!snap || routed.current || !snap.config.memberName) return
    routed.current = true
    if (!snap.config.agents.length) setTab('agents')
  }, [snap])

  if (!snap) return <div className="loading">불러오는 중…</div>

  const needsSetup = !snap.config.memberName
  const pending =
    snap.approvals.filter((a) => a.status === 'pending').length +
    snap.tasks.filter((t) => t.status === 'needs_input' || t.status === 'needs_review').length
  const unread = snap.messages.filter((m) => !m.read).length
  const current: Tab = needsSetup ? 'settings' : tab

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'board', label: '태스크 보드' },
    { id: 'company', label: '회사' },
    { id: 'projects', label: '프로젝트' },
    { id: 'agents', label: '에이전트' },
    { id: 'inbox', label: '메시지 · 메모리', badge: unread },
    { id: 'approvals', label: '승인·확인·자료 요청', badge: pending },
    { id: 'settings', label: '설정' }
  ]

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="logo">⬢</span> HiveDesk
        </div>
        <nav>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={'nav' + (current === t.id ? ' on' : '')}
              disabled={needsSetup && t.id !== 'settings'}
              onClick={() => setTab(t.id)}
            >
              <span>{t.label}</span>
              {!!t.badge && <span className={'badge' + (t.id === 'approvals' ? ' warn' : '')}>{t.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <div className="who">{snap.config.memberName || '이름 미설정'}</div>
          <div className="muted small">
            {snap.gitEnabled ? '팀 공유 켜짐' : '로컬 전용'} · 자동 실행 {snap.config.autoRun ? 'ON' : 'OFF'}
          </div>
        </div>
      </aside>
      <main className="main">
        {update.info && !update.hidden && (
          <div className="update-bar">
            <span>
              새 버전 <b>v{update.info.version}</b>이 나왔어요 (지금 v{update.info.current}).
            </span>
            {update.info.url && (
              <button className="sm primary" onClick={() => void window.hive.openUrl(update.info!.url!)}>
                받으러 가기
              </button>
            )}
            <button className="sm ghost" onClick={update.dismiss}>
              나중에
            </button>
          </div>
        )}
        {current === 'board' && <Board snap={snap} output={output} live={live} onGoAgents={() => setTab('agents')} />}
        {current === 'company' && <Company snap={snap} />}
        {current === 'projects' && <Projects snap={snap} />}
        {current === 'agents' && <Agents snap={snap} goBoard={() => setTab('board')} />}
        {current === 'inbox' && <Inbox snap={snap} />}
        {current === 'approvals' && <Approvals snap={snap} />}
        {current === 'settings' && <Settings snap={snap} firstRun={needsSetup} onSaved={refresh} />}
      </main>
    </div>
  )
}
