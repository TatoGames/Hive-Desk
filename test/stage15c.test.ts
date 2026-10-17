import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner, RunResult } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { SHARED_PATCH_MAX, dependencyText } from '../src/main/runner'
import type { Agent, Task } from '../src/shared/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s15c-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = '[[DID: 로그인 화면 수정]]\n[[FILES: src/login.ts]]\n[[VERIFY: npm test]]\n[[RISK: none]]\n[[NEXT: none]]'
const ok = (stdout = 'done\n' + REPORT): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false })

function engine(runner: Runner): Engine {
  const eng = new Engine(join(dir, 'config.json'), () => {}, runner, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'off' })
  eng.watchMs = 30
  return eng
}
function folder(name: string): string {
  const w = join(dir, name)
  mkdirSync(w, { recursive: true })
  return w
}
function agent(eng: Engine, workDir: string, name = 'dev'): Agent {
  return eng.saveAgent({ name, adapter: 'claude', workDir })
}
const promptOf = (eng: Engine, taskId: string): string =>
  eng.runDetail(taskId, eng.hive.getTask(taskId)!.lastRunId!)!.prompt

describe('D1/D2: projects and fixed briefing', () => {
  it('the briefing, fixed memory and recent memory all reach the prompt', async () => {
    const eng = engine(async () => ok())
    const a = agent(eng, folder('w'))
    const p = eng.saveProject({ name: '타토 게임', briefing: '규칙: 한국어 주석, pnpm 사용' })
    eng.addMemory('절대 main에 직접 푸시하지 않는다', 'fixed')
    eng.addMemory('오늘은 UI 작업 중')
    const t = eng.createTask({ title: 'x', assignee: a.id, projectId: p.id })
    await eng.runTask(t.id)
    const prompt = promptOf(eng, t.id)
    expect(prompt).toContain('Project: 타토 게임')
    expect(prompt).toContain('한국어 주석, pnpm 사용')
    expect(prompt).toContain('절대 main에 직접 푸시하지 않는다')
    expect(prompt).toContain('오늘은 UI 작업 중')
    eng.shutdown()
  })

  it('fixed memory stays in the prompt even when many newer entries push it out of "recent"', async () => {
    const eng = engine(async () => ok())
    const a = agent(eng, folder('w'))
    eng.addMemory('고정 규칙 하나', 'fixed')
    for (let i = 0; i < 30; i++) eng.addMemory('잡담 ' + i)
    const t = eng.createTask({ title: 'x', assignee: a.id })
    await eng.runTask(t.id)
    const prompt = promptOf(eng, t.id)
    expect(prompt).toContain('고정 규칙 하나')
    expect(prompt).not.toContain('잡담 0\n')
    expect(prompt).toContain('잡담 29')
    eng.shutdown()
  })

  it('an entry can be pinned and unpinned', () => {
    const eng = engine(async () => ok())
    eng.addMemory('a')
    const id = eng.hive.listMemory()[0].id
    eng.setMemoryKind(id, 'fixed')
    expect(eng.hive.memoryForPrompt().fixed.map((m) => m.text)).toEqual(['a'])
    eng.setMemoryKind(id, 'recent')
    expect(eng.hive.memoryForPrompt().fixed).toEqual([])
    eng.shutdown()
  })

  it('deleting a project detaches its tasks', () => {
    const eng = engine(async () => ok())
    const p = eng.saveProject({ name: 'p' })
    const t = eng.createTask({ title: 'x', projectId: p.id })
    eng.deleteProject(p.id)
    expect(eng.hive.getTask(t.id)!.projectId).toBeUndefined()
    expect(eng.hive.listProjects()).toEqual([])
    eng.shutdown()
  })
})

describe('E2: the project folder is mapped per computer', () => {
  it('the run happens in this computer\'s folder for the project, not the agent\'s', async () => {
    const seen: string[] = []
    const eng = engine(async (_c, o) => {
      seen.push(o.cwd)
      return ok()
    })
    const agentDir = folder('agent-dir')
    const projDir = folder('proj-dir')
    const a = agent(eng, agentDir)
    const p = eng.saveProject({ name: 'p', folderName: 'tato-game' })
    const t = eng.createTask({ title: 'x', assignee: a.id, projectId: p.id })
    // no mapping yet on this computer → falls back to the agent's folder, and preflight says so
    const pre = await eng.preflight(t.id)
    expect(pre.items.some((i) => i.text.includes('이 컴퓨터에 설정돼 있지 않아요'))).toBe(true)
    await eng.runTask(t.id)
    eng.setProjectPath(p.id, projDir)
    const t2 = eng.createTask({ title: 'y', assignee: a.id, projectId: p.id })
    await eng.runTask(t2.id)
    expect(seen[0]).toBe(agentDir)
    expect(seen[1]).toBe(projDir)
    eng.shutdown()
  })

  it('the shared project file has the name but no path; the path is local-only', () => {
    const eng = engine(async () => ok())
    const p = eng.saveProject({ name: 'p', folderName: 'tato-game' })
    eng.setProjectPath(p.id, '/Users/minu/tato')
    const shared = readFileSync(join(eng.hive.root, 'projects', p.id + '.json'), 'utf8')
    expect(shared).toContain('tato-game')
    expect(shared).not.toContain('/Users/minu')
    expect(existsSync(join(eng.hive.root, '.local', 'paths.json'))).toBe(true)
    eng.shutdown()
  })

  it('two tasks on different computers\' paths of one project share the folder lock key by path', async () => {
    let active = 0
    let max = 0
    const eng = engine(async () => {
      active++
      max = Math.max(max, active)
      await new Promise((r) => setTimeout(r, 60))
      active--
      return ok()
    })
    const shared = folder('shared')
    const a = agent(eng, folder('a1'), 'one')
    const b = agent(eng, folder('a2'), 'two')
    const p = eng.saveProject({ name: 'p' })
    eng.setProjectPath(p.id, shared)
    const t1 = eng.createTask({ title: '1', assignee: a.id, projectId: p.id })
    const t2 = eng.createTask({ title: '2', assignee: b.id, projectId: p.id })
    await Promise.all([eng.runTask(t1.id), eng.runTask(t2.id)])
    expect(max).toBe(1)
    eng.shutdown()
  })
})

describe('D3: dependents get the structured report, not a cut-off result', () => {
  const task = (over: Partial<Task>): Task => ({
    id: 'x', title: 't', description: '', assignee: null, status: 'done', risky: false, dependsOn: [],
    createdBy: 'a', createdAt: '', updatedAt: '', cleared: [], notes: [], ...over
  })

  it('uses the report when there is one', () => {
    const text = dependencyText(
      task({ result: 'x'.repeat(9000), report: { did: '다 했어요', files: 'a.ts', verify: 'npm test', risks: 'none', next: 'none' } })
    )
    expect(text).toContain('Did: 다 했어요')
    expect(text).toContain('Files: a.ts')
    expect(text).not.toContain('xxxx')
    expect(text).not.toContain('Risks')
  })

  it('keeps risks when the report names some', () => {
    expect(dependencyText(task({ report: { did: 'd', files: 'f', verify: 'v', risks: '캐시가 오래될 수 있어요', next: 'none' } }))).toContain('Risks: 캐시')
  })

  it('without a report, a long result is cut and says so', () => {
    const text = dependencyText(task({ result: 'y'.repeat(5000) }))
    expect(text.length).toBeLessThan(1700)
    expect(text).toContain('no structured report')
  })

  it('reaches the next task\'s prompt end to end', async () => {
    const eng = engine(async () => ok('긴 잡담 '.repeat(500) + '\n' + REPORT))
    const a = agent(eng, folder('w'))
    const t1 = eng.createTask({ title: '먼저', assignee: a.id })
    await eng.runTask(t1.id)
    const t2 = eng.createTask({ title: '다음', assignee: a.id, dependsOn: [t1.id] })
    await eng.runTask(t2.id)
    const prompt = promptOf(eng, t2.id)
    expect(prompt).toContain('Did: 로그인 화면 수정')
    expect(prompt).toContain('Files: src/login.ts')
    eng.shutdown()
  })
})

describe('E1: shared run summaries', () => {
  it('a finished run leaves a summary in the shared reports folder', async () => {
    const eng = engine(async (_c, o) => {
      writeFileSync(join(o.cwd, 'new.txt'), 'hello\n')
      return ok()
    })
    const a = agent(eng, folder('w'))
    const t = eng.createTask({ title: 'x', assignee: a.id })
    await eng.runTask(t.id)
    const runs = eng.sharedRuns(t.id)
    expect(runs).toHaveLength(1)
    expect(runs[0].machine).toBe('alice')
    expect(runs[0].outcome).toBe('done')
    expect(runs[0].report?.did).toBe('로그인 화면 수정')
    expect(runs[0].diffStat.files).toBeGreaterThanOrEqual(1)
    expect(runs[0].files.some((f) => f.path === 'new.txt')).toBe(true)
    eng.shutdown()
  })

  it('a huge answer stays local; the summary still has the numbers', async () => {
    const big = 'z'.repeat(SHARED_PATCH_MAX + 10)
    const eng = engine(async () => ok(big + '\n' + REPORT))
    const a = agent(eng, folder('w'))
    const t = eng.createTask({ title: 'x', assignee: a.id })
    await eng.runTask(t.id)
    const [r] = eng.sharedRuns(t.id)
    expect(r.response).toBeUndefined()
    expect(r.report?.did).toBe('로그인 화면 수정')
    eng.shutdown()
  })

  it('deleting a task removes its shared summaries', async () => {
    const eng = engine(async () => ok())
    const a = agent(eng, folder('w'))
    const t = eng.createTask({ title: 'x', assignee: a.id })
    await eng.runTask(t.id)
    eng.deleteTask(t.id)
    expect(eng.sharedRuns(t.id)).toEqual([])
    eng.shutdown()
  })
})

describe('E3: hand edits are appended as events', () => {
  it('changes of assignee / title / permission are logged, unchanged fields are not', () => {
    const eng = engine(async () => ok())
    const a = agent(eng, folder('w'))
    const t = eng.createTask({ title: '처음 제목' })
    eng.updateTask(t.id, { title: '새 제목', assignee: a.id, permission: 'read' })
    eng.updateTask(t.id, { title: '새 제목' })
    const ev = eng.taskHistory(t.id).events.filter((e) => e.kind === 'changed')
    expect(ev.map((e) => e.text).join('|')).toContain('제목을(를) 바꿨어요: 처음 제목 → 새 제목')
    expect(ev.some((e) => e.text.startsWith('담당'))).toBe(true)
    expect(ev.some((e) => e.text.startsWith('권한'))).toBe(true)
    expect(ev).toHaveLength(3)
    eng.shutdown()
  })
})

describe('F2: roster shows the last connection check', () => {
  it('a check result is published on the roster entry and survives republishing', () => {
    const eng = engine(async () => ok())
    const a = agent(eng, folder('w'))
    expect(eng.hive.listRoster()[0].check).toBeUndefined()
    eng.recordCheck('claude', { ok: false, message: '로그인이 필요해요' })
    const r = eng.hive.listRoster().find((x) => x.id === a.id)!
    expect(r.check?.ok).toBe(false)
    expect(r.check?.message).toBe('로그인이 필요해요')
    eng.saveAgent({ ...a, role: '개발' }) // republish must not drop the check
    expect(eng.hive.listRoster().find((x) => x.id === a.id)!.check?.ok).toBe(false)
    eng.recordCheck('claude', { ok: true, message: 'ok' })
    expect(eng.hive.listRoster().find((x) => x.id === a.id)!.check?.ok).toBe(true)
    eng.shutdown()
  })
})
