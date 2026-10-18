import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/main/engine'
import { delegationTrees, employeeState, handoffs, progressOf } from '../src/shared/office'
import type { Approval, Task } from '../src/shared/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s53-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

let n = 0
const task = (p: Partial<Task>): Task =>
  ({ id: 't' + ++n, title: 'x', description: '', assignee: null, status: 'todo', risky: false, dependsOn: [], createdBy: '', createdAt: '', updatedAt: '', cleared: [], notes: [], ...p }) as Task

describe('employee state', () => {
  const st = (agent: string, tasks: Task[], opts: { running?: string[]; limited?: boolean; approvals?: Approval[] } = {}) =>
    employeeState(agent, tasks, opts.approvals ?? [], opts.running ?? [], !!opts.limited)

  it('idle without work; working / reviewing when running; the others by what the person waits for', () => {
    expect(st('a', []).state).toBe('idle')
    const w = task({ assignee: 'a', status: 'running' })
    expect(st('a', [w], { running: [w.id] })).toMatchObject({ state: 'working', task: w })
    const r = task({ assignee: 'a', status: 'running', kind: 'review' })
    expect(st('a', [r], { running: [r.id] }).state).toBe('reviewing')
    expect(st('a', [task({ assignee: 'a', status: 'needs_input' })]).state).toBe('waiting-input')
    expect(st('a', [task({ assignee: 'a', status: 'awaiting_approval' })]).state).toBe('waiting-approval')
    const t = task({ assignee: 'a' })
    expect(st('a', [t], { approvals: [{ id: 'p', taskId: t.id, status: 'pending' } as Approval] }).state).toBe('waiting-approval')
    expect(st('a', [task({ assignee: 'a', status: 'failed' })]).state).toBe('error')
  })

  it('a limit only matters when something is waiting; running wins over everything; queue is listed', () => {
    expect(st('a', [], { limited: true }).state).toBe('idle')
    const q = task({ assignee: 'a' })
    expect(st('a', [q], { limited: true })).toMatchObject({ state: 'limit', queued: [q] })
    const w = task({ assignee: 'a', status: 'running' })
    const f = task({ assignee: 'a', status: 'failed' })
    expect(st('a', [f, w, q], { running: [w.id], limited: true }).state).toBe('working')
    expect(st('b', [w]).state).toBe('idle') // other people's tasks do not count
    expect(st('a', [task({ assignee: 'a', hidden: true, status: 'running' })]).state).toBe('idle')
  })
})

describe('progress', () => {
  it('a plain task: status, or its own checklist', () => {
    const run = task({ status: 'running' })
    expect(progressOf(task({ status: 'done' }), [])).toBe(1)
    expect(progressOf(task({ status: 'todo' }), [])).toBe(0)
    expect(progressOf(run, [])).toBeCloseTo(0.3)
    const live = { [run.id]: { plan: [{ text: 'a', done: true }, { text: 'b', done: true }, { text: 'c', done: false }, { text: 'd', done: false }] } } as never
    expect(progressOf(run, [run], live)).toBeCloseTo(0.45)
    expect(progressOf(task({ status: 'in_review' }), [])).toBe(0.9)
  })

  it('a parent is the run-weighted average of its sub-tasks; integration lifts it to at least 90%', () => {
    const root = task({ status: 'delegated', kind: 'plan' })
    const big = task({ parentId: root.id, status: 'done', kind: 'plan', plan: { estimateRuns: 9 } as never })
    const small = task({ parentId: root.id, status: 'todo' })
    expect(progressOf(root, [root, big, small])).toBeCloseTo(0.9, 5) // (9*1 + 1*0)/10 = 0.9
    const done = task({ parentId: root.id, status: 'done' })
    const root2 = task({ status: 'running', kind: 'integrate' })
    expect(progressOf(root2, [root2, { ...done, parentId: root2.id }])).toBeGreaterThanOrEqual(0.9)
    expect(progressOf({ ...root2, status: 'done' }, [])).toBe(1)
  })
})

describe('trees and handoffs', () => {
  it('builds trees from delegation roots and lists hand-offs that are still going', () => {
    const root = task({ kind: 'plan', assignee: 'coo', status: 'delegated' })
    const mid = task({ parentId: root.id, kind: 'plan', assignee: 'lead', status: 'delegated' })
    const leaf = task({ parentId: mid.id, kind: 'work', assignee: 'dev', status: 'running' })
    const finished = task({ parentId: mid.id, kind: 'work', assignee: 'dev2', status: 'done' })
    const plain = task({ title: 'plain' })
    const all = [root, mid, leaf, finished, plain]
    const trees = delegationTrees(all)
    expect(trees).toHaveLength(1)
    expect(trees[0].children[0].children.map((c) => c.task.id)).toEqual([leaf.id, finished.id])
    expect(handoffs(all)).toEqual([
      { from: 'coo', to: 'lead', taskId: mid.id },
      { from: 'lead', to: 'dev', taskId: leaf.id }
    ])
  })
})

describe('reassign and the news board', () => {
  function setup() {
    const eng = new Engine(join(dir, 'c.json'), () => {}, async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    const mk = (name: string, job?: string) => {
      mkdirSync(join(dir, name), { recursive: true })
      return eng.saveAgent({ name, adapter: 'claude', workDir: join(dir, name), job })
    }
    return { eng, a: mk('a'), b: mk('b'), boss: mk('boss', 'lead') }
  }

  it('moves a waiting task to another person and writes it to the timeline; refuses running/done/unknown', () => {
    const { eng, a, b } = setup()
    const t = eng.createTask({ title: '일', assignee: a.id })
    expect(eng.reassignTask(t.id, b.id).assignee).toBe(b.id)
    expect(eng.hive.listEvents(t.id).some((e) => e.text.includes('담당'))).toBe(true)
    expect(() => eng.reassignTask(t.id, 'nobody')).toThrow('없는 직원')
    eng.hive.updateTask(t.id, { status: 'running' })
    expect(() => eng.reassignTask(t.id, a.id)).toThrow('실행 중')
    eng.hive.updateTask(t.id, { status: 'done' })
    expect(() => eng.reassignTask(t.id, a.id)).toThrow('이미 끝났')
    eng.shutdown()
  })

  it('a failed task goes back to todo when moved; a plan task only goes to a manager', () => {
    const { eng, a, b, boss } = setup()
    const t = eng.createTask({ title: '일', assignee: a.id })
    eng.hive.updateTask(t.id, { status: 'failed' })
    expect(eng.reassignTask(t.id, b.id).status).toBe('todo')
    eng.hive.updateTask(t.id, { kind: 'plan' })
    expect(() => eng.reassignTask(t.id, a.id)).toThrow('관리자')
    expect(eng.reassignTask(t.id, boss.id).assignee).toBe(boss.id)
    eng.shutdown()
  })

  it('the feed lists the newest events with the person\'s name', () => {
    const { eng, a } = setup()
    const t = eng.createTask({ title: '소식 일', assignee: a.id })
    eng.hive.addEvent(t.id, 'status', a.id, '3/5단계 완료')
    const f = eng.officeFeed()
    expect(f.find((e) => e.text === '3/5단계 완료')).toMatchObject({ taskId: t.id, taskTitle: '소식 일', actor: 'a' })
    expect(f.length).toBeGreaterThanOrEqual(2)
    eng.shutdown()
  })
})
