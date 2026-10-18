import { useMemo } from 'react'
import type { Snapshot } from '@shared/types'
import { bundlesOf, type Bundle } from '@shared/bundles'
import { fmtTime } from '../store'

/** Delegated jobs as units: how far along, how much is left, when anything last happened. */
export function useBundles(snap: Snapshot): Bundle[] {
  return useMemo(() => bundlesOf(snap.tasks), [snap.tasks])
}

export default function Bundles({ snap, onOpen }: { snap: Snapshot; onOpen?: (taskId: string) => void }): JSX.Element | null {
  const all = useBundles(snap)
  const list = all.filter((b) => b.remaining > 0 || b.running > 0)
  if (!list.length) return null
  return (
    <details className="panel bundles" open>
      <summary>
        <b>위임 묶음</b> <span className="muted small">진행 중 {list.length}개</span>
      </summary>
      {list.map((b) => (
        <div key={b.root.id} className="row between bundle">
          <div className="grow">
            <div>
              <b>{b.root.title}</b>{' '}
              {b.held > 0 && <span className="tag">보류 {b.held}</span>}
              {b.running > 0 && <span className="tag warn">실행 중 {b.running}</span>}
            </div>
            <div className="pbar">
              <div style={{ width: `${Math.round(b.progress * 100)}%` }} />
            </div>
            <div className="muted small">
              완료 {b.done}/{b.total} · 남은 작업 {b.remaining}건 · 마지막 활동 {fmtTime(b.lastActivity)}
            </div>
          </div>
          <div className="row">
            {onOpen && (
              <button className="sm ghost" onClick={() => onOpen(b.root.id)}>
                열기
              </button>
            )}
            <button
              className="sm"
              onClick={() => {
                if (window.confirm(`"${b.root.title}" 묶음의 시작 안 한 작업 ${b.waiting}건을 취소할까요? (진행 중인 것은 그대로 둬요)`)) void window.hive.cancelTask(b.root.id, { scope: 'pending', files: 'keep' })
              }}
            >
              남은 일 취소
            </button>
          </div>
        </div>
      ))}
    </details>
  )
}
