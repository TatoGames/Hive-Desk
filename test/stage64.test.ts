import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { lighterThan } from '../src/shared/connections'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s64-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = '[[DID: ok]]\n[[FILES: none]]\n[[VERIFY: ok]]\n[[RISK: none]]\n[[NEXT: none]]'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await wait(20)
}

describe('6-4 (P14): the auto-connect preview shows what it costs', () => {
  it('every row has the usage weight of its model and a lighter choice when one is usable', async () => {
    const runner: Runner = async () => ({ code: 0, stdout: 'OK', stderr: '', timedOut: false, aborted: false })
    const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    eng.applyTemplate('game-studio', '게임사', false)
    eng.recordCheck('claude', { ok: true, message: 'ok' })
    await eng.verifyAllModels('claude')
    const rows = eng.autoConnectPreview()
    const weights = Object.fromEntries(eng.catalog().map((m) => [m.id, m.weight]))
    for (const r of rows) {
      expect(r.weight).toBe(weights[r.chosen!])
      if (r.lighter) expect(r.lighter.weight).toBeLessThan(r.weight)
    }
    // the heaviest seat (a CEO on a top model) can always go lighter: Haiku is connected too
    const ceo = rows.find((r) => r.job === 'ceo')!
    expect(ceo.lighter).toBeDefined()
    // applying the lighter choice hires that model
    expect(eng.autoConnectApply([{ seatId: ceo.seatId, modelAgentId: ceo.lighter!.modelAgentId }])).toBe(1)
    const seat = eng.snapshot().company.seats.find((s) => s.id === ceo.seatId)!
    expect(eng.config.agents.find((a) => a.id === seat.agentId)!.modelRef!.id).toBe(ceo.lighter!.modelId)
    eng.shutdown()
  })

  it('lighterThan picks the heaviest of the lighter models', () => {
    const m = (id: string, tier: 'top' | 'balanced' | 'light', weight: number) => ({ id, tier, weight })
    const all = [m('fable', 'top', 10), m('opus', 'top', 6), m('sonnet', 'balanced', 3), m('haiku', 'light', 1)]
    expect(lighterThan(all[0], all)?.id).toBe('opus')
    expect(lighterThan(all[2], all)?.id).toBe('haiku')
    expect(lighterThan(all[3], all)).toBeUndefined()
  })
})

describe('6-4 (P11): a message reaches an AI that is working right now', () => {
  function liveRunner() {
    const sent: string[] = []
    let finish: (() => void) | undefined
    const runner: Runner = (_b, o) =>
      new Promise((resolve) => {
        finish = () => resolve({ code: 0, stdout: REPORT, stderr: '', timedOut: false, aborted: false })
        o.signal?.addEventListener('abort', () => resolve({ code: 1, stdout: '', stderr: '', timedOut: false, aborted: true }))
        o.onHandle?.({ send: (t) => (sent.push(t), true), interrupt: () => true, paused: () => false })
      })
    return { runner, sent, finish: () => finish?.() }
  }

  it('the running Claude gets it at once and it counts as read; an idle agent gets it at the next run', async () => {
    const lr = liveRunner()
    const eng = new Engine(join(dir, 'c.json'), () => {}, lr.runner, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    eng.watchMs = 20
    const work = join(dir, 'work')
    mkdirSync(work, { recursive: true })
    const busy = eng.saveAgent({ name: 'busy', adapter: 'claude', workDir: work })
    const idle = eng.saveAgent({ name: 'idle', adapter: 'claude', workDir: join(dir, 'w2') })
    const t = eng.createTask({ title: '긴 일', assignee: busy.id })
    const p = eng.runTask(t.id)
    await waitFor(() => !!eng.hive.getTask(t.id)?.liveInput)
    eng.sendMessage('alice', busy.id, 'API 주소가 바뀌었어요')
    expect(lr.sent.some((s) => s.includes('API 주소가 바뀌었어요') && s.includes('alice'))).toBe(true)
    expect(eng.hive.listInbox(busy.id).every((m) => m.read)).toBe(true)
    eng.sendMessage('alice', idle.id, '나중에 봐 주세요')
    expect(eng.hive.listInbox(idle.id).filter((m) => !m.read).length).toBe(1)
    lr.finish()
    await p
    eng.shutdown()
  })
})
