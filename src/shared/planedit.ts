import type { PermissionLevel, SubtaskSpec } from './types'

/** Remove sub-task `i` (0-based): the others' `after` numbers are renumbered, dependencies on it are dropped. */
export function removeItem(items: SubtaskSpec[], i: number): SubtaskSpec[] {
  const n = i + 1
  return items
    .filter((_, k) => k !== i)
    .map((it) => ({ ...it, after: it.after.filter((a) => a !== n).map((a) => (a > n ? a - 1 : a)) }))
}

/** Move sub-task `i` one place up (-1) or down (+1); `after` numbers follow the move. */
export function moveItem(items: SubtaskSpec[], i: number, dir: -1 | 1): SubtaskSpec[] {
  const j = i + dir
  if (j < 0 || j >= items.length) return items
  const swap = (n: number): number => (n === i + 1 ? j + 1 : n === j + 1 ? i + 1 : n)
  const out = items.map((it) => ({ ...it, after: it.after.map(swap) }))
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

export interface PlanIssue {
  /** 0-based sub-task. */
  index: number
  kind: 'github' | 'web' | 'readonly'
  text: string
  /** How a single click can fix it. */
  fix?: { access: PermissionLevel }
}

const GITHUB = /(배포|푸시|\bpush\b|pull request|\bPR\b|머지|\bmerge\b|깃허브|github|gh-pages|pages)/i
const WEB = /(웹\s?검색|웹에서|인터넷|온라인으로|검색해서|사이트를?\s?(조사|크롤)|크롤링|\burl\b)/i
const MAKES_FILES = /(작성|만들|구현|생성|저장|파일로|문서화|코드)/

/**
 * Before the board decides: which sub-tasks cannot be done as written? (No GitHub connection, web reading off, a read-only
 * job that has to produce files.) `has` says what this company can do right now.
 */
export function planIssues(items: SubtaskSpec[], has: { github: boolean; web: boolean }, isManager: (assignee: string) => boolean): PlanIssue[] {
  const out: PlanIssue[] = []
  items.forEach((it, index) => {
    const text = `${it.title} ${it.done}`
    if (!has.github && GITHUB.test(text)) out.push({ index, kind: 'github', text: '지금 할 수 없어요: GitHub 연결이 없어요' })
    if (!has.web && WEB.test(text)) out.push({ index, kind: 'web', text: '지금 할 수 없어요: 웹 읽기가 꺼져 있어요' })
    if (!isManager(it.assignee) && it.access === 'read' && MAKES_FILES.test(text)) {
      out.push({ index, kind: 'readonly', text: '파일을 만드는 일인데 읽기 전용이에요', fix: { access: 'edit' } })
    }
  })
  return out
}
