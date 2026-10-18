import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCommand } from '../src/main/adapters'
import type { Runner } from '../src/main/adapters'
import { makeAgent } from '../src/main/config'
import { Engine } from '../src/main/engine'
import { accountEntries, parseModelList, tierOfSlug } from '../src/shared/company'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s50-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false })

describe('F1: agy takes a model', () => {
  it('passes --model before the prompt flag', () => {
    const a = makeAgent('x', { name: 'x', adapter: 'agy', extraArgs: '', model: 'gemini-3.5-pro' })
    const b = buildCommand(a)
    const i = b.args.indexOf('--model')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(b.args[i + 1]).toBe('gemini-3.5-pro')
    expect(b.args.indexOf('-p')).toBeGreaterThan(i)
  })
  it('no model → no flag', () => {
    expect(buildCommand(makeAgent('x', { name: 'x', adapter: 'agy', extraArgs: '' })).args).not.toContain('--model')
  })
})

describe('F2: account model list', () => {
  it('reads slugs from plain, bulleted and described lines; skips headings', () => {
    const text = 'Available models:\n  gemini-3.5-pro  Gemini 3.5 Pro\n- gemini-3.5-flash (fast)\n* claude-sonnet-4-5\n\nDone\n'
    expect(parseModelList(text).map((m) => m.slug)).toEqual(['gemini-3.5-pro', 'gemini-3.5-flash', 'claude-sonnet-4-5'])
    expect(parseModelList(text)[0].label).toBe('Gemini 3.5 Pro')
    expect(parseModelList('')).toEqual([])
  })
  it('guesses the tier from the name; entries are marked verified by the account', () => {
    expect(tierOfSlug('gemini-3.5-flash')).toBe('light')
    expect(tierOfSlug('gemini-3.5-pro')).toBe('top')
    const [e] = accountEntries('agy', [{ slug: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' }], '2026-10-18T00:00:00Z')
    expect(e).toMatchObject({ id: 'acct-agy-gemini-3.5-pro', adapter: 'agy', cliArg: 'gemini-3.5-pro', fromAccount: true })
    expect(e.verified?.at).toBe('2026-10-18')
  })
  it('refreshing asks `agy models`, adds the models to the catalog and marks them usable', async () => {
    const calls: string[][] = []
    const runner: Runner = async (b) => (calls.push([b.command, ...b.args]), ok('gemini-3.5-pro  Gemini 3.5 Pro\nmystery-model-9\n'))
    const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
    const before = eng.catalog().find((m) => m.cliArg === 'gemini-3.5-pro')!
    expect(before.verified).toBeUndefined() // bundled but unconfirmed
    const r = await eng.refreshAccountModels('agy')
    expect(r).toMatchObject({ ok: true, count: 2 })
    expect(calls[0]).toEqual(['agy', 'models'])
    const cat = eng.catalog()
    expect(cat.find((m) => m.id === 'acct-agy-mystery-model-9')).toMatchObject({ adapter: 'agy', fromAccount: true })
    const g35 = cat.find((m) => m.adapter === 'agy' && m.cliArg === 'gemini-3.5-pro')!
    expect(g35.adapter).toBe('agy')
    expect(eng.snapshot().company.availability[g35.id]?.ok).toBe(true)
    expect(eng.snapshot().company.availability['acct-agy-mystery-model-9'].ok).toBe(true)
    eng.shutdown()
  })
  it('a CLI without a list command or a failing command changes nothing', async () => {
    const eng = new Engine(join(dir, 'c.json'), () => {}, async () => ({ code: 1, stdout: '', stderr: 'not logged in', timedOut: false, aborted: false }), dir)
    expect((await eng.refreshAccountModels('claude')).ok).toBe(false)
    const r = await eng.refreshAccountModels('agy')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('로그인')
    expect(eng.catalog().some((m) => m.fromAccount)).toBe(false)
    eng.shutdown()
  })
  it('the bundled catalog has the Gemini 3.5 entries, unconfirmed, and confirmed Claude entries', () => {
    const eng = new Engine(join(dir, 'c.json'), () => {}, async () => ok(''), dir)
    const cat = eng.catalog()
    expect(cat.find((m) => m.id === 'google-gemini-3-5-flash')?.verified).toBeUndefined()
    expect(cat.find((m) => m.id === 'claude-opus-5-5')?.verified).toBeDefined()
    eng.shutdown()
  })
})

describe('F4: a connection check covers every agent on that connection, also ones made later', () => {
  it('shows the last check on an agent created after the check', () => {
    const eng = new Engine(join(dir, 'c.json'), () => {}, async () => ok(''), dir)
    eng.recordCheck('claude', { ok: true, message: '연결됐어요: OK' })
    const a = eng.saveAgent({ name: 'late', adapter: 'claude' })
    const r = eng.snapshot().roster.find((x) => x.id === a.id)!
    expect(r.check).toMatchObject({ ok: true })
    // a different connection is not affected
    const b = eng.saveAgent({ name: 'other', adapter: 'codex' })
    expect(eng.snapshot().roster.find((x) => x.id === b.id)!.check).toBeUndefined()
    eng.shutdown()
  })
})
