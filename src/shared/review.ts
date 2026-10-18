import type { CheckRun, DiffFile } from './types'

/**
 * v5.1: spend AI reviews where they matter. The app first runs the project's own checks (no tokens);
 * the size and kind of the change decide whether another model still has to look.
 */

export type Risk = 'low' | 'medium' | 'high'

/** Paths whose change always gets a careful review. */
const SENSITIVE =
  /(^|[\\/._-])(auth|login|session|password|passwd|secret|token|credential|key|payment|billing|crypto|security|permission|acl|migration|migrations)([\\/._-]|$)|(^|[\\/])\.github[\\/]|(^|[\\/])\.env|dockerfile|docker-compose|\.ya?ml$|(^|[\\/])package\.json$|requirements\.txt$|pyproject\.toml$|cargo\.toml$|go\.mod$/i
const DOC = /\.(md|mdx|txt|rst|adoc)$|(^|[\\/])(docs?|LICENSE)([\\/]|$)/i

export interface RiskInput {
  files: Pick<DiffFile, 'path' | 'status' | 'additions' | 'deletions'>[]
  /** false = the folder is not git: lines were not counted. */
  lines?: boolean
}

/** How risky a change is, from the diff alone (no AI). */
export function reviewRisk(d: RiskInput): { risk: Risk; why: string } {
  const files = d.files
  if (!files.length) return { risk: 'low', why: '바뀐 파일 없음' }
  const sensitive = files.find((f) => SENSITIVE.test(f.path))
  if (sensitive) return { risk: 'high', why: `민감한 파일: ${sensitive.path}` }
  const deleted = files.filter((f) => f.status === 'D').length
  const adds = files.reduce((n, f) => n + (f.additions ?? 0), 0)
  const dels = files.reduce((n, f) => n + (f.deletions ?? 0), 0)
  if (deleted > 3 || dels > 200) return { risk: 'high', why: `많이 지움 (파일 ${deleted}개, ${dels}줄)` }
  if (files.every((f) => DOC.test(f.path))) return { risk: 'low', why: '문서만 바뀜' }
  // without line counts a "small" change cannot be told apart
  if (d.lines === false) return { risk: 'medium', why: '줄 수를 셀 수 없는 폴더' }
  if (files.length <= 3 && adds + dels <= 40) return { risk: 'low', why: `작은 변경 (파일 ${files.length}개, ${adds + dels}줄)` }
  if (files.length > 15 || adds + dels > 600) return { risk: 'high', why: `큰 변경 (파일 ${files.length}개, ${adds + dels}줄)` }
  return { risk: 'medium', why: `보통 변경 (파일 ${files.length}개, ${adds + dels}줄)` }
}

/** May the AI review be left out? Only for low risk, and only when something actually checked the work (or it is docs only). */
export function canSkipReview(policy: 'risk' | 'always', risk: { risk: Risk; why: string }, checks?: CheckRun): boolean {
  if (policy !== 'risk' || risk.risk !== 'low') return false
  if (risk.why === '문서만 바뀜' || risk.why === '바뀐 파일 없음') return true
  return !!checks?.ok && checks.items.some((i) => !i.skipped)
}

const clip = (s: string, n: number): string => (s.length > n ? '…' + s.slice(-n) : s)

/** What the worker is told when a check failed (sent back without an AI review). */
export function checksFailNote(c: CheckRun): string {
  const bad = c.items.filter((i) => !i.ok && !i.skipped)
  return [
    `앱이 돌린 자동 검사가 실패했어요 (${bad.map((b) => b.name).join(', ')}). 고쳐서 다시 끝내 주세요.`,
    ...bad.map((b) => `\n### ${b.name}: ${b.cmd}\n${clip(b.tail.trim(), 1500)}`)
  ].join('\n')
}

/** For the reviewer: what already passed, so it does not run it again. */
export function checksForReviewer(c?: CheckRun): string[] {
  if (!c || !c.items.length) return []
  const lines = ['', 'The app already ran these checks in the work folder (do NOT run them again):']
  for (const i of c.items) {
    lines.push(`- ${i.name} (${i.cmd}): ${i.skipped ? 'skipped — ' + i.skipped : i.ok ? 'passed' : 'FAILED'}`)
    if (i.name === 'app' && i.tail.trim()) lines.push('  ' + clip(i.tail.trim(), 800).replace(/\n/g, '\n  '))
    if (i.screenshot) lines.push(`  A screenshot of the app's first window: ${i.screenshot} — open it and judge whether the screen looks right.`)
  }
  return lines
}

/** One line for people: "자동 검사 통과 (test, typecheck)". */
export function checksLine(c?: CheckRun): string {
  if (!c || !c.items.length) return ''
  const ran = c.items.filter((i) => !i.skipped)
  if (!ran.length) return '자동 검사: 돌릴 검사가 없었어요'
  return c.ok ? `자동 검사 통과 (${ran.map((i) => i.name).join(', ')})` : `자동 검사 실패 (${ran.filter((i) => !i.ok).map((i) => i.name).join(', ')})`
}

/** Commands that may stay silent for minutes (installs, builds, tests): the run is not stuck. */
export function isLongCommand(cmd: string): boolean {
  const c = cmd.trim().toLowerCase()
  return (
    /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|run\s+(build|dist|package|test|e2e)|test|build)\b/.test(c) ||
    /\bpip3?\s+install\b|\bpoetry\s+install\b|\bcargo\s+(build|test|install)\b|\bgo\s+(build|test|get)\b|\bgradlew?\b|\bmvn\b|\bdotnet\s+(build|test|restore)\b/.test(c) ||
    /\b(electron-builder|electron-forge|tsc|webpack|vite\s+build|pytest|vitest|jest|playwright)\b/.test(c)
  )
}
