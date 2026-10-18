import { useEffect, useState } from 'react'
import type { AdapterInfo, Snapshot } from '@shared/types'
import { CliSetup } from './Agents'
import { QuickTeam } from './Teams'
import { ConfirmButton } from './Materials'

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
  const [sent, setSent] = useState<{ dir: string } | null>(null)
  const [folder, setFolder] = useState('')
  const [git, setGit] = useState<'ok' | 'none' | 'not-top' | 'no-commit' | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const pick = async (): Promise<void> => {
    const p = await window.hive.pickFolder()
    if (!p) return
    setFolder(p)
    setNote(null)
    setGit(await window.hive.folderGit(p))
  }
  const give = async (): Promise<void> => {
    if (!text.trim()) return
    const r = await window.hive.startFirstTask(text, folder || undefined)
    if (!r.ok) return setNote({ ok: false, text: r.warning ?? '업무를 만들지 못했어요.' })
    setSent({ dir: r.dir })
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
        <div className="folder-pick">
          <div className="row">
            <b className="small">작업 폴더</b>
            <button className="sm" onClick={() => void pick()}>
              {folder ? '다른 폴더 고르기' : '폴더 고르기'}
            </button>
            {folder && (
              <button className="sm ghost" onClick={() => (setFolder(''), setGit(null), setNote(null))}>
                고르지 않기
              </button>
            )}
          </div>
          <div className="muted small">
            {folder ? <span title={folder}>📂 {folder}</span> : `고르지 않으면 앱의 회사 폴더에서 작업해요 (${snap.companyRoot || snap.config.workspace}). 이미 만들어 둔 프로젝트 폴더를 고르는 걸 추천해요.`}
          </div>
          {folder && git && git !== 'ok' && (
            <div className="small">
              {git === 'not-top'
                ? '이 폴더는 다른 git 폴더의 하위 폴더예요. 그대로도 쓸 수 있지만, 일이 동시에 돌려면 git의 맨 위 폴더를 고르세요.'
                : '이 폴더는 아직 git 폴더가 아니에요. 그대로도 쓸 수 있지만, git 폴더로 만들면 변경 비교·정확한 되돌리기·동시 작업을 쓸 수 있어요.'}
              {git !== 'not-top' && (
                <ConfirmButton
                  label="git 폴더로 만들기"
                  onConfirm={async () => {
                    const r = await window.hive.initFolderGit(folder)
                    setNote({ ok: r.ok, text: r.message })
                    setGit(await window.hive.folderGit(folder))
                  }}
                />
              )}
            </div>
          )}
          {note && <div className={note.ok ? 'ok-text small' : 'warn-text small'}>{note.text}</div>}
        </div>
        <textarea rows={3} placeholder="예: 단위 변환기 웹페이지를 만들어줘…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <button className="primary" disabled={!text.trim()} onClick={() => void give()}>
            맡기기
          </button>
          {sent && (
            <>
              <button className="ghost" onClick={() => go('board')}>
                맡겼어요 — 진행 보러 가기
              </button>
              <button className="ghost" onClick={() => void window.hive.openPath(sent.dir)}>
                결과가 생길 폴더 열기
              </button>
            </>
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
