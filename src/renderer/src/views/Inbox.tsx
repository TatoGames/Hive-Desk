import { useState } from 'react'
import type { Snapshot } from '@shared/types'
import { fmtTime } from '../store'
import { ConfirmButton } from './Materials'

export default function Inbox({ snap }: { snap: Snapshot }): JSX.Element {
  const [to, setTo] = useState('')
  const [body, setBody] = useState('')
  const [mem, setMem] = useState('')
  const me = snap.config.memberName

  const send = async (): Promise<void> => {
    if (!to || !body.trim()) return
    await window.hive.sendMessage(me, to, body)
    setBody('')
  }

  const name = (id: string): string => snap.roster.find((r) => r.id === id)?.name ?? id

  return (
    <div className="page">
      <header className="page-head">
        <h1>메시지 · 공유 메모리</h1>
      </header>
      <div className="two-col">
        <section className="panel">
          <h2>메시지함</h2>
          <p className="muted small">
            에이전트에게 보낸 메시지는 다음 실행 때 전달돼요. 에이전트끼리도 서로 메시지를 남겨요.
          </p>
          <div className="row">
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">받는 에이전트…</option>
              {snap.roster.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.owner}
                </option>
              ))}
            </select>
            <input
              className="grow"
              value={body}
              placeholder="메시지"
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void send()}
            />
            <button className="primary" disabled={!to || !body.trim()} onClick={() => void send()}>
              보내기
            </button>
          </div>
          <div className="list">
            {!snap.messages.length && <div className="empty">내 에이전트에게 온 메시지가 없어요.</div>}
            {snap.messages.map((m) => (
              <div key={m.id} className={'msg' + (m.read ? ' read' : '')}>
                <div className="small muted">
                  {name(m.from)} → {name(m.to)} · {fmtTime(m.createdAt)} {m.read ? '· 전달됨' : '· 대기'}
                </div>
                <div>{m.body}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>공유 메모리</h2>
          <p className="muted small">
            모든 에이전트가 매 실행마다 최근 메모리를 함께 읽어요. 프로젝트 규칙, 결정 사항을 적어 두세요.
          </p>
          <div className="row">
            <input
              className="grow"
              value={mem}
              placeholder="예: 커밋 메시지는 한국어로, 패키지 매니저는 pnpm"
              onChange={(e) => setMem(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && mem.trim()) {
                  await window.hive.addMemory(mem)
                  setMem('')
                }
              }}
            />
            <button
              className="primary"
              disabled={!mem.trim()}
              onClick={async () => {
                await window.hive.addMemory(mem)
                setMem('')
              }}
            >
              기록
            </button>
          </div>
          <div className="list">
            {!snap.memory.length && <div className="empty">아직 기록이 없어요.</div>}
            {[...snap.memory].reverse().map((m) => (
              <div key={m.id} className="msg">
                <div className="small muted">
                  {name(m.author)} · {fmtTime(m.createdAt)}
                </div>
                <div className="row between">
                  <div>{m.text}</div>
                  <ConfirmButton label="삭제" onConfirm={() => window.hive.deleteMemory(m.id)} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
