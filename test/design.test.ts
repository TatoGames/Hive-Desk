import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { DESIGN_DIRECTIONS, designBlock, hasDesign, looksVisual, pickDesign, usedDesigns } from '../src/shared/design'

describe('design directions', () => {
  it('fits the project words and never repeats a sibling project', () => {
    const a = pickDesign({ name: '골목 카페 타이쿤', description: '작은 가게를 키워요' }, [])
    expect(a.key).toBe('retro-print')
    const b = pickDesign({ name: '골목 카페 타이쿤', description: '작은 가게를 키워요' }, [a.key])
    expect(b.key).not.toBe(a.key)
    const all = DESIGN_DIRECTIONS.map((d) => d.key)
    expect(pickDesign({ name: 'x' }, all)).toBeTruthy() // all used: still gives one
  })
  it('reads marks back, and leaves a briefing that already has rules alone', () => {
    const d = DESIGN_DIRECTIONS[0]
    expect(usedDesigns(['a\n' + designBlock(d), 'none'])).toEqual([d.key])
    expect(hasDesign(designBlock(d))).toBe(true)
    expect(hasDesign('디자인 가이드: 흑백만')).toBe(true)
    expect(hasDesign('서버 규칙만')).toBe(false)
    expect(looksVisual('화면 만들기')).toBe(true)
    expect(looksVisual('데이터베이스 정리')).toBe(false)
  })
})

describe('the first screen task of a project gets its design rules', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hivedesk-design-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('adds them once, differently per project, and not when switched off', async () => {
    const prompts: string[] = []
    const runner: Runner = async (_b, o) => {
      prompts.push(o.prompt)
      writeFileSync(join(o.cwd, 'x.txt'), 'x\n')
      return { code: 0, stdout: '[[DID: 했어요]]\n[[FILES: x.txt]]\n[[VERIFY: 확인]]\n[[RISK: none]]\n[[NEXT: none]]', stderr: '', timedOut: false, aborted: false }
    }
    const work = join(dir, 'work')
    mkdirSync(work, { recursive: true })
    const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), parallelWorktrees: false, humanReview: 'off' })
    const dev = eng.saveAgent({ name: '개발', adapter: 'claude', workDir: work })
    const p1 = eng.saveProject({ name: '골목 카페 타이쿤' })
    const p2 = eng.saveProject({ name: '가게 타이쿤 2' })
    const run = async (projectId: string, title: string): Promise<void> => {
      const t = eng.createTask({ title, assignee: dev.id, projectId })
      await eng.runTask(t.id)
      await wait(100)
    }
    await run(p1.id, '화면 만들기')
    const b1 = eng.hive.getProject(p1.id)!.briefing
    expect(b1).toContain('[디자인 지침:')
    expect(prompts[0]).toContain('[디자인 지침:')
    await run(p1.id, '화면 고치기')
    expect(eng.hive.getProject(p1.id)!.briefing).toBe(b1) // once
    await run(p2.id, '가게 화면 만들기')
    const b2 = eng.hive.getProject(p2.id)!.briefing
    expect(b2).toContain('[디자인 지침:')
    expect(usedDesigns([b1])[0]).not.toBe(usedDesigns([b2])[0])
    const p3 = eng.saveProject({ name: '세 번째' })
    eng.saveSettings({ autoDesign: false })
    await run(p3.id, '세 번째 화면 만들기')
    expect(eng.hive.getProject(p3.id)!.briefing).not.toContain('[디자인 지침:')
    eng.shutdown()
  })
})
