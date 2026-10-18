import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { loadConfig } from '../src/main/config'
import { Engine } from '../src/main/engine'
import { movedPath, recordFolderMove } from '../src/main/workspace'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-up4-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = '[[DID: ok]]\n[[FILES: none]]\n[[VERIFY: ok]]\n[[RISK: none]]\n[[NEXT: none]]'

describe('upgrading to v4', () => {
  it('an old "auto-run off" keeps delegated work moving (organisation switch stays on)', () => {
    const f = join(dir, 'c.json')
    writeFileSync(f, JSON.stringify({ memberName: 'a', workspace: join(dir, 'ws'), autoRun: false, agents: [] }))
    const cfg = loadConfig(f, dir)
    expect(cfg.autoRun).toBe(false)
    expect(cfg.autoRunOrg).toBe(true)
    writeFileSync(f, JSON.stringify({ memberName: 'a', workspace: join(dir, 'ws'), autoRun: false, autoRunOrg: false, agents: [] }))
    expect(loadConfig(f, dir).autoRunOrg).toBe(false)
  })

  it('company folders named by id get the company name at startup; old paths still resolve', () => {
    const ws = join(dir, 'ws')
    const id = 'old-id-123'
    mkdirSync(join(ws, 'companies', id, 'tasks'), { recursive: true })
    writeFileSync(join(ws, 'companies', id, 'meta.json'), JSON.stringify({ id, name: '졸작팀', createdAt: '2026-10-01T00:00:00Z' }))
    const runner: Runner = async () => ({ code: 0, stdout: 'OK', stderr: '', timedOut: false, aborted: false })
    const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
    eng.saveSettings({ memberName: 'a', workspace: ws })
    expect(readdirSync(join(ws, 'companies'))).toEqual(['졸작팀'])
    expect(eng.snapshot().companies.map((c) => c.name)).toEqual(['졸작팀'])
    expect(movedPath(ws, join(ws, 'companies', id, 'workspace', 'a.txt'))).toBe(join(ws, 'companies', '졸작팀', 'workspace', 'a.txt'))
    // renaming follows on
    eng.renameCompany(eng.snapshot().companies[0].id, '졸업작품')
    expect(existsSync(join(ws, 'companies', '졸업작품', 'meta.json'))).toBe(true)
    expect(movedPath(ws, join(ws, 'companies', id))).toBe(join(ws, 'companies', '졸업작품'))
    eng.shutdown()
  })

  it('movedPath leaves unrelated paths alone', () => {
    const ws = join(dir, 'ws2')
    recordFolderMove(ws, join(ws, 'companies', 'a'), join(ws, 'companies', 'A팀'))
    expect(movedPath(ws, join(ws, 'companies', 'ab', 'x'))).toBe(join(ws, 'companies', 'ab', 'x'))
    expect(movedPath(join(dir, 'none'), '/x/y')).toBe('/x/y')
  })

  it('"hand it over" from the quick assignment starts the run at once, even with auto-run off', async () => {
    let runs = 0
    const runner: Runner = async (_b, o) => {
      if (o.prompt.includes('connection check')) return { code: 0, stdout: 'OK', stderr: '', timedOut: false, aborted: false }
      runs++
      return { code: 0, stdout: REPORT, stderr: '', timedOut: false, aborted: false }
    }
    const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
    eng.saveSettings({ memberName: 'a', workspace: join(dir, 'ws3') })
    eng.saveSettings({ autoRun: false, autoRunOrg: false })
    const ag = eng.saveAgent({ name: 'writer', adapter: 'claude' })
    const t = eng.quickAssign({ title: '한 줄 소개 쓰기', agentId: ag.id })
    for (let i = 0; i < 50 && runs === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(runs).toBe(1)
    for (let i = 0; i < 50 && eng.snapshot().tasks.find((x) => x.id === t.id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 20))
    expect(['done', 'needs_review', 'in_review']).toContain(eng.snapshot().tasks.find((x) => x.id === t.id)?.status)
    eng.shutdown()
  })
})
