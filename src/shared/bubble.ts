import type { EmployeeState } from './office'
import type { ActivityKind, Task } from './types'

/**
 * v5 work-status view: what an employee is doing right now, as one short sentence in a speech bubble.
 * Made from the activity the app already reads from the CLI (no AI run, no tokens). Local screen only.
 */

export type BubbleTone = 'work' | 'wait' | 'limit' | 'error' | 'info'

export interface Bubble {
  text: string
  tone: BubbleTone
}

/** `src/game/map.ts` → `map.ts` (the full path is never shown). */
export function fileName(p: string): string {
  const t = p.trim().replace(/[\\/]+$/, '')
  return t.split(/[\\/]/).pop() || t
}

/**
 * What kind of command it is — the command line itself is never shown (it may carry a token or a password).
 */
export function commandKind(cmd: string): string {
  const c = cmd.trim().toLowerCase()
  if (/(^|\s|\/)(vitest|jest|pytest|mocha|go test|cargo test|dotnet test|phpunit|rspec)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bunittest\b/.test(c)) return '테스트 돌려 보는 중…'
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bapt(-get)?\s+install\b|\bcargo\s+add\b|\bgo\s+get\b/.test(c)) return '패키지 설치 중…'
  if (/^git\b|\s&&\s*git\b/.test(c)) return '변경 정리 중…'
  if (/\b(build|tsc|make|compile|webpack|vite\s+build|cargo\s+build|go\s+build)\b/.test(c)) return '빌드하는 중…'
  if (/^(ls|dir|cat|head|tail|find|grep|rg|tree|pwd|type)\b/.test(c)) return '파일 둘러보는 중…'
  return '명령 실행 중…'
}

/** The first sentence of what the AI said, cut to 40 characters. */
function firstSentence(t: string): string {
  const one = t.replace(/\s+/g, ' ').trim()
  const s = one.split(/(?<=[.!?。])\s|(?<=다\.)|(?<=요\.)/)[0] ?? one
  return s.length > 40 ? s.slice(0, 39) + '…' : s
}

/** One activity line (as the live summary keeps it: `kind` + text like "수정: src/a.ts +3 −1") → a bubble sentence. */
export function bubbleFromActivity(kind: ActivityKind | undefined, text: string | undefined): string {
  const t = (text ?? '').trim()
  if (!t) return '작업 중…'
  const after = (prefix: RegExp): string => t.replace(prefix, '').replace(/\s[+−-]\d+.*$/, '').trim()
  switch (kind) {
    case 'read':
      return `${fileName(after(/^파일 읽음:\s*/))} 파일 살펴보는 중…`
    case 'write':
      return `${fileName(after(/^파일 작성:\s*/))} 만드는 중…`
    case 'edit':
      return `${fileName(after(/^(노트북 )?수정:\s*/))} 고치는 중…`
    case 'command':
      return commandKind(t.replace(/^명령:\s*/, ''))
    case 'search':
      return /^웹:/.test(t) ? '자료 찾아보는 중…' : '코드에서 찾아보는 중…'
    case 'tool':
      return /^외부 앱 도구/.test(t) ? '다른 앱으로 작업하는 중…' : '도구 쓰는 중…'
    case 'plan': {
      const m = t.match(/^(\d+)\/(\d+) 단계 완료/)
      return m ? `${m[1]}/${m[2]}단계 끝냈어요` : '할 일 정리하는 중…'
    }
    case 'error':
      return '막힌 곳을 살펴보는 중…'
    case 'message':
      if (/\[\[(DID|FILES|VERIFY|RISK|NEXT)\b/.test(t)) return '보고서 쓰는 중…'
      return firstSentence(t)
    default:
      return '작업 중…'
  }
}

/**
 * The bubble of one employee: a state that stops the work wins (approval, question, limit, error);
 * a fresh hand-over says so; otherwise the latest activity.
 */
export function bubbleFor(o: {
  state: EmployeeState
  task?: Task
  /** `lastKind` + `last` of the task's live summary while it runs. */
  lastKind?: ActivityKind
  last?: string
  /** Name of an employee, for "○○님이 이어받아요". */
  nameOf: (id: string) => string
  /** The limit of this employee's connection, when there is one. */
  limitUntil?: string
  now?: number
}): Bubble {
  const now = o.now ?? Date.now()
  const t = o.task
  const clock = (iso: string): string => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  const fresh = t?.handoffs?.length ? t.handoffs[t.handoffs.length - 1] : undefined
  switch (o.state) {
    case 'waiting-approval':
      return { text: '이 작업 해도 될까요? (결재 요청)', tone: 'wait' }
    case 'waiting-input':
      return { text: '자료가 필요해요. 답을 기다려요', tone: 'wait' }
    case 'limit':
      return { text: o.limitUntil ? `한도 대기 (${clock(o.limitUntil)}까지)` : '한도 대기', tone: 'limit' }
    case 'error':
      return { text: '문제가 생겼어요. 확인해 주세요', tone: 'error' }
    case 'held':
      return { text: '멈춰 있어요 (보류)', tone: 'info' }
    case 'idle':
      return { text: '쉬는 중', tone: 'info' }
    default:
      break
  }
  if (fresh && t && fresh.to === t.assignee && now - new Date(fresh.at).getTime() < 90_000) {
    return { text: `${o.nameOf(fresh.from)}의 일을 이어받았어요`, tone: 'info' }
  }
  if (!o.last) {
    if (o.state === 'reviewing') return { text: '결과 검토하는 중…', tone: 'work' }
    if (t?.kind === 'plan') return { text: '일을 나눠 계획하는 중…', tone: 'work' }
    return { text: '작업 시작하는 중…', tone: 'work' }
  }
  return { text: bubbleFromActivity(o.lastKind, o.last), tone: 'work' }
}

/** Keeps a bubble at least `holdMs` on screen; what came in between is merged (only the latest is shown next). Same text again = "계속 ○○". */
export class BubbleHold {
  private shown = new Map<string, { text: string; since: number; repeats: number }>()
  private pending = new Map<string, string>()

  constructor(private holdMs = 1500) {}

  /** The text to show for `key` now, given the newest one. */
  next(key: string, newest: string, now = Date.now()): string {
    const cur = this.shown.get(key)
    if (!cur) {
      this.shown.set(key, { text: newest, since: now, repeats: 0 })
      return newest
    }
    const base = cur.text.replace(/^계속 /, '')
    if (newest === base) {
      this.pending.delete(key)
      // the same thing again after it was shown a while: "계속 테스트 돌려 보는 중…"
      if (now - cur.since >= this.holdMs * 2 && !cur.text.startsWith('계속 ') && /중…$/.test(base)) {
        const text = '계속 ' + base
        this.shown.set(key, { text, since: now, repeats: cur.repeats + 1 })
        return text
      }
      return cur.text
    }
    if (now - cur.since < this.holdMs) {
      this.pending.set(key, newest)
      return cur.text
    }
    this.pending.delete(key)
    this.shown.set(key, { text: newest, since: now, repeats: 0 })
    return newest
  }

  /** A newer text waits for the hold to end (the view asks again a little later). */
  waiting(key: string): boolean {
    return this.pending.has(key)
  }

  forget(key: string): void {
    this.shown.delete(key)
    this.pending.delete(key)
  }
}
