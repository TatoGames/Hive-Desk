import { useState } from 'react'

/** Words of the app in plain language (shown behind a small "?"). */
export const GLOSSARY: Record<string, string> = {
  연결: '내 컴퓨터에 로그인된 AI 프로그램(Claude Code, Codex, Antigravity)이에요. 구독 계정 하나가 연결 하나예요.',
  직원: '연결 하나에 이름·역할·모델을 정해 둔 AI예요. 연결 하나로 여러 직원을 둘 수 있어요.',
  자리: '조직도의 한 칸이에요(예: 서버 개발자). 직원을 자리에 앉히면 그 자리의 일을 맡아요.',
  결재: 'AI가 위험하거나 비싼 일을 하기 전에 사람에게 허락을 받는 거예요. 내가 할 일에 모여요.',
  교차검토: '만든 AI와 다른 모델의 AI가 결과를 확인하는 거예요. 같은 실수를 서로 잡아 줘요.',
  자동검사: 'AI를 쓰지 않고 앱이 직접 프로젝트의 테스트·타입 검사·린트를 돌리고, Electron 앱이면 띄워서 확인해요.',
  한도: '구독마다 몇 시간 동안 쓸 수 있는 양이 정해져 있어요. 다 쓰면 풀릴 때까지 그 연결은 쉬어요.',
  이어받기: '한도가 찬 연결 대신 다른 연결의 직원이 마지막으로 끝낸 단계부터 이어서 해요.',
  되돌리기: '실행 전에 저장해 둔 상태로 작업 폴더를 돌려놓아요. git 폴더면 정확하게 돌아가요.',
  묶음: '큰 일을 관리자가 여러 하위 업무로 나눈 것이에요. 다 끝나면 통합 보고서가 나와요.',
  프로젝트: '작업 폴더와 프로젝트 설명이에요. 설명은 모든 직원이 일하기 전에 읽어요.'
}

/** A word with its plain-language meaning behind a "?". */
export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children?: React.ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const text = GLOSSARY[k]
  return (
    <span className="term">
      {children ?? k}
      {text && (
        <button className="q" aria-label={`${k} 설명`} title={text} onClick={() => setOpen(!open)}>
          ?
        </button>
      )}
      {open && text && (
        <span className="term-pop" role="note">
          {text}
        </span>
      )}
    </span>
  )
}

const seen = (id: string): boolean => {
  try {
    return localStorage.getItem('hivedesk.hint.' + id) === '1'
  } catch {
    return false
  }
}

/** A one-time hint at the top of a screen; "알겠어요" hides it for good (on this computer). */
export function Hint({ id, children }: { id: string; children: React.ReactNode }): JSX.Element | null {
  const [hidden, setHidden] = useState(() => seen(id))
  if (hidden) return null
  return (
    <div className="hint" role="note">
      <span className="hint-icon">💡</span>
      <div className="hint-body">{children}</div>
      <button
        className="sm ghost"
        onClick={() => {
          setHidden(true)
          try {
            localStorage.setItem('hivedesk.hint.' + id, '1')
          } catch {
            /* shown again next time: fine */
          }
        }}
      >
        알겠어요
      </button>
    </div>
  )
}

/** Settings: show every hint again. */
export function resetHints(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('hivedesk.hint.')) localStorage.removeItem(k)
  } catch {
    /* nothing to reset */
  }
}

/** The glossary as a list (in the settings help section). */
export function Glossary(): JSX.Element {
  return (
    <dl className="glossary">
      {Object.entries(GLOSSARY).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}
