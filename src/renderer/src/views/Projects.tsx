import { useState } from 'react'
import type { Project, Snapshot } from '@shared/types'
import { ConfirmButton } from './Materials'

const EMPTY = { name: '', description: '', briefing: '', folderName: '' }

export default function Projects({ snap }: { snap: Snapshot }): JSX.Element {
  const [draft, setDraft] = useState<(Partial<Project> & typeof EMPTY) | null>(null)

  const save = async (): Promise<void> => {
    if (!draft || !draft.name.trim()) return
    await window.hive.saveProject(draft)
    setDraft(null)
  }

  const pick = async (id: string): Promise<void> => {
    const dir = await window.hive.pickFolder()
    if (!dir) return
    const r = await window.hive.setProjectPath(id, dir)
    if (!r.ok && r.warning && window.confirm(r.warning + '\n\n그래도 이 폴더를 쓸까요?')) await window.hive.setProjectPath(id, dir, true)
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>프로젝트</h1>
        <button className="primary" onClick={() => setDraft({ ...EMPTY })}>
          + 프로젝트 추가
        </button>
      </header>
      <p className="muted small">
        프로젝트는 팀이 함께 보는 작업 묶음이에요. 브리핑(목표·규칙)은 이 프로젝트 태스크의 모든 실행에 들어가고, 작업 폴더는
        컴퓨터마다 자기 경로를 지정해요.
      </p>
      {!snap.projects.length && <div className="empty">아직 프로젝트가 없어요.</div>}
      <div className="agent-list">
        {snap.projects.map((p) => {
          const path = snap.projectPaths[p.id] ?? ''
          const count = snap.tasks.filter((t) => t.projectId === p.id).length
          return (
            <section key={p.id} className="panel">
              <div className="row between">
                <div>
                  <div className="title">
                    {p.name} <span className="tag">태스크 {count}</span>
                  </div>
                  {p.description && <div className="muted small">{p.description}</div>}
                </div>
                <div className="row">
                  <button className="sm" onClick={() => setDraft({ ...EMPTY, ...p })}>
                    수정
                  </button>
                  <ConfirmButton label="삭제" onConfirm={() => window.hive.deleteProject(p.id)} />
                </div>
              </div>
              {p.briefing && <pre className="briefing">{p.briefing}</pre>}
              <div className="row">
                <span className="small">
                  작업 폴더{p.folderName ? ` (${p.folderName})` : ''}:{' '}
                  {path ? path : <span className="warn-text">이 컴퓨터에 지정 안 됨</span>}
                </span>
                <button className="sm" onClick={() => void pick(p.id)}>
                  이 컴퓨터의 폴더 지정
                </button>
                {path && (
                  <button className="sm ghost" onClick={() => void window.hive.setProjectPath(p.id, '')}>
                    지정 해제
                  </button>
                )}
              </div>
            </section>
          )
        })}
      </div>

      {draft && (
        <div className="overlay" onClick={() => setDraft(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{draft.id ? '프로젝트 수정' : '프로젝트 추가'}</h2>
            <label className="full">
              이름
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="full">
              한 줄 설명
              <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>
            <label className="full">
              고정 브리핑 (목표, 규칙, 코드 스타일 …)
              <textarea rows={6} value={draft.briefing} onChange={(e) => setDraft({ ...draft, briefing: e.target.value })} />
            </label>
            <label className="full">
              작업 폴더 이름 (팀 공통 이름, 경로는 컴퓨터마다 따로 지정)
              <input value={draft.folderName} onChange={(e) => setDraft({ ...draft, folderName: e.target.value })} />
            </label>
            <label className="full">
              AI 실행 예산 (횟수, 0이면 제한 없음 — 위임 계획이 넘기면 이사회 승인을 받아요)
              <input
                type="number"
                min={0}
                value={draft.runBudget ?? 0}
                onChange={(e) => setDraft({ ...draft, runBudget: Math.max(0, Number(e.target.value) || 0) })}
              />
            </label>
            <div className="row end">
              <button onClick={() => setDraft(null)}>취소</button>
              <button className="primary" disabled={!draft.name.trim()} onClick={() => void save()}>
                저장
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
