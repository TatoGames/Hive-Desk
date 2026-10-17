import { useState } from 'react'
import type { Snapshot } from '@shared/types'
import { TEMPLATES } from '@shared/templates'

/** 이사회 대시보드: every company side by side. Nothing is mixed — each card is one company. */
export default function Boardroom({ snap, goBoard }: { snap: Snapshot; goBoard: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [tpl, setTpl] = useState('')
  const [err, setErr] = useState('')
  const create = async (): Promise<void> => {
    try {
      setErr('')
      await window.hive.createCompany(name, tpl || undefined)
      setOpen(false)
      setName('')
      setTpl('')
      goBoard()
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }
  return (
    <div className="page">
      <header className="page-head">
        <h1>이사회</h1>
        <button className="primary" onClick={() => setOpen(true)}>
          + 새 회사
        </button>
      </header>
      <p className="muted small">
        회사는 서로 완전히 분리돼 있어요. 보드, 메모리, 메시지, 프로젝트, 보고서가 회사 안에만 있고, AI는 다른 회사를 알지 못해요.
        여기서는 나만 모든 회사를 한눈에 봐요.
      </p>
      <div className="companies">
        {snap.companies.map((c) => (
          <section key={c.id} className={'panel company-card' + (c.active ? ' active' : '')}>
            <div className="row between">
              <b>{c.name}</b>
              {c.active && <span className="tag">보는 중</span>}
            </div>
            <div className="stats">
              <div>
                <span className="num">{c.open}</span>
                <span className="muted small">진행할 일</span>
              </div>
              <div>
                <span className="num">{c.running}</span>
                <span className="muted small">실행 중</span>
              </div>
              <div>
                <span className={'num' + (c.waiting ? ' warn-text' : '')}>{c.waiting}</span>
                <span className="muted small">내 결정 대기</span>
              </div>
              <div>
                <span className="num">{c.members}</span>
                <span className="muted small">직원(이 컴퓨터)</span>
              </div>
            </div>
            <div className="muted small">
              오늘 AI 실행 {c.runsToday}회 · {c.minutesToday}분
            </div>
            <div className="row">
              <button
                className="primary"
                onClick={async () => {
                  await window.hive.switchCompany(c.id)
                  goBoard()
                }}
              >
                {c.active ? '이 회사 보드로' : '이 회사로 전환'}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  const n = window.prompt('새 회사 이름', c.name)
                  if (n && n.trim() && n !== c.name) void window.hive.renameCompany(c.id, n.trim()).catch((e) => window.alert(String(e.message ?? e)))
                }}
              >
                이름 바꾸기
              </button>
            </div>
          </section>
        ))}
      </div>
      {open && (
        <div className="overlay" onClick={() => setOpen(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>새 회사</h2>
            <label className="full">
              회사 이름
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="full">
              조직 템플릿 (나중에 회사 탭에서 바꿀 수 있어요)
              <select value={tpl} onChange={(e) => setTpl(e.target.value)}>
                <option value="">템플릿 없이 빈 회사로 시작</option>
                {TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {t.description}
                  </option>
                ))}
              </select>
            </label>
            {err && <div className="warn-text small">{err}</div>}
            <div className="row end">
              <button onClick={() => setOpen(false)}>취소</button>
              <button className="primary" disabled={!name.trim()} onClick={() => void create()}>
                만들기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
