import { describe, expect, it } from 'vitest'
import { groupByZone, zoneOf } from '../src/shared/zones'

describe('D5: work-status floor areas', () => {
  it('puts each job in its area and the unknown ones in "other"', () => {
    expect(zoneOf('ceo').id).toBe('mgmt')
    expect(zoneOf('build').id).toBe('make')
    expect(zoneOf('qa').id).toBe('check')
    expect(zoneOf('ops').id).toBe('support')
    expect(zoneOf(undefined).id).toBe('other')
    expect(zoneOf('nope').id).toBe('other')
  })
  it('groups in floor order, leaves out empty areas and keeps the list order inside one', () => {
    const g = groupByZone([{ n: 'a', job: 'review' }, { n: 'b', job: 'build' }, { n: 'c', job: 'plan' }, { n: 'd' }])
    expect(g.map((x) => x.zone.id)).toEqual(['make', 'check', 'other'])
    expect(g[0].people.map((p) => p.n)).toEqual(['b', 'c'])
  })
})
