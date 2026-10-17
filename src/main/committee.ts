import type { Agenda, AgendaPhase, Agent, Task } from '../shared/types'
import { newId, type Hive } from './hive'
import { parseVote, tally } from '../shared/committee'

export interface CommitteeCtx {
  hive: Hive
  me: () => string
  changed: () => void
  notify: (title: string, body: string) => void
}

const PHASE_TASK: Record<string, string> = { proposals: '제안', critique: '비판', votes: '투표' }

/**
 * The CEO committee: agents on CEO seats each propose, criticise once, vote with a reason; the
 * board decides. Every step is an ordinary hidden task, so runs, limits and permissions work as usual.
 */
export class Committee {
  constructor(private c: CommitteeCtx) {}

  members(): string[] {
    const seats = this.c.hive.listSeats().filter((s) => s.job === 'ceo' && s.agentId)
    return [...new Set(seats.map((s) => s.agentId!))]
  }

  open(title: string, body: string, by: string, fromTaskId?: string): Agenda {
    const members = this.members()
    if (!members.length) throw new Error('CEO 자리에 에이전트가 앉아 있어야 위원회를 열 수 있어요. (회사 탭에서 CEO 자리를 만들고 에이전트를 배정하세요)')
    const a: Agenda = {
      id: newId(), title: title.trim(), body: body.trim(), createdAt: new Date().toISOString(), createdBy: by,
      phase: 'proposals', members, taskIds: [], proposals: [], critiques: [], votes: [],
      ...(fromTaskId ? { fromTaskId } : {})
    }
    this.start(a, 'proposals')
    this.c.notify('CEO 위원회가 열렸어요', a.title)
    return a
  }

  private start(a: Agenda, phase: AgendaPhase): void {
    a.phase = phase
    a.taskIds = []
    for (const id of a.members) {
      const t = this.c.hive.createTask({
        title: `[위원회·${PHASE_TASK[phase]}] ${a.title}`, assignee: id, permission: 'read', createdBy: 'committee'
      })
      this.c.hive.updateTask(t.id, { kind: 'committee', hidden: true, auto: true, agendaId: a.id, depth: 0 })
      a.taskIds.push(t.id)
    }
    this.c.hive.saveAgenda(a)
  }

  promptExtras(task: Task, agent: Agent): string[] {
    const a = task.agendaId ? this.c.hive.getAgenda(task.agendaId) : null
    if (!a) return []
    const name = (id: string): string => this.c.hive.listRoster().find((r) => r.id === id)?.name ?? id
    const head = ['', `## Your role in this task: CEO COMMITTEE member (${agent.name})`, `Agenda: ${a.title}`, a.body, 'You only read and think; do not change any files.']
    const numbered = a.proposals.map((p, i) => `### Proposal ${i + 1} (by ${name(p.agentId)})\n${p.text}`)
    if (a.phase === 'proposals') return [...head, 'Write your own independent proposal in plain language: what to do, why, risks, and what it costs. Do not ask the others.']
    if (a.phase === 'critique')
      return [...head, 'Here are all proposals. Write ONE round of critique: for each proposal, its strongest weakness and what you would change. Be specific and short.', ...numbered]
    return [
      ...head,
      'Vote for exactly one proposal, with a reason. End your answer with `[[VOTE: <number> | <reason in one sentence>]]`.',
      ...numbered,
      ...a.critiques.map((c) => `### Critique by ${name(c.agentId)}\n${c.text}`)
    ]
  }

  onRunFinished(taskId: string): void {
    const t = this.c.hive.getTask(taskId)
    if (!t || t.kind !== 'committee' || !t.agendaId) return
    const a = this.c.hive.getAgenda(t.agendaId)
    if (!a || !a.taskIds.includes(taskId)) return
    const tasks = a.taskIds.map((id) => this.c.hive.getTask(id))
    if (tasks.some((x) => x && x.status !== 'done' && x.status !== 'failed')) return // others still working
    const results = tasks.flatMap((x) => (x && x.status === 'done' && x.assignee ? [{ agentId: x.assignee, text: (x.result ?? '').trim() }] : []))
    if (!results.length) {
      a.phase = 'failed'
      a.note = '위원 모두 답을 내지 못했어요.'
      this.c.hive.saveAgenda(a)
      this.c.notify('위원회가 진행되지 못했어요', a.title)
      return
    }
    if (a.phase === 'proposals') {
      a.proposals = results
      if (results.length === 1) return this.toBoard(a, { choice: 1, tally: [1], minority: [] })
      this.start(a, 'critique')
    } else if (a.phase === 'critique') {
      a.critiques = results
      this.start(a, 'votes')
    } else if (a.phase === 'votes') {
      a.votes = results.flatMap((r) => {
        const v = parseVote(r.text, a.proposals.length)
        return v ? [{ agentId: r.agentId, ...v }] : []
      })
      this.toBoard(a, tally(a.votes, a.proposals.length))
    }
    this.c.changed()
  }

  private toBoard(a: Agenda, rec: NonNullable<Agenda['recommendation']>): void {
    a.phase = 'board'
    a.recommendation = rec
    a.taskIds = []
    this.c.hive.saveAgenda(a)
    this.c.notify('위원회가 결론을 냈어요', `${a.title} — 이사회 결정이 필요해요.`)
  }

  /** The board picks a proposal (1-based) and the decision becomes a fixed memory. */
  decide(id: string, choice: number, note: string, by: string): Agenda | null {
    const a = this.c.hive.getAgenda(id)
    if (!a || a.phase !== 'board') return null
    if (!Number.isInteger(choice) || choice < 1 || choice > a.proposals.length) return null
    a.decision = { at: new Date().toISOString(), by, choice, note: note.trim() }
    a.phase = 'decided'
    this.c.hive.saveAgenda(a)
    const picked = a.proposals[choice - 1].text.replace(/\s+/g, ' ').slice(0, 300)
    this.c.hive.addMemory(by, `[위원회 결정] ${a.title}: ${picked}${note.trim() ? ` (이사회 메모: ${note.trim()})` : ''}`, 'fixed')
    if (a.fromTaskId) {
      const t = this.c.hive.getTask(a.fromTaskId)
      if (t && t.status === 'needs_input') {
        this.c.hive.updateTask(t.id, { status: 'todo', reply: `위원회 결정: ${picked}${note.trim() ? `\n이사회 메모: ${note.trim()}` : ''}`, question: undefined })
      }
    }
    return a
  }
}
