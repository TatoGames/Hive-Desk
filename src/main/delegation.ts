import { parseEscalation } from '../shared/committee'
import { orderByFiles, planIssues, removeItem } from '../shared/planedit'
import {
  FLAG_LABEL,
  LIMITS,
  estimateBreakdown,
  parsePlan,
  parseVerdict,
  validateAfter
} from '../shared/delegation'
import {
  TIER_LABEL,
  jobLabel,
  modelLabel,
  tierRank,
  type Company,
  type ModelEntry,
  type OrgUnit,
  type Seat
} from '../shared/company'
import type {
  Agent,
  FinalReport,
  Plan,
  ReportNode,
  RosterEntry,
  SubtaskSpec,
  Task
} from '../shared/types'
import { rootOf, subtree } from '../shared/tree'
import { canSkipReview, checksFailNote, checksForReviewer, checksLine, reviewRisk } from '../shared/review'
import { DEFAULT_REVIEW, type ReviewSettings } from '../shared/types'
import type { Hive } from './hive'

export interface DelegationCtx {
  hive: Hive
  me: () => string
  catalog: () => ModelEntry[]
  changed: () => void
  notify: (title: string, body: string) => void
  /** A manager cannot tell which direction to take: hand the question to the CEO committee. */
  escalate?: (task: Task, question: string) => void
  /** Cancel a whole bundle (running parts are stopped). */
  cancelTree?: (rootId: string) => void
  /** A quick (single-employee) job did not work out: move it up. True when it was moved on. */
  quickEscalate?: (task: Task, why: string) => boolean
  /** Credit/charge the model that did a task (cross review result). */
  aptitude: (agentId: string | null, taskId: string, d: { approved?: number; changes?: number }) => void
  /** What the company's external connections make possible (GitHub, web reading). */
  capabilities?: () => { github: boolean; web: boolean }
  /** v5.1: the app's own checks and when an AI review is needed. */
  reviewSettings?: () => ReviewSettings
}

/** Who sent work back when it was the app's own checks (not a reviewer). */
const CHECKS_BY = 'checks'

/** Two check outputs say the same thing (timings and counts aside). */
const sameOutput = (a: string, b: string): boolean => a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#')

const MANAGER_JOBS = ['lead', 'coo']
const isManagerJob = (j?: string): boolean => !!j && MANAGER_JOBS.includes(j)

/**
 * The delegation engine (design ch.4–5, 9): requirement check and distribution plan by a manager,
 * approval by the right level, splitting into sub-tasks, cross review by a different model,
 * roll-up and the final report. Every step is an ordinary task run by the normal runner;
 * this class only reads what a run produced and decides what happens next.
 */
export class Delegation {
  constructor(private c: DelegationCtx) {}

  // ---- the organisation, as the engine needs it ----
  private get company(): Company | null {
    return this.c.hive.getCompany()
  }
  private get units(): OrgUnit[] {
    return this.c.hive.listUnits()
  }
  private get seats(): Seat[] {
    return this.c.hive.listSeats()
  }
  private roster(): RosterEntry[] {
    return this.c.hive.listRoster()
  }
  private rosterOf(id: string | null | undefined): RosterEntry | undefined {
    return id ? this.roster().find((r) => r.id === id) : undefined
  }
  seatOf(agentId: string | null | undefined): Seat | undefined {
    return agentId ? this.seats.find((s) => s.agentId === agentId) : undefined
  }
  private subtree(unitId: string): Set<string> {
    const units = this.units
    const out = new Set<string>([unitId])
    const walk = (id: string): void => {
      for (const u of units) if (u.parentId === id && !out.has(u.id)) (out.add(u.id), walk(u.id))
    }
    walk(unitId)
    return out
  }
  isManager(agentId: string | null | undefined): boolean {
    return isManagerJob(this.seatOf(agentId)?.job)
  }
  cooAgent(): string | null {
    return this.seats.find((s) => s.job === 'coo' && s.agentId)?.agentId ?? null
  }
  leadOfUnit(unitId: string): string | null {
    return this.seats.find((s) => s.unitId === unitId && s.job === 'lead' && s.agentId)?.agentId ?? null
  }

  /** The agent one level up: the lead of the nearest unit above (or of the same unit for a worker), else the COO. */
  superiorOf(agentId: string): string | null {
    const seat = this.seatOf(agentId)
    if (!seat || seat.job === 'coo') return null
    const units = this.units
    let unit: OrgUnit | undefined = units.find((u) => u.id === seat.unitId)
    // a lead reports to the unit above; a worker to the lead of its own unit
    if (seat.job === 'lead') unit = unit?.parentId ? units.find((u) => u.id === unit!.parentId) : undefined
    while (unit) {
      const lead = this.seats.find((s) => s.unitId === unit!.id && s.job === 'lead' && s.agentId && s.agentId !== agentId)
      if (lead) return lead.agentId!
      unit = unit.parentId ? units.find((u) => u.id === unit!.parentId) : undefined
    }
    return this.cooAgent()
  }

  /** Who a manager may hand work to: its unit's members, and the leads of the units directly below. */
  teamOf(agentId: string): { agent: RosterEntry; seat: Seat }[] {
    const seat = this.seatOf(agentId)
    if (!seat) return []
    const units = this.units
    const out: { agent: RosterEntry; seat: Seat }[] = []
    const add = (s: Seat): void => {
      const a = this.rosterOf(s.agentId)
      if (a && s.agentId !== agentId) out.push({ agent: a, seat: s })
    }
    if (seat.job === 'coo') {
      // the COO hands work to the heads of the top-level units (not to the executive unit itself)
      for (const u of units.filter((x) => !x.parentId && x.id !== seat.unitId)) {
        const lead = this.seats.find((s) => s.unitId === u.id && s.job === 'lead' && s.agentId)
        if (lead) add(lead)
        else this.seats.filter((s) => s.unitId === u.id).forEach(add)
      }
      return out
    }
    this.seats.filter((s) => s.unitId === seat.unitId && s.id !== seat.id && !isManagerJob(s.job)).forEach(add)
    for (const child of units.filter((u) => u.parentId === seat.unitId)) {
      const lead = this.seats.find((s) => s.unitId === child.id && s.job === 'lead' && s.agentId)
      if (lead) add(lead)
      else this.seats.filter((s) => s.unitId === child.id).forEach(add)
    }
    return out
  }

  private modelKeyOf(agentId: string): string {
    const r = this.rosterOf(agentId)
    return r?.modelId ?? `${r?.adapter ?? '?'}:${r?.model ?? 'default'}`
  }
  private modelOf(agentId: string): ModelEntry | undefined {
    const id = this.rosterOf(agentId)?.modelId
    return id ? this.c.catalog().find((m) => m.id === id) : undefined
  }
  private modelName(agentId: string | null | undefined): string {
    if (!agentId) return '-'
    const m = this.modelOf(agentId)
    if (m) return modelLabel(m)
    const r = this.rosterOf(agentId)
    return r?.model ?? r?.adapter ?? '-'
  }

  /** A reviewer on a different model (same or higher tier), preferably a reviewer/QA seat close to the worker. */
  pickReviewer(workerId: string | null): string | null {
    if (!workerId) return null
    const wkey = this.modelKeyOf(workerId)
    const wtier = this.modelOf(workerId)?.tier
    const wseat = this.seatOf(workerId)
    const near = wseat ? this.subtree(wseat.unitId) : new Set<string>()
    type Cand = { id: string; score: number }
    const cands: Cand[] = []
    for (const s of this.seats) {
      if (!s.agentId || s.agentId === workerId) continue
      if (this.modelKeyOf(s.agentId) === wkey) continue
      const m = this.modelOf(s.agentId)
      let score = 0
      if (s.job === 'review') score -= 6
      else if (s.job === 'qa') score -= 4
      else if (isManagerJob(s.job)) score -= 1
      if (near.has(s.unitId)) score -= 3
      if (wtier && m && tierRank(m.tier) < tierRank(wtier)) score += 5 // weaker than the worker: last resort
      cands.push({ id: s.agentId, score })
    }
    // agents without a seat can still review when nobody on a seat qualifies
    if (!cands.length) {
      for (const r of this.roster()) {
        if (r.id !== workerId && this.modelKeyOf(r.id) !== wkey && !this.seatOf(r.id)) cands.push({ id: r.id, score: 0 })
      }
    }
    cands.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    return cands[0]?.id ?? null
  }

  // ---- entry: the board hands over a job ----
  /**
   * Decide how a freshly created task enters the flow (design ch.4): an employee works at once and is
   * cross-reviewed; a manager (or a unit) plans; nobody named → the COO takes it.
   */
  begin(task: Task, opts: { unitId?: string; delegate?: boolean }): Task {
    const h = this.c.hive
    let assignee = task.assignee
    let kind: Task['kind'] = 'work'
    let directed = false
    if (opts.unitId) {
      const lead = this.leadOfUnit(opts.unitId)
      if (!lead) throw new Error('그 조직에는 에이전트가 배치된 관리자 자리가 없어요.')
      assignee = lead
      kind = 'plan'
      directed = true
    } else if (assignee) {
      if (this.isManager(assignee)) {
        kind = 'plan'
        directed = true
      }
    } else {
      const coo = this.cooAgent()
      if (!coo) throw new Error('총괄 본부장 자리에 에이전트를 배치해야 미지정 업무를 접수할 수 있어요.')
      assignee = coo
      kind = 'plan'
    }
    const next = h.updateTask(task.id, {
      assignee,
      kind,
      depth: 0,
      auto: true,
      directed,
      ...(kind === 'plan' ? { permission: 'read' as const } : {})
    })
    const who = this.rosterOf(assignee)?.name ?? assignee
    h.addEvent(
      task.id,
      'delegation',
      this.c.me(),
      kind === 'plan'
        ? `${who}에게 맡겼어요. 요구사항을 점검하고 분배 계획을 세워요.`
        : `${who}가 바로 작업하고, 끝나면 다른 모델이 교차 검토해요.`
    )
    return next
  }

  // ---- prompts ----
  /** Extra instructions for a delegation step; the runner appends them to the normal prompt. */
  promptExtras(task: Task, agent: Agent): string[] {
    if (task.kind === 'plan') return this.planPrompt(task, agent)
    if (task.kind === 'review') return this.reviewPrompt(task)
    if (task.kind === 'integrate') return this.integratePrompt(task)
    return []
  }

  private planPrompt(task: Task, agent: Agent): string[] {
    const team = this.teamOf(agent.id)
    const ranks = this.company?.ranks ?? []
    const lines = [
      '',
      '## Your role in this task: MANAGER (planner)',
      'You are a manager. Your job is to plan, not to do the work — unless it is small.',
      'Step 1 — Requirement check. Check the request for: goal, scope, completion criteria, constraints, deliverable format, priority.',
      'If you need help from outside the company (information or work only another company could give), write [[COLLAB: 외부 도움 필요 | what you need | why]]; the board decides who, if anyone, helps. Never guess other companies\' names.',
      'If the direction itself is unclear (two or more very different ways, and the choice matters), ask the CEO committee with [[ESCALATE: the question and the options]] and stop.',
      'If something essential is missing, do NOT plan. Ask the board exactly what you need with [[NEED: your specific questions]] and stop.',
      'Step 2 — Size. If the job is small enough that you can do it yourself, answer only [[SELF: why it is small]] (no sub-tasks).',
      'Step 3 — Otherwise write a distribution plan, one line per sub-task, in this exact form:',
      '[[SUBTASK: <title> | assignee=<agent id from the list below> | access=<read|edit|exec> | files=<folders or files it works in, comma separated> | est=<AI runs it needs, e.g. 2> | done=<completion criteria> | after=<numbers of sub-tasks that must finish first, comma separated, or none>]]',
      'access: edit = the result is files (writing, building, editing) — this is the usual case; read = only analysis or a report; exec = commands must run (build, test, install). Do NOT give read to a sub-task that has to create files.',
      'files: sub-tasks whose files do not overlap start at the same time; the app orders overlapping ones for you, so use "after" only for real dependencies (one needs the other\'s result). est: your honest guess of AI runs for this sub-task (usually 1–3).',
      'Sub-tasks are numbered 1, 2, 3 … in the order you write them; "after" may only point at earlier numbers.',
      `Write at most ${LIMITS.maxSubtasks} sub-tasks. Give each piece to the lowest rank that can do it well.`,
      'Then write [[ESTIMATE: <total AI runs expected, counting reviews>]] and [[FLAGS: <comma separated of: risky, scope, other-unit, conflict — or none>]].',
      'FLAGS: risky = mass delete/change, deploy or sending data out; scope = goes beyond the original request; other-unit = needs people outside your unit; conflict = contradicts a CEO committee decision in the team memory.',
      '',
      'Agents you may assign to (use the id exactly):'
    ]
    if (!team.length) lines.push('(nobody is available — say so with [[NEED: ...]])')
    for (const t of team) {
      const m = this.modelOf(t.agent.id)
      const rank = ranks.find((r) => r.id === t.seat.rankId)?.name ?? ''
      lines.push(
        `- ${t.agent.id} | ${t.seat.title} | ${jobLabel(t.seat.job)}${isManagerJob(t.seat.job) ? ' (manager: will split further)' : ''} | ${rank} | ${m ? TIER_LABEL[m.tier] : this.modelName(t.agent.id)}`
      )
    }
    if (task.reply) lines.push('', 'Note: your previous answer was sent back — follow the feedback you were given above.')
    return lines
  }

  private lastRun(taskId: string) {
    const runs = this.c.hive.listSharedRuns(taskId)
    return runs[runs.length - 1]
  }

  private reviewPrompt(task: Task): string[] {
    const target = task.reviewOf ? this.c.hive.getTask(task.reviewOf) : null
    if (!target) return ['', '## Your role: REVIEWER', 'The task you should review no longer exists. Answer [[VERDICT: pass]].']
    if (target.kind === 'plan') {
      const p = target.plan
      return [
        '',
        '## Your role in this task: PLAN REVIEWER (the manager above)',
        `Review the distribution plan of "${target.title}". Check: does it cover the request, are the completion criteria clear, are the assignees right (lowest rank that fits), is the estimate plausible?`,
        `Original request: ${target.description || target.title}`,
        'Plan:',
        ...(p?.items ?? []).map((it, i) => `${i + 1}. ${it.title} → ${it.assignee} | done: ${it.done} | after: ${it.after.join(',') || 'none'}`),
        `Estimated AI runs: ${p?.estimateRuns ?? '?'}; flags: ${p?.flags.join(', ') || 'none'}`,
        'Answer with exactly one verdict line: [[VERDICT: approve]] or [[VERDICT: reject: what must change]].'
      ]
    }
    const run = this.lastRun(target.id)
    const r = target.report
    const lines = [
      '',
      '## Your role in this task: CROSS REVIEWER',
      `Check the work of another agent (a different model): "${target.title}".`,
      `Completion criteria: ${target.criteria || '(none given — judge against the task description)'}`,
      `Task description: ${target.description || target.title}`,
      'The agent reported:'
    ]
    if (r) lines.push(`- did: ${r.did}`, `- files: ${r.files}`, `- how to verify: ${r.verify}`, `- risks: ${r.risks}`)
    else lines.push((target.result ?? '(no report)').slice(0, 3000))
    if (run) {
      lines.push(`Changes (${run.diffStat.files} files, +${run.diffStat.additions} −${run.diffStat.deletions}):`)
      lines.push(...run.files.slice(0, 30).map((f) => `- ${f.status} ${f.path}`))
      if (run.patch) lines.push('```diff', run.patch.slice(0, 12000), '```')
    }
    lines.push(...checksForReviewer(target.checks))
    lines.push(
      run?.patch
        ? 'Judge from the report and the diff above; open other files in the work folder only when the diff is not enough (read only — do not change anything). Be strict but fair.'
        : 'Inspect the changed files in the work folder yourself (read only — do not change anything). Be strict but fair.',
      'Answer with exactly one verdict line: [[VERDICT: pass]] or [[VERDICT: changes: the concrete things to fix]].'
    )
    return lines
  }

  private integratePrompt(task: Task): string[] {
    const all = this.children(task.id)
    const kids = all.filter((k) => k.status !== 'cancelled')
    const dropped = all.filter((k) => k.status === 'cancelled')
    const lines = [
      '',
      '## Your role in this task: INTEGRATION (confirm and report up)',
      'Every sub-task is finished and was cross-reviewed. Confirm that each result meets its completion criteria, integrate them, and report on the whole job.',
      'Give the final report in the usual DID / FILES / VERIFY / RISK / NEXT markers, covering the whole job (not just your part).',
      '',
      'Sub-task results:'
    ]
    for (const k of kids) {
      lines.push(`### ${k.title} — ${this.rosterOf(k.assignee)?.name ?? k.assignee} (${this.modelName(k.assignee)})`)
      lines.push(`criteria: ${k.criteria || '-'}`)
      if (k.report) lines.push(`did: ${k.report.did}`, `files: ${k.report.files}`, `verify: ${k.report.verify}`, `risks: ${k.report.risks}`)
      else lines.push((k.result ?? '').slice(0, 1500))
    }
    if (dropped.length) {
      lines.push('', 'These sub-tasks were cancelled or skipped by the board and were NOT done — leave them out and say so in RISK:')
      for (const k of dropped) lines.push(`- ${k.title}`)
    }
    return lines
  }

  private children(id: string): Task[] {
    return this.c.hive.listTasks().filter((t) => t.parentId === id && t.kind !== 'review')
  }

  // ---- after a run ----
  /** Called by the engine when a run of `taskId` has ended (whatever the outcome). */
  onRunFinished(taskId: string): void {
    const t = this.c.hive.getTask(taskId)
    if (!t || !t.kind) return
    const quick = t.kind === 'work' && !!t.quick && !t.parentId && !t.reviewOf
    if (t.status === 'failed') {
      // a model that could not do a quick job: one tier up (not for limits / logins, which another model would not fix)
      if (quick && t.errorKind !== 'limit' && t.errorKind !== 'login' && t.errorKind !== 'network' && this.c.quickEscalate?.(t, (t.error ?? '실패').split('\n')[0])) return void this.c.changed()
      return void this.afterFailure(t)
    }
    if (t.status !== 'done') return
    if (quick) {
      const why = parseEscalation(t.result ?? '')
      if (why && this.c.quickEscalate?.(t, why)) return void this.c.changed()
      if (!t.quick!.writes) {
        // answers and research need no cross review
        this.c.hive.updateTask(t.id, { reviewState: { status: 'skipped', round: 0, escalations: 0, note: '파일을 바꾸지 않는 일이라 검토를 생략했어요.' } })
        this.c.aptitude(t.assignee, t.id, { approved: 1 })
        return void this.c.changed()
      }
    }
    const q = t.kind === 'plan' ? parseEscalation(t.result ?? '') : null
    if (q && this.c.escalate) this.c.escalate(t, q)
    else if (t.kind === 'plan') this.afterPlan(t)
    else if (t.kind === 'review') this.afterReview(t)
    else if (t.kind === 'work') this.afterWork(t)
    else if (t.kind === 'integrate') this.afterIntegrate(t)
    this.c.changed()
  }

  /**
   * A task of a bundle failed: whatever waits for it is marked blocked (with the reason), the manager above is told,
   * and the board gets one decision to make: another model / go on without it / cancel the bundle.
   */
  afterFailure(t: Task): void {
    const h = this.c.hive
    const all = h.listTasks()
    for (const d of all) {
      if (d.dependsOn.includes(t.id) && d.status === 'todo' && !d.blocked) {
        h.updateTask(d.id, { blocked: { by: t.id, reason: `앞 작업 "${t.title}"가 실패했어요` } })
        this.event(d.id, `앞 작업 "${t.title}"가 실패해서 막혔어요.`)
      }
    }
    if (!t.parentId && !t.reviewOf) return
    const parent = all.find((x) => x.id === (t.parentId ?? t.reviewOf))
    if (parent) this.event(parent.id, `하위 작업 "${t.title}"가 실패했어요: ${(t.error ?? '').split('\n')[0].slice(0, 120)}`)
    if (h.hasPendingApproval(t.id, 'failure')) return
    h.createApproval({
      kind: 'failure',
      taskId: t.id,
      agentId: t.assignee ?? '',
      reason: `"${t.title}"가 실패했어요 — ${(t.error ?? '').split('\n')[0].slice(0, 160)}\n이 작업을 기다리던 일이 멈췄어요. 정해 주세요.`
    })
    this.c.notify('묶음이 막혔어요', `${t.title}: 실패 · 결재함에서 다음 행동을 골라 주세요`)
  }

  /** The board's answer to a failure: another model, go on without it, or cancel the whole bundle. */
  resolveFailure(approvalId: string, choice: 'retry' | 'skip' | 'cancel-all', by: string): void {
    const h = this.c.hive
    const a = h.listApprovals().find((x) => x.id === approvalId)
    if (!a || a.kind !== 'failure' || a.status !== 'pending') return
    const t = h.getTask(a.taskId)
    h.closeApproval(approvalId, by, choice === 'retry' ? '다른 모델로 다시 시도' : choice === 'skip' ? '이 작업을 빼고 진행' : '묶음 전체 취소', 'approved')
    if (!t) return
    const unblock = (): void => {
      for (const d of h.listTasks()) if (d.blocked?.by === t.id) h.updateTask(d.id, { blocked: undefined })
    }
    if (choice === 'cancel-all') {
      this.c.cancelTree?.(rootOf(h.listTasks(), t).id)
      return
    }
    if (choice === 'retry') {
      const alt = t.assignee ? this.alternativeFor(t.assignee) : null
      h.updateTask(t.id, {
        status: 'todo', error: undefined, errorKind: undefined, auto: true, planTries: 0,
        ...(alt ? { assignee: alt } : {}), reply: undefined
      })
      this.event(t.id, alt ? `다른 모델(${this.modelName(alt)}, ${this.rosterOf(alt)?.name ?? alt})로 다시 시도해요.` : '같은 담당자가 다시 시도해요 (바꿀 다른 모델이 없어요).')
      unblock()
      return void this.c.changed()
    }
    // skip
    if (t.kind === 'review' && t.reviewOf) {
      const target = h.getTask(t.reviewOf)
      h.updateTask(t.id, { status: 'cancelled', error: undefined })
      if (target) {
        h.updateTask(target.id, { status: 'done', reviewState: { status: 'skipped', round: target.reviewState?.round ?? 0, escalations: target.reviewState?.escalations ?? 0, note: '검토가 실패해서 검토 없이 진행했어요.' } })
        this.event(target.id, '검토가 실패해서 사람이 "검토 없이 진행"을 골랐어요.')
        this.rollUp(h.getTask(target.id)!)
      }
    } else {
      h.updateTask(t.id, { status: 'cancelled', error: '이사회가 이 작업을 빼고 진행하기로 했어요.' })
      for (const d of h.listTasks()) {
        if (d.dependsOn.includes(t.id)) h.updateTask(d.id, { dependsOn: d.dependsOn.filter((x) => x !== t.id), blocked: d.blocked?.by === t.id ? undefined : d.blocked })
      }
      this.event(t.id, '이 작업을 빼고 진행해요 (통합 보고서에 적혀요).')
      if (t.parentId) this.checkParent(t.parentId)
    }
    unblock()
    this.c.changed()
  }

  /** Another employee for the same kind of work: a different model, same or higher tier, preferably the same unit. */
  alternativeFor(agentId: string): string | null {
    const seat = this.seatOf(agentId)
    const key = this.modelKeyOf(agentId)
    const tier = this.modelOf(agentId)?.tier
    const near = seat ? this.subtree(seat.unitId) : new Set<string>()
    const cands = this.seats
      .filter((s) => s.agentId && s.agentId !== agentId && s.job === (seat?.job ?? s.job) && this.modelKeyOf(s.agentId) !== key)
      .map((s) => {
        const m = this.modelOf(s.agentId!)
        let score = near.has(s.unitId) ? 0 : 5
        if (tier && m && tierRank(m.tier) < tierRank(tier)) score += 8
        return { id: s.agentId!, score }
      })
      .sort((a, b) => a.score - b.score)
    return cands[0]?.id ?? null
  }

  private event(taskId: string, text: string): void {
    this.c.hive.addEvent(taskId, 'delegation', 'system', text)
  }

  /** Send a plan/review answer back to its author with a reason; fail after too many tries. */
  private sendBack(t: Task, message: string): void {
    const tries = (t.planTries ?? 0) + 1
    if (tries > LIMITS.planFormatTries) {
      this.c.hive.updateTask(t.id, {
        status: 'failed',
        error: `답변 형식이 계속 맞지 않아 멈췄어요: ${message}`,
        planTries: tries,
        finishedAt: new Date().toISOString()
      })
      this.event(t.id, `형식 문제로 멈췄어요: ${message}`)
      this.c.notify('위임이 멈췄어요', `${t.title}: ${message}`)
      return
    }
    this.c.hive.updateTask(t.id, { status: 'todo', reply: message, planTries: tries, auto: true })
    this.event(t.id, `다시 요청했어요: ${message}`)
  }

  private afterPlan(t: Task): void {
    const h = this.c.hive
    const parsed = parsePlan(t.result ?? '')
    if (parsed.self !== undefined && !parsed.items.length) {
      h.updateTask(t.id, { kind: 'work', status: 'todo', auto: true, permission: undefined, notes: [...t.notes, `직접 처리할 크기로 판단했어요: ${parsed.self}`] })
      this.event(t.id, `작은 일이라 직접 처리해요 (분배 생략): ${parsed.self}`)
      return
    }
    if (!t.assignee) return
    const team = this.teamOf(t.assignee)
    const ids = new Set(team.map((x) => x.agent.id))
    if (!parsed.items.length) {
      return this.sendBack(t, '[[SUBTASK: 제목 | assignee=<id> | done=<완료 조건> | after=none]] 형식으로 하위 작업을 적어 주세요. 직접 처리할 크기면 [[SELF: 이유]]만 적으세요.')
    }
    if (parsed.bad.length) {
      return this.sendBack(t, `읽을 수 없는 줄이 있어요(assignee가 필요해요): ${parsed.bad.join(' / ')}`)
    }
    if (parsed.items.length > LIMITS.maxSubtasks) {
      return this.sendBack(t, `하위 작업은 최대 ${LIMITS.maxSubtasks}개예요. 묶어서 다시 적어 주세요.`)
    }
    const after = validateAfter(parsed.items)
    if (after) return this.sendBack(t, after)
    const unknown = parsed.items.filter((i) => !ids.has(i.assignee)).map((i) => i.assignee)
    if (unknown.length) {
      return this.sendBack(t, `목록에 없는 담당자예요: ${[...new Set(unknown)].join(', ')}. 목록의 id만 쓰세요: ${[...ids].join(', ')}`)
    }
    // sub-tasks that declare overlapping files get an order; the rest may start together
    const ordered = orderByFiles(parsed.items)
    parsed.items = ordered.items
    for (const [later, earlier] of ordered.added) this.event(t.id, `${later}번 작업은 ${earlier}번과 같은 파일을 다뤄서 ${earlier}번이 끝난 뒤에 시작하도록 순서를 붙였어요.`)
    const depth = t.depth ?? 0
    const managers = parsed.items.map((i) => this.isManager(i.assignee))
    if (depth + 1 >= LIMITS.maxDepth && managers.some(Boolean)) {
      return this.sendBack(t, `분배 단계가 너무 깊어요(최대 ${LIMITS.maxDepth}단계). 관리자에게 다시 나누지 말고 담당자에게 직접 맡기세요.`)
    }

    const company = this.company
    const flags = new Set(parsed.flags)
    const mySeat = this.seatOf(t.assignee)
    if (mySeat && mySeat.job !== 'coo') {
      const mine = this.subtree(mySeat.unitId)
      if (parsed.items.some((i) => {
        const s = this.seatOf(i.assignee)
        return s && !mine.has(s.unitId)
      })) flags.add('other-unit')
    }
    const est = estimateBreakdown(
      parsed.items.map((i, k) => ({ manager: managers[k], est: i.est, reviewed: i.access !== 'read' })),
      this.runHistory()
    )
    // the planner's own total (if it gave one) is the first source; the parts show where a number from history/defaults would land
    const estimate = parsed.estimate ?? est.total
    if (parsed.estimate) est.basis = ['planner', ...est.basis.filter((b) => b !== 'planner')]
    const budget = this.budgetOf(t.projectId)
    if (budget && this.runsUsed(t.projectId) + estimate > budget) flags.add('budget')

    const issues = planIssues(parsed.items, this.capabilities(), (id) => this.isManager(id))
    const reasons: string[] = []
    if (issues.length) reasons.push(`할 수 없는 작업이 ${new Set(issues.map((i) => i.index)).size}개 있어요: ${issues.map((i) => `${i.index + 1}번 ${i.text}`).join(' / ')}`)
    if (company && estimate > company.bigJobRuns) reasons.push(`예상 AI 실행 ${estimate}회 (기준 ${company.bigJobRuns}회 초과)`)
    for (const f of flags) reasons.push(FLAG_LABEL[f])
    if (t.risky) reasons.push('위험 작업으로 표시된 태스크예요')
    if (t.directed) reasons.push('이사회가 관리자를 직접 지정했어요 (첫 분배 계획은 이사회 결재)')
    const rejections = t.plan?.rejections ?? 0
    if (rejections > LIMITS.planRejectLimit) reasons.push('계획이 반복해서 반려됐어요')

    let approver: Plan['approver'] = 'board'
    let superior: string | null = null
    if (!reasons.length) {
      if (mySeat?.job === 'coo') approver = 'auto'
      else {
        superior = this.superiorOf(t.assignee)
        if (superior) approver = 'superior'
        else reasons.push('결재해 줄 윗 직책이 없어요')
      }
    }
    const plan: Plan = {
      items: parsed.items,
      estimateRuns: estimate,
      estimateParts: { plan: est.plan, work: est.work, review: est.review, buffer: est.buffer, basis: est.basis },
      ...(issues.length ? { issues } : {}),
      ...(t.plan?.estimateRuns && rejections > 0 ? { prevEstimate: t.plan.estimateRuns } : {}),
      flags: [...flags],
      status: approver === 'board' ? 'awaiting_board' : approver === 'superior' ? 'awaiting_superior' : 'approved',
      approver,
      boardReasons: reasons,
      rejections
    }
    h.updateTask(t.id, { plan, planTries: 0 })
    this.event(t.id, `분배 계획 ${parsed.items.length}개 작업 · 예상 실행 ${estimate}회 · 결재: ${approver === 'board' ? '이사회' : approver === 'superior' ? this.rosterOf(superior)?.name : '필요 없음(자동)'}`)

    if (approver === 'auto') return void this.approvePlan(t.id, 'system')
    if (approver === 'board') {
      h.createApproval({ kind: 'plan', taskId: t.id, agentId: t.assignee, reason: `분배 계획 결재: ${reasons.join(' / ')}` })
      h.updateTask(t.id, { status: 'awaiting_approval' })
      this.c.notify('분배 계획 결재가 필요해요', `${t.title}: ${reasons[0] ?? ''}`)
      return
    }
    // superior approves: a plan-review task runs on the superior's agent
    this.makeReviewTask(t, superior!, `[계획 검토] ${t.title}`)
    h.updateTask(t.id, { status: 'in_review' })
  }

  /** What this company can do beyond reading and writing files (grows with the external connections of v4 stage 6-5 and later). */
  capabilities(): { github: boolean; web: boolean } {
    return this.c.capabilities?.() ?? { github: false, web: false }
  }

  /**
   * The board edits a plan itself (take a sub-task out, change who does it, reorder, fix the completion condition)
   * and approves it — no AI run. Sub-tasks marked `human` become tasks nobody is assigned to.
   */
  editPlan(taskId: string, items: SubtaskSpec[], by: string, human: number[] = []): void {
    const h = this.c.hive
    const t = h.getTask(taskId)
    if (!t?.plan) throw new Error('고칠 계획이 없어요.')
    const team = this.teamOf(t.assignee ?? '')
    const ids = new Set(team.map((x) => x.agent.id))
    let list = items
    // work for a person: leave the plan, become an open task
    for (const i of [...human].sort((a, b) => b - a)) {
      const it = list[i]
      if (!it) continue
      const made = h.createTask({ title: it.title, description: `${it.title}\n\n상위 업무: ${t.title}\n완료 조건: ${it.done || '(정해지지 않음)'}\n(자동 계획에서 사람이 할 일로 옮겼어요)`, assignee: null, createdBy: by, projectId: t.projectId })
      h.addEvent(t.id, 'delegation', by, `"${it.title}"는 사람이 할 일로 옮겼어요 (업무 ${made.id.slice(0, 6)}).`)
      list = removeItem(list, i)
    }
    if (!list.length) throw new Error('하위 작업이 하나도 남지 않았어요. 계획을 반려하거나 취소하세요.')
    list = orderByFiles(list).items
    const bad = validateAfter(list)
    if (bad) throw new Error(bad)
    const unknown = list.filter((i) => !ids.has(i.assignee)).map((i) => i.assignee)
    if (unknown.length) throw new Error(`목록에 없는 담당자예요: ${[...new Set(unknown)].join(', ')}`)
    const managers = list.map((i) => this.isManager(i.assignee))
    const est = estimateBreakdown(list.map((i, k) => ({ manager: managers[k], est: i.est, reviewed: i.access !== 'read' })), this.runHistory())
    const issues = planIssues(list, this.capabilities(), (id) => this.isManager(id))
    if (issues.length) throw new Error(`아직 할 수 없는 작업이 있어요: ${issues.map((i) => `${i.index + 1}번 ${i.text}`).join(' / ')}`)
    h.updateTask(t.id, {
      plan: { ...t.plan, items: list, estimateRuns: est.total, estimateParts: { plan: est.plan, work: est.work, review: est.review, buffer: est.buffer, basis: est.basis }, issues: undefined }
    })
    this.event(t.id, `${by}가 계획을 직접 고쳤어요 (하위 작업 ${list.length}개 · 예상 실행 ${est.total}회).`)
  }

  /** The board takes one step of a running plan out: it counts as done so what waits on it can go on. */
  skipStep(childId: string, by: string): boolean {
    const h = this.c.hive
    const c = h.getTask(childId)
    if (!c?.parentId || c.status === 'done' || c.status === 'cancelled' || c.status === 'running') return false
    h.updateTask(c.id, { status: 'done', result: '사람이 이 단계를 건너뛰었어요.', error: undefined, finishedAt: new Date().toISOString(), reviewState: { status: 'skipped', round: 0, escalations: 0, note: '사람이 건너뜀' } })
    h.addEvent(c.id, 'status', by, '이 단계를 건너뛰었어요.')
    h.addEvent(c.parentId, 'delegation', by, `하위 작업 "${c.title}"를 건너뛰었어요.`)
    this.checkParent(c.parentId)
    return true
  }

  /** The board adds a step to a running plan (it must finish before the bundle is integrated). */
  addStep(parentId: string, spec: { title: string; assignee: string; done?: string; after?: string[] }, by: string): Task {
    const h = this.c.hive
    const p = h.getTask(parentId)
    if (!p || p.status !== 'delegated' || !p.plan) throw new Error('진행 중인 분배 계획에만 단계를 더할 수 있어요.')
    if (!spec.title.trim()) throw new Error('작업 제목을 적어 주세요.')
    const ids = new Set(this.teamOf(p.assignee ?? '').map((x) => x.agent.id))
    if (!ids.has(spec.assignee)) throw new Error('이 계획을 맡은 팀에 없는 담당자예요.')
    const manager = this.isManager(spec.assignee)
    const c = h.createTask({
      title: spec.title.trim(),
      description: `${spec.title.trim()}\n\n상위 업무: ${p.title}\n완료 조건: ${spec.done || '(정해지지 않음)'}\n(사람이 진행 중에 더한 단계예요)`,
      assignee: spec.assignee,
      dependsOn: spec.after ?? [],
      projectId: p.projectId,
      permission: manager ? ('read' as const) : 'edit',
      createdBy: by
    })
    h.updateTask(c.id, { kind: manager ? 'plan' : 'work', parentId: p.id, depth: (p.depth ?? 0) + 1, auto: true, criteria: spec.done, projectId: p.projectId })
    h.updateTask(p.id, { plan: { ...p.plan, childIds: [...(p.plan.childIds ?? []), c.id] } })
    h.addEvent(p.id, 'delegation', by, `단계를 더했어요: "${c.title}"`)
    return h.getTask(c.id)!
  }

  /**
   * The board changed its mind about the whole plan: every unfinished sub-task is dropped by the caller,
   * and the planner writes a new plan that takes the new instruction (and the finished work) into account.
   */
  replan(taskId: string, instruction: string, by: string): boolean {
    const h = this.c.hive
    const t = h.getTask(taskId)
    if (!t?.plan || t.status !== 'delegated') return false
    const done = this.children(t.id).filter((k) => k.status === 'done').map((k) => `- ${k.title}`)
    h.updateTask(t.id, {
      plan: { ...t.plan, status: 'rejected', note: instruction, rejections: t.plan.rejections },
      status: 'todo',
      auto: true,
      reply: `사람이 방향을 바꿨어요 (${by}): ${instruction}\n이 지시를 반영해서 분배 계획을 처음부터 다시 써 주세요.${done.length ? `\n이미 끝난 하위 작업이에요. 다시 만들지 말고 필요하면 결과를 재사용하세요:\n${done.join('\n')}` : ''}`
    })
    this.event(t.id, `${by}가 새 지시로 계획을 다시 세우라고 했어요: ${instruction}`)
    return true
  }

  /** What finished sub-tasks of this company really cost in AI runs (needs a few samples to count). */
  private runHistory(): { worker?: number; manager?: number } {
    const h = this.c.hive
    const all = h.listTasks()
    const runsOf = (ids: string[]): number => h.listAptitude().filter((a) => ids.includes(a.taskId.split('~')[0])).reduce((n, a) => n + a.runs, 0)
    const avg = (ts: Task[], f: (t: Task) => number): number | undefined => {
      const xs = ts.map(f).filter((n) => n > 0)
      return xs.length >= 3 ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : undefined
    }
    const workers = all.filter((t) => t.parentId && t.kind === 'work' && t.status === 'done')
    const managers = all.filter((t) => t.parentId && t.kind === 'plan' || t.parentId && t.kind === 'integrate').filter((t) => t.status === 'done')
    return {
      worker: avg(workers, (t) => runsOf([t.id, ...all.filter((x) => x.reviewOf === t.id).map((x) => x.id)])),
      manager: avg(managers, (t) => runsOf(this.subtreeIds(t.id)))
    }
  }

  private subtreeIds(id: string): string[] {
    const all = this.c.hive.listTasks()
    const out = new Set<string>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const t of all) if (!out.has(t.id) && ((t.parentId && out.has(t.parentId)) || (t.reviewOf && out.has(t.reviewOf)))) (out.add(t.id), (grew = true))
    }
    return [...out]
  }

  private makeReviewTask(target: Task, reviewer: string, title: string): Task {
    const h = this.c.hive
    const r = h.createTask({
      title,
      description: `검토 대상: ${target.title}`,
      assignee: reviewer,
      permission: 'read',
      createdBy: 'system'
    })
    return h.updateTask(r.id, {
      kind: 'review',
      reviewOf: target.id,
      depth: target.depth ?? 0,
      auto: true,
      projectId: target.projectId
    })
  }

  /** Create the sub-tasks of an approved plan; the task now waits for them. */
  approvePlan(taskId: string, by: string): void {
    const h = this.c.hive
    const t = h.getTask(taskId)
    if (!t?.plan) return
    const created: string[] = []
    t.plan.items.forEach((it, idx) => {
      const manager = this.isManager(it.assignee)
      const c = h.createTask({
        title: it.title,
        description: `${it.title}\n\n상위 업무: ${t.title}${t.description ? `\n상위 업무 설명: ${t.description}` : ''}\n완료 조건: ${it.done || '(정해지지 않음)'}`,
        assignee: it.assignee,
        dependsOn: it.after.map((n) => created[n - 1]).filter(Boolean),
        projectId: t.projectId,
        // managers only plan (read); workers get what their result needs — file work is `edit`, never read-only by accident
        permission: manager ? ('read' as const) : (it.access ?? 'edit'),
        createdBy: by
      })
      h.updateTask(c.id, {
        kind: manager ? 'plan' : 'work',
        parentId: t.id,
        depth: (t.depth ?? 0) + 1,
        auto: true,
        criteria: it.done,
        projectId: t.projectId
      })
      created.push(c.id)
    })
    h.updateTask(t.id, { status: 'delegated', plan: { ...t.plan, status: 'approved', childIds: created } })
    this.event(t.id, `${by === 'system' ? '자동 승인' : by + ' 승인'}: 하위 작업 ${created.length}개를 만들었어요.`)
  }

  /** A plan is sent back with a reason (by the superior or by the board). */
  rejectPlan(taskId: string, reason: string, by: string, byBoard = false): void {
    const h = this.c.hive
    const t = h.getTask(taskId)
    if (!t?.plan) return
    const rejections = t.plan.rejections + 1
    if (!byBoard && rejections > LIMITS.planRejectLimit) {
      // sent back too often: the board decides
      const plan: Plan = {
        ...t.plan,
        rejections,
        status: 'awaiting_board',
        approver: 'board',
        boardReasons: [...t.plan.boardReasons, '윗 직책이 계획을 반복해서 반려했어요']
      }
      h.updateTask(t.id, { plan, status: 'awaiting_approval' })
      h.createApproval({ kind: 'plan', taskId: t.id, agentId: t.assignee ?? '', reason: `분배 계획 결재: 반복 반려 — 마지막 이유: ${reason}` })
      this.event(t.id, `반려가 ${rejections}번째라 이사회 결재로 올렸어요: ${reason}`)
      this.c.notify('분배 계획 결재가 필요해요', `${t.title}: 반복 반려`)
      return
    }
    h.updateTask(t.id, {
      plan: { ...t.plan, rejections, status: 'rejected', note: reason },
      status: 'todo',
      reply: `분배 계획이 반려됐어요 (${by}): ${reason}\n이유를 반영해서 계획을 다시 써 주세요.`,
      auto: true
    })
    this.event(t.id, `계획 반려 (${by}): ${reason}`)
  }

  private settings(): ReviewSettings {
    return { ...DEFAULT_REVIEW, ...(this.c.reviewSettings?.() ?? {}) }
  }

  private afterWork(w: Task): void {
    const h = this.c.hive
    if (w.reviewState?.status === 'pending') return
    const prev = w.reviewState
    const s = this.settings()
    // v5.1: the app's own checks failed — back to the worker with the output, no AI review spent
    // the very same failure again after a send-back: probably not this work's fault (a test that was already broken) — a reviewer judges
    const failNote = w.checks && !w.checks.ok ? checksFailNote(w.checks) : ''
    const sameAgain = !!failNote && prev?.status === 'changes' && prev.by === CHECKS_BY && !!prev.note && sameOutput(prev.note, failNote)
    if (failNote && !sameAgain) return this.handleChanges(w, failNote, '자동 검사', CHECKS_BY)
    if (sameAgain) this.event(w.id, '고친 뒤에도 자동 검사가 똑같이 실패해요. 원래 있던 문제일 수 있어서 검토자가 판단해요.')
    // small, safe and checked: no AI review needed (not after a reviewer sent it back — that reviewer confirms the fix)
    const run = this.lastRun(w.id)
    const risk = reviewRisk({ files: run?.files ?? [], lines: run?.diffStat.available })
    const reviewerAsked = prev?.status === 'changes' && prev.by !== CHECKS_BY
    if (!reviewerAsked && !sameAgain && canSkipReview(s.policy, risk, w.checks)) {
      const why = `${risk.why}${w.checks ? ' · ' + checksLine(w.checks) : ''}`
      h.updateTask(w.id, { reviewState: { status: 'skipped', round: prev?.round ?? 0, escalations: prev?.escalations ?? 0, note: `AI 검토 생략: ${why}` } })
      this.event(w.id, `위험이 낮아서 AI 검토를 생략했어요 (${why}).`)
      this.c.aptitude(w.assignee, w.id, { approved: 1 })
      return void this.rollUp(w)
    }
    const reviewer = this.pickReviewer(w.assignee)
    if (!reviewer) {
      h.updateTask(w.id, { reviewState: { status: 'skipped', round: prev?.round ?? 0, escalations: prev?.escalations ?? 0, note: '다른 모델의 검토자가 없어서 검토 없이 끝냈어요.' } })
      this.event(w.id, '다른 모델의 검토자를 찾지 못해 교차 검토를 건너뛰었어요 (회사 탭에서 검토자 자리에 다른 모델 에이전트를 두세요).')
      this.c.aptitude(w.assignee, w.id, { approved: 1 })
      return void this.rollUp(w)
    }
    this.makeReviewTask(w, reviewer, `[검토] ${w.title}`)
    h.updateTask(w.id, {
      status: 'in_review',
      reviewState: { status: 'pending', round: prev?.round ?? 0, escalations: prev?.escalations ?? 0, by: reviewer }
    })
    this.event(w.id, `${this.rosterOf(reviewer)?.name ?? reviewer}(${this.modelName(reviewer)})가 교차 검토해요.`)
  }

  private afterReview(r: Task): void {
    const h = this.c.hive
    const target = r.reviewOf ? h.getTask(r.reviewOf) : null
    const v = parseVerdict(r.result ?? '')
    if (!target) return
    if (!v) {
      const tries = (r.planTries ?? 0) + 1
      if (tries <= LIMITS.planFormatTries) {
        h.updateTask(r.id, { status: 'todo', reply: '마지막에 [[VERDICT: pass]] 또는 [[VERDICT: changes: 고칠 점]] 한 줄로 결론을 적어 주세요.', planTries: tries, auto: true })
        return
      }
      // the reviewer never gave a verdict: a human has to look
      this.event(target.id, '검토자가 결론을 내지 못했어요. 사람이 확인해야 해요.')
      if (target.kind === 'plan') {
        this.escalatePlanToBoard(target, '검토자가 결론을 내지 못했어요')
      } else {
        h.updateTask(target.id, { status: 'needs_review', reviewState: { status: 'skipped', round: target.reviewState?.round ?? 0, escalations: target.reviewState?.escalations ?? 0, note: '검토자가 결론을 내지 못했어요.' } })
        this.c.notify('사람 확인이 필요해요', `${target.title}: 검토자가 결론을 내지 못했어요`)
      }
      return
    }
    const reviewerName = this.rosterOf(r.assignee)?.name ?? r.assignee ?? ''
    if (target.kind === 'plan') {
      if (v.pass) {
        this.event(target.id, `${reviewerName}가 계획을 승인했어요.`)
        this.approvePlan(target.id, reviewerName)
      } else {
        this.rejectPlan(target.id, v.note, reviewerName)
      }
      return
    }
    // a work task
    const st = target.reviewState
    if (v.pass) {
      h.updateTask(target.id, {
        status: 'done',
        reviewState: { status: 'passed', round: st?.round ?? 0, escalations: st?.escalations ?? 0, by: r.assignee ?? undefined, note: v.note || undefined }
      })
      this.event(target.id, `교차 검토 통과 (${reviewerName}).${v.note ? ' ' + v.note : ''}`)
      this.c.aptitude(target.assignee, target.id, { approved: 1 })
      return void this.rollUp(h.getTask(target.id)!)
    }
    this.handleChanges(target, v.note, reviewerName)
  }

  private escalatePlanToBoard(t: Task, why: string): void {
    const h = this.c.hive
    if (!t.plan) return
    h.updateTask(t.id, { plan: { ...t.plan, status: 'awaiting_board', approver: 'board', boardReasons: [...t.plan.boardReasons, why] }, status: 'awaiting_approval' })
    h.createApproval({ kind: 'plan', taskId: t.id, agentId: t.assignee ?? '', reason: `분배 계획 결재: ${why}` })
    this.c.notify('분배 계획 결재가 필요해요', `${t.title}: ${why}`)
  }

  /** The reviewer wants changes: back to the worker, then up to the lead, then to the board. */
  private handleChanges(w: Task, note: string, reviewerName: string, by?: string): void {
    const h = this.c.hive
    const st = w.reviewState ?? { status: 'pending' as const, round: 0, escalations: 0 }
    this.c.aptitude(w.assignee, w.id, { changes: 1 })
    const round = st.round + 1
    const maxRounds = Math.min(3, Math.max(1, this.settings().maxRounds || LIMITS.rejectLimit))
    // a quick job sent back twice goes one tier up instead of to a lead
    if (w.quick && !w.parentId && round >= 2 && this.c.quickEscalate?.(w, `검토에서 ${round}번 반려됐어요: ${note}`)) return
    if (round <= maxRounds) {
      h.updateTask(w.id, {
        status: 'todo',
        auto: true,
        reply: by === CHECKS_BY ? `${note}\n(${round}/${maxRounds})` : `교차 검토(${reviewerName})에서 수정을 요청했어요 (${round}/${maxRounds}):\n${note}`,
        reviewState: { status: 'changes', round, escalations: st.escalations, by: by ?? st.by, note }
      })
      this.event(w.id, `수정 요청 ${round}/${maxRounds} (${reviewerName}): ${note.split('\n')[0]}`)
      return
    }
    const lead = st.escalations === 0 && w.assignee ? this.superiorOf(w.assignee) : null
    if (lead) {
      h.updateTask(w.id, {
        assignee: lead,
        status: 'todo',
        auto: true,
        reply: `이 작업은 담당자가 ${maxRounds}번 반려돼서 당신에게 올라왔어요. 검토 의견:\n${note}\n직접 고쳐서 끝내 주세요.`,
        reviewState: { status: 'changes', round: 0, escalations: 1, by: st.by, note }
      })
      this.event(w.id, `반려가 ${maxRounds}번 반복돼서 ${this.rosterOf(lead)?.name ?? lead}(윗 직책)에게 올렸어요.`)
      this.c.notify('작업이 윗 직책으로 올라갔어요', w.title)
      return
    }
    h.createApproval({ kind: 'agent-request', taskId: w.id, agentId: w.assignee ?? '', reason: `끝까지 막혔어요 — 마지막 검토 의견: ${note}` })
    h.updateTask(w.id, {
      status: 'awaiting_approval',
      reviewState: { status: 'changes', round, escalations: st.escalations, by: st.by, note }
    })
    this.event(w.id, '끝까지 막혀서 이사회에 올렸어요.')
    this.c.notify('이사회 결정이 필요해요', `${w.title}: 반복 반려로 막혔어요`)
  }

  /** When a sub-task is done, see whether its parent can move on to integration. */
  private rollUp(child: Task): void {
    if (!child.parentId) return
    this.checkParent(child.parentId)
  }

  /** A sub-task was cancelled or skipped: the bundle may be ready to integrate. */
  childSettled(parentId: string): void {
    this.checkParent(parentId)
  }

  private checkParent(parentId: string): void {
    const h = this.c.hive
    const p = h.getTask(parentId)
    if (!p || p.status !== 'delegated') return
    const kids = this.children(p.id)
    if (!kids.length || !kids.every((k) => k.status === 'done' || k.status === 'cancelled') || !kids.some((k) => k.status === 'done')) return
    h.updateTask(p.id, { kind: 'integrate', status: 'todo', auto: true, permission: 'read', reply: undefined })
    this.event(p.id, '하위 작업이 모두 끝났어요. 담당 관리자가 확인하고 통합해요.')
  }

  private afterIntegrate(t: Task): void {
    const h = this.c.hive
    if (t.parentId) {
      this.event(t.id, '통합을 마쳤어요. 상위로 보고해요.')
      return void this.checkParent(t.parentId)
    }
    const report = this.buildFinal(t.id)
    h.saveFinal(report)
    h.updateTask(t.id, { status: 'needs_review' })
    this.event(t.id, '최종 보고서를 이사회에 제출했어요.')
    this.c.notify('최종 보고서가 도착했어요', t.title)
  }

  /** The board answered the final report (the usual review buttons). */
  recordDecision(taskId: string, accepted: boolean, by: string, note?: string): void {
    const t = this.c.hive.getTask(taskId)
    const r = this.c.hive.getFinal(taskId)
    if (!t || t.kind !== 'integrate' || t.parentId || !r) return
    this.c.hive.saveFinal({ ...r, decision: { at: new Date().toISOString(), by, accepted, note } })
  }

  /** After the board asked for changes on a final report: integrate again with their note. */
  reopenIntegration(taskId: string): void {
    this.c.hive.updateTask(taskId, { kind: 'integrate', auto: true })
  }

  // ---- project budget ----
  private budgetOf(projectId?: string): number {
    return this.c.hive.getProject(projectId)?.runBudget ?? 0
  }
  runsUsed(projectId?: string): number {
    if (!projectId) return 0
    const ids = new Set(this.c.hive.listTasks().filter((t) => t.projectId === projectId).map((t) => t.id))
    return this.c.hive.listAptitude().filter((a) => ids.has(a.taskId.split('~')[0])).reduce((n, a) => n + a.runs, 0)
  }

// ---- final report ----
  buildFinal(rootId: string): FinalReport {
    const h = this.c.hive
    const all = h.listTasks()
    const apt = h.listAptitude()
    const root = all.find((t) => t.id === rootId)!
    let additions = 0
    let deletions = 0
    const changed = new Set<string>()
    let tasks = 0
    const verification: string[] = []
    const risks: string[] = []

    const node = (t: Task): ReportNode => {
      tasks++
      const ids = [t.id, ...all.filter((x) => x.kind === 'review' && x.reviewOf === t.id).map((x) => x.id)]
      let runs = 0
      let ms = 0
      for (const a of apt) {
        const base = a.taskId.split('~')[0]
        if (ids.includes(base)) (runs += a.runs, (ms += a.ms))
      }
      const shared = h.listSharedRuns(t.id)
      const files = new Map<string, ReportNode['files'][number]>()
      for (const run of shared) {
        additions += run.diffStat.additions
        deletions += run.diffStat.deletions
        for (const f of run.files) (files.set(f.path, f), changed.add(f.path))
      }
      if (t.report?.verify && t.report.verify.toLowerCase() !== 'none') verification.push(`${t.title}: ${t.report.verify.replace(/\n/g, ' ')}`)
      if (t.report?.risks && t.report.risks.toLowerCase() !== 'none') risks.push(`${t.title}: ${t.report.risks.replace(/\n/g, ' ')}`)
      const rs = t.reviewState
      const review = rs
        ? rs.status === 'passed'
          ? `통과${rs.round ? ` (수정 ${rs.round}회)` : ''}`
          : rs.status === 'skipped'
            ? '검토 생략'
            : '수정 요청 중'
        : undefined
      const seat = this.seatOf(t.assignee)
      return {
        taskId: t.id,
        title: t.title,
        kind: t.kind ?? 'work',
        agentId: t.assignee,
        agentName: this.rosterOf(t.assignee)?.name ?? t.assignee ?? '-',
        job: seat ? jobLabel(seat.job) : undefined,
        model: this.modelName(t.assignee),
        status: t.status,
        runs,
        minutes: Math.round(ms / 60000),
        files: [...files.values()],
        report: t.report,
        review,
        children: all.filter((x) => x.parentId === t.id && x.kind !== 'review').map(node)
      }
    }
    const tree = node(root)
    const inTree = new Set(subtree(all, root.id).map((t) => t.id))
    const skipped = all.filter((x) => x.status === 'cancelled' && x.kind !== 'review' && inTree.has(x.id))
    if (skipped.length) risks.push(`취소되거나 빠진 하위 업무 ${skipped.length}건: ${skipped.map((k) => k.title).join(', ')}`)
    const sum = (n: ReportNode): { runs: number; minutes: number } =>
      n.children.reduce((a, c) => ({ runs: a.runs + sum(c).runs, minutes: a.minutes + sum(c).minutes }), { runs: n.runs, minutes: n.minutes })
    const total = sum(tree)
    return {
      id: rootId,
      title: root.title,
      createdAt: new Date().toISOString(),
      summary: root.report?.did || (root.result ?? '').slice(0, 1500),
      tree,
      totals: { ...total, files: changed.size, additions, deletions, tasks },
      verification,
      risks,
      next: root.report?.next && root.report.next.toLowerCase() !== 'none' ? [root.report.next] : []
    }
  }
}
