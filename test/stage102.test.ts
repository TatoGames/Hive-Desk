import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s102-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const idle: Runner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false })
const mk = (): Engine => {
  const eng = new Engine(join(dir, 'c.json'), () => {}, idle, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
  return eng
}

describe('the first task goes to the folder the person picked', () => {
  it('a project is made for the folder and reused the next time; no folder = the company folder', () => {
    const eng = mk()
    const f = join(dir, 'my-app')
    mkdirSync(f)
    const a = eng.startFirstTask('단위 변환기를 만들어줘. 길이와 무게를 바꿔 줘.', f)
    expect(a.ok).toBe(true)
    expect(a.dir).toBe(f)
    const t = eng.hive.getTask(a.id!)!
    expect(t.title).toBe('단위 변환기를 만들어줘')
    expect(eng.hive.projectDir(t.projectId)).toBe(f)
    expect(eng.hive.getProject(t.projectId)?.name).toBe('my-app')
    const b = eng.startFirstTask('README를 고쳐줘', f)
    expect(eng.hive.getTask(b.id!)!.projectId).toBe(t.projectId)
    expect(eng.hive.listProjects().length).toBe(1)
    const c = eng.startFirstTask('폴더 없이 시작')
    expect(eng.hive.getTask(c.id!)!.projectId).toBeUndefined()
    expect(c.dir).toBe(eng.hive.ensureWorkspace())
    eng.shutdown()
  })

  it('a folder another company already uses is refused with the reason, and no project is left behind', () => {
    const eng = mk()
    const f = join(dir, 'shared')
    mkdirSync(f)
    expect(eng.startFirstTask('첫 회사 일', f).ok).toBe(true)
    const other = eng.createCompany('두 번째 회사')
    eng.switchCompany(other.id)
    const r = eng.startFirstTask('두 번째 회사 일', f)
    expect(r.ok).toBe(false)
    expect(r.warning).toContain('이미 쓰이고 있어요')
    expect(eng.hive.listProjects()).toEqual([])
    eng.shutdown()
  })
})

describe('Electron folders get the Electron starting rules', () => {
  it('a folder that depends on electron: the briefing has the rules; a plain folder has none', () => {
    const eng = mk()
    const e = join(dir, 'electron-app')
    mkdirSync(e)
    writeFileSync(join(e, 'package.json'), JSON.stringify({ devDependencies: { electron: '^33' } }))
    const r = eng.startFirstTask('창 하나 띄우는 앱', e)
    expect(r.preset).toBe('Electron 데스크톱 앱')
    const proj = eng.hive.getProject(eng.hive.getTask(r.id!)!.projectId)!
    expect(proj.briefing).toContain('contextIsolation: true')
    expect(proj.briefing).toContain('"typecheck"')
    const p = join(dir, 'plain')
    mkdirSync(p)
    const r2 = eng.startFirstTask('글 쓰기', p)
    expect(r2.preset).toBeUndefined()
    expect(eng.hive.getProject(eng.hive.getTask(r2.id!)!.projectId)!.briefing).toBe('')
    eng.shutdown()
  })
})
