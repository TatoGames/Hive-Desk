import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { freeName } from '../src/shared/team'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s91-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const idle: Runner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false })

function setup(connected = true): Engine {
  const eng = new Engine(join(dir, 'c.json'), () => {}, idle, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
  if (connected) {
    const at = new Date().toISOString()
    eng.machine.saveModelAgents([
      { id: 'ma-claude-claude-opus-5-5', adapter: 'claude', modelId: 'claude-opus-5-5', createdAt: at },
      { id: 'ma-claude-claude-sonnet-5-5', adapter: 'claude', modelId: 'claude-sonnet-5-5', createdAt: at },
      { id: 'ma-codex-openai-gpt-6-1-sol', adapter: 'codex', modelId: 'openai-gpt-6-1-sol', createdAt: at },
      { id: 'ma-codex-openai-gpt-6-astra', adapter: 'codex', modelId: 'openai-gpt-6-astra', createdAt: at }
    ])
  }
  return eng
}

describe('v0.6: no more silent duplicates', () => {
  it('a new employee with a taken name becomes "name 2" instead of replacing the first', () => {
    const eng = setup()
    const a = eng.saveAgent({ name: '민수', adapter: 'claude' })
    const b = eng.saveAgent({ name: '민수', adapter: 'codex' })
    expect(a.id).not.toBe(b.id)
    expect(b.name).toBe('민수 2')
    expect(eng.agentsOf(eng.hive.id).map((x) => x.adapter).sort()).toEqual(['claude', 'codex'])
    // editing keeps the name
    expect(eng.saveAgent({ ...a, role: '개발' }).name).toBe('민수')
    expect(freeName('x', (n) => n === 'x' || n === 'x 2')).toBe('x 3')
    eng.shutdown()
  })
})

describe('v0.6: a whole team in one go', () => {
  it('one click: the org chart of a template with every seat filled by a connected AI', () => {
    const eng = setup()
    const r = eng.quickTeam('team-project')
    expect(r.seats).toBeGreaterThan(2)
    expect(r.hired).toBe(r.seats - r.missing)
    expect(r.hired).toBeGreaterThan(0)
    const seats = eng.hive.listSeats()
    expect(seats.filter((s) => s.agentId).length).toBe(r.hired)
    // reviewers sit on a different model than the workers they check (the placement rules hold)
    expect(new Set(eng.agentsOf(eng.hive.id).map((a) => a.adapter)).size).toBe(2)
    eng.shutdown()
  })

  it('says what to do when no AI is connected', () => {
    const eng = setup(false)
    expect(() => eng.quickTeam('team-project')).toThrow('연결된 AI가 없어요')
    eng.shutdown()
  })

  it('a team saved in one company is set up again in another: same employees on the same seats', () => {
    const eng = setup()
    eng.quickTeam('team-project')
    const before = eng.hive.listSeats().map((s) => [s.title, eng.agentsOf(eng.hive.id).find((a) => a.id === s.agentId)?.name ?? null])
    const saved = eng.saveTeam('우리 기본 팀')
    expect(saved).toMatchObject({ name: '우리 기본 팀', members: before.filter(([, n]) => n).length })
    expect(eng.listTeams().map((t) => t.name)).toEqual(['우리 기본 팀'])

    const other = eng.createCompany('두 번째 회사')
    eng.switchCompany(other.id)
    expect(eng.agentsOf(eng.hive.id)).toEqual([])
    const r = eng.applyTeam(saved.id)
    expect(r.skipped).toEqual([])
    const after = eng.hive.listSeats().map((s) => [s.title, eng.agentsOf(eng.hive.id).find((a) => a.id === s.agentId)?.name ?? null])
    expect(after).toEqual(before)
    // they are new employees of this company, not the first company's
    expect(eng.agentsOf(eng.hive.id).every((a) => a.companyId === other.id)).toBe(true)

    // saving under the same name replaces the older one
    eng.saveTeam('우리 기본 팀')
    expect(eng.listTeams().length).toBe(1)
    eng.deleteTeam(eng.listTeams()[0].id)
    expect(eng.listTeams()).toEqual([])
    eng.shutdown()
  })

  it('employees of another company can be copied over', () => {
    const eng = setup()
    const first = eng.hive.id
    const a = eng.saveAgent({ name: '지아', adapter: 'codex', role: '테스트 담당', timeoutMinutes: 30 })
    const other = eng.createCompany('B')
    eng.switchCompany(other.id)
    expect(eng.copyAgents(first, [a.id])).toBe(1)
    const copy = eng.agentsOf(other.id)[0]
    expect(copy).toMatchObject({ name: '지아', role: '테스트 담당', timeoutMinutes: 30, companyId: other.id })
    expect(copy.id).not.toBe(a.id)
    eng.shutdown()
  })
})
