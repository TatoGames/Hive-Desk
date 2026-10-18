import { companyDir } from '../src/main/workspace'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { channelAllows, parseCollab, type CollabChannel } from '../src/shared/collab'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s54-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = '[[DID: 했어요]]\n[[FILES: none]]\n[[VERIFY: 확인]]\n[[RISK: none]]\n[[NEXT: none]]'

function setup() {
  const prompts: string[] = []
  const state = { out: REPORT }
  const runner: Runner = async (_b, o) => {
    prompts.push(o.prompt)
    return { code: 0, stdout: state.out, stderr: '', timedOut: false, aborted: false }
  }
  const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), maxConcurrent: 4 })
  eng.watchMs = 20
  const a = eng.snapshot().companies[0]
  const wa = join(dir, 'wa')
  mkdirSync(wa)
  const agentA = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: wa })
  const b = eng.createCompany('B 회사')
  const wb = join(dir, 'wb')
  mkdirSync(wb)
  const agentB = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: wb })
  return { eng, a, b, agentA, agentB, prompts, state }
}

const scope = (over: Record<string, unknown> = {}) => ({
  what: ['material'] as never[], direction: 'oneway' as const, permission: 'read' as const, duration: { kind: 'open' as const }, ...over
})

async function runIn(eng: Engine, company: string, agent: string, title = '일'): Promise<void> {
  eng.switchCompany(company)
  const t = eng.createTask({ title, assignee: agent })
  await eng.runTask(t.id)
}

describe('rules', () => {
  const ch = (over: Partial<CollabChannel> = {}): CollabChannel => ({
    id: 'x', from: 'A', to: 'B', what: ['material'], direction: 'oneway', permission: 'read', duration: { kind: 'open' }, status: 'active', createdAt: '2026-01-01T00:00:00Z', createdBy: 'me', ...over
  })
  it('nothing is allowed without a channel', () => {
    expect(channelAllows(undefined, 'A', 'B', 'material').ok).toBe(false)
  })
  it('direction, kind, permission, expiry, once and closed are all enforced', () => {
    expect(channelAllows(ch(), 'A', 'B', 'material').ok).toBe(true)
    expect(channelAllows(ch(), 'B', 'A', 'material').ok).toBe(false)
    expect(channelAllows(ch({ direction: 'both' }), 'B', 'A', 'material').ok).toBe(true)
    expect(channelAllows(ch(), 'A', 'B', 'message').ok).toBe(false)
    expect(channelAllows(ch({ what: ['work'] }), 'A', 'B', 'work').ok).toBe(false) // read only
    expect(channelAllows(ch({ what: ['work'], permission: 'request' }), 'A', 'B', 'work').ok).toBe(true)
    expect(channelAllows(ch({ duration: { kind: 'until', date: '2026-02-01' } }), 'A', 'B', 'material', new Date('2026-03-01')).ok).toBe(false)
    expect(channelAllows(ch({ duration: { kind: 'until', date: '2026-02-01' } }), 'A', 'B', 'material', new Date('2026-01-15')).ok).toBe(true)
    expect(channelAllows(ch({ duration: { kind: 'once' }, usedAt: 'now' }), 'A', 'B', 'material').ok).toBe(false)
    expect(channelAllows(ch({ status: 'closed' }), 'A', 'B', 'material').ok).toBe(false)
    expect(channelAllows(ch({ from: 'A', to: 'B' }), 'C', 'B', 'material').ok).toBe(false)
  })
  it('reads the COLLAB marker', () => {
    expect(parseCollab('끝 [[COLLAB: 외부 도움 필요 | 번역가 | 영어 문서가 많아요]]')).toEqual({ hint: '외부 도움 필요', need: '번역가', why: '영어 문서가 많아요' })
    expect(parseCollab('[[COLLAB: 법무 검토]]')?.need).toBe('법무 검토')
    expect(parseCollab('없음')).toBeNull()
  })
})

describe('collaboration between companies', () => {
  it('is off by default: nothing crosses, every refusal is logged, no AI sees the other company', async () => {
    const { eng, a, b, agentA, agentB, prompts } = setup()
    eng.switchCompany(a.id)
    const m = eng.addMemory('A-비밀-메모', 'fixed')
    void m
    expect(() => eng.collab.sendMessage('nope', a.id, 'hi')).toThrow()
    expect(eng.collab.listShareable(a.id).length).toBeGreaterThan(0)
    await runIn(eng, b.id, agentB.id)
    expect(prompts.join('\n')).not.toContain('A-비밀')
    expect(eng.snapshot().external).toEqual([])
    void agentA
    eng.shutdown()
  })

  it('a one-way channel copies material with its source; the receiver’s AI sees it, the sender’s side does not change', async () => {
    const { eng, a, b, agentA, agentB, prompts } = setup()
    eng.switchCompany(a.id)
    eng.addMemory('A-공유-자료', 'fixed')
    const ch = eng.collab.createChannel({ from: a.id, to: b.id, ...scope() }, 'alice')
    const ref = eng.collab.listShareable(a.id).find((r) => r.title.includes('A-공유-자료'))!
    eng.collab.sendMaterial(ch.id, a.id, { ref: ref.ref })
    // wrong way is refused
    expect(() => eng.collab.sendMessage(ch.id, b.id, 'x')).toThrow()
    expect(() => eng.collab.sendMaterial(ch.id, b.id, { ref: ref.ref })).toThrow()
    eng.switchCompany(b.id)
    const box = eng.snapshot().external
    expect(box).toHaveLength(1)
    expect(box[0]).toMatchObject({ fromCompanyName: expect.any(String), channelId: ch.id, kind: 'material' })
    expect(box[0].fromCompanyId).toBe(a.id)
    prompts.length = 0
    await runIn(eng, b.id, agentB.id)
    expect(prompts.join('\n')).toContain('A-공유-자료')
    // A's own box stays empty, and A never receives B's data
    eng.switchCompany(a.id)
    expect(eng.snapshot().external).toEqual([])
    void agentA
    eng.shutdown()
  })

  it('once: the second transfer is refused; expired channels refuse; read-only refuses work', () => {
    const { eng, a, b } = setup()
    eng.switchCompany(a.id)
    const once = eng.collab.createChannel({ from: a.id, to: b.id, ...scope({ what: ['message'], duration: { kind: 'once' } }) }, 'alice')
    eng.collab.sendMessage(once.id, a.id, '하나')
    expect(() => eng.collab.sendMessage(once.id, a.id, '둘')).toThrow(/1회/)
    const old = eng.collab.createChannel({ from: a.id, to: b.id, ...scope({ what: ['message'], duration: { kind: 'until', date: '2000-01-01' } }) }, 'alice')
    expect(() => eng.collab.sendMessage(old.id, a.id, 'x')).toThrow(/기간/)
    expect(() => eng.collab.createChannel({ from: a.id, to: b.id, ...scope({ what: ['work'], permission: 'read' }) }, 'alice')).toThrow()
    const ro = eng.collab.createChannel({ from: a.id, to: b.id, ...scope({ what: ['message'] }) }, 'alice')
    expect(() => eng.collab.requestWork(ro.id, a.id, '일', '내용')).toThrow()
    expect(() => eng.collab.createChannel({ from: a.id, to: a.id, ...scope() }, 'alice')).toThrow()
    expect(eng.collab.view().audit.filter((x) => x.action === 'blocked').length).toBeGreaterThanOrEqual(3)
    eng.shutdown()
  })

  it('closing recalls the copies: kept in the record, never given to an AI again', async () => {
    const { eng, a, b, agentB, prompts } = setup()
    eng.switchCompany(a.id)
    const ch = eng.collab.createChannel({ from: a.id, to: b.id, ...scope({ what: ['message'] }) }, 'alice')
    eng.collab.sendMessage(ch.id, a.id, 'A-회수대상-메시지')
    await runIn(eng, b.id, agentB.id)
    expect(prompts.join('\n')).toContain('A-회수대상')
    expect(eng.collab.closeChannel(ch.id, 'alice')).toBe(1)
    prompts.length = 0
    await runIn(eng, b.id, agentB.id, '또 일')
    expect(prompts.join('\n')).not.toContain('A-회수대상')
    const item = eng.snapshot().external[0]
    expect(item.recalledAt).toBeTruthy()
    expect(item.body).toContain('A-회수대상')
    expect(() => eng.collab.sendMessage(ch.id, a.id, '또')).toThrow()
    expect(eng.collab.view().audit.map((x) => x.action)).toContain('channel-closed')
    eng.shutdown()
  })

  it('a two-way channel works both directions and keeps company folders free of collaboration data', () => {
    const { eng, a, b } = setup()
    eng.switchCompany(a.id)
    const ch = eng.collab.createChannel({ from: a.id, to: b.id, ...scope({ what: ['message'], direction: 'both' }) }, 'alice')
    eng.collab.sendMessage(ch.id, a.id, '가')
    eng.collab.sendMessage(ch.id, b.id, '나')
    expect(eng.snapshot().external.map((x) => x.body)).toEqual(['나'])
    const ws = join(dir, 'ws')
    expect(existsSync(join(ws, 'collab', 'channels'))).toBe(true)
    for (const id of [a.id, b.id]) expect(readdirSync(join(companyDir(ws, id)))).not.toContain('collab')
    eng.shutdown()
  })

  it('a work request lands on the receiver’s board and the accepted result goes back to the asker', () => {
    const { eng, a, b } = setup()
    // the receiver has a COO who takes unassigned work
    eng.switchCompany(b.id)
    const exec = eng.saveUnit({ name: '경영', kind: '경영' })
    const coo = eng.saveAgent({ name: 'coo', adapter: 'claude', workDir: join(dir, 'wb'), modelRef: { id: 'claude-opus-5-5', pin: 'pinned' } })
    eng.assignSeat(eng.saveSeat({ unitId: exec.id, title: '총괄', job: 'coo' }).id, coo.id)
    eng.switchCompany(a.id)
    const ch = eng.collab.createChannel({ from: a.id, to: b.id, ...scope({ what: ['work'], permission: 'request', duration: { kind: 'once' } }) }, 'alice')
    const t = eng.collab.requestWork(ch.id, a.id, '번역 부탁', '문서를 영어로')
    expect(t.external?.fromCompanyId).toBe(a.id)
    eng.switchCompany(b.id)
    const mine = eng.snapshot().tasks.find((x) => x.id === t.id)!
    expect(mine.title).toContain('[외부 의뢰]')
    expect(mine.assignee).toBe(coo.id)
    // the receiver's board accepts it: the result is handed back
    eng.updateTask(t.id, { status: 'done', result: '번역 완료본' })
    eng.switchCompany(a.id)
    const back = eng.snapshot().external
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ kind: 'result', fromCompanyId: b.id })
    expect(back[0].body).toContain('번역 완료본')
    // only once
    eng.switchCompany(b.id)
    eng.updateTask(t.id, {})
    eng.switchCompany(a.id)
    expect(eng.snapshot().external).toHaveLength(1)
    expect(eng.collab.view().audit.map((x) => x.action)).toEqual(expect.arrayContaining(['work-requested', 'result-returned']))
    eng.shutdown()
  })

  it('a result is not handed back when the channel was closed meanwhile', () => {
    const { eng, a, b } = setup()
    eng.switchCompany(b.id)
    const exec = eng.saveUnit({ name: '경영', kind: '경영' })
    const coo = eng.saveAgent({ name: 'coo', adapter: 'claude', workDir: join(dir, 'wb'), modelRef: { id: 'claude-opus-5-5', pin: 'pinned' } })
    eng.assignSeat(eng.saveSeat({ unitId: exec.id, title: '총괄', job: 'coo' }).id, coo.id)
    const ch = eng.collab.createChannel({ from: a.id, to: b.id, ...scope({ what: ['work'], permission: 'request' }) }, 'alice')
    const t = eng.collab.requestWork(ch.id, a.id, '일', '내용')
    eng.collab.closeChannel(ch.id, 'alice')
    eng.updateTask(t.id, { status: 'done', result: '끝' })
    eng.switchCompany(a.id)
    expect(eng.snapshot().external).toEqual([])
    expect(eng.collab.view().audit.some((x) => x.action === 'blocked' && x.text.includes('결과를 돌려주지'))).toBe(true)
    eng.shutdown()
  })

  it('an AI’s [[COLLAB]] request waits for the board, which picks the company; non-managers are ignored', async () => {
    const { eng, a, b, agentA, state } = setup()
    eng.switchCompany(a.id)
    // a manager seat for the asking company's agent
    const exec = eng.saveUnit({ name: '경영', kind: '경영' })
    eng.assignSeat(eng.saveSeat({ unitId: exec.id, title: '총괄', job: 'coo' }).id, agentA.id)
    state.out = `${REPORT}\n[[COLLAB: 외부 도움 필요 | 번역가 | 영어 문서]]`
    const t = eng.createTask({ title: '계획', assignee: agentA.id })
    await eng.runTask(t.id)
    const pending = eng.collab.pendingRequests()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ fromCompanyId: a.id, need: '번역가', status: 'pending' })
    expect(eng.collab.view().channels).toEqual([]) // nothing opens by itself
    // same answer again does not duplicate
    await eng.runTask(t.id).catch(() => {})
    expect(eng.collab.pendingRequests()).toHaveLength(1)
    // reject
    eng.collab.decideRequest(pending[0].id, 'rejected', 'alice')
    expect(eng.collab.pendingRequests()).toHaveLength(0)
    expect(() => eng.collab.decideRequest(pending[0].id, 'approved', 'alice', { to: b.id, ...scope() })).toThrow()
    eng.shutdown()
  })

  it('approving an AI request opens the channel the board chose', async () => {
    const { eng, a, b, agentA, state } = setup()
    eng.switchCompany(a.id)
    const exec = eng.saveUnit({ name: '경영', kind: '경영' })
    eng.assignSeat(eng.saveSeat({ unitId: exec.id, title: '총괄', job: 'coo' }).id, agentA.id)
    state.out = `${REPORT}\n[[COLLAB: 번역가 | 번역 | 이유]]`
    const t = eng.createTask({ title: '계획', assignee: agentA.id })
    await eng.runTask(t.id)
    const r = eng.collab.pendingRequests()[0]
    const ch = eng.collab.decideRequest(r.id, 'approved', 'alice', { to: b.id, ...scope({ what: ['message'] }) })!
    expect(ch).toMatchObject({ from: a.id, to: b.id, requestId: r.id })
    expect(eng.collab.view().requests[0]).toMatchObject({ status: 'approved', channelId: ch.id })
    eng.shutdown()
  })

  it('a plain worker’s [[COLLAB]] is ignored', async () => {
    const { eng, a, agentA, state } = setup()
    eng.switchCompany(a.id)
    state.out = `${REPORT}\n[[COLLAB: x | 도움 | y]]`
    const t = eng.createTask({ title: '일', assignee: agentA.id })
    await eng.runTask(t.id)
    expect(eng.collab.pendingRequests()).toEqual([])
    eng.shutdown()
  })
})
