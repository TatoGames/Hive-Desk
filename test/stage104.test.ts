import { describe, expect, it } from 'vitest'
import type { AptitudeRecord } from '../src/shared/aptitude'
import { taskCost } from '../src/shared/cost'
import type { Task } from '../src/shared/types'

const t = (id: string, over: Partial<Task> = {}): Task => ({ id, title: id, status: 'done', notes: [], dependsOn: [], ...over }) as unknown as Task
const a = (taskId: string, runs: number, ms: number): AptitudeRecord => ({ taskId, modelKey: 'm', modelLabel: 'm', domain: 'x', runs, ms, approved: 0, changes: 0, failed: 0, updatedAt: '' })

describe('F: where the AI runs and time of a job went', () => {
  const all = [
    t('root', { kind: 'plan' }),
    t('w1', { kind: 'work', parentId: 'root', checks: { at: '', ok: true, items: [{ name: 'test', cmd: 'npm test', ok: true, ms: 2000, tail: '' }, { name: 'app', cmd: 'electron .', ok: true, ms: 6000, tail: '', skipped: 'x' }] }, reviewState: { status: 'skipped', round: 0, escalations: 0, note: 'AI 검토 생략: 작은 변경' } }),
    t('w2', { kind: 'work', parentId: 'root', reviewState: { status: 'skipped', deferred: true, round: 0, escalations: 0 } }),
    t('r1', { kind: 'review', reviewOf: 'w2' }),
    t('other', { kind: 'work' })
  ]
  const apt = [a('root', 1, 60_000), a('w1', 3, 90_000), a('w2', 1, 30_000), a('r1', 1, 20_000), a('other', 5, 999_000)]

  it('splits plan / work / rework / review; counts the checks apart; counts the reviews that were not needed', () => {
    const c = taskCost(all, 'root', apt)
    const by = Object.fromEntries(c.stages.map((s) => [s.stage, [s.runs, s.ms]]))
    expect(by.plan).toEqual([1, 60_000])
    // w1: 3 runs → the first is the work, two are rework (same average length)
    expect(by.work).toEqual([2, 60_000])
    expect(by.rework).toEqual([2, 60_000])
    expect(by.review).toEqual([1, 20_000])
    expect(c.runs).toBe(6)
    expect(c.ms).toBe(200_000)
    // the app check that was skipped does not count; the test run does
    expect(c.checkRuns).toBe(1)
    expect(c.checkMs).toBe(2000)
    expect(c.reviewsSaved).toBe(2)
    // tasks outside the job are not counted
    expect(c.tasks).toBe(3)
  })

  it('a task with no runs yet shows nothing', () => {
    expect(taskCost(all, 'other', []).runs).toBe(0)
  })
})
