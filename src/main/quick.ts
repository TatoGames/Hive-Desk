import { tierOfSlug, type ModelEntry } from '../shared/company'
import { escalationTarget, pickWorker, quickLine, rank, readJob, JOB_KIND_LABEL, type Cand, type JobRead, type Pick, type RecordLite } from '../shared/quick'
import type { PermissionLevel, QuickInfo, RosterEntry, Task } from '../shared/types'
import type { Hive } from './hive'

export interface QuickCtx {
  hive: Hive
  me: () => string
  roster: () => RosterEntry[]
  catalog: () => ModelEntry[]
  isManager: (agentId: string) => boolean
  limited: (adapter: string) => boolean
  trialRate: () => number
  /** Hand a task to the organisation (a manager plans it). */
  toOrganisation: (task: Task) => Task
  changed: () => void
  notify: (title: string, body: string) => void
}

export interface QuickOption {
  agentId: string
  name: string
  label: string
  line: string
  expectedRuns: number
  expectedUsage: number
  trial: boolean
}

export interface QuickPreview {
  size: JobRead['size']
  kind: JobRead['kind']
  writes: boolean
  reasons: string[]
  /** The line shown to the person; null when the job should go to the organisation (or nobody can do it). */
  line: string | null
  pick: QuickOption | null
  options: QuickOption[]
}

/** Quick assignment: a small job goes to one employee chosen by expected total usage; moves up when it does not work. */
export class QuickAssign {
  constructor(private c: QuickCtx) {}

  private candidates(): Cand[] {
    const h = this.c.hive
    const cat = this.c.catalog()
    const busy = new Set(h.listTasks().filter((t) => ['running', 'todo', 'needs_input', 'in_review'].includes(t.status)).map((t) => t.assignee))
    const out: Cand[] = []
    for (const r of this.c.roster()) {
      if (this.c.isManager(r.id)) continue
      if (r.check && !r.check.ok && Date.now() - new Date(r.check.at).getTime() < 24 * 3600e3) continue
      const m = r.modelId ? cat.find((x) => x.id === r.modelId) : undefined
      const arg = r.model ?? 'default'
      const tier = m?.tier ?? tierOfSlug(arg)
      out.push({
        agentId: r.id,
        name: r.name,
        modelKey: m?.id ?? `${r.adapter}:${arg}`,
        label: m ? `${m.family} ${m.version}`.trim() : arg,
        tier,
        weight: m?.weight ?? (tier === 'top' ? 6 : tier === 'balanced' ? 3 : 1),
        idle: !busy.has(r.id),
        thinking: /thinking/i.test(arg + ' ' + (m?.family ?? '') + ' ' + (m?.cliArg ?? '')),
        limitRoom: this.c.limited(r.adapter) ? 0 : 1
      })
    }
    return out
  }

  private records(): RecordLite[] {
    return this.c.hive.listAptitude().map((a) => ({ modelKey: a.modelKey, jobKind: a.jobKind, approved: a.approved, changes: a.changes, failed: a.failed, runs: a.runs }))
  }

  private option(job: JobRead, p: Pick): QuickOption {
    return { agentId: p.cand.agentId, name: p.cand.name, label: p.cand.label, line: quickLine(job, p), expectedRuns: p.expectedRuns, expectedUsage: p.expectedUsage, trial: p.trial }
  }

  preview(title: string, description = '', attachments = 0, rnd?: () => number): QuickPreview {
    const job = readJob(`${title}\n${description}`, { attachments })
    const base = { size: job.size, kind: job.kind, writes: job.writes, reasons: job.reasons }
    if (job.size === 'big') return { ...base, line: null, pick: null, options: [] }
    const cands = this.candidates()
    const rec = this.records()
    const { pick, ranked } = pickWorker(job, cands, rec, { trialRate: this.c.trialRate(), rnd })
    if (!pick) return { ...base, line: null, pick: null, options: [] }
    return { ...base, line: quickLine(job, pick), pick: this.option(job, pick), options: ranked.map((p) => this.option(job, p)) }
  }

  /** Create the task for one employee (the app's pick, or the person's). */
  assign(input: { title: string; description?: string; agentId?: string; projectId?: string }, create: (t: { assignee: string; permission: PermissionLevel; quick: QuickInfo; jobKind: QuickInfo['kind'] }) => Task): Task {
    const pv = this.preview(input.title, input.description ?? '', 0, () => 1)
    const job = readJob(`${input.title}\n${input.description ?? ''}`)
    const chosen = input.agentId && input.agentId !== pv.pick?.agentId
    const opt = (input.agentId ? pv.options.find((o) => o.agentId === input.agentId) : null) ?? pv.pick
    const agentId = input.agentId ?? opt?.agentId
    if (!agentId) throw new Error('맡길 수 있는 직원이 없어요. 조직에 맡겨 보세요.')
    const quick: QuickInfo = {
      size: job.size === 'big' ? 'unsure' : job.size,
      kind: job.kind,
      writes: job.writes,
      trial: !!opt?.trial,
      chosen: !!chosen,
      expectedRuns: opt?.expectedRuns ?? 1.5,
      expectedUsage: opt?.expectedUsage ?? 0,
      escalations: 0,
      trail: []
    }
    return create({ assignee: agentId, permission: job.writes ? 'edit' : 'read', quick, jobKind: job.kind })
  }

  /** Added to the prompt of a quick job. */
  promptExtras(t: Task): string[] {
    if (!t.quick) return []
    const out = [
      'This is a small job given to you alone (no plan, no manager).',
      'If it turns out to be much bigger than it looks (many files, unclear goal, needs a design first), stop and write [[ESCALATE: why it is bigger]] — a stronger colleague will take over with your notes.'
    ]
    if (!t.quick.writes) out.push('You do not change files for this job; answer or research and report.')
    if (t.quick.trail.length) out.push('Earlier attempts on this job:\n' + t.quick.trail.map((x) => `- ${x}`).join('\n'))
    return out
  }

  /**
   * The job did not work out with this employee (it failed, said it is bigger, or was sent back twice):
   * give it to one tier higher, with what happened so far. After two moves it goes to the organisation.
   * Returns true when the task was moved on (the caller does nothing else).
   */
  escalate(t: Task, why: string): boolean {
    const q = t.quick
    if (!q) return false
    const h = this.c.hive
    const trail = [...q.trail, `${this.nameOf(t.assignee)}: ${why.slice(0, 300)}`]
    const cands = this.candidates()
    const cur = cands.find((c) => c.agentId === t.assignee)
    const job: JobRead = { size: q.size, kind: q.kind, writes: q.writes, minTier: 'light', reasons: [] }
    const next = q.escalations < 2 && cur ? escalationTarget(job, cands, this.records(), cur) : null
    const prevResult = (t.result ?? '').slice(0, 1500)
    if (next) {
      h.updateTask(t.id, {
        assignee: next.cand.agentId,
        status: 'todo',
        auto: true,
        error: undefined,
        errorKind: undefined,
        reviewState: undefined,
        sessionId: undefined,
        planTries: 0,
        quick: { ...q, escalations: q.escalations + 1, trail },
        reply: `이 일은 앞선 담당자가 끝내지 못해 당신에게 넘어왔어요.\n사유: ${why}${prevResult ? `\n그동안의 결과:\n${prevResult}` : ''}\n이어서 끝내 주세요.`
      })
      h.addEvent(t.id, 'delegation', 'quick', `${this.nameOf(t.assignee)}가 끝내지 못해 한 단계 위인 ${next.cand.name}(${next.cand.label})에게 넘겼어요: ${why.slice(0, 120)}`)
      this.c.changed()
      return true
    }
    // nobody above (or already moved twice): the organisation takes it
    try {
      h.updateTask(t.id, { quick: { ...q, escalations: q.escalations + 1, trail }, reviewState: undefined, error: undefined, errorKind: undefined })
      h.addEvent(t.id, 'delegation', 'quick', `빠른 배정으로 끝내지 못해 조직에 맡겼어요: ${why.slice(0, 120)}`)
      this.c.toOrganisation(h.getTask(t.id)!)
      this.c.changed()
      return true
    } catch (e) {
      this.c.notify('빠른 배정이 막혔어요', `${t.title}: ${(e as Error).message}`)
      return false
    }
  }

  private nameOf(id: string | null): string {
    return this.c.roster().find((r) => r.id === id)?.name ?? id ?? '?'
  }

  /** Per model and kind of job: first-pass rate, average runs, average usage (for the performance tab). */
  table(): { modelKey: string; label: string; kind: string; kindLabel: string; tasks: number; firstPass: number; avgRuns: number; avgUsage: number }[] {
    const cat = this.c.catalog()
    const groups = new Map<string, { label: string; kind: string; list: ReturnType<Hive['listAptitude']> }>()
    for (const a of this.c.hive.listAptitude()) {
      if (!a.jobKind || a.approved + a.changes + a.failed === 0) continue
      const k = a.modelKey + '|' + a.jobKind
      const g = groups.get(k) ?? { label: a.modelLabel, kind: a.jobKind, list: [] }
      g.list.push(a)
      groups.set(k, g)
    }
    return [...groups.entries()].map(([k, g]) => {
      const modelKey = k.split('|')[0]
      const w = cat.find((m) => m.id === modelKey)?.weight ?? 1
      const tasks = g.list.length
      const first = g.list.filter((a) => a.changes + a.failed === 0).length
      const runs = g.list.reduce((n, a) => n + a.runs, 0)
      return {
        modelKey, label: g.label, kind: g.kind, kindLabel: JOB_KIND_LABEL[g.kind as keyof typeof JOB_KIND_LABEL] ?? g.kind,
        tasks, firstPass: first / tasks, avgRuns: runs / tasks, avgUsage: (runs * w) / tasks
      }
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.avgUsage - b.avgUsage)
  }

  /** For tests and the screen: the ranking without picking. */
  ranking(title: string, description = ''): Pick[] {
    return rank(readJob(`${title}\n${description}`), this.candidates(), this.records())
  }
}
