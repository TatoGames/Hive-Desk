import type { ModelEntry } from '../shared/company'
import { tierOfSlug } from '../shared/company'
import { costLine, handoffNote, handoffReasonLabel, nearLimit, pickHandoff, shouldWait, whyNot, type HandoffCand, type HandoffNeed } from '../shared/handoff'
import { readJob } from '../shared/quick'
import { LOCAL_QUEUE } from '../shared/localqueue'
import { DEFAULT_HANDOFF, type Agent, type Handoff, type HandoffReason, type HandoffSettings, type Task } from '../shared/types'
import { rollback } from './checkpoint'
import type { Hive } from './hive'
import type { LimitInfo } from './limits'

export interface HandoffCtx {
  readonly hive: Hive
  /** Employees of the company on this computer. */
  agents: () => Agent[]
  catalog: () => ModelEntry[]
  settings: () => HandoffSettings
  limitFor: (adapter: Agent['adapter']) => LimitInfo | undefined
  /** The employee's own daily budget is used up. */
  budgetGone: (agent: Agent) => boolean
  nearLimit: (adapter: Agent['adapter']) => boolean
  isManager: (agentId: string) => boolean
  /** Does this task use external connections with this employee (web, MCP)? */
  usesExternal: (task: Task, agent: Agent) => boolean
  isRunning: (taskId: string) => boolean
  /** A1: null = a model on this PC may do this task (easy enough, permission fits); otherwise why not. Uses the same guard as the local run. */
  localFit?: (task: Task, agent: Agent) => string | null
  /** A1: the engine of this employee's model answered and lists the model. */
  localReady?: (agent: Agent) => boolean
  /** A3: tasks waiting in line for this employee's model. */
  localWaiting?: (agent: Agent) => number
  excludesFor: (root: string) => string[]
  changed: () => void
  notify: (title: string, body: string) => void
  me: () => string
}

export interface HandoffOption {
  agentId: string
  name: string
  label: string
  /** null = can take it. */
  why: string | null
  costX: number
}

/** v5: when a connection runs out of usage, an employee of another connection carries the task on from its last step. */
export class Handoffs {
  /** Hand-overs given to each employee in this round (spreads a bundle over several people). */
  private round = new Map<string, number>()
  private roundAt = 0

  constructor(private c: HandoffCtx) {}

  private model(a: Agent): { key: string; label: string; tier: ModelEntry['tier']; weight: number } {
    const m = a.modelRef ? this.c.catalog().find((x) => x.id === a.modelRef!.id) : undefined
    if (m) return { key: m.id, label: `${m.family} ${m.version}`.trim(), tier: m.tier, weight: m.weight || 1 }
    const tier = tierOfSlug(a.model ?? 'default')
    return { key: `${a.adapter}:${a.model ?? 'default'}`, label: a.model || a.adapter, tier, weight: tier === 'top' ? 6 : tier === 'balanced' ? 3 : 1 }
  }

  private rankLevel(a: Agent): number | undefined {
    return this.c.hive.getCompany()?.ranks.find((r) => r.id === a.rankId)?.level
  }

  private passRate(a: Agent, kind: string | undefined): number | undefined {
    const key = this.model(a).key
    const rs = this.c.hive.listAptitude().filter((r) => r.modelKey === key && !r.handedOver && (!kind || r.jobKind === kind || r.domain === kind))
    const n = rs.filter((r) => r.approved + r.changes + r.failed > 0)
    if (!n.length) return undefined
    return n.filter((r) => r.approved > 0 && r.changes + r.failed === 0).length / n.length
  }

  /** Why a model on this PC cannot take this task now (null = it can): A1 conditions 1, 3, 4 (condition 2, the permission, is `whyNot`). */
  private localBlock(task: Task, a: Agent): string | null {
    if (!this.c.localFit || !this.c.localReady) return '내 PC AI 연결이 준비되지 않음'
    const fit = this.c.localFit(task, a)
    if (fit) return `내 PC AI에게는 어려운 일: ${fit}`
    if (!this.c.localReady(a)) return '내 PC의 모델이 떠 있지 않음'
    if ((this.c.localWaiting?.(a) ?? 0) >= LOCAL_QUEUE.maxWaiting) return '내 PC 모델의 대기열이 길음'
    return null
  }

  /** `local`: also the employees that use a model on this PC (only when a usage limit hands the task over). */
  private candidates(task: Task, opts: { local?: boolean } = {}): HandoffCand[] {
    const h = this.c.hive
    const all = h.listTasks()
    if (Date.now() - this.roundAt > 60_000) this.round.clear()
    return this.c.agents().filter((a) => !a.localModel || opts.local).map((a) => {
      if (a.localModel) {
        const busy = all.some((t) => t.id !== task.id && t.assignee === a.id && (t.status === 'running' || this.c.isRunning(t.id) || t.status === 'todo'))
        return {
          agentId: a.id,
          name: a.name,
          adapter: a.adapter,
          modelKey: `local:${a.localModel.endpointId}|${a.localModel.model}`,
          tier: 'light' as const,
          weight: 0.1,
          rankLevel: this.rankLevel(a),
          isManager: this.c.isManager(a.id),
          idle: !busy,
          limited: this.c.budgetGone(a),
          taken: this.round.get(a.id) ?? 0,
          local: true,
          blocked: this.localBlock(task, a) ?? undefined
        }
      }
      const m = this.model(a)
      const busy = all.some((t) => t.id !== task.id && t.assignee === a.id && (t.status === 'running' || this.c.isRunning(t.id) || t.status === 'todo'))
      return {
        agentId: a.id,
        name: a.name,
        adapter: a.adapter,
        modelKey: m.key,
        tier: m.tier,
        weight: m.weight,
        rankLevel: this.rankLevel(a),
        isManager: this.c.isManager(a.id),
        idle: !busy,
        limited: !!this.c.limitFor(a.adapter) || this.c.budgetGone(a),
        nearLimit: this.c.nearLimit(a.adapter),
        passRate: this.passRate(a, task.jobKind),
        taken: this.round.get(a.id) ?? 0
      }
    })
  }

  private need(task: Task, from: Agent): HandoffNeed {
    const h = this.c.hive
    const job = readJob(`${task.title}\n${task.description}`)
    const avoid: string[] = []
    if (task.kind === 'review' && task.reviewOf) {
      const target = h.getTask(task.reviewOf)
      const worker = target?.assignee ? this.c.agents().find((a) => a.id === target.assignee) : undefined
      if (worker) avoid.push(this.model(worker).key)
      else if (target?.assignee) {
        const r = h.listRoster().find((x) => x.id === target.assignee)
        if (r?.modelId) avoid.push(r.modelId)
      }
    }
    return {
      kind: task.kind,
      permission: task.permission ?? from.permission ?? 'edit',
      minTier: task.kind === 'plan' || task.kind === 'integrate' ? 'balanced' : job.minTier,
      usesExternal: this.c.usesExternal(task, from),
      avoidModels: avoid,
      triedAdapters: [...new Set((task.handoffs ?? []).flatMap((x) => [x.fromAdapter, x.toAdapter]))].filter((ad) => ad !== from.adapter)
    }
  }

  /**
   * The run hit its connection's usage limit (or the tick looks at a task that waits for it). Hand it over when the
   * settings allow and somebody can; otherwise leave it waiting. Returns the new employee when it was handed over.
   */
  async onLimit(taskId: string): Promise<string | null> {
    const s = { ...DEFAULT_HANDOFF, ...this.c.settings() }
    const h = this.c.hive
    const t = h.getTask(taskId)
    if (!t || t.status !== 'todo' || !t.assignee) return null
    const from = this.c.agents().find((a) => a.id === t.assignee)
    if (!from) return null
    const lim = this.c.limitFor(from.adapter)
    if (!lim) {
      if (t.limitWait) h.updateTask(taskId, { limitWait: undefined })
      return null
    }
    if (!t.limitWait) h.updateTask(taskId, { limitWait: { adapter: from.adapter, since: new Date().toISOString() } })
    if (!s.auto || shouldWait(lim, s.waitMinutes)) return null
    return this.proceed(t, from, s, 'limit', { local: s.allowLocal !== false })
  }

  /**
   * A3: a task of a model on this PC could not run here (out of memory / model would not load / waited too long in line).
   * Not tried again on this PC: an employee of another connection takes it when settings allow, else it stays with a person.
   */
  async onLocalFailure(taskId: string, kind: 'memory' | 'load' | 'queue'): Promise<string | null> {
    const s = { ...DEFAULT_HANDOFF, ...this.c.settings() }
    const t = this.c.hive.getTask(taskId)
    const from = t?.assignee ? this.c.agents().find((a) => a.id === t.assignee) : undefined
    if (!t || !from?.localModel || t.status !== 'needs_input' || !s.auto) return null
    if (this.c.hive.listApprovals().some((a) => a.taskId === taskId && a.kind === 'handoff' && a.status === 'pending')) return null
    return this.proceed(t, from, s, kind === 'queue' ? 'queue' : 'memory', { local: false })
  }

  private async proceed(t: Task, from: Agent, s: HandoffSettings, reason: HandoffReason, o: { local: boolean }): Promise<string | null> {
    const h = this.c.hive
    if (h.listApprovals().some((a) => a.taskId === t.id && a.kind === 'handoff' && a.status === 'pending')) return null
    const fm = this.model(from)
    const fromInfo = from.localModel ? { tier: 'light' as const, weight: 1 } : fm
    const r = pickHandoff({ agentId: from.id, adapter: from.adapter, tier: fromInfo.tier, weight: fromInfo.weight, rankLevel: this.rankLevel(from) }, this.candidates(t, { local: o.local }), this.need(t, from), { up: s.up })
    if (!r.pick) return null
    if (s.confirmAtCostX > 0 && r.pick.costX >= s.confirmAtCostX) {
      const to = this.c.agents().find((a) => a.id === r.pick!.cand.agentId)!
      const lead = reason === 'limit' ? `${from.name}의 연결이 한도에 걸렸어요.` : `${from.name}의 내 PC AI로는 할 수 없었어요(${handoffReasonLabel(reason)}).`
      const a = h.createApproval({
        kind: 'handoff',
        taskId: t.id,
        agentId: from.id,
        reason: `${lead} ${to.name}(${this.model(to).label})에게 넘길까요? ${costLine(r.pick.costX)}. 거절하면 ${reason === 'limit' ? '한도가 풀릴 때까지 기다려요' : '사람이 정할 때까지 기다려요'}.`
      })
      h.saveApproval({ ...a, handoff: { to: to.id, costX: r.pick.costX, reason } })
      this.c.changed()
      return null
    }
    return this.perform(t.id, r.pick.cand.agentId, reason, r.pick.costX)
  }

  /** The employees a person could hand this task to, with why the others cannot (for [다른 직원에게 넘기기]). */
  options(taskId: string): HandoffOption[] {
    const t = this.c.hive.getTask(taskId)
    const from = t?.assignee ? this.c.agents().find((a) => a.id === t.assignee) : undefined
    if (!t || !from) return []
    const fm = this.model(from)
    const need = { ...this.need(t, from), triedAdapters: [] }
    return this.candidates(t)
      .filter((c) => c.agentId !== from.id)
      .map((c) => {
        // a person may move work within the same connection (not about the limit)
        const why = whyNot(c, { agentId: from.id, adapter: '__none__' as Agent['adapter'] }, need)
        const a = this.c.agents().find((x) => x.id === c.agentId)!
        return { agentId: c.agentId, name: c.name, label: this.model(a).label, why, costX: fm.weight > 0 ? c.weight / fm.weight : 1 }
      })
      .sort((a, b) => Number(!!a.why) - Number(!!b.why) || a.costX - b.costX)
  }

  /** A person moves a task that is not running to another employee, with the same hand-over note. */
  async manual(taskId: string, toId: string): Promise<string> {
    const t = this.c.hive.getTask(taskId)
    if (!t) throw new Error('없는 업무예요.')
    if (t.status === 'running' || this.c.isRunning(taskId)) throw new Error('실행 중인 업무는 넘길 수 없어요. 먼저 중지한 뒤 넘겨 주세요.')
    if (['done', 'cancelled', 'delegated', 'in_review'].includes(t.status)) throw new Error('끝났거나 나뉜 업무는 넘길 수 없어요.')
    const opt = this.options(taskId).find((o) => o.agentId === toId)
    if (!opt) throw new Error('넘길 수 없는 직원이에요.')
    if (opt.why) throw new Error(`넘길 수 없어요: ${opt.why}`)
    const id = await this.perform(taskId, toId, 'manual', opt.costX)
    if (!id) throw new Error('넘기지 못했어요.')
    return id
  }

  /** A person answered the "it costs more" question. */
  async decide(approvalId: string, approved: boolean): Promise<string | null> {
    const h = this.c.hive
    const a = h.listApprovals().find((x) => x.id === approvalId)
    if (!a?.handoff) return null
    if (!approved) {
      h.addEvent(a.taskId, 'status', this.c.me(), '더 비싼 직원에게 넘기지 않고 한도가 풀릴 때까지 기다려요.')
      return null
    }
    const t = h.getTask(a.taskId)
    if (!t || (t.status !== 'todo' && !(a.handoff.reason !== 'limit' && t.status === 'needs_input'))) return null
    return this.perform(a.taskId, a.handoff.to, a.handoff.reason, a.handoff.costX)
  }

  /** Move the task: note from the last step saving point, the step in progress put back (git), recorded and told. */
  private async perform(taskId: string, toId: string, reason: HandoffReason, costX: number): Promise<string | null> {
    const h = this.c.hive
    const t = h.getTask(taskId)
    const from = t?.assignee ? this.c.agents().find((a) => a.id === t.assignee) : undefined
    const to = this.c.agents().find((a) => a.id === toId)
    if (!t || !from || !to) return null
    const s = { ...DEFAULT_HANDOFF, ...this.c.settings() }
    const run = t.lastRunId ? h.getRun(t.id, t.lastRunId) : null
    const save = t.stepSave && (!t.lastRunId || t.stepSave.runId === t.lastRunId) ? t.stepSave : undefined
    let rolledBack = false
    if (reason === 'limit' && s.rollbackStep && save?.checkpoint && save.done < save.plan.length) {
      // the half-done step goes back to how it was when it started
      const r = await rollback(h, save.checkpoint, this.c.excludesFor(save.checkpoint.root)).catch((e: Error) => ({ ok: false, message: e.message }))
      rolledBack = r.ok
      if (!r.ok) h.addEvent(taskId, 'status', 'system', `진행 중이던 단계를 되돌리지 못해 그대로 넘겨요: ${r.message}`)
    }
    const fm = this.model(from)
    const tm = this.model(to)
    const note = handoffNote({
      fromName: from.name,
      fromModel: fm.label,
      reason,
      save,
      files: run?.diff.files.map((f) => f.path),
      lastOutput: run?.response?.slice(-800),
      rolledBack
    })
    const rec: Handoff = { from: from.id, to: to.id, fromAdapter: from.adapter, toAdapter: to.adapter, reason, at: new Date().toISOString(), costX: Math.round(costX * 100) / 100 }
    h.updateTask(taskId, {
      assignee: to.id,
      status: 'todo',
      restartNote: note,
      sessionId: undefined,
      limitWait: undefined,
      error: undefined,
      errorKind: undefined,
      handoffs: [...(t.handoffs ?? []), rec]
    })
    const why = reason === 'limit' ? '한도' : handoffReasonLabel(reason)
    const cost = Math.abs(costX - 1) >= 0.15 ? `, ${tm.label} · ${costLine(costX)}` : ''
    h.addEvent(taskId, 'changed', reason === 'manual' ? this.c.me() : 'system', `${from.name} → ${to.name} (${why}${cost}). ${save ? `${save.done}/${save.plan.length}단계까지 한 것을 이어받아요.` : '지금까지 한 것을 요약해 넘겼어요.'}${rolledBack ? ' 진행 중이던 단계는 시작 상태로 되돌렸어요.' : ''}`)
    this.round.set(to.id, (this.round.get(to.id) ?? 0) + 1)
    this.roundAt = Date.now()
    if (reason !== 'manual') this.c.notify(reason === 'limit' ? '한도 이어받기' : '다른 직원이 이어받기', `${t.title}: ${from.name} → ${to.name}${cost ? ` (${costLine(costX)})` : ''}`)
    this.c.changed()
    return to.id
  }

  /** Earliest time a limited connection of this company comes back (for "모두 한도 대기 — 15:20"). */
  earliestReset(): string | null {
    const times = [...new Set(this.c.agents().map((a) => a.adapter))].map((ad) => this.c.limitFor(ad)?.until).filter((x): x is string => !!x)
    return times.sort()[0] ?? null
  }
}

export { nearLimit }
