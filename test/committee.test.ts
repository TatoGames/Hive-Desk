import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { parseEscalation, parseVote, tally } from '../src/shared/committee'
import { performance } from '../src/shared/performance'
import type { EngineEvent } from '../src/shared/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s4-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false })

function setup(votes: Record<string, number>, ceos = ['c1', 'c2', 'c3'], plan?: (p: string) => string) {
  const events: EngineEvent[] = []
  const runner: Runner = async (_b, o) => {
    const who = basename(o.cwd)
    if (o.prompt.includes('CEO COMMITTEE')) {
      if (o.prompt.includes('independent proposal')) return ok(`${who}의 제안: 방법 ${who}`)
      if (o.prompt.includes('ONE round of critique')) return ok(`${who}의 비판`)
      return ok(`검토 결과\n[[VOTE: ${votes[who] ?? 1} | ${who}의 이유]]`)
    }
    return ok(plan ? plan(o.prompt) : '[[SELF: 작아요]]')
  }
  const eng = new Engine(join(dir, 'config.json'), (e) => events.push(e), runner, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
  eng.applyTemplate('blank', 'T', false)
  const exec = eng.saveUnit({ name: '경영진', kind: '경영' })
  const ids: Record<string, string> = {}
  for (const [name, job] of [...ceos.map((c) => [c, 'ceo']), ['coo', 'coo']] as [string, string][]) {
    const w = join(dir, name)
    mkdirSync(w, { recursive: true })
    const a = eng.saveAgent({ name, adapter: 'claude', workDir: w })
    eng.assignSeat(eng.saveSeat({ unitId: exec.id, title: name, job }).id, a.id)
    ids[name] = a.id
  }
  return { eng, ids, events }
}

async function settle(eng: Engine): Promise<void> {
  let idle = 0
  for (let i = 0; i < 300 && idle < 4; i++) {
    const before = JSON.stringify(eng.hive.listTasks().map((t) => [t.id, t.status]))
    await eng.tick()
    for (let k = 0; k < 200 && eng.snapshot().running.length; k++) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 5))
    idle = before === JSON.stringify(eng.hive.listTasks().map((t) => [t.id, t.status])) && !eng.snapshot().running.length ? idle + 1 : 0
  }
}

describe('vote parsing', () => {
  it('reads a vote with a reason and ignores invalid numbers', () => {
    expect(parseVote('[[VOTE: 2 | 더 안전해요]]', 3)).toEqual({ choice: 2, reason: '더 안전해요' })
    expect(parseVote('[[VOTE: 4 | x]]', 3)).toBeNull()
    expect(parseVote('[[VOTE: 0]]', 3)).toBeNull()
    expect(parseVote('투표 안 함', 3)).toBeNull()
  })
  it('majority wins and the rest is the minority opinion; a tie has no winner', () => {
    const v = (agentId: string, choice: number) => ({ agentId, choice, reason: 'r' })
    const r = tally([v('a', 1), v('b', 1), v('c', 2)], 2)
    expect(r.choice).toBe(1)
    expect(r.tally).toEqual([2, 1])
    expect(r.minority.map((m) => m.agentId)).toEqual(['c'])
    expect(tally([v('a', 1), v('b', 2)], 2).choice).toBe(0)
    expect(tally([], 2).choice).toBe(0)
  })
  it('escalation marker', () => {
    expect(parseEscalation('[[ESCALATE: A안과 B안 중 무엇?]]')).toBe('A안과 B안 중 무엇?')
    expect(parseEscalation('없음')).toBeNull()
  })
})

describe('CEO committee quick mode', () => {
  it('is the default: one round of runs (one per member), then straight to the board with every proposal side by side', async () => {
    const { eng } = setup({ c1: 1, c2: 2, c3: 3 })
    eng.openAgenda('빠른 안건', '본문')
    await settle(eng)
    const a = eng.hive.listAgendas()[0]
    expect(a.mode).toBe('quick')
    expect(a.phase).toBe('board')
    expect(a.proposals).toHaveLength(3)
    expect(a.critiques).toHaveLength(0)
    expect(a.recommendation).toBeTruthy()
    eng.shutdown()
  })
})

describe('CEO committee', () => {
  it('proposals → critique → votes → recommendation with minority → board decision becomes fixed memory', async () => {
    const { eng, ids } = setup({ c1: 2, c2: 2, c3: 1 })
    eng.openAgenda('새 사업 방향', '게임을 만들까요 도구를 만들까요?', true)
    const a0 = eng.hive.listAgendas()[0]
    expect(a0.members.sort()).toEqual([ids.c1, ids.c2, ids.c3].sort())
    await settle(eng)
    const a = eng.hive.listAgendas()[0]
    expect(a.phase).toBe('board')
    expect(a.proposals).toHaveLength(3)
    expect(a.critiques).toHaveLength(3)
    expect(a.votes).toHaveLength(3)
    expect(a.recommendation).toMatchObject({ choice: 2, tally: [1, 2, 0] })
    expect(a.recommendation!.minority).toEqual([{ agentId: ids.c3, choice: 1, reason: 'c3의 이유' }])
    // the committee's tasks never show on the board and are read-only
    const hidden = eng.hive.listTasks().filter((t) => t.kind === 'committee')
    expect(hidden).toHaveLength(9)
    expect(hidden.every((t) => t.hidden && t.permission === 'read')).toBe(true)

    eng.decideAgenda(a.id, 1, '안전한 쪽으로')
    const d = eng.hive.getAgenda(a.id)!
    expect(d.phase).toBe('decided')
    expect(d.decision).toMatchObject({ choice: 1, by: 'alice', note: '안전한 쪽으로' })
    const mem = eng.hive.listMemory().find((m) => m.text.includes('[위원회 결정]'))!
    expect(mem.kind).toBe('fixed')
    expect(mem.text).toContain('c1의 제안')
    expect(mem.text).toContain('안전한 쪽으로')
    // deciding twice or with a bad number changes nothing
    eng.decideAgenda(a.id, 2)
    expect(eng.hive.getAgenda(a.id)!.decision!.choice).toBe(1)
    eng.shutdown()
  })

  it('later phases receive the earlier texts', async () => {
    const seen: string[] = []
    const events: EngineEvent[] = []
    void events
    const { eng } = setup({}, ['c1', 'c2'])
    const inner = (eng as unknown as { runner: Runner }).runner
    ;(eng as unknown as { runner: Runner }).runner = async (b, o) => {
      if (o.prompt.includes('Vote for exactly one')) seen.push(o.prompt)
      return inner(b, o)
    }
    eng.openAgenda('A', 'B', true)
    await settle(eng)
    expect(seen.length).toBe(2)
    expect(seen[0]).toContain('Proposal 1 (by c1)')
    expect(seen[0]).toContain('c2의 비판')
    eng.shutdown()
  })

  it('a single member goes straight to the board; no CEO seat is refused', async () => {
    const { eng } = setup({}, ['solo'])
    eng.openAgenda('하나', '본문')
    await settle(eng)
    expect(eng.hive.listAgendas()[0]).toMatchObject({ phase: 'board', recommendation: { choice: 1 } })
    eng.shutdown()

    const eng2 = new Engine(join(dir, 'c2.json'), () => {}, async () => ok(''), dir)
    eng2.saveSettings({ memberName: 'a', workspace: join(dir, 'ws2') })
    eng2.applyTemplate('blank', 'T', false)
    expect(() => eng2.openAgenda('x', 'y')).toThrow('CEO 자리')
    eng2.shutdown()
  })

  it('a manager who cannot choose a direction waits for the committee, then continues with its decision', async () => {
    let asked = false
    let sawDecision = false
    const { eng, ids } = setup({ c1: 1, c2: 1, c3: 1 }, undefined, (p) => {
      if (!p.includes('MANAGER (planner)')) return ''
      if (!asked) {
        asked = true
        return '[[ESCALATE: A로 갈까요 B로 갈까요?]]'
      }
      sawDecision = p.includes('위원회 결정')
      return '[[SELF: 결정대로]]'
    })
    const t = eng.createTask({ title: '방향 업무', assignee: ids.coo, delegate: true })
    await settle(eng)
    expect(eng.hive.getTask(t.id)).toMatchObject({ status: 'needs_input' })
    expect(eng.hive.getTask(t.id)!.question).toContain('CEO 위원회')
    const a = eng.hive.listAgendas()[0]
    expect(a).toMatchObject({ fromTaskId: t.id, phase: 'board' })
    eng.decideAgenda(a.id, 1)
    expect(eng.hive.getTask(t.id)).toMatchObject({ status: 'todo' })
    await settle(eng)
    expect(sawDecision).toBe(true)
    eng.shutdown()
  })

  it('without a committee the board gets the question directly', async () => {
    const { eng, ids } = setup({}, [], () => '[[ESCALATE: 어느 쪽?]]')
    const t = eng.createTask({ title: 'Q', assignee: ids.coo, delegate: true })
    await settle(eng)
    expect(eng.hive.getTask(t.id)).toMatchObject({ status: 'needs_input', question: '어느 쪽?' })
    eng.shutdown()
  })
})

describe('notifications', () => {
  it('announces new things waiting for the person once, not at start-up', async () => {
    const { eng, events, ids } = setup({}, ['c1'], () => '[[NEED: 정보 주세요]]')
    const notes = () => events.filter((e) => e.type === 'notify').map((e) => (e as { title: string }).title)
    expect(notes()).toEqual([])
    eng.createTask({ title: 'N', assignee: ids.coo, delegate: true })
    await settle(eng)
    expect(notes().filter((t) => t === '에이전트가 자료를 기다려요')).toHaveLength(1)
    eng.shutdown()
  })
})

describe('performance', () => {
  it('sums per agent, unit and model with the model weight', () => {
    const apt = (modelKey: string, runs: number, approved: number, changes: number) => ({
      taskId: 't' + modelKey, modelKey, modelLabel: modelKey, domain: 'build', runs, ms: 120000 * runs, approved, changes, failed: 0, updatedAt: ''
    })
    const base = { description: '', status: 'done', risky: false, dependsOn: [], createdBy: '', createdAt: '', updatedAt: '', cleared: [], notes: [] }
    const tasks = [
      { ...base, id: '1', title: 'a', assignee: 'x', reviewState: { status: 'passed', round: 1, escalations: 0 } },
      { ...base, id: '2', title: 'b', assignee: 'x', status: 'failed' },
      { ...base, id: '3', title: 'h', assignee: 'x', hidden: true }
    ] as never[]
    const r = performance({
      tasks,
      aptitude: [apt('m1', 3, 2, 1)],
      catalog: [{ id: 'm1', weight: 4 }] as never[],
      agents: { x: { name: 'X', unitId: 'u' } },
      units: { u: '서버팀' }
    })
    expect(r.agents[0]).toMatchObject({ label: 'X', tasks: 2, done: 1, failed: 1, changeRounds: 1, passed: 1 })
    expect(r.units[0].label).toBe('서버팀')
    expect(r.models[0]).toMatchObject({ runs: 3, minutes: 6, load: 12, done: 2, changeRounds: 1 })
  })
})

describe('apply a recommended model change', () => {
  it('moves local agents of that job to the better model, nothing else', () => {
    const { eng, ids } = setup({})
    const a = eng.config.agents.find((x) => x.id === ids.c1)!
    eng.saveAgent({ ...a, modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    expect(eng.applyReassignment('ceo', 'claude-sonnet-5-5', 'claude-opus-5-5')).toBe(1)
    expect(eng.config.agents.find((x) => x.id === ids.c1)!.modelRef).toEqual({ id: 'claude-opus-5-5', pin: 'pinned' })
    expect(eng.config.agents.find((x) => x.id === ids.c2)!.modelRef?.id).not.toBe('claude-opus-5-5')
    expect(eng.applyReassignment('ceo', 'x', 'unknown-model')).toBe(0)
    eng.shutdown()
  })
})
