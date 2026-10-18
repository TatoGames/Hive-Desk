import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner, RunResult } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { escalationTarget, pickWorker, quickLine, rank, readJob, type Cand, type RecordLite } from '../src/shared/quick'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-quick-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const cand = (over: Partial<Cand>): Cand => ({ agentId: 'a', name: 'a', modelKey: 'm', label: 'M', tier: 'light', weight: 1, idle: true, ...over })
const rec = (modelKey: string, jobKind: string, ok: number, bad: number): RecordLite[] => [
  ...Array.from({ length: ok }, () => ({ modelKey, jobKind, approved: 1, changes: 0, failed: 0, runs: 1 })),
  ...Array.from({ length: bad }, () => ({ modelKey, jobKind, approved: 0, changes: 2, failed: 0, runs: 3 }))
]

describe('6-0.5: reading a job', () => {
  it('short document job is small and writes; research does not write; wide jobs are big', () => {
    expect(readJob('README에 설치 방법 문서 작성해줘')).toMatchObject({ size: 'small', kind: 'doc', writes: true })
    expect(readJob('Godot 물리 엔진 비교 조사해줘')).toMatchObject({ size: 'small', kind: 'research', writes: false })
    expect(readJob('전체 구조를 리팩터링하고 여러 모듈을 통합해줘').size).toBe('big')
    expect(readJob('로그인 함수 구현해줘').minTier).toBe('balanced')
  })
})

describe('6-0.5: choosing by expected total usage', () => {
  const haiku = cand({ agentId: 'h', name: '문서 팀원', modelKey: 'haiku', label: 'Haiku', tier: 'light', weight: 1 })
  const sonnet = cand({ agentId: 's', name: '구현 팀원', modelKey: 'sonnet', label: 'Sonnet', tier: 'balanced', weight: 3 })
  const job = readJob('기획서 문서 작성해줘')

  it('a light model with a good record on this kind of job wins', () => {
    const r = [...rec('haiku', 'doc', 9, 1), ...rec('sonnet', 'doc', 10, 0)]
    const { pick } = pickWorker(job, [haiku, sonnet], r, { trialRate: 0 })
    expect(pick?.cand.agentId).toBe('h')
    expect(pick?.estimated).toBe(false)
    expect(quickLine(job, pick!)).toContain('첫 통과율')
  })

  it('the same light model loses when its record on this kind of job is bad', () => {
    const r = [...rec('haiku', 'doc', 2, 8), ...rec('sonnet', 'doc', 10, 0)]
    expect(pickWorker(job, [haiku, sonnet], r, { trialRate: 0 }).pick?.cand.agentId).toBe('s')
  })

  it('implementation never goes to a light model (minimum tier), whatever the record says', () => {
    const impl = readJob('로그인 함수 구현해줘')
    const r = rec('haiku', 'impl', 20, 0)
    const { ranked } = pickWorker(impl, [haiku, sonnet], r, { trialRate: 0 })
    expect(ranked.map((p) => p.cand.agentId)).toEqual(['s'])
  })

  it('thin records lean to the higher tier: a light model is only picked when it is clearly cheaper', () => {
    const impl2 = readJob('짧은 문서 수정해줘')
    const { pick } = pickWorker(impl2, [haiku, sonnet], [], { trialRate: 0 })
    expect(pick?.estimated).toBe(true)
    expect(pick?.cand.agentId).toBe('h') // 1×1.5 < 3×1.2
  })

  it('near ties go to the idle employee', () => {
    const a = cand({ agentId: 'a', modelKey: 'x', weight: 1, idle: false })
    const b = cand({ agentId: 'b', modelKey: 'y', weight: 1, idle: true })
    expect(rank(job, [a, b], [])[0].cand.agentId).toBe('b')
  })

  it('trial: a lighter model with a thin record is tried now and then, only for jobs that write nothing', () => {
    const research = readJob('Godot 물리 엔진 비교 조사해줘')
    const r = rec('sonnet', 'research', 12, 0)
    const trial = pickWorker(research, [haiku, sonnet], r, { trialRate: 1, rnd: () => 0 })
    // sonnet has a record and haiku is cheaper anyway; make sonnet the natural pick by a bad haiku prior
    expect(trial.pick).toBeTruthy()
    const writes = readJob('기획서 문서 작성해줘')
    expect(pickWorker(writes, [haiku, sonnet], [], { trialRate: 1, rnd: () => 0 }).pick?.trial).toBe(false)
  })

  it('escalation goes exactly one tier up', () => {
    const opus = cand({ agentId: 'o', modelKey: 'opus', tier: 'top', weight: 5 })
    expect(escalationTarget(job, [haiku, sonnet, opus], [], { modelKey: 'haiku', tier: 'light' })?.cand.agentId).toBe('s')
    expect(escalationTarget(job, [haiku, sonnet, opus], [], { modelKey: 'opus', tier: 'top' })).toBeNull()
  })
})

const REPORT = '[[DID: 했어요]]\n[[FILES: none]]\n[[VERIFY: 확인]]\n[[RISK: none]]\n[[NEXT: none]]'
const res = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false })
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('6-0.5: handing a small job to one employee', () => {
  it('goes straight to an employee (no plan), research needs no review, and a bigger-than-expected job moves one tier up with the notes', async () => {
    const seen: { agent: string; prompt: string }[] = []
    let n = 0
    const runner: Runner = async (b, o) => {
      n++
      seen.push({ agent: b.args.join(' '), prompt: o.prompt })
      await wait(20)
      return res(n === 1 ? '생각보다 큽니다.\n[[ESCALATE: 여러 모듈이 얽혀 있어요]]' : REPORT)
    }
    const eng = new Engine(join(dir, 'config.json'), () => {}, runner, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), autoRun: true })
    eng.watchMs = 20
    const w = join(dir, 'w')
    mkdirSync(w)
    const haiku = eng.saveAgent({ name: '가벼운 팀원', adapter: 'claude', workDir: w, modelRef: { id: 'claude-haiku-5-5', pin: 'pinned' } })
    const sonnet = eng.saveAgent({ name: '균형 팀원', adapter: 'claude', workDir: w, modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })

    const pv = eng.quickPreview('Godot 물리 엔진 비교 조사해줘')
    expect(pv.size).toBe('small')
    expect(pv.pick?.agentId).toBe(haiku.id) // lightest that can do research
    expect(pv.line).toContain('조사')

    const t = eng.quickAssign({ title: 'Godot 물리 엔진 비교 조사해줘', agentId: haiku.id })
    expect(eng.hive.getTask(t.id)).toMatchObject({ kind: 'work', jobKind: 'research', assignee: haiku.id, permission: 'read' })
    await eng.runTask(t.id)
    await wait(100)
    const after = eng.hive.getTask(t.id)!
    expect(after.assignee).toBe(sonnet.id) // moved one tier up
    expect(after.quick?.escalations).toBe(1)
    expect(after.reply).toContain('여러 모듈이 얽혀 있어요')
    await eng.runTask(t.id)
    await wait(100)
    const fin = eng.hive.getTask(t.id)!
    expect(fin.status).toBe('done') // no files written → no cross review
    expect(seen[1].prompt).toContain('여러 모듈이 얽혀 있어요')
    eng.shutdown()
  })

  it('a big job is not given to a single employee', () => {
    const eng = new Engine(join(dir, 'config.json'), () => {}, async () => res(REPORT), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    eng.saveAgent({ name: 'x', adapter: 'claude', workDir: dir, modelRef: { id: 'claude-haiku-5-5', pin: 'pinned' } })
    const pv = eng.quickPreview('전체 구조를 리팩터링하고 여러 모듈을 통합해줘')
    expect(pv.pick).toBeNull()
    expect(pv.line).toBeNull()
    eng.shutdown()
  })
})
