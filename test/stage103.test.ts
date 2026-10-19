import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { clearSnapshotCache, folderSnapshot, folderTree, projectFacts, recentWork } from '../src/main/snapshot'
import type { Task } from '../src/shared/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s103-'))
  clearSnapshotCache()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function project(): string {
  const w = join(dir, 'app')
  mkdirSync(join(w, 'src', 'main'), { recursive: true })
  mkdirSync(join(w, 'node_modules', 'big'), { recursive: true })
  mkdirSync(join(w, '.git'))
  writeFileSync(join(w, 'node_modules', 'big', 'x.js'), 'x')
  writeFileSync(join(w, 'src', 'main', 'index.ts'), 'a')
  writeFileSync(join(w, 'src', 'util.ts'), 'a')
  writeFileSync(join(w, 'README.md'), '# 계산기\n\n![badge](x.png)\n덧셈 뺄셈을 하는 앱\n')
  writeFileSync(join(w, 'package.json'), JSON.stringify({ name: 'calc', description: '작은 계산기', scripts: { test: 'vitest', build: 'vite build', postinstall: 'x' }, dependencies: { electron: '^33', react: '^18' }, devDependencies: { vitest: '^2' } }))
  return w
}

describe('the project snapshot (made by the app, no AI)', () => {
  it('tree: folders first with file counts, heavy folders left out', () => {
    const { lines, files } = folderTree(project())
    const text = lines.join('\n')
    expect(text).toContain('src/  (2 files)')
    expect(text).not.toContain('node_modules')
    expect(text).not.toContain('.git')
    expect(files).toBe(4)
  })

  it('facts: kind, scripts that matter, main dependencies', () => {
    const f = projectFacts(project()).join('\n')
    expect(f).toContain('Electron app')
    expect(f).toContain('React')
    expect(f).toContain('test = vitest')
    expect(f).toContain('build = vite build')
    expect(f).not.toContain('postinstall')
  })

  it('snapshot: README without badges, kept short; an empty folder gives nothing', () => {
    const s = folderSnapshot(project())
    expect(s).toContain('덧셈 뺄셈을 하는 앱')
    expect(s).not.toContain('badge')
    expect(s.length).toBeLessThan(3300)
    const empty = join(dir, 'empty')
    mkdirSync(empty)
    expect(folderSnapshot(empty)).toBe('')
  })

  it('recent work: newest finished tasks of the same project only', () => {
    const mk = (id: string, projectId: string, at: string, did: string): Task => ({ id, title: id, status: 'done', projectId, finishedAt: at, report: { did, files: '', verify: '', risks: '', next: '' } }) as unknown as Task
    const list = [mk('a', 'p1', '2026-01-01', '첫 일'), mk('b', 'p1', '2026-01-03', '셋째 일'), mk('c', 'p2', '2026-01-04', '다른 프로젝트'), mk('self', 'p1', '2026-01-05', '자기 자신')]
    expect(recentWork(list, 'p1', 'self')).toEqual(['- b: 셋째 일', '- a: 첫 일'])
    expect(recentWork(list, undefined, 'self')).toEqual([])
  })
})

describe('the prompt carries the snapshot; the setting turns it off; reviewers do not get it', () => {
  it('a worker sees structure and scripts; with the setting off it does not', async () => {
    const w = project()
    const prompts: string[] = []
    const runner: Runner = async (_b, o) => (prompts.push(o.prompt), { code: 0, stdout: '[[DID: ok]]', stderr: '', timedOut: false, aborted: false })
    const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'off' })
    const a = eng.saveAgent({ name: '가', adapter: 'claude', workDir: w, modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    const t = eng.createTask({ title: '일 하나', assignee: a.id })
    await eng.runTask(t.id)
    expect(prompts[0]).toContain('## Project snapshot')
    expect(prompts[0]).toContain('Electron app')
    expect(prompts[0]).toContain('src/  (2 files)')
    clearSnapshotCache()
    eng.saveSettings({ projectSnapshot: false })
    const t2 = eng.createTask({ title: '일 둘', assignee: a.id })
    await eng.runTask(t2.id)
    expect(prompts[1]).not.toContain('## Project snapshot')
    eng.shutdown()
  })
})
