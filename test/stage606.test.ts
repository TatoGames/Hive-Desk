import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundlesOf, isStale } from '../src/shared/bundles'
import { moveItem, planIssues, removeItem } from '../src/shared/planedit'
import type { SubtaskSpec, Task } from '../src/shared/types'
import { Hive } from '../src/main/hive'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s606-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const it3: SubtaskSpec[] = [
  { title: '조사', assignee: 'a', done: '요약', after: [] },
  { title: '문서 작성', assignee: 'b', done: '문서', after: [1] },
  { title: '검토 자료', assignee: 'c', done: '표', after: [1, 2] }
]

describe('6-0.6: editing a plan by hand', () => {
  it('removing renumbers the dependencies and drops the ones on the removed item', () => {
    const out = removeItem(it3, 1)
    expect(out.map((i) => i.title)).toEqual(['조사', '검토 자료'])
    expect(out[1].after).toEqual([1])
  })
  it('moving keeps the dependencies attached to the right items', () => {
    const out = moveItem(it3, 1, -1)
    expect(out.map((i) => i.title)).toEqual(['문서 작성', '조사', '검토 자료'])
    // "문서 작성" waited for 조사 (was 1) → now 조사 is item 2
    expect(out[0].after).toEqual([2])
    expect(out[2].after).toEqual([2, 1])
  })
})

describe('6-0.6: sub-tasks that cannot be done as written', () => {
  const none = { github: false, web: false }
  const mgr = (): boolean => false
  it('deployment without a GitHub connection, web search with web off, and read-only file work are flagged', () => {
    const items: SubtaskSpec[] = [
      { title: 'GitHub Pages로 배포', assignee: 'a', done: '사이트가 열림', after: [] },
      { title: '웹 검색으로 자료 조사', assignee: 'a', done: '요약', after: [] },
      { title: '명세 문서 작성', assignee: 'a', done: '파일', after: [], access: 'read' },
      { title: '명세 문서 작성', assignee: 'a', done: '파일', after: [], access: 'edit' }
    ]
    const issues = planIssues(items, none, mgr)
    expect(issues.map((i) => [i.index, i.kind])).toEqual([[0, 'github'], [1, 'web'], [2, 'readonly']])
    expect(issues[2].fix).toEqual({ access: 'edit' })
    expect(planIssues(items, { github: true, web: true }, mgr).map((i) => i.kind)).toEqual(['readonly'])
  })
})

describe('6-0.6: bundles', () => {
  it('counts progress and finds old ones', () => {
    const h = new Hive(join(dir, 'h'))
    const root = h.createTask({ title: '묶음', assignee: 'a', createdBy: 'x' })
    const mk = (title: string, status: Task['status']): Task => {
      const t = h.createTask({ title, assignee: 'a', createdBy: 'x' })
      return h.updateTask(t.id, { parentId: root.id, kind: 'work', status })
    }
    mk('일1', 'done')
    mk('일2', 'todo')
    mk('일3', 'running')
    h.updateTask(root.id, { status: 'delegated', plan: { items: [], estimateRuns: 3, flags: [], status: 'approved', approver: 'auto', boardReasons: [], rejections: 0 } })
    const [b] = bundlesOf(h.listTasks())
    expect(b).toMatchObject({ total: 3, done: 1, remaining: 2, running: 1 })
    expect(isStale({ ...b, running: 0 }, 24, Date.now() + 25 * 3600e3)).toBe(true)
    expect(isStale({ ...b, running: 0 }, 24, Date.now())).toBe(false)
  })
})

describe('6-0.7: sub-tasks that touch the same files get an order, the others run together', () => {
  it('overlapping folders are ordered, disjoint ones are left alone', async () => {
    const { orderByFiles, filesOverlap } = await import('../src/shared/planedit')
    expect(filesOverlap(['src/api'], ['src/api/user.ts'])).toBe(true)
    expect(filesOverlap(['src/api'], ['src/app'])).toBe(false)
    const items: SubtaskSpec[] = [
      { title: 'a', assignee: 'x', done: '', after: [], files: ['src/api'] },
      { title: 'b', assignee: 'x', done: '', after: [], files: ['docs'] },
      { title: 'c', assignee: 'x', done: '', after: [], files: ['src/api/user.ts'] },
      { title: 'd', assignee: 'x', done: '', after: [1] }
    ]
    const r = orderByFiles(items)
    expect(r.added).toEqual([[3, 1]])
    expect(r.items[2].after).toEqual([1])
    expect(r.items[1].after).toEqual([])
  })
})
