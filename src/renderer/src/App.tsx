import { useEffect, useRef, useState } from 'react'
import { useHive } from './store'
import Board from './views/Board'
import Agents from './views/Agents'
import Inbox from './views/Inbox'
import Approvals from './views/Approvals'
import Settings from './views/Settings'

type Tab = 'board' | 'agents' | 'inbox' | 'approvals' | 'settings'

export default function App(): JSX.Element {
  const { snap, output, refresh } = useHive()
  const [tab, setTab] = useState<Tab>('board')
  const routed = useRef(false)

  // No AI connected yet → open the setup screen first.
  useEffect(() => {
    if (!snap || routed.current || !snap.config.memberName) return
    routed.current = true
    if (!snap.config.agents.length) setTab('agents')
  }, [snap])

  if (!snap) return <div className="loading">불러오는 중…</div>

  const needsSetup = !snap.config.memberName
  const pending = snap.approvals.filter((a) => a.status === 'pending').length
  const unread = snap.messages.filter((m) => !m.read).length
  const current: Tab = needsSetup ? 'settings' : tab

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'board', label: '태스크 보드' },
    { id: 'agents', label: '에이전트' },
    { id: 'inbox', label: '메시지 · 메모리', badge: unread },
    { id: 'approvals', label: '승인 대기', badge: pending },
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
        {current === 'board' && <Board snap={snap} output={output} />}
        {current === 'agents' && <Agents snap={snap} goBoard={() => setTab('board')} />}
        {current === 'inbox' && <Inbox snap={snap} />}
        {current === 'approvals' && <Approvals snap={snap} />}
        {current === 'settings' && <Settings snap={snap} firstRun={needsSetup} onSaved={refresh} />}
      </main>
    </div>
  )
}
