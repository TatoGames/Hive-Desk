import { useEffect, useState } from 'react'
import type { AdapterInfo, Snapshot } from '@shared/types'
import { CliSetup } from './Agents'
import { QuickTeam } from './Teams'

/** What is left to do before the company can work: an AI connected, a team, a first task. */
export function startSteps(snap: Snapshot): { connected: boolean; team: boolean; task: boolean; done: boolean } {
  const connected = snap.connections.some((c) => c.check?.ok)
  const team = snap.company.seats.some((s) => !!s.agentId) || snap.config.agents.filter((a) => (a.companyId ?? '') === '' || snap.companies.find((c) => c.active)?.id === a.companyId).length > 1
  const task = snap.tasks.some((t) => !t.hidden && t.createdBy !== 'system' && !t.title.startsWith('연결 테스트'))
  return { connected, team, task, done: connected && team && task }
}

const EXAMPLES = [
  '단위 변환기 웹페이지를 만들어줘. index.html 하나에 길이·무게·온도 변환을 넣고, 숫자를 입력하면 바로 바뀌게.',
  '이 폴더의 README.md를 읽고 설치 방법과 사용법을 초보자도 알 수 있게 다시 써줘.',
  '할 일 목록을 관리하는 파이썬 명령줄 프로그램을 만들어줘. 추가·완료·삭제·목록 보기, 데이터는 JSON 파일에 저장.'
]

/** v0.6 start screen: three steps, each with the button that does it. */
export default function Start({ snap, go }: { snap: Snapshot; go: (tab: 'board' | 'company' | 'connections') => void }): JSX.Element {
  const [detected, setDetected] = useState<AdapterInfo[] | null>(null)
  const detect = async (): Promise<void> => {
    setDetected(null)
    setDetected(await window.hive.detectAdapters())
  }
  useEffect(() => {
    void detect()
  }, [])
  const s = startSteps(snap)
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const give = async (): Promise<void> => {
    if (!text.trim()) return
    await window.hive.createTask({ title: text.trim().split(/[.\n]/)[0].slice(0, 60), description: text.trim() })
    setSent(true)
    setText('')
  }
  const mark = (ok: boolean, n: number): string => (ok ? '✓' : String(n))

  return (
    <div className="page start">
      <header className="page-head">
        <h1>시작하기</h1>
        {s.done && (
          <button className="primary" onClick={() => go('board')}>
            업무 보러 가기
          </button>
        )}
      </header>
      <p className="muted">세 단계면 AI 직원들이 일을 시작해요. 다 하면 이 화면은 메뉴에서 사라져요.</p>

      <section className={'panel step' + (s.connected ? ' done' : ' now')}>
        <h2>
          <span className="step-no">{mark(s.connected, 1)}</span> 쓰고 있는 AI 로그인하기
        </h2>
        <p className="muted small">
          쓰고 있는 구독(Claude Pro/Max, ChatGPT Plus/Pro, Google 계정)의 프로그램을 설치하고 로그인해요. 하나만 있어도 되고, 둘 이상이면 서로 검토하고 한도가 차면 이어받을
          수 있어요.
        </p>
        <CliSetup detected={detected} agents={snap.config.agents} onRedetect={detect} />
      </section>

      <section className={'panel step' + (s.team ? ' done' : s.connected ? ' now' : '')}>
        <h2>
          <span className="step-no">{mark(s.team, 2)}</span> 팀 꾸리기
        </h2>
        {s.team ? (
          <p className="muted small">
            팀이 있어요.{' '}
            <button className="sm ghost" onClick={() => go('company')}>
              조직도 보기
            </button>
          </p>
        ) : (
          <QuickTeam snap={snap} />
        )}
      </section>

      <section className={'panel step' + (s.task ? ' done' : s.team ? ' now' : '')}>
        <h2>
          <span className="step-no">{mark(s.task, 3)}</span> 첫 일 맡기기
        </h2>
        <p className="muted small">하고 싶은 일을 평소 말하듯 적으면 돼요. 누구에게 맡길지, 나눠서 할지는 앱이 정해요.</p>
        <textarea rows={3} placeholder="예: 단위 변환기 웹페이지를 만들어줘…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <button className="primary" disabled={!text.trim()} onClick={() => void give()}>
            맡기기
          </button>
          {sent && (
            <button className="ghost" onClick={() => go('board')}>
              맡겼어요 — 진행 보러 가기
            </button>
          )}
        </div>
        <div className="muted small">예시 (누르면 채워져요):</div>
        <div className="examples">
          {EXAMPLES.map((e) => (
            <button key={e} className="sm ghost example" onClick={() => setText(e)}>
              {e}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
