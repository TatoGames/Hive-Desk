import type { FinalReport, ReportNode, SubtaskSpec } from './types'

/** Hard limits of the delegation engine (design ch.9). */
export const LIMITS = {
  /** A manager may split into at most this many sub-tasks per plan. */
  maxSubtasks: 8,
  /** Levels of splitting below what the board handed over. */
  maxDepth: 4,
  /** A reviewer may send work back this many times before it moves up. */
  rejectLimit: 2,
  /** A plan may be sent back this many times before the board decides. */
  planRejectLimit: 2,
  /** Tries to get a plan in the right format before the task fails. */
  planFormatTries: 2
}

export const FLAG_LABEL: Record<string, string> = {
  risky: '위험 작업 포함 (대량 삭제·변경, 배포, 외부 전송)',
  scope: '원래 요청 범위를 벗어남',
  'other-unit': '다른 본부 인력이 필요함',
  conflict: 'CEO 위원회의 기존 결정과 충돌',
  budget: '프로젝트 실행 예산 초과'
}

export interface ParsedPlan {
  items: SubtaskSpec[]
  estimate?: number
  flags: string[]
  /** The manager says it is small enough to do directly. */
  self?: string
  /** Lines that looked like sub-tasks but could not be read. */
  bad: string[]
}

const SUBTASK = /^[ \t]*\[\[SUBTASK:[ \t]*([\s\S]*?)\]\][ \t]*$/gm
const SINGLE = (name: string): RegExp => new RegExp(`^[ \\t]*\\[\\[${name}:[ \\t]*([\\s\\S]*?)\\]\\][ \\t]*$`, 'm')

/** Read a manager's answer: `[[SUBTASK: title | assignee=id | done=… | after=1,2]]` lines, ESTIMATE, FLAGS, SELF. */
export function parsePlan(text: string): ParsedPlan {
  const items: SubtaskSpec[] = []
  const bad: string[] = []
  for (const m of text.matchAll(SUBTASK)) {
    const parts = m[1].split('|').map((x) => x.trim())
    const title = parts[0]
    const kv: Record<string, string> = {}
    for (const p of parts.slice(1)) {
      const i = p.indexOf('=')
      if (i > 0) kv[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim()
    }
    if (!title || !kv.assignee) {
      bad.push(m[1].slice(0, 80))
      continue
    }
    const after = (kv.after ?? '')
      .split(/[,\s]+/)
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n > 0)
    const access = ['read', 'edit', 'exec'].includes((kv.access ?? '').toLowerCase()) ? (kv.access.toLowerCase() as 'read' | 'edit' | 'exec') : undefined
    const est = Number((kv.est ?? '').match(/\d+/)?.[0]) || undefined
    const files = (kv.files ?? '').split(/[,;]/).map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== 'none')
    items.push({ title, assignee: kv.assignee, done: kv.done ?? '', after, ...(access ? { access } : {}), ...(est ? { est } : {}), ...(files.length ? { files } : {}) })
  }
  const est = SINGLE('ESTIMATE').exec(text)?.[1]
  const estimate = est ? Number(est.match(/\d+/)?.[0]) || undefined : undefined
  const flagsRaw = SINGLE('FLAGS').exec(text)?.[1] ?? ''
  const flags = flagsRaw
    .toLowerCase()
    .split(/[,\s]+/)
    .filter((f) => f in FLAG_LABEL)
  const self = SINGLE('SELF').exec(text)?.[1]?.trim()
  return { items, estimate, flags: [...new Set(flags)], self, bad }
}

/** Dependencies must point at earlier sub-tasks and must not loop. */
export function validateAfter(items: SubtaskSpec[]): string | null {
  for (const [i, it] of items.entries()) {
    for (const a of it.after) {
      if (a < 1 || a > items.length) return `${i + 1}번 작업의 after=${a}는 없는 번호예요.`
      if (a >= i + 1) return `${i + 1}번 작업은 자기보다 뒤(또는 자기 자신)의 작업을 기다릴 수 없어요.`
    }
  }
  return null
}

export type Verdict = { pass: true; note: string } | { pass: false; note: string }

/** `[[VERDICT: pass]]` / `[[VERDICT: changes: what to fix]]` (also approve / reject for plans). null = no verdict given. */
export function parseVerdict(text: string): Verdict | null {
  const m = SINGLE('VERDICT').exec(text)
  if (!m) return null
  const body = m[1].trim()
  const head = body.split(/[:\s]/, 1)[0].toLowerCase()
  const note = body.slice(head.length).replace(/^[:\s]+/, '').trim()
  if (['pass', 'approve', 'approved', 'ok'].includes(head)) return { pass: true, note }
  if (['changes', 'change', 'reject', 'rejected', 'fail'].includes(head)) return { pass: false, note: note || '자세한 이유가 없어요.' }
  return null
}

/** Where an estimate comes from, shown to the board so the number can be argued with. */
export interface Estimate {
  total: number
  /** The manager's own planning and the final integration. */
  plan: number
  work: number
  review: number
  /** Allowance for sending work back. */
  buffer: number
  /** How the work number was found: the planner's own guesses, this company's past bundles, a default. */
  basis: ('planner' | 'history' | 'default' | 'quick')[]
}

export interface EstimateItem {
  manager: boolean
  /** The planner's own guess for this sub-task. */
  est?: number
  /** A small job that gets a quick single-employee run (1–2 runs, no plan). */
  quick?: boolean
  /** Does a different model check this sub-task's result? (read-only work is not reviewed) */
  reviewed?: boolean
}

export interface EstimateHistory {
  /** Average AI runs of a finished worker sub-task / manager sub-task in this company (needs a few samples). */
  worker?: number
  manager?: number
}

/**
 * Expected number of AI runs of a plan: no fixed formula per kind of employee, but
 * (1) what the planner expected for each sub-task, else (2) what similar sub-tasks really took in this company,
 * else (3) a small default; quick jobs count 1–2.
 */
export function estimateBreakdown(items: EstimateItem[], history: EstimateHistory = {}): Estimate {
  let work = 0
  let review = 0
  const basis = new Set<Estimate['basis'][number]>()
  let workers = 0
  for (const it of items) {
    if (it.manager) {
      const n = it.est ?? history.manager ?? 6
      work += n
      basis.add(it.est ? 'planner' : history.manager ? 'history' : 'default')
      continue
    }
    workers++
    if (it.quick) {
      work += 1
      basis.add('quick')
    } else {
      const n = it.est ?? history.worker ?? 2
      work += n
      basis.add(it.est ? 'planner' : history.worker ? 'history' : 'default')
      if (it.reviewed !== false) review += 1
    }
  }
  const plan = 2
  const buffer = Math.ceil(workers * 0.3)
  return { total: plan + work + review + buffer, plan, work, review, buffer, basis: [...basis] }
}

/** @deprecated kept for old callers: the fixed formula of v0.3.0. */
export function estimateRuns(items: { manager: boolean }[]): number {
  return estimateBreakdown(items.map((i) => ({ manager: i.manager }))).total
}

// ---- final report as a document ----
function nodeLines(n: ReportNode, depth: number): string[] {
  const pad = '  '.repeat(depth)
  const mins = n.minutes ? `${n.minutes}분` : '1분 미만'
  const lines = [`${pad}- **${n.title}** — ${n.agentName}${n.job ? ` (${n.job})` : ''} · ${n.model} · ${n.runs}회 · ${mins}${n.review ? ` · 검토: ${n.review}` : ''}`]
  if (n.report?.did) lines.push(`${pad}  - 한 일: ${n.report.did.replace(/\n/g, ' ')}`)
  if (n.files.length) lines.push(`${pad}  - 바뀐 파일: ${n.files.map((f) => f.path).slice(0, 8).join(', ')}${n.files.length > 8 ? ` 외 ${n.files.length - 8}개` : ''}`)
  for (const c of n.children) lines.push(...nodeLines(c, depth + 1))
  return lines
}

export function finalReportMarkdown(r: FinalReport): string {
  const t = r.totals
  const out = [
    `# ${r.title}`,
    '',
    `작성: ${r.createdAt.slice(0, 16).replace('T', ' ')}${r.decision ? ` · 이사회 ${r.decision.accepted ? '승인' : '반려'} (${r.decision.by})` : ' · 이사회 확인 대기'}`,
    '',
    '## 요약',
    r.summary || '(요약 없음)',
    '',
    '## 업무 트리 (누가 · 어떤 모델이 · 무엇을)',
    ...nodeLines(r.tree, 0),
    '',
    '## 결과물과 변경',
    `파일 ${t.files}개 변경 (+${t.additions} −${t.deletions})`,
    '',
    '## 검증',
    ...(r.verification.length ? r.verification.map((v) => `- ${v}`) : ['- (없음)']),
    '',
    '## 비용',
    `AI 실행 ${t.runs}회 · 총 ${t.minutes}분 · 태스크 ${t.tasks}개`,
    '',
    '## 남은 위험',
    ...(r.risks.length ? r.risks.map((v) => `- ${v}`) : ['- 없음']),
    '',
    '## 다음 제안',
    ...(r.next.length ? r.next.map((v) => `- ${v}`) : ['- 없음']),
    ''
  ]
  return out.join('\n')
}
