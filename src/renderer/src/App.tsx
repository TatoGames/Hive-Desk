import { useEffect, useRef, useState } from 'react'
import { useHive } from './store'
import Board from './views/Board'
import Agents from './views/Agents'
import Connections from './views/Connections'
import External from './views/External'
import Boardroom from './views/Boardroom'
import Collab from './views/Collab'
import Committee from './views/Committee'
import Performance from './views/Performance'
import Reports from './views/Reports'
import Projects from './views/Projects'
import Company from './views/Company'
import Inbox from './views/Inbox'
import Approvals from './views/Approvals'
import Settings from './views/Settings'
import Start, { startSteps } from './views/Start'

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

type Tab = 'start' | 'boardroom' | 'collab' | 'connections' | 'external' | 'board' | 'company' | 'projects' | 'reports' | 'committee' | 'performance' | 'agents' | 'inbox' | 'approvals' | 'settings'

export default function App(): JSX.Element {
  const { snap, output, live, refresh } = useHive()
  const [tab, setTab] = useState<Tab>('board')
  const routed = useRef(false)
  const update = useUpdateNotice()

  // Not ready to work yet → open the start screen first.
  useEffect(() => {
    if (!snap || routed.current || !snap.config.memberName) return
    routed.current = true
    if (!startSteps(snap).done && (!snap.config.agents.length || snap.config.uiMode === 'basic')) setTab('start')
  }, [snap])

  if (!snap) return <div className="loading">불러오는 중…</div>

  const needsSetup = !snap.config.memberName
  const pending =
    snap.approvals.filter((a) => a.status === 'pending').length +
    snap.tasks.filter((t) => t.status === 'needs_input' || t.status === 'needs_review').length
  const unread = snap.messages.filter((m) => !m.read).length
  const current: Tab = needsSetup ? 'settings' : tab

  const otherWaiting = snap.companies.filter((c) => !c.active).reduce((n, c) => n + c.waiting, 0)
  const steps = startSteps(snap)
  const basic = snap.config.uiMode === 'basic'
  type Item = { id: Tab; label: string; badge?: number; advanced?: boolean; hint?: string }
  // menus grouped by what people do: the work, the team, and the rest (shown in advanced mode, or when something waits there)
  const groups: { title: string; items: Item[] }[] = [
    {
      title: '일',
      items: [
        ...(!steps.done ? [{ id: 'start' as Tab, label: '시작하기', hint: 'AI 연결 → 팀 꾸리기 → 첫 일 맡기기' }] : []),
        { id: 'approvals', label: '내가 할 일', badge: pending, hint: '결재, 질문, 확인할 결과가 모여요' },
        { id: 'board', label: '업무', hint: '맡긴 일과 진행 상황 (오피스 · 작업 현황 · 목록)' },
        { id: 'reports', label: '보고서함', badge: snap.tasks.filter((t) => t.kind === 'integrate' && !t.parentId && t.status === 'needs_review').length, hint: '끝난 일의 결과 보고서' },
        { id: 'projects', label: '프로젝트', hint: '작업 폴더와 프로젝트 설명' }
      ]
    },
    {
      title: '팀',
      items: [
        { id: 'company', label: '회사 · 조직도', hint: '팀 꾸리기, 자리와 직원' },
        { id: 'agents', label: '에이전트', hint: '직원 한 명 한 명의 설정' },
        { id: 'connections', label: 'AI 연결', hint: 'Claude · Codex · Antigravity 로그인과 모델' },
        { id: 'performance', label: '성과', advanced: true }
      ]
    },
    {
      title: '더보기',
      items: [
        { id: 'boardroom', label: '이사회 (모든 회사)', badge: otherWaiting, advanced: snap.companies.length < 2 },
        { id: 'committee', label: 'CEO 위원회', badge: snap.company.agendas.filter((a) => a.phase === 'board').length, advanced: true },
        { id: 'collab', label: '협업', badge: snap.collab.requests.filter((r) => r.status === 'pending').length, advanced: true },
        { id: 'external', label: '외부 연결', badge: snap.approvals.filter((a) => a.status === 'pending' && a.kind === 'external').length, advanced: true },
        { id: 'inbox', label: '메시지 · 메모리', badge: unread, advanced: true }
      ]
    },
    { title: '', items: [{ id: 'settings', label: '설정' }] }
  ]
  const shown = (t: Item): boolean => !basic || !t.advanced || !!t.badge || current === t.id

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="logo">⬢</span> HiveDesk
        </div>
        {snap.companies.length > 0 && (
          <div className="switcher">
            <select
              value={snap.companies.find((c) => c.active)?.id ?? ''}
              onChange={(e) => void window.hive.switchCompany(e.target.value)}
              title="회사 전환 — 회사끼리는 데이터가 완전히 분리돼 있어요"
            >
              {snap.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {!c.active && c.waiting ? ` (${c.waiting})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <nav>
          {groups.map((g) => {
            const items = g.items.filter(shown)
            if (!items.length) return null
            return (
              <div key={g.title || 'end'} className="nav-group">
                {g.title && <div className="nav-title">{g.title}</div>}
                {items.map((t) => (
                  <button
                    key={t.id}
                    className={'nav' + (current === t.id ? ' on' : '') + (t.id === 'start' ? ' nav-start' : '')}
                    disabled={needsSetup && t.id !== 'settings'}
                    onClick={() => setTab(t.id)}
                    title={t.hint}
                  >
                    <span>{t.label}</span>
                    {!!t.badge && <span className={'badge' + (t.id === 'approvals' ? ' warn' : '')}>{t.badge}</span>}
                  </button>
                ))}
              </div>
            )
          })}
        </nav>
        {!needsSetup && (
          <label className="mode-toggle small" title="기본: 매일 쓰는 메뉴만 · 고급: 위원회·협업·외부 연결 등 모든 메뉴">
            <input type="checkbox" checked={!basic} onChange={(e) => void window.hive.saveSettings({ uiMode: e.target.checked ? 'advanced' : 'basic' }).then(refresh)} /> 고급 메뉴 보기
          </label>
        )}
        <div className="side-foot">
          <div className="who">{snap.config.memberName || '이름 미설정'}</div>
          <div className="muted small">
            {snap.gitEnabled ? '팀 공유 켜짐' : '로컬 전용'} · {snap.config.autoRun ? '자동 실행 켜짐' : '자동 실행 꺼짐'}{snap.config.autoRunOrg === false ? ' · 조직 진행 꺼짐' : snap.config.autoRun ? '' : ' · 조직 자동 진행 켜짐 (위임 업무는 계속 돌아요)'}
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
        {current === 'start' && <Start snap={snap} go={(t) => setTab(t)} />}
        {current === 'boardroom' && <Boardroom snap={snap} goBoard={() => setTab('board')} />}
        {current === 'collab' && <Collab snap={snap} />}
        {current === 'connections' && <Connections snap={snap} />}
        {current === 'external' && <External snap={snap} />}
        {current === 'board' && <Board snap={snap} output={output} live={live} onGoAgents={() => setTab('agents')} />}
        {current === 'company' && <Company snap={snap} />}
        {current === 'projects' && <Projects snap={snap} />}
        {current === 'reports' && <Reports snap={snap} />}
        {current === 'committee' && <Committee snap={snap} />}
        {current === 'performance' && <Performance snap={snap} />}
        {current === 'agents' && <Agents snap={snap} goBoard={() => setTab('board')} />}
        {current === 'inbox' && <Inbox snap={snap} />}
        {current === 'approvals' && <Approvals snap={snap} />}
        {current === 'settings' && <Settings snap={snap} firstRun={needsSetup} onSaved={refresh} />}
      </main>
    </div>
  )
}
