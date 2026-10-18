import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { substituteFor } from '../src/shared/connections'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s52-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = '[[DID: ok]]\n[[FILES: none]]\n[[VERIFY: ok]]\n[[RISK: none]]\n[[NEXT: none]]'
/** A runner whose model checks pass only for the models in `works`. */
function runnerFor(works: string[], log: string[] = []): Runner {
  return async (b, o) => {
    const i = b.args.findIndex((a) => a === '--model' || a === '-m')
    const model = i >= 0 ? b.args[i + 1] : ''
    if (o.prompt.includes('connection check')) {
      const ok = !model || works.includes(model)
      return { code: ok ? 0 : 1, stdout: ok ? 'OK' : '', stderr: ok ? '' : 'model not available for your plan', timedOut: false, aborted: false }
    }
    log.push(o.cwd.split('/').pop() ?? '')
    await new Promise((r) => setTimeout(r, 40))
    return { code: 0, stdout: REPORT, stderr: '', timedOut: false, aborted: false }
  }
}

function engine(works: string[] = [], log: string[] = []) {
  const eng = new Engine(join(dir, 'c.json'), () => {}, runnerFor(works, log), dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), maxConcurrent: 4 })
  eng.watchMs = 20
  return eng
}

describe('connections and model agents', () => {
  it('a working connection gets one default agent per model of that CLI; others stay absent', () => {
    const eng = engine()
    expect(eng.snapshot().connections).toEqual([])
    eng.recordCheck('claude', { ok: true, message: '연결됐어요' })
    const c = eng.snapshot().connections
    expect(c.map((x) => x.adapter)).toEqual(['claude'])
    expect(c[0].check?.ok).toBe(true)
    const labels = c[0].models.map((m) => m.label)
    expect(labels).toEqual(expect.arrayContaining(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']))
    expect(c[0].models.every((m) => m.status === 'unchecked')).toBe(true)
    // a failed check creates nothing
    eng.recordCheck('codex', { ok: false, message: '로그인 필요' })
    expect(eng.snapshot().connections.find((x) => x.adapter === 'codex')?.models).toEqual([])
    eng.shutdown()
  })

  it('checking all models marks the ones the account cannot use; those cannot be hired', async () => {
    const eng = engine(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'opus', 'sonnet', 'haiku'])
    eng.recordCheck('claude', { ok: true, message: 'ok' })
    const r = await eng.verifyAllModels('claude')
    expect(r.checked).toBeGreaterThan(0)
    const models = eng.snapshot().connections[0].models
    expect(models.find((m) => m.label === 'Sonnet 5.5')!.status).toBe('ok')
    const fable = models.find((m) => m.label === 'Fable 5.1')!
    expect(fable.status).toBe('unavailable')
    expect(() => eng.hire({ modelAgentId: fable.id })).toThrow('쓸 수 없어요')
    eng.shutdown()
  })

  it('an account model list marks everything else of that CLI unavailable', async () => {
    const eng = new Engine(
      join(dir, 'c.json'),
      () => {},
      async (b) => ({ code: 0, stdout: b.args[0] === 'models' ? 'fast-model-1  Fast\nbig-model-2  Big\n' : 'OK', stderr: '', timedOut: false, aborted: false }),
      dir
    )
    await eng.refreshAccountModels('agy')
    eng.recordCheck('agy', { ok: true, message: 'ok' })
    const agy = eng.snapshot().connections.find((c) => c.adapter === 'agy')!
    expect(agy.canList).toBe(true)
    expect(agy.models.map((m) => m.modelId).sort()).toEqual(['acct-agy-big-model-2', 'acct-agy-fast-model-1'])
    expect(agy.models.every((m) => m.status === 'ok' && m.verified)).toBe(true)
    eng.shutdown()
  })
})

describe('hiring', () => {
  it('creates an employee of the company on screen with its own name and the model, and seats it', () => {
    const eng = engine()
    eng.applyTemplate('startup', '스타트업', false)
    eng.recordCheck('claude', { ok: true, message: 'ok' })
    const ma = eng.snapshot().connections[0].models.find((m) => m.label === 'Sonnet 5.5')!
    const seat = eng.snapshot().company.seats.find((s) => s.job === 'build')!
    const a = eng.hire({ modelAgentId: ma.id, seatId: seat.id })
    expect(a).toMatchObject({ name: seat.title, adapter: 'claude', modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    expect(eng.snapshot().company.seats.find((s) => s.id === seat.id)!.agentId).toBe(a.id)
    expect(eng.snapshot().config.agents.find((x) => x.id === a.id)).toMatchObject({ unitId: seat.unitId, job: seat.job })
    // same model again, no seat: the name stays unique inside the company
    const b = eng.hire({ modelAgentId: ma.id })
    const c = eng.hire({ modelAgentId: ma.id })
    expect(new Set([b.name, c.name]).size).toBe(2)
    // another company can hire the same model agent: separate employees
    eng.createCompany('다른 회사')
    const d = eng.hire({ modelAgentId: ma.id })
    expect(d.id).not.toBe(b.id)
    expect(eng.snapshot().config.agents.map((x) => x.id)).toEqual([d.id])
    eng.shutdown()
  })
})

describe('auto connect', () => {
  it('previews a table, substitutes unusable models with the same tier, and hires on confirm', async () => {
    // only Claude works: the design wants other makers too (min models per team, CEO trio)
    const eng = engine(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'opus', 'sonnet', 'haiku'])
    eng.applyTemplate('game-studio', '게임사', false)
    eng.recordCheck('claude', { ok: true, message: 'ok' })
    await eng.verifyAllModels('claude')
    const rows = eng.autoConnectPreview()
    expect(rows.length).toBe(eng.snapshot().company.seats.length)
    expect(rows.every((r) => r.chosen && r.modelAgentId)).toBe(true)
    const subs = rows.filter((r) => r.substituted)
    expect(subs.length).toBeGreaterThan(0)
    expect(subs[0].note).toContain('대체')
    // a CEO seat keeps a top-tier model when one is usable
    const ceo = rows.find((r) => r.job === 'ceo')!
    expect(ceo.chosenLabel).toContain('Opus')
    const n = eng.autoConnectApply()
    expect(n).toBe(rows.length)
    expect(eng.autoConnectPreview()).toEqual([])
    expect(eng.snapshot().company.seats.every((s) => !!s.agentId)).toBe(true)
    expect(eng.autoConnectApply()).toBe(0)
    eng.shutdown()
  })

  it('stand-ins still follow the team rules: a reviewer never ends up on a worker stand-in, ties go to the lighter model', async () => {
    const all = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
    const eng = engine(all)
    eng.applyTemplate('team-project', '졸작', false)
    eng.recordCheck('claude', { ok: true, message: 'ok' })
    await eng.verifyAllModels('claude')
    const rows = eng.autoConnectPreview()
    const seats = eng.snapshot().company.seats
    const unitOf = (id: string) => seats.find((s) => s.id === id)!.unitId
    for (const r of rows.filter((x) => x.job === 'review' || x.job === 'qa')) {
      const workers = rows.filter((w) => unitOf(w.seatId) === unitOf(r.seatId) && ['plan', 'build', 'docs', 'research', 'ops'].includes(w.job))
      expect(workers.map((w) => w.chosen)).not.toContain(r.chosen)
    }
    // Opus and Fable are the same tier; Opus is lighter, so a worker stand-in never picks Fable over it
    // (a reviewer may: it must be at least the workers' tier and differ from all of them)
    expect(rows.filter((r) => r.job !== 'review' && r.job !== 'qa').map((r) => r.chosenLabel)).not.toContain('Fable 5.1')
    eng.shutdown()
  })

  it('without any connection every row says so; the person can apply an edited choice', () => {
    const eng = engine()
    eng.applyTemplate('startup', '스타트업', false)
    const rows = eng.autoConnectPreview()
    expect(rows.every((r) => r.chosen === null && r.note.includes('연결'))).toBe(true)
    expect(eng.autoConnectApply()).toBe(0)
    eng.recordCheck('claude', { ok: true, message: 'ok' })
    const ma = eng.snapshot().connections[0].models.find((m) => m.label === 'Haiku 5.5')!
    const seat = rows[0].seatId
    expect(eng.autoConnectApply([{ seatId: seat, modelAgentId: ma.id }])).toBe(1)
    expect(eng.snapshot().company.seats.find((s) => s.id === seat)!.agentId).toBeDefined()
    eng.shutdown()
  })

  it('substituteFor: same tier, then stronger, then weaker', () => {
    const m = (id: string, tier: 'top' | 'balanced' | 'light') => ({ id, tier }) as never
    expect(substituteFor(m('x', 'balanced'), [m('a', 'top'), m('b', 'balanced'), m('c', 'light')])?.id).toBe('b')
    expect(substituteFor(m('x', 'balanced'), [m('a', 'top'), m('c', 'light')])?.id).toBe('a')
    expect(substituteFor(m('x', 'top'), [m('c', 'light')])?.id).toBe('c')
    expect(substituteFor(m('x', 'top'), [])).toBeUndefined()
  })

  it('substituteFor: within a tier the lighter model stands in (Opus over Fable)', () => {
    const m = (id: string, tier: 'top' | 'balanced' | 'light', weight: number) => ({ id, tier, weight }) as never
    const usable = [m('claude-fable-5-1', 'top', 10), m('claude-opus-5-5', 'top', 6), m('claude-sonnet-5-5', 'balanced', 3)]
    expect(substituteFor(m('openai-gpt-6-astra', 'top', 8), usable)?.id).toBe('claude-opus-5-5')
  })
})

describe('sharing one account between companies', () => {
  function twoWithWork(log: string[]) {
    const eng = engine([], log)
    const a = eng.snapshot().companies[0]
    mkdirSync(join(dir, 'wa'))
    const ag = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: join(dir, 'wa') })
    const b = eng.createCompany('B')
    mkdirSync(join(dir, 'wb'))
    const bg = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: join(dir, 'wb') })
    const tb = eng.createTask({ title: 'B 일', assignee: bg.id })
    eng.switchCompany(a.id)
    const ta = eng.createTask({ title: 'A 일', assignee: ag.id })
    eng.saveSettings({ autoRun: true })
    return { eng, a, b, ta, tb }
  }
  const statusOf = (c: string, t: string): string => JSON.parse(readFileSync(join(dir, 'ws', 'companies', c, 'tasks', t + '.json'), 'utf8')).status
  const waitIdle = async (eng: Engine): Promise<void> => {
    for (let i = 0; i < 200 && eng.snapshot().running.length; i++) await new Promise((r) => setTimeout(r, 10))
  }

  it('normally both companies run at the same time', async () => {
    const log: string[] = []
    const { eng } = twoWithWork(log)
    await eng.tick()
    expect(eng.snapshot().running).toHaveLength(2)
    await waitIdle(eng)
    eng.shutdown()
  })

  it('after the account hit its limit, the lower-priority company waits for the higher one', async () => {
    const log: string[] = []
    const { eng, a, b, ta, tb } = twoWithWork(log)
    eng.setCompanyOrder([b.id, a.id]) // B first
    eng.machine.noteLimitHit('claude') // the limit was hit a moment ago (and has been lifted since)
    await eng.tick()
    expect(eng.snapshot().running).toEqual([tb.id]) // A waits
    await waitIdle(eng)
    await eng.tick() // B has nothing left: A may start now
    expect(eng.snapshot().running).toEqual([ta.id])
    await waitIdle(eng)
    expect(['done', 'needs_review']).toContain(statusOf(a.id, ta.id))
    expect(['done', 'needs_review']).toContain(statusOf(b.id, tb.id))
    eng.shutdown()
  })

  it('priority can be set per connection and overrides the general order', () => {
    const { eng, a, b } = twoWithWork([])
    eng.setCompanyOrder([a.id, b.id])
    eng.setCompanyOrder([b.id, a.id], 'codex')
    eng.recordCheck('claude', { ok: true, message: 'ok' })
    eng.recordCheck('codex', { ok: true, message: 'ok' })
    const v = eng.snapshot().connections
    expect(v.find((c) => c.adapter === 'claude')!.order).toEqual([a.id, b.id])
    expect(v.find((c) => c.adapter === 'codex')!.order).toEqual([b.id, a.id])
    // companies not in the list follow in creation order
    eng.setCompanyOrder([b.id])
    expect(eng.snapshot().connections.find((c) => c.adapter === 'claude')!.order).toEqual([b.id, a.id])
    eng.shutdown()
  })

  it('a manual run is never held back by the priority rule', async () => {
    const log: string[] = []
    const { eng, a, b, ta } = twoWithWork(log)
    eng.setCompanyOrder([b.id, a.id])
    eng.machine.noteLimitHit('claude')
    await eng.runTask(ta.id)
    expect(['done', 'needs_review']).toContain(statusOf(a.id, ta.id))
    eng.shutdown()
  })
})
