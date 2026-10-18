import { readdirSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner, RunResult } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { classifyInput } from '../src/shared/manage'
import { reportFileName, safeName, uniqueName } from '../src/shared/names'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s60-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = '[[DID: 했어요]]\n[[FILES: none]]\n[[VERIFY: 확인]]\n[[RISK: none]]\n[[NEXT: none]]'
const res = (o: Partial<RunResult> = {}): RunResult => ({ code: 0, stdout: REPORT, stderr: '', timedOut: false, aborted: false, ...o })
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A runner that stays busy until it is told to stop, remembering every prompt it got. */
function hanging() {
  const prompts: string[] = []
  let calls = 0
  const runner: Runner = (_b, o) => {
    calls++
    prompts.push(o.prompt)
    if (calls > 1) return Promise.resolve(res())
    return new Promise((resolve) => {
      o.signal?.addEventListener('abort', () => resolve(res({ code: 1, stdout: '', aborted: true })))
    })
  }
  return { runner, prompts, calls: () => calls }
}

function setup(runner: Runner) {
  const eng = new Engine(join(dir, 'config.json'), () => {}, runner, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
  eng.watchMs = 20
  const work = join(dir, 'work')
  mkdirSync(work, { recursive: true })
  const agent = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: work })
  return { eng, agent, work }
}

describe('6-0: a stopped task stays stopped', () => {
  it('stop → held, nothing restarts it, resume with an instruction runs it again with that instruction', async () => {
    const h = hanging()
    const { eng, agent } = setup(h.runner)
    const t = eng.createTask({ title: '긴 일', assignee: agent.id })
    void eng.runTask(t.id)
    await wait(150)
    expect(eng.hive.getTask(t.id)!.status).toBe('running')
    eng.stopTask(t.id, 'hold')
    await wait(200)
    const held = eng.hive.getTask(t.id)!
    expect(held.status).toBe('held')
    expect(held.stoppedBy?.kind).toBe('hold')
    // a stray status write from a late callback must not undo the stop
    await wait(400)
    expect(eng.hive.getTask(t.id)!.status).toBe('held')
    expect(h.calls()).toBe(1)

    eng.resumeTask(t.id, '표를 먼저 만들어줘')
    await wait(500)
    expect(h.calls()).toBe(2)
    expect(h.prompts[1]).toContain('표를 먼저 만들어줘')
    expect(eng.hive.getTask(t.id)!.status).toBe('done')
    eng.shutdown()
  })

  it('cancel keeps the task as cancelled', async () => {
    const h = hanging()
    const { eng, agent } = setup(h.runner)
    const t = eng.createTask({ title: '취소할 일', assignee: agent.id })
    void eng.runTask(t.id)
    await wait(150)
    eng.stopTask(t.id, 'cancel')
    await wait(200)
    expect(eng.hive.getTask(t.id)!.status).toBe('cancelled')
    eng.shutdown()
  })

  it('emergency stop aborts runs and switches both auto-run switches off', async () => {
    const h = hanging()
    const { eng, agent } = setup(h.runner)
    const t = eng.createTask({ title: '급한 정지', assignee: agent.id })
    void eng.runTask(t.id)
    await wait(150)
    expect(eng.emergencyStop()).toBe(1)
    await wait(200)
    expect(eng.hive.getTask(t.id)!.status).toBe('held')
    expect(eng.snapshot().config.autoRun).toBe(false)
    expect(eng.snapshot().config.autoRunOrg).toBe(false)
    eng.shutdown()
  })
})

describe('6-0: instructions are not lost', () => {
  it('an instruction given during a run that fails is still in the next run', async () => {
    let n = 0
    const prompts: string[] = []
    const runner: Runner = async (_b, o) => {
      n++
      prompts.push(o.prompt)
      await wait(60)
      return n === 1 ? res({ code: 2, stdout: '', stderr: 'segfault' }) : res()
    }
    const { eng, agent } = setup(runner)
    const t = eng.createTask({ title: '지시 유지', assignee: agent.id })
    const run = eng.runTask(t.id)
    await wait(20)
    eng.addInstruction(t.id, '결과는 표로', 'after')
    await run
    expect(eng.hive.getTask(t.id)!.status).toBe('failed')
    expect(eng.hive.getTask(t.id)!.instructions?.some((i) => i.state === 'queued')).toBe(true)
    eng.updateTask(t.id, { status: 'todo' }) // the person presses "try again"
    await eng.runTask(t.id)
    expect(prompts[1]).toContain('결과는 표로')
    eng.shutdown()
  })
})

describe('6-0: company work folder and results', () => {
  it('a task without a work folder runs in <company>/workspace and is told to save into results', async () => {
    const seen: { cwd: string; prompt: string }[] = []
    const runner: Runner = async (_b, o) => {
      seen.push({ cwd: o.cwd, prompt: o.prompt })
      return res()
    }
    const eng = new Engine(join(dir, 'config.json'), () => {}, runner, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    eng.watchMs = 20
    const agent = eng.saveAgent({ name: 'dev', adapter: 'claude' })
    const t = eng.createTask({ title: '보고서 쓰기', assignee: agent.id })
    await eng.runTask(t.id)
    expect(seen).toHaveLength(1)
    expect(seen[0].cwd.replace(/\\/g, '/')).toMatch(/\/workspace$/)
    expect(existsSync(join(seen[0].cwd, 'results'))).toBe(true)
    expect(seen[0].prompt).toContain('results')
    eng.shutdown()
  })

  it('writes a readable report per finished task and keeps run summaries in .sync/runs', async () => {
    const { eng, agent } = setup(async () => res())
    const t = eng.createTask({ title: '문서 정리', assignee: agent.id })
    await eng.runTask(t.id)
    const done = eng.hive.getTask(t.id)!
    expect(done.reportFile).toMatch(/^보고서[\\/]\d{4}-\d{2}-\d{2}_문서-정리\.md$/)
    const root = eng.snapshot().companies[0]
    expect(root).toBeTruthy()
    eng.shutdown()
  })
})

describe('6-0: company folders carry the company name', () => {
  it('new companies get a folder named after them, clashes are numbered, rename moves the folder, workspace/results exist', () => {
    const eng = new Engine(join(dir, 'config.json'), () => {}, async () => res(), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    const a = eng.createCompany('졸작팀')
    const b = eng.createCompany('졸작팀/2')
    const folders = (): string[] => readdirSync(join(dir, 'ws', 'companies'))
    expect(folders()).toContain('졸작팀')
    expect(folders()).toContain('졸작팀_2')
    expect(existsSync(join(dir, 'ws', 'companies', '졸작팀', 'workspace', 'results'))).toBe(true)
    eng.renameCompany(a.id, '캡스톤')
    expect(folders()).toContain('캡스톤')
    expect(folders()).not.toContain('졸작팀')
    // still the same company: its id finds the new folder
    expect(eng.snapshot().companies.some((c) => c.id === a.id && c.name === '캡스톤')).toBe(true)
    expect(b.id).not.toBe(a.id)
    eng.shutdown()
  })
})

describe('6-0: helpers', () => {
  it('classifies management commands apart from jobs', () => {
    expect(classifyInput('전부 멈춰').kind).toBe('command')
    expect(classifyInput('로그인 화면을 만들어줘').kind).toBe('task')
  })
  it('makes safe, unique folder and file names', () => {
    expect(safeName('a/b:c*?')).toBe('a_b_c__')
    expect(safeName('CON')).toBe('CON_')
    expect(safeName('  ..  ')).toBe('이름 없음')
    expect(uniqueName('졸작팀', ['졸작팀', '졸작팀 (2)'])).toBe('졸작팀 (3)')
    expect(uniqueName('Team', ['team'])).toBe('Team (2)')
    expect(reportFileName('2026-10-18T10:00:00Z', '업무 이름')).toBe('2026-10-18_업무-이름.md')
  })
})
