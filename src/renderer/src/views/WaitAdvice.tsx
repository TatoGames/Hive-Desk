import { useEffect, useState } from 'react'
import { ConfirmButton } from './Materials'

type Advice = { state: 'ok' | 'single' | 'off' | 'none' | 'no-commit' | 'not-top'; dir: string; message: string }

/** Why a task waits for its folder and what to do about it (one question to the person, never silently). */
export function WaitAdvice({ taskId }: { taskId: string }): JSX.Element | null {
  const [a, setA] = useState<Advice | null>(null)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.hive.parallelAdvice(taskId).then((r) => alive && setA(r))
    return () => {
      alive = false
    }
  }, [taskId])
  if (done) return <div className="ok-text small">{done}</div>
  if (!a || a.state === 'ok' || !a.message) return null
  const fix = a.state === 'none' || a.state === 'no-commit' || a.state === 'off'
  return (
    <div className="wait-advice small">
      <div>{a.message}</div>
      {fix && (
        <div className="row">
          <ConfirmButton
            label={a.state === 'off' ? '병렬 작업 켜기' : 'git 폴더로 만들고 병렬 켜기'}
            onConfirm={async () => {
              const r = await window.hive.enableParallel(taskId)
              setDone(r.message)
            }}
          />
          <span className="muted">
            {a.state === 'off'
              ? '하위 업무마다 폴더를 나눠 동시에 돌아요.'
              : `"${a.dir}" 폴더에 git 기록(.git)을 만들고 지금 파일을 첫 기록으로 저장해요. 설치된 패키지 폴더 등은 .gitignore로 제외해요.`}
          </span>
        </div>
      )}
    </div>
  )
}
