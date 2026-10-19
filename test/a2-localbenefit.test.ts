import { describe, expect, it } from 'vitest'
import type { AptitudeRecord } from '../src/shared/aptitude'
import { DEFAULT_EXTERNAL_WEIGHT, LOCAL_BENEFIT, localBenefit, localHistory, localSavings, localScopeOf, type LocalBenefitInput } from '../src/shared/localbenefit'

const base: LocalBenefitInput = { passed: 0, attempts: 0, externalWeight: 3, hasChecks: false, limited: true }

const rec = (o: Partial<AptitudeRecord>): AptitudeRecord => ({
  taskId: 't', modelKey: 'local:e|m', modelLabel: 'm', domain: 'general', runs: 1, ms: 1000, approved: 1, changes: 0, failed: 0, updatedAt: '', ...o
})

describe('A2: localBenefit', () => {
  it('thin record (below the sample limit): the default rate is used and the reason says so', () => {
    for (const n of [0, 1, LOCAL_BENEFIT.minSamples - 1]) {
      const r = localBenefit({ ...base, passed: n, attempts: n }) // even a perfect record of 2 is not trusted
      expect(r.assumed).toBe(true)
      expect(r.passRate).toBe(LOCAL_BENEFIT.defaultPassRate)
      expect(r.confidence).toBe('low')
      expect(r.reason).toContain('아직 이력이 적어요')
    }
  })

  it('exactly the sample limit: the record is used', () => {
    const r = localBenefit({ ...base, passed: 3, attempts: LOCAL_BENEFIT.minSamples })
    expect(r.assumed).toBe(false)
    expect(r.passRate).toBe(1)
    expect(r.confidence).toBe('medium')
    expect(r.reason).not.toContain('아직 이력이 적어요')
  })

  it('confidence grows with the samples', () => {
    expect(localBenefit({ ...base, passed: 5, attempts: LOCAL_BENEFIT.highSamples - 1 }).confidence).toBe('medium')
    expect(localBenefit({ ...base, passed: 5, attempts: LOCAL_BENEFIT.highSamples }).confidence).toBe('high')
  })

  it('good record: recommended, reason shows rate and count', () => {
    const r = localBenefit({ ...base, passed: 4, attempts: 5 })
    expect(r.recommend).toBe(true)
    expect(r.score).toBeGreaterThan(0)
    expect(r.reason).toBe('이런 일은 통과율 80%(5건)라서 쓰는 게 이득이에요')
  })

  it('bad record: not recommended, with a reason', () => {
    const r = localBenefit({ ...base, passed: 1, attempts: 5 })
    expect(r.recommend).toBe(false)
    expect(r.score).toBeLessThan(0)
    expect(r.reason).toContain('통과율 20%(5건)')
  })

  it('the default rate keeps an easy task with no history going to this PC when a limit stops everyone', () => {
    expect(localBenefit(base).recommend).toBe(true)
    // ... but not when nothing is stuck on a limit and the outside model is light and there are no checks
    expect(localBenefit({ ...base, limited: false, externalWeight: 1 }).recommend).toBe(false)
  })

  it('break-even lies below the default rate (limit, balanced model, no checks)', () => {
    const at = (p: number): boolean => localBenefit({ ...base, passed: Math.round(p * 100), attempts: 100 }).recommend
    expect(at(0.5)).toBe(false)
    expect(at(0.52)).toBe(true)
    expect(LOCAL_BENEFIT.defaultPassRate).toBeGreaterThan(0.52)
  })

  it('automatic checks lower the cost of a failure', () => {
    const rec1 = { ...base, passed: 5, attempts: 10 } // 50%: not worth it without checks
    const a = localBenefit(rec1)
    const b = localBenefit({ ...rec1, hasChecks: true })
    expect(a.recommend).toBe(false)
    expect(b.score).toBeGreaterThan(a.score)
    expect(b.recommend).toBe(true)
    expect(a.reason).toContain('자동 검사가 없어요')
    expect(b.reason).not.toContain('자동 검사가 없어요')
  })

  it('a risky task costs more when it fails', () => {
    const x = { ...base, passed: 6, attempts: 10 }
    expect(localBenefit({ ...x, risky: true }).score).toBeLessThan(localBenefit(x).score)
  })

  it('saving a heavier model is worth more; a wait that is avoided adds to it', () => {
    const x = { ...base, passed: 7, attempts: 10 }
    expect(localBenefit({ ...x, externalWeight: 6 }).score).toBeGreaterThan(localBenefit({ ...x, externalWeight: 1 }).score)
    expect(localBenefit({ ...x, limited: true }).score).toBeGreaterThan(localBenefit({ ...x, limited: false }).score)
  })

  it('score is a plain number with two decimals', () => {
    const s = localBenefit({ ...base, passed: 2, attempts: 7 }).score
    expect(Math.round(s * 100) / 100).toBe(s)
  })
})

describe('A2: history and scope', () => {
  it('counts first-pass tasks of the model and kind; hand-overs and undecided records do not count', () => {
    const rs = [
      rec({ taskId: 'a', jobKind: 'doc' }),
      rec({ taskId: 'b', jobKind: 'doc', approved: 0, changes: 1 }),
      rec({ taskId: 'c', jobKind: 'impl' }),
      rec({ taskId: 'd', jobKind: 'doc', handedOver: true }),
      rec({ taskId: 'e', jobKind: 'doc', approved: 0 }),
      rec({ taskId: 'f', jobKind: 'doc', modelKey: 'claude:x' })
    ]
    expect(localHistory(rs, 'local:e|m', 'doc')).toEqual({ passed: 1, attempts: 2 })
    expect(localHistory(rs, 'local:e|m', 'research')).toEqual({ passed: 2, attempts: 3 }) // no record of this kind: all kinds
    expect(localHistory(rs, 'local:e|m')).toEqual({ passed: 2, attempts: 3 })
    expect(localHistory([], 'local:e|m', 'doc')).toEqual({ passed: 0, attempts: 0 })
  })

  it('allowLocal compatibility: localScope wins, else false = off, else easy', () => {
    expect(localScopeOf({})).toBe('easy')
    expect(localScopeOf({ allowLocal: true })).toBe('easy')
    expect(localScopeOf({ allowLocal: false })).toBe('off')
    expect(localScopeOf({ localScope: 'limit-only', allowLocal: false })).toBe('limit-only')
    expect(localScopeOf({ localScope: 'easy', allowLocal: false })).toBe('easy')
    expect(localScopeOf({ localScope: 'off' })).toBe('off')
  })
})

describe('A2: savings', () => {
  it('counts passed local tasks and estimates the outside usage they replaced', () => {
    const rs = [
      rec({ taskId: 'a' }),
      rec({ taskId: 'b~x' }),
      rec({ taskId: 'c', changes: 1 }),
      rec({ taskId: 'd', failed: 1, approved: 0 }),
      rec({ taskId: 'e', modelKey: 'claude:default' }),
      rec({ taskId: 'f', approved: 0 })
    ]
    const w: Record<string, number> = { a: 6 }
    const s = localSavings(rs, (id) => w[id])
    expect(s.tasks).toBe(2)
    expect(s.usage).toBe(6 + DEFAULT_EXTERNAL_WEIGHT)
  })
  it('nothing yet', () => {
    expect(localSavings([], () => 1)).toEqual({ tasks: 0, usage: 0 })
  })
})
