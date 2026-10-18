import { describe, expect, it } from 'vitest'
import { costLine, handoffNote, nearLimit, pickHandoff, shouldWait, type HandoffCand, type HandoffNeed } from '../src/shared/handoff'

const c = (o: Partial<HandoffCand> & { agentId: string; adapter: HandoffCand['adapter']; tier: HandoffCand['tier'] }): HandoffCand => ({
  name: o.agentId,
  modelKey: o.agentId + '-model',
  weight: o.tier === 'top' ? 6 : o.tier === 'balanced' ? 3 : 1,
  isManager: false,
  idle: true,
  limited: false,
  ...o
})
const need = (o: Partial<HandoffNeed> = {}): HandoffNeed => ({ permission: 'edit', minTier: 'light', usesExternal: false, avoidModels: [], triedAdapters: [], ...o })
const A = { agentId: 'a', adapter: 'claude' as const, tier: 'balanced' as const, weight: 3 }

describe('7-2: who carries on when the connection runs out', () => {
  it('another connection of the same tier first; never the same connection', () => {
    const r = pickHandoff(A, [c({ agentId: 'a2', adapter: 'claude', tier: 'balanced' }), c({ agentId: 'up', adapter: 'codex', tier: 'top' }), c({ agentId: 'same', adapter: 'codex', tier: 'balanced' })], need())
    expect(r.pick?.cand.agentId).toBe('same')
    expect(r.pick?.up).toBe(false)
    expect(r.skipped.find((s) => s.agentId === 'a2')?.why).toContain('같은 연결')
  })

  it('one tier up when nobody of the same tier can; the cost factor is told', () => {
    const r = pickHandoff(A, [c({ agentId: 'busy', adapter: 'codex', tier: 'balanced', limited: true }), c({ agentId: 'up', adapter: 'agy', tier: 'top' })], need())
    expect(r.pick?.cand.agentId).toBe('up')
    expect(r.pick?.up).toBe(true)
    expect(r.pick?.costX).toBe(2)
    expect(costLine(2)).toBe('약 2배 비용')
  })

  it('up can be switched off; a stronger tier comes before an even stronger one', () => {
    const cands = [c({ agentId: 'top', adapter: 'codex', tier: 'top' })]
    expect(pickHandoff(A, cands, need(), { up: false }).pick).toBeNull()
    const light = { ...A, tier: 'light' as const, weight: 1 }
    expect(pickHandoff(light, [c({ agentId: 't', adapter: 'codex', tier: 'top' }), c({ agentId: 'b', adapter: 'agy', tier: 'balanced' })], need()).pick?.cand.agentId).toBe('b')
  })

  it('never lower than the job needs, never back to a connection it went through', () => {
    expect(pickHandoff(A, [c({ agentId: 'l', adapter: 'codex', tier: 'light' })], need({ minTier: 'balanced' })).pick).toBeNull()
    expect(pickHandoff(A, [c({ agentId: 'x', adapter: 'codex', tier: 'balanced' })], need({ triedAdapters: ['codex'] })).pick).toBeNull()
  })

  it('manager-only work goes to managers; ordinary work prefers non-managers', () => {
    const cands = [c({ agentId: 'boss', adapter: 'codex', tier: 'balanced', isManager: true }), c({ agentId: 'dev', adapter: 'agy', tier: 'balanced' })]
    expect(pickHandoff(A, cands, need({ kind: 'plan' })).pick?.cand.agentId).toBe('boss')
    expect(pickHandoff(A, cands, need({ kind: 'work' })).pick?.cand.agentId).toBe('dev')
  })

  it('a review stays with another model than the work; external connections only to those who can use them; read-only only where it is enforced', () => {
    const cands = [c({ agentId: 'x', adapter: 'codex', tier: 'balanced', modelKey: 'm-worker' })]
    expect(pickHandoff(A, cands, need({ avoidModels: ['m-worker'] })).skipped[0].why).toContain('검토')
    expect(pickHandoff({ ...A, adapter: 'codex' }, [c({ agentId: 'g', adapter: 'agy', tier: 'balanced' })], need({ usesExternal: true })).pick).toBeNull()
    expect(pickHandoff(A, [c({ agentId: 'g', adapter: 'agy', tier: 'balanced' })], need({ permission: 'read' })).skipped[0].why).toContain('읽기만')
    expect(pickHandoff(A, [c({ agentId: 'x', adapter: 'codex', tier: 'balanced' })], need({ permission: 'read' })).pick?.cand.agentId).toBe('x')
  })

  it('within a tier: idle, fewer hand-overs this round, better record, lighter, not near its limit', () => {
    const base = { tier: 'balanced' as const }
    expect(pickHandoff(A, [c({ ...base, agentId: 'b1', adapter: 'codex', idle: false }), c({ ...base, agentId: 'b2', adapter: 'agy' })], need()).pick?.cand.agentId).toBe('b2')
    expect(pickHandoff(A, [c({ ...base, agentId: 'b1', adapter: 'codex', taken: 2 }), c({ ...base, agentId: 'b2', adapter: 'agy', taken: 0 })], need()).pick?.cand.agentId).toBe('b2')
    expect(pickHandoff(A, [c({ ...base, agentId: 'b1', adapter: 'codex', passRate: 0.5 }), c({ ...base, agentId: 'b2', adapter: 'agy', passRate: 0.9 })], need()).pick?.cand.agentId).toBe('b2')
    expect(pickHandoff(A, [c({ ...base, agentId: 'b1', adapter: 'codex', nearLimit: true }), c({ ...base, agentId: 'b2', adapter: 'agy' })], need()).pick?.cand.agentId).toBe('b2')
  })

  it('waits only when the reset time is known and close', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    expect(shouldWait({ until: '2026-10-18T12:10:00Z', guessed: false }, 20, now)).toBe(true)
    expect(shouldWait({ until: '2026-10-18T12:10:00Z', guessed: true }, 20, now)).toBe(false)
    expect(shouldWait({ until: '2026-10-18T13:00:00Z', guessed: false }, 20, now)).toBe(false)
    expect(shouldWait({ until: '2026-10-18T12:10:00Z', guessed: false }, 0, now)).toBe(false)
  })

  it('near the limit: 85% of the median runs it took before', () => {
    expect(nearLimit(undefined)).toBe(false)
    expect(nearLimit({ since: 5, hits: [] })).toBe(false)
    expect(nearLimit({ since: 17, hits: [20, 30, 10] })).toBe(true)
    expect(nearLimit({ since: 16, hits: [20, 30, 10] })).toBe(false)
  })

  it('the hand-over note names the step in progress, the changed files and stays short', () => {
    const note = handoffNote({
      fromName: '민수',
      fromModel: 'Sonnet 5.5',
      reason: 'limit',
      save: { runId: 'r', plan: ['맵 만들기', '적 넣기', '테스트'], done: 1, files: ['game.js'], last: '적 이동을 쓰는 중', at: '' },
      rolledBack: true
    })
    expect(note).toContain('[done] 맵 만들기')
    expect(note).toContain('[in progress] 적 넣기')
    expect(note).toContain('Step 2 ("적 넣기")')
    expect(note).toContain('undone')
    expect(note).toContain('- game.js')
    const long = handoffNote({ fromName: 'x', fromModel: 'y', reason: 'limit', files: Array.from({ length: 100 }, (_, i) => `f${i}.ts`), lastOutput: 'z'.repeat(5000), rolledBack: false })
    expect(long.length).toBeLessThanOrEqual(3800)
    expect(long).not.toContain('f30.ts')
  })
})
