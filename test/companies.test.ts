import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { Hive } from '../src/main/hive'
import { initSync } from '../src/main/sync'
import { isLegacyLayout, listCompanyMetas, migrateLegacy } from '../src/main/workspace'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s51-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = '[[DID: 했어요]]\n[[FILES: none]]\n[[VERIFY: 확인]]\n[[RISK: none]]\n[[NEXT: none]]'
function recorder() {
  const prompts: { cwd: string; prompt: string }[] = []
  const runner: Runner = async (_b, o) => {
    prompts.push({ cwd: o.cwd, prompt: o.prompt })
    await new Promise((r) => setTimeout(r, 30))
    return { code: 0, stdout: REPORT, stderr: '', timedOut: false, aborted: false }
  }
  return { prompts, runner }
}

/** A workspace written the way v0.2.0 did: the hive's folders directly in the workspace. */
function legacyWorkspace(ws: string): { taskId: string } {
  const h = new Hive(ws)
  const t = h.createTask({ title: '옛 업무', assignee: 'alice-dev', createdBy: 'alice' })
  h.addMemory('alice', '옛 메모리', 'fixed')
  h.saveCompany({
    id: 'co1', name: '타토 게임즈', templateId: 'blank', ranks: [], rules: { minModelsPerTeam: true, reviewerDiffers: true, ceoTrioDiffers: true },
    bigJobRuns: 20, createdAt: new Date().toISOString()
  } as never)
  writeFileSync(join(ws, '.local', 'marker.txt'), 'x')
  return { taskId: t.id }
}

describe('moving a v0.2 workspace', () => {
  it('becomes the first company; everything is kept; a backup is made', () => {
    const ws = join(dir, 'HiveDesk')
    const { taskId } = legacyWorkspace(ws)
    expect(isLegacyLayout(ws)).toBe(true)
    // the default workspace of an engine started in `dir` is <dir>/HiveDesk
    const e2 = new Engine(join(dir, 'cfg2.json'), () => {}, async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }), dir)
    expect(e2.migration).not.toBeNull()
    const metas = listCompanyMetas(ws)
    expect(metas).toHaveLength(1)
    expect(metas[0].name).toBe('타토 게임즈')
    expect(e2.snapshot().tasks.map((t) => t.id)).toEqual([taskId])
    expect(e2.snapshot().memory[0].text).toBe('옛 메모리')
    expect(e2.snapshot().company.company?.name).toBe('타토 게임즈')
    // the workspace root no longer holds hive folders; the backup has the old layout
    expect(existsSync(join(ws, 'tasks'))).toBe(false)
    expect(existsSync(join(ws, 'migration.json'))).toBe(true)
    const backup = e2.migration!.backup
    expect(existsSync(join(backup, 'tasks'))).toBe(true)
    expect(existsSync(join(backup, '.local', 'marker.txt'))).toBe(true)
    expect(isLegacyLayout(ws)).toBe(false)
    e2.shutdown()
  })

  it('a failure half way puts everything back and keeps the backup', () => {
    const ws = join(dir, 'HiveDesk')
    legacyWorkspace(ws)
    const before = readdirSync(ws).sort()
    let n = 0
    expect(() =>
      migrateLegacy(ws, 'newco', {
        beforeMove: () => {
          if (++n === 3) throw new Error('디스크 오류')
        }
      })
    ).toThrow(/원래대로 되돌렸어요/)
    expect(readdirSync(ws).sort()).toEqual(before)
    expect(existsSync(join(ws, 'companies'))).toBe(false)
    expect(isLegacyLayout(ws)).toBe(true)
    const backups = readdirSync(dir).filter((d) => d.includes('backup-v0.2'))
    expect(backups).toHaveLength(1)
    expect(existsSync(join(dir, backups[0], 'tasks'))).toBe(true)
    expect(new Hive(ws).listTasks()).toHaveLength(1)
  })

  it('an existing git repo moves with the company (its history stays)', () => {
    const ws = join(dir, 'HiveDesk')
    legacyWorkspace(ws)
    execFileSync('git', ['init', '-q'], { cwd: ws })
    execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'add', '-A'], { cwd: ws })
    execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'old'], { cwd: ws })
    const r = migrateLegacy(ws, 'co-x')
    expect(existsSync(join(ws, 'companies', r.companyId, '.git'))).toBe(true)
    expect(existsSync(join(ws, '.git'))).toBe(false)
  })

  it('a fresh start creates one empty company and nothing to migrate', () => {
    const ws = join(dir, 'fresh')
    const eng = new Engine(join(dir, 'c.json'), () => {}, undefined, dir)
    eng.saveSettings({ workspace: ws, memberName: 'alice' })
    expect(eng.migration).toBeNull()
    expect(eng.snapshot().companies).toHaveLength(1)
    expect(listCompanyMetas(ws)).toHaveLength(1)
    eng.shutdown()
  })
})

function twoCompanies() {
  const { prompts, runner } = recorder()
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
  return { eng, a, b, agentA, agentB, wa, wb, prompts }
}

describe('companies are separate', () => {
  it('data is not shared: tasks, memory, messages, projects, roster, organization', () => {
    const { eng, a, b } = twoCompanies()
    expect(eng.snapshot().companies.map((c) => c.active)).toEqual([false, true])
    eng.addMemory('B만의 비밀', 'fixed')
    eng.saveProject({ name: 'B 프로젝트' })
    eng.createTask({ title: 'B 업무' })
    eng.applyTemplate('startup', 'B 회사', false)
    eng.switchCompany(a.id)
    const s = eng.snapshot()
    expect(s.tasks).toEqual([])
    expect(s.memory).toEqual([])
    expect(s.projects).toEqual([])
    expect(s.company.units).toEqual([])
    expect(s.roster.map((r) => r.name)).toEqual(['dev'])
    eng.switchCompany(b.id)
    expect(eng.snapshot().tasks.map((t) => t.title)).toEqual(['B 업무'])
    // each company is its own folder
    const ws = join(dir, 'ws')
    expect(existsSync(join(ws, 'companies', a.id, 'tasks'))).toBe(true)
    expect(readdirSync(join(ws, 'companies', a.id, 'tasks'))).toHaveLength(0)
    expect(readdirSync(join(ws, 'companies', b.id, 'tasks'))).toHaveLength(1)
    eng.shutdown()
  })

  it('employees with the same name get different ids and are only visible in their company', () => {
    const { eng, a, b, agentA, agentB } = twoCompanies()
    expect(agentA.id).not.toBe(agentB.id)
    expect(eng.snapshot().config.agents.map((x) => x.id)).toEqual([agentB.id])
    eng.switchCompany(a.id)
    expect(eng.snapshot().config.agents.map((x) => x.id)).toEqual([agentA.id])
    // renaming the member rebuilds the ids but keeps each employee in its company
    eng.saveSettings({ memberName: 'alice2' })
    expect(eng.snapshot().config.agents).toHaveLength(1)
    eng.switchCompany(b.id)
    expect(eng.snapshot().config.agents).toHaveLength(1)
    expect(eng.snapshot().config.agents[0].id).not.toBe(eng.agentsOf(a.id)[0].id)
    eng.shutdown()
  })

  it("a company's instructions never contain another company's memory, messages or briefing", async () => {
    const { eng, a, b, agentA, agentB, prompts } = twoCompanies()
    eng.addMemory('B-비밀-메모', 'fixed')
    const pb = eng.saveProject({ name: 'B-비밀-프로젝트', briefing: 'B-비밀-브리핑' })
    void pb
    eng.switchCompany(a.id)
    eng.addMemory('A-공개-메모', 'fixed')
    const t = eng.createTask({ title: 'A 일', assignee: agentA.id })
    await eng.runTask(t.id)
    const text = prompts.map((p) => p.prompt).join('\n')
    expect(text).toContain('A-공개-메모')
    expect(text).not.toContain('B-비밀')
    prompts.length = 0
    eng.switchCompany(b.id)
    const t2 = eng.createTask({ title: 'B 일', assignee: agentB.id })
    await eng.runTask(t2.id)
    expect(prompts.map((p) => p.prompt).join('\n')).not.toContain('A-공개-메모')
    eng.shutdown()
  })

  it('runs of both companies at the same time each write to their own company, even when the screen switches', async () => {
    const { eng, a, b, agentA, agentB } = twoCompanies()
    const tb = eng.createTask({ title: 'B 일', assignee: agentB.id })
    eng.switchCompany(a.id)
    const ta = eng.createTask({ title: 'A 일', assignee: agentA.id })
    const pa = eng.runTask(ta.id)
    eng.switchCompany(b.id)
    const pb = eng.runTask(tb.id)
    eng.switchCompany(a.id) // switching back and forth while both run
    eng.switchCompany(b.id)
    await Promise.all([pa, pb])
    const ws = join(dir, 'ws', 'companies')
    const doneIn = (id: string, taskId: string): boolean => {
      const f = join(ws, id, 'tasks', taskId + '.json')
      return existsSync(f) && ['done', 'needs_review'].includes(JSON.parse(readFileSync(f, 'utf8')).status)
    }
    expect(doneIn(a.id, ta.id)).toBe(true)
    expect(doneIn(b.id, tb.id)).toBe(true)
    // nothing of A's run leaked into B's folder and vice versa
    expect(existsSync(join(ws, b.id, 'tasks', ta.id + '.json'))).toBe(false)
    expect(existsSync(join(ws, a.id, 'tasks', tb.id + '.json'))).toBe(false)
    expect(readdirSync(join(ws, a.id, 'events')).length).toBeGreaterThan(0)
    expect(readdirSync(join(ws, b.id, 'events'))).not.toContain(ta.id)
    expect(readdirSync(join(ws, a.id, 'events'))).not.toContain(tb.id)
    eng.shutdown()
  })

  it('auto-run starts ready tasks of every company, sharing one concurrency limit', async () => {
    const { eng, a, b, agentA, agentB } = twoCompanies()
    eng.saveSettings({ autoRun: true, maxConcurrent: 1 })
    const tb = eng.createTask({ title: 'B 일', assignee: agentB.id })
    eng.switchCompany(a.id)
    const ta = eng.createTask({ title: 'A 일', assignee: agentA.id })
    await eng.tick()
    expect(eng.snapshot().running).toHaveLength(1) // not one per company
    for (let i = 0; i < 100 && eng.snapshot().running.length; i++) await new Promise((r) => setTimeout(r, 10))
    await eng.tick()
    for (let i = 0; i < 100 && eng.snapshot().running.length; i++) await new Promise((r) => setTimeout(r, 10))
    const get = (c: string, t: string) => JSON.parse(readFileSync(join(dir, 'ws', 'companies', c, 'tasks', t + '.json'), 'utf8')).status
    expect(['done', 'needs_review']).toContain(get(a.id, ta.id))
    expect(['done', 'needs_review']).toContain(get(b.id, tb.id))
    eng.shutdown()
  })

  it('a usage limit of an account applies to every company', () => {
    const { eng, a, agentA } = twoCompanies()
    ;(eng as unknown as { noteLimit: (a: string, i: unknown) => void }).noteLimit('claude', { until: new Date(Date.now() + 3600e3).toISOString(), message: 'limit', guessed: false })
    eng.switchCompany(a.id)
    expect(eng.limitFor('claude')).toBeDefined()
    expect(Object.keys(eng.snapshot().limits)).toEqual(['claude'])
    void agentA
    eng.shutdown()
  })

  it('the same work folder in two companies is refused until the person confirms', () => {
    const { eng, a, b, wa } = twoCompanies()
    eng.switchCompany(a.id)
    const pa = eng.saveProject({ name: 'A 프로젝트' })
    expect(eng.setProjectPath(pa.id, wa).ok).toBe(true)
    eng.switchCompany(b.id)
    const pb = eng.saveProject({ name: 'B 프로젝트' })
    const r = eng.setProjectPath(pb.id, wa)
    expect(r.ok).toBe(false)
    expect(r.warning).toContain('다른 회사')
    expect(eng.snapshot().projectPaths[pb.id]).toBeUndefined()
    expect(eng.setProjectPath(pb.id, wa, true).ok).toBe(true)
    expect(eng.setProjectPath(pb.id, '').ok).toBe(true)
    eng.shutdown()
  })

  it('each company is its own git repository', async () => {
    const { eng, a, b } = twoCompanies()
    const remote = join(dir, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    eng.switchCompany(a.id)
    expect(eng.snapshot().gitEnabled).toBe(false)
    await initSync(join(dir, 'ws', 'companies', a.id), remote)
    expect(eng.snapshot().gitEnabled).toBe(true)
    eng.switchCompany(b.id)
    expect(eng.snapshot().gitEnabled).toBe(false) // B is not shared
    eng.shutdown()
  })

  it('summaries count each company separately and rename keeps the names unique', () => {
    const { eng, a, b } = twoCompanies()
    eng.createTask({ title: '대기', risky: true })
    const s = eng.snapshot().companies
    expect(s.find((c) => c.id === b.id)).toMatchObject({ open: 1, members: 1, active: true })
    expect(s.find((c) => c.id === a.id)).toMatchObject({ open: 0, members: 1, active: false })
    expect(() => eng.createCompany('B 회사')).toThrow('같은 이름')
    expect(() => eng.renameCompany(a.id, 'B 회사')).toThrow('같은 이름')
    eng.renameCompany(a.id, 'A 회사')
    expect(eng.snapshot().companies.find((c) => c.id === a.id)!.name).toBe('A 회사')
    eng.shutdown()
  })

  it('the choice of company survives a restart; unknown ids fall back to the first company', () => {
    const { eng, a, b } = twoCompanies()
    eng.switchCompany(a.id)
    eng.shutdown()
    const e2 = new Engine(join(dir, 'c.json'), () => {}, undefined, dir)
    expect(e2.snapshot().companies.find((c) => c.active)!.id).toBe(a.id)
    expect(() => e2.switchCompany('nope')).toThrow('없는 회사')
    void b
    e2.shutdown()
  })

  it('a company created from a template starts with that organization and does not touch the other', () => {
    const { eng, a } = twoCompanies()
    const c = eng.createCompany('C 회사', 'startup', false)
    expect(eng.snapshot().company.units.length).toBeGreaterThan(0)
    eng.switchCompany(a.id)
    expect(eng.snapshot().company.units).toEqual([])
    void c
    eng.shutdown()
  })
})
