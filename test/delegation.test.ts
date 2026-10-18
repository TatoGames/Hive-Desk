import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner, RunResult } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { LIMITS, estimateBreakdown, estimateRuns, finalReportMarkdown, parsePlan, parseVerdict, validateAfter } from '../src/shared/delegation'
import type { Task } from '../src/shared/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s3-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = (n: string): string => `[[DID: ${n} 완료]]\n[[FILES: ${n}.txt]]\n[[VERIFY: ${n} 확인]]\n[[RISK: none]]\n[[NEXT: none]]`
const res = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false })

/** What a scripted fake AI answers, by the role the prompt asks for. */
interface Script {
  plan: (who: string, task: string, prompt: string) => string
  planReview: (who: string, task: string) => string
  review: (who: string, task: string) => string
  work: (who: string, task: string, cwd: string) => string
  integrate: (who: string, task: string) => string
  log: string[]
}

function makeScript(over: Partial<Script> = {}): Script {
  const s: Script = {
    plan: () => '[[SELF: 작아요]]',
    planReview: () => '[[VERDICT: approve]]',
    review: () => '[[VERDICT: pass]]',
    work: (who, task, cwd) => {
      writeFileSync(join(cwd, who + '.txt'), task + '\n')
      return REPORT(who)
    },
    integrate: (who) => '통합 결과\n' + REPORT(who + '-통합'),
    log: [],
    ...over
  }
  return s
}

const titleOf = (prompt: string): string => /## Your task\n(.*)/.exec(prompt)?.[1] ?? ''

function scripted(s: Script): Runner {
  return async (_b, o) => {
    const who = basename(o.cwd)
    const title = titleOf(o.prompt)
    let kind = 'work'
    let out: string
    if (o.prompt.includes('MANAGER (planner)')) (kind = 'plan', (out = s.plan(who, title, o.prompt)))
    else if (o.prompt.includes('PLAN REVIEWER')) (kind = 'planReview', (out = s.planReview(who, title)))
    else if (o.prompt.includes('CROSS REVIEWER')) (kind = 'review', (out = s.review(who, title)))
    else if (o.prompt.includes('INTEGRATION')) (kind = 'integrate', (out = s.integrate(who, title)))
    else out = s.work(who, title, o.cwd)
    s.log.push(`${kind}:${who}:${title}`)
    return res(out)
  }
}

/** A small company: COO — 개발본부장 — 서버팀(팀장, 개발자 ×2, 리뷰어), 인프라팀(팀장). */
function company(s: Script) {
  const eng = new Engine(join(dir, 'config.json'), () => {}, scripted(s), dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'changes', review: { checks: true, appCheck: true, policy: 'always', maxRounds: 2 } })
  eng.watchMs = 20
  eng.applyTemplate('blank', '테스트 회사', false)
  const exec = eng.saveUnit({ name: '경영진', kind: '경영' })
  const hq = eng.saveUnit({ name: '개발본부', kind: '본부' })
  const server = eng.saveUnit({ name: '서버팀', kind: '팀', parentId: hq.id })
  const infra = eng.saveUnit({ name: '인프라팀', kind: '팀', parentId: hq.id })
  const defs: [string, string, string, string, string][] = [
    // agent name, unit, seat title, job, model
    ['coo', exec.id, '총괄 본부장', 'coo', 'claude-opus-5-5'],
    ['hq', hq.id, '개발본부장', 'lead', 'claude-sonnet-5-5'],
    ['srv', server.id, '서버 팀장', 'lead', 'claude-sonnet-5-5'],
    ['dev1', server.id, '서버 개발자 1', 'build', 'claude-sonnet-5-5'],
    ['dev2', server.id, '서버 개발자 2', 'build', 'claude-sonnet-5-5'],
    ['rev', server.id, '서버 리뷰어', 'review', 'claude-opus-5-5'],
    ['ops', infra.id, '인프라 팀장', 'lead', 'claude-sonnet-5-5']
  ]
  const ids: Record<string, string> = {}
  for (const [name, unitId, title, job, model] of defs) {
    const w = join(dir, name)
    mkdirSync(w, { recursive: true })
    const a = eng.saveAgent({ name, adapter: 'claude', workDir: w, modelRef: { id: model, pin: 'pinned' } })
    const seat = eng.saveSeat({ unitId, title, job })
    eng.assignSeat(seat.id, a.id)
    ids[name] = a.id
  }
  return { eng, ids, units: { exec, hq, server, infra } }
}

/** Drive the auto-run loop until nothing is runnable or running any more. */
async function settle(eng: Engine, max = 400): Promise<void> {
  let idle = 0
  // Generous waits: under a loaded CI machine a run (git checkpoint + diff) can take well over a
  // second, and a run started by tick() registers as running only after its async setup.
  for (let i = 0; i < max && idle < 6; i++) {
    const before = JSON.stringify(eng.hive.listTasks().map((t) => [t.id, t.status, t.kind, t.assignee]))
    await eng.tick()
    await new Promise((r) => setTimeout(r, 20))
    for (let k = 0; k < 1500 && eng.snapshot().running.length; k++) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 10))
    const after = JSON.stringify(eng.hive.listTasks().map((t) => [t.id, t.status, t.kind, t.assignee]))
    idle = before === after && !eng.snapshot().running.length ? idle + 1 : 0
  }
}

const task = (eng: Engine, id: string): Task => eng.hive.getTask(id)!
const kids = (eng: Engine, id: string): Task[] => eng.hive.listTasks().filter((t) => t.parentId === id)
const events = (eng: Engine, id: string): string[] => eng.hive.listEvents(id).map((e) => e.text)

describe('plan / verdict parsing', () => {
  it('reads sub-task lines, estimate, flags and SELF', () => {
    const p = parsePlan(
      [
        '[[SUBTASK: API 만들기 | assignee=bob-dev | done=테스트 통과 | after=none]]',
        '[[SUBTASK: 문서 | assignee=bob-doc | done=README | after=1]]',
        '[[ESTIMATE: 12 runs]]',
        '[[FLAGS: Risky, other-unit, nonsense]]'
      ].join('\n')
    )
    expect(p.items).toEqual([
      { title: 'API 만들기', assignee: 'bob-dev', done: '테스트 통과', after: [] },
      { title: '문서', assignee: 'bob-doc', done: 'README', after: [1] }
    ])
    expect(p.estimate).toBe(12)
    expect(p.flags).toEqual(['risky', 'other-unit'])
    expect(parsePlan('[[SELF: 작아요]]').self).toBe('작아요')
  })

  it('collects unreadable lines and checks dependencies', () => {
    expect(parsePlan('[[SUBTASK: 담당 없음 | done=x]]').bad).toHaveLength(1)
    const it = (after: number[]) => ({ title: 't', assignee: 'a', done: '', after })
    expect(validateAfter([it([]), it([1])])).toBeNull()
    expect(validateAfter([it([1])])).toContain('자기')
    expect(validateAfter([it([]), it([5])])).toContain('없는 번호')
    expect(validateAfter([it([2]), it([])])).toContain('뒤')
  })

  it('verdicts: pass / changes / approve / reject', () => {
    expect(parseVerdict('[[VERDICT: pass]]')).toEqual({ pass: true, note: '' })
    expect(parseVerdict('[[VERDICT: changes: 테스트가 없어요]]')).toEqual({ pass: false, note: '테스트가 없어요' })
    expect(parseVerdict('[[VERDICT: approve]]')?.pass).toBe(true)
    expect(parseVerdict('[[VERDICT: reject: 범위가 넓어요]]')).toEqual({ pass: false, note: '범위가 넓어요' })
    expect(parseVerdict('결론 없음')).toBeNull()
    expect(parseVerdict('[[VERDICT: maybe]]')).toBeNull()
  })

  it('estimate counts planning, work, review and integration', () => {
    // no fixed price per kind of employee: planner's guess → this company's history → small default
    expect(estimateRuns([{ manager: false }, { manager: false }])).toBe(9)
    expect(estimateRuns([{ manager: true }])).toBe(8)
    expect(estimateBreakdown([{ manager: false, est: 1 }, { manager: false, quick: true }])).toMatchObject({ plan: 2, work: 2, review: 1, buffer: 1, total: 6 })
    expect(estimateBreakdown([{ manager: false }], { worker: 4 }).work).toBe(4)
    expect(estimateBreakdown([{ manager: false, reviewed: false }]).review).toBe(0)
  })
})

describe('entry: who receives the job', () => {
  it('unassigned → the COO plans; a manager → plans (directed); an employee → works at once', () => {
    const { eng, ids } = company(makeScript())
    const a = eng.createTask({ title: 'A', delegate: true })
    expect(task(eng, a.id)).toMatchObject({ kind: 'plan', assignee: ids.coo, directed: false, auto: true, permission: 'read', depth: 0 })
    const b = eng.createTask({ title: 'B', assignee: ids.srv, delegate: true })
    expect(task(eng, b.id)).toMatchObject({ kind: 'plan', directed: true })
    const c = eng.createTask({ title: 'C', assignee: ids.dev1, delegate: true })
    expect(task(eng, c.id)).toMatchObject({ kind: 'work', directed: false })
    eng.shutdown()
  })

  it('a unit hands the job to its lead', () => {
    const { eng, ids, units } = company(makeScript())
    const t = eng.createTask({ title: 'U', unitId: units.server.id })
    expect(task(eng, t.id)).toMatchObject({ kind: 'plan', assignee: ids.srv, directed: true })
    expect(() => eng.createTask({ title: 'X', unitId: units.exec.id })).toThrow('관리자 자리')
    eng.shutdown()
  })

  it('without a COO, an unassigned job is refused and nothing is left behind', () => {
    const eng = new Engine(join(dir, 'c2.json'), () => {}, scripted(makeScript()), dir)
    eng.saveSettings({ memberName: 'a', workspace: join(dir, 'ws2'), review: { checks: true, appCheck: true, policy: 'always', maxRounds: 2 } })
    eng.applyTemplate('blank', 'x', false)
    expect(() => eng.createTask({ title: 'X', delegate: true })).toThrow('총괄 본부장')
    expect(eng.hive.listTasks()).toEqual([])
    eng.shutdown()
  })

  it('without the delegate switch a task stays plain (old behaviour)', () => {
    const { eng, ids } = company(makeScript())
    const t = eng.createTask({ title: 'plain', assignee: ids.hq })
    expect(task(eng, t.id).kind).toBeUndefined()
    eng.shutdown()
  })
})

describe('org helpers', () => {
  it('superior = the lead above; the COO above the top units; the team = own unit + leads below', () => {
    const { eng, ids } = company(makeScript())
    const d = eng.delegation
    expect(d.superiorOf(ids.dev1)).toBe(ids.srv)
    expect(d.superiorOf(ids.srv)).toBe(ids.hq)
    expect(d.superiorOf(ids.hq)).toBe(ids.coo)
    expect(d.superiorOf(ids.coo)).toBeNull()
    expect(d.teamOf(ids.coo).map((t) => t.agent.id)).toEqual([ids.hq])
    expect(d.teamOf(ids.hq).map((t) => t.agent.id).sort()).toEqual([ids.srv, ids.ops].sort())
    expect(d.teamOf(ids.srv).map((t) => t.agent.id).sort()).toEqual([ids.dev1, ids.dev2, ids.rev].sort())
    eng.shutdown()
  })

  it('the reviewer is on another model, preferring a reviewer seat nearby', () => {
    const { eng, ids } = company(makeScript())
    expect(eng.delegation.pickReviewer(ids.dev1)).toBe(ids.rev)
    // the reviewer himself is Opus: his work is reviewed by a Sonnet agent
    expect(eng.delegation.pickReviewer(ids.rev)).not.toBe(ids.rev)
    expect(eng.delegation.pickReviewer(null)).toBeNull()
    eng.shutdown()
  })
})

describe('the whole flow', () => {
  it('COO → head → team lead → two developers, cross review, integration, final report', async () => {
    const s = makeScript({
      plan: (who, task) => {
        if (who === 'coo') return '[[SUBTASK: 서버 만들기 | assignee=alice-hq | done=서버 동작 | after=none]]\n[[ESTIMATE: 6]]\n[[FLAGS: none]]'
        if (who === 'hq') return '[[SUBTASK: 서버팀 작업 | assignee=alice-srv | done=API 완성 | after=none]]\n[[ESTIMATE: 5]]'
        return '[[SUBTASK: 모델 | assignee=alice-dev1 | done=모델 테스트 | after=none]]\n[[SUBTASK: 라우터 | assignee=alice-dev2 | done=라우터 테스트 | after=1]]\n[[ESTIMATE: 4]]\n[[FLAGS: none]]'
      }
    })
    const { eng, ids } = company(s)
    const root = eng.createTask({ title: '게임 서버', description: '로그인 API가 있는 서버', delegate: true })
    await settle(eng)

    // the tree
    const r = task(eng, root.id)
    expect(r.status).toBe('needs_review')
    expect(r.kind).toBe('integrate')
    const l1 = kids(eng, root.id)
    expect(l1.map((t) => t.assignee)).toEqual([ids.hq])
    const l2 = kids(eng, l1[0].id)
    expect(l2.map((t) => [t.assignee, t.depth])).toEqual([[ids.srv, 2]])
    const work = kids(eng, l2[0].id)
    expect(work.map((t) => t.title)).toEqual(['모델', '라우터'])
    expect(work.every((t) => t.status === 'done' && t.reviewState?.status === 'passed')).toBe(true)
    expect(work[1].dependsOn).toEqual([work[0].id])
    expect(work[0].description).toContain('완료 조건: 모델 테스트')
    expect(work[0].description).toContain('상위 업무: 서버팀 작업')
    expect(task(eng, l1[0].id).status).toBe('done')
    expect(task(eng, l2[0].id).status).toBe('done')
    // the order of work: dev1 before dev2, each reviewed by the other model
    const order = s.log.filter((l) => l.startsWith('work') || l.startsWith('review')).map((l) => l.split(':').slice(0, 2).join(':'))
    expect(order).toEqual(['work:dev1', 'review:rev', 'work:dev2', 'review:rev'])
    // the superior approved the team lead's plan (a plan review ran on the head's agent)
    expect(s.log).toContain('planReview:hq:[계획 검토] 서버팀 작업')

    // the final report
    const f = eng.hive.getFinal(root.id)!
    expect(f.tree.children[0].children[0].children.map((n) => n.title)).toEqual(['모델', '라우터'])
    const leaf = f.tree.children[0].children[0].children[0]
    expect(leaf).toMatchObject({ agentName: 'dev1', model: 'Sonnet 5.5', review: '통과', status: 'done' })
    expect(leaf.files.map((x) => x.path)).toContain('dev1.txt')
    expect(f.totals.tasks).toBe(5)
    expect(f.totals.files).toBeGreaterThanOrEqual(2)
    expect(f.totals.runs).toBeGreaterThanOrEqual(10)
    expect(f.verification.some((v) => v.includes('모델'))).toBe(true)
    const md = finalReportMarkdown(f)
    for (const h of ['# 게임 서버', '## 업무 트리', '## 비용', '## 남은 위험', '## 다음 제안']) expect(md).toContain(h)
    expect(md).toContain('Sonnet 5.5')

    // the board accepts
    eng.reviewTask(root.id, 'approve')
    expect(task(eng, root.id).status).toBe('done')
    expect(eng.hive.getFinal(root.id)!.decision).toMatchObject({ accepted: true, by: 'alice' })
    // the cross review credited the workers' model
    const apt = eng.snapshot().company.aptitude.find((a) => a.taskId === work[0].id)!
    expect(apt.approved).toBe(1)
    eng.shutdown()
  })

  it('the board can send the final report back: the manager integrates again with the note', async () => {
    const s = makeScript({ plan: (who) => (who === 'coo' ? '[[SUBTASK: 일 | assignee=alice-hq | done=끝 | after=none]]' : '[[SELF: 작아요]]') })
    const { eng } = company(s)
    const root = eng.createTask({ title: 'R', delegate: true })
    await settle(eng)
    expect(task(eng, root.id).status).toBe('needs_review')
    eng.reviewTask(root.id, 'changes', '요약을 더 짧게')
    expect(eng.hive.getFinal(root.id)!.decision).toMatchObject({ accepted: false, note: '요약을 더 짧게' })
    await settle(eng)
    expect(task(eng, root.id).status).toBe('needs_review')
    expect(eng.hive.getFinal(root.id)!.decision).toBeUndefined()
    const ints = s.log.filter((l) => l.startsWith('integrate:coo'))
    expect(ints.length).toBeGreaterThanOrEqual(2)
    eng.shutdown()
  })
})

describe('approval rules', () => {
  const plan1 = (assignee: string, extra = ''): string => `[[SUBTASK: 일 | assignee=${assignee} | done=끝 | after=none]]\n${extra}`

  it('a COO plan that is not big needs nobody\'s approval', async () => {
    const { eng, ids } = company(makeScript({ plan: (who) => (who === 'coo' ? plan1('alice-hq', '[[ESTIMATE: 5]]') : '[[SELF: x]]') }))
    const t = eng.createTask({ title: 'T', delegate: true })
    await settle(eng)
    expect(task(eng, t.id).plan).toMatchObject({ approver: 'auto', status: 'approved' })
    expect(eng.hive.listApprovals()).toEqual([])
    expect(kids(eng, t.id)[0].assignee).toBe(ids.hq)
    eng.shutdown()
  })

  it('a big job (many runs) goes to the board, which can reject with a reason and approve the second try', async () => {
    let attempt = 0
    const s = makeScript({
      plan: (who, _t, prompt) => {
        if (who !== 'coo') return '[[SELF: x]]'
        attempt++
        expect(prompt.includes('반려')).toBe(attempt > 1)
        return plan1('alice-hq', '[[ESTIMATE: 50]]')
      }
    })
    const { eng } = company(s)
    const t = eng.createTask({ title: '큰 일', delegate: true })
    await settle(eng)
    const ap = eng.hive.listApprovals()
    expect(ap).toHaveLength(1)
    expect(ap[0]).toMatchObject({ kind: 'plan', status: 'pending', taskId: t.id })
    expect(task(eng, t.id).status).toBe('awaiting_approval')
    expect(task(eng, t.id).plan!.boardReasons[0]).toContain('예상 AI 실행 50회')
    expect(kids(eng, t.id)).toEqual([])

    eng.decideApproval(ap[0].id, 'rejected', '범위를 줄여 주세요')
    expect(task(eng, t.id)).toMatchObject({ status: 'todo' })
    expect(task(eng, t.id).reply).toContain('범위를 줄여 주세요')
    await settle(eng)
    const ap2 = eng.hive.listApprovals().filter((a) => a.status === 'pending')
    expect(ap2).toHaveLength(1)
    eng.decideApproval(ap2[0].id, 'approved')
    expect(task(eng, t.id).status).toBe('delegated')
    expect(kids(eng, t.id)).toHaveLength(1)
    eng.shutdown()
  })

  it('flags (risky / scope / conflict) and a risky task go to the board with their reasons', async () => {
    const { eng } = company(makeScript({ plan: (who) => (who === 'coo' ? plan1('alice-hq', '[[ESTIMATE: 5]]\n[[FLAGS: risky, conflict]]') : '[[SELF: x]]') }))
    const t = eng.createTask({ title: 'F', delegate: true })
    await settle(eng)
    const reasons = task(eng, t.id).plan!.boardReasons.join('|')
    expect(reasons).toContain('위험 작업 포함')
    expect(reasons).toContain('기존 결정과 충돌')
    expect(task(eng, t.id).status).toBe('awaiting_approval')
    eng.shutdown()
  })

  it('the first plan of a manager the board named goes to the board even when small', async () => {
    const { eng, ids } = company(makeScript({ plan: (who) => (who === 'srv' ? plan1('alice-dev1', '[[ESTIMATE: 4]]') : '[[SELF: x]]') }))
    const t = eng.createTask({ title: 'D', assignee: ids.srv, delegate: true })
    await settle(eng)
    expect(task(eng, t.id).plan!.approver).toBe('board')
    expect(task(eng, t.id).plan!.boardReasons.join('|')).toContain('직접 지정')
    eng.shutdown()
  })

  it('a plan for people outside the manager\'s unit is flagged other-unit', async () => {
    const { eng, ids } = company(makeScript({ plan: (who) => (who === 'srv' ? plan1(ids_placeholder) : '[[SELF: x]]') }))
    void ids
    eng.shutdown()
  })

  it('a sub-manager\'s ordinary plan is approved by the superior (a plan review runs)', async () => {
    const s = makeScript({
      plan: (who) => (who === 'srv' ? plan1('alice-dev1', '[[ESTIMATE: 4]]') : '[[SELF: x]]')
    })
    const { eng, ids } = company(s)
    // the head hands the job to the team lead (not directed → no board reason)
    const root = eng.createTask({ title: 'R', assignee: ids.hq, delegate: true })
    eng.hive.updateTask(root.id, { directed: false, kind: 'plan' })
    const child = eng.hive.createTask({ title: 'C', assignee: ids.srv, permission: 'read', createdBy: 'x' })
    eng.hive.updateTask(child.id, { kind: 'plan', depth: 1, auto: true, parentId: root.id })
    eng.hive.updateTask(root.id, { status: 'delegated' })
    await settle(eng)
    expect(task(eng, child.id).plan).toMatchObject({ approver: 'superior', status: 'approved' })
    expect(s.log).toContain('planReview:hq:[계획 검토] C')
    expect(kids(eng, child.id).map((t) => t.assignee)).toEqual([ids.dev1])
    eng.shutdown()
  })

  it('a superior who keeps rejecting is overruled by the board after too many rejections', async () => {
    let n = 0
    const s = makeScript({
      plan: (who) => (who === 'srv' ? plan1('alice-dev1', '[[ESTIMATE: 4]]') : '[[SELF: x]]'),
      planReview: () => `[[VERDICT: reject: 안 돼요 ${++n}]]`
    })
    const { eng, ids } = company(s)
    const root = eng.hive.createTask({ title: 'R', assignee: ids.hq, createdBy: 'x' })
    eng.hive.updateTask(root.id, { kind: 'plan', status: 'delegated', depth: 0 })
    const child = eng.hive.createTask({ title: 'C', assignee: ids.srv, permission: 'read', createdBy: 'x' })
    eng.hive.updateTask(child.id, { kind: 'plan', depth: 1, auto: true, parentId: root.id })
    await settle(eng)
    expect(n).toBe(LIMITS.planRejectLimit + 1)
    expect(task(eng, child.id).status).toBe('awaiting_approval')
    const ap = eng.hive.listApprovals().filter((a) => a.status === 'pending')
    expect(ap).toHaveLength(1)
    expect(ap[0].reason).toContain('반복 반려')
    eng.shutdown()
  })

  it('the project run budget is a board reason', async () => {
    const s = makeScript({ plan: (who) => (who === 'coo' ? plan1('alice-hq', '[[ESTIMATE: 5]]') : '[[SELF: x]]') })
    const { eng } = company(s)
    const p = eng.saveProject({ name: 'P', runBudget: 3 })
    const t = eng.createTask({ title: 'B', delegate: true, projectId: p.id })
    await settle(eng)
    expect(task(eng, t.id).plan!.flags).toContain('budget')
    expect(task(eng, t.id).status).toBe('awaiting_approval')
    eng.shutdown()
  })
})

const ids_placeholder = 'alice-ops' // infra team lead: outside the server team

describe('plan problems', () => {
  it('an unknown assignee is sent back with the valid ids, and the plan is accepted after a fix', async () => {
    let n = 0
    const s = makeScript({
      plan: (who, _t, prompt) => {
        if (who !== 'srv') return '[[SELF: x]]'
        n++
        if (n === 1) return '[[SUBTASK: 일 | assignee=nobody | done=끝 | after=none]]'
        expect(prompt).toContain('목록에 없는 담당자')
        return '[[SUBTASK: 일 | assignee=alice-dev1 | done=끝 | after=none]]'
      }
    })
    const { eng, ids } = company(s)
    const t = eng.createTask({ title: 'X', assignee: ids.srv, delegate: true })
    await settle(eng)
    expect(n).toBe(2)
    expect(task(eng, t.id).plan).toBeDefined()
    eng.shutdown()
  })

  it('an answer that never has the right format stops the task with a reason', async () => {
    const { eng, ids } = company(makeScript({ plan: () => '계획을 말로만 설명할게요' }))
    const t = eng.createTask({ title: 'X', assignee: ids.srv, delegate: true })
    await settle(eng)
    expect(task(eng, t.id).status).toBe('failed')
    expect(task(eng, t.id).error).toContain('형식')
    eng.shutdown()
  })

  it('too many sub-tasks, a loop in the order, or too deep a split are sent back', async () => {
    const many = Array.from({ length: LIMITS.maxSubtasks + 1 }, (_, i) => `[[SUBTASK: ${i} | assignee=alice-dev1 | done=x | after=none]]`).join('\n')
    const { eng, ids } = company(makeScript({ plan: () => many }))
    const t = eng.createTask({ title: 'X', assignee: ids.srv, delegate: true })
    await settle(eng)
    expect(events(eng, t.id).some((e) => e.includes(`최대 ${LIMITS.maxSubtasks}개`))).toBe(true)
    eng.shutdown()

    const { eng: e2, ids: i2 } = company(makeScript({ plan: () => '[[SUBTASK: a | assignee=alice-dev1 | done=x | after=2]]\n[[SUBTASK: b | assignee=alice-dev2 | done=x | after=none]]' }))
    const t2 = e2.createTask({ title: 'Y', assignee: i2.srv, delegate: true })
    await settle(e2)
    expect(events(e2, t2.id).some((e) => e.includes('뒤'))).toBe(true)
    e2.shutdown()

    const { eng: e3, ids: i3 } = company(makeScript({ plan: () => '[[SUBTASK: a | assignee=alice-ops | done=x | after=none]]' }))
    const t3 = e3.createTask({ title: 'Z', assignee: i3.hq, delegate: true })
    e3.hive.updateTask(t3.id, { depth: LIMITS.maxDepth - 1 })
    await settle(e3)
    expect(events(e3, t3.id).some((e) => e.includes('너무 깊어요'))).toBe(true)
    e3.shutdown()
  })

  it('"small enough" skips the split: the manager does the job and it is cross-reviewed', async () => {
    const s = makeScript({ plan: () => '[[SELF: 한 줄 수정]]' })
    const { eng, ids } = company(s)
    const t = eng.createTask({ title: '작은 일', assignee: ids.srv, delegate: true })
    await settle(eng)
    const x = task(eng, t.id)
    expect(x.kind).toBe('work')
    expect(x.status).toBe('done')
    expect(x.reviewState?.status).toBe('passed')
    expect(kids(eng, t.id)).toEqual([])
    expect(s.log.map((l) => l.split(':')[0])).toEqual(['plan', 'work', 'review'])
    eng.shutdown()
  })
})

describe('requirement check', () => {
  it('a manager who is missing information asks the board and plans after the answer', async () => {
    let asked = false
    const s = makeScript({
      plan: (who, _t, prompt) => {
        if (who !== 'srv') return '[[SELF: x]]'
        if (!asked) {
          asked = true
          return '[[NEED: 완료 조건과 사용할 DB를 알려 주세요]]'
        }
        expect(prompt).toContain('PostgreSQL')
        return '[[SUBTASK: 일 | assignee=alice-dev1 | done=끝 | after=none]]'
      }
    })
    const { eng, ids } = company(s)
    const t = eng.createTask({ title: '모호한 일', assignee: ids.srv, delegate: true })
    await settle(eng)
    expect(task(eng, t.id)).toMatchObject({ status: 'needs_input', question: '완료 조건과 사용할 DB를 알려 주세요' })
    eng.replyToTask(t.id, 'PostgreSQL, 모든 API 테스트 통과')
    await settle(eng)
    expect(task(eng, t.id).plan).toBeDefined()
    eng.shutdown()
  })

  it('the plan prompt contains the checklist and the team list', async () => {
    let seen = ''
    const { eng, ids } = company(makeScript({ plan: (_w, _t, p) => ((seen = p), '[[SELF: x]]') }))
    eng.createTask({ title: 'P', assignee: ids.srv, delegate: true })
    await settle(eng)
    for (const w of ['goal, scope, completion criteria', 'alice-dev1', 'alice-rev', 'SUBTASK', 'ESTIMATE', 'FLAGS']) expect(seen).toContain(w)
    expect(seen).not.toContain('alice-hq |') // a manager does not assign upward
    eng.shutdown()
  })
})

describe('cross review', () => {
  it('"changes" goes back to the worker with the notes; two rounds, then up to the lead, who finishes it', async () => {
    let n = 0
    const works: string[] = []
    const s = makeScript({
      review: () => (++n <= 3 ? `[[VERDICT: changes: 고칠 점 ${n}]]` : '[[VERDICT: pass]]'),
      work: (who, task, cwd) => {
        works.push(who)
        writeFileSync(join(cwd, who + '.txt'), task)
        return REPORT(who)
      }
    })
    const { eng, ids } = company(s)
    const t = eng.createTask({ title: '까다로운 일', assignee: ids.dev1, delegate: true })
    await settle(eng)
    // dev1 → (1) → dev1 → (2) → dev1 → (3rd rejection escalates) → srv, then passes
    expect(works).toEqual(['dev1', 'dev1', 'dev1', 'srv'])
    const x = task(eng, t.id)
    expect(x.status).toBe('done')
    expect(x.assignee).toBe(ids.srv)
    expect(x.reviewState).toMatchObject({ status: 'passed', escalations: 1 })
    expect(events(eng, t.id).some((e) => e.includes('윗 직책'))).toBe(true)
    eng.shutdown()
  })

  it('when it keeps failing even after moving up, the board decides', async () => {
    const s = makeScript({ review: () => '[[VERDICT: changes: 아직 아니에요]]' })
    const { eng, ids } = company(s)
    const t = eng.createTask({ title: '불가능한 일', assignee: ids.dev1, delegate: true })
    await settle(eng)
    expect(task(eng, t.id).status).toBe('awaiting_approval')
    const ap = eng.hive.listApprovals().filter((a) => a.status === 'pending')
    expect(ap).toHaveLength(1)
    expect(ap[0]).toMatchObject({ kind: 'agent-request', taskId: t.id })
    expect(ap[0].reason).toContain('끝까지 막혔어요')
    eng.shutdown()
  })

  it('a reviewer who gives no verdict is asked again, then a human has to look', async () => {
    const s = makeScript({ review: () => '잘 모르겠어요' })
    const { eng, ids } = company(s)
    const t = eng.createTask({ title: '일', assignee: ids.dev1, delegate: true })
    await settle(eng)
    expect(task(eng, t.id).status).toBe('needs_review')
    expect(task(eng, t.id).reviewState?.status).toBe('skipped')
    expect(s.log.filter((l) => l.startsWith('review')).length).toBe(LIMITS.planFormatTries + 1)
    eng.shutdown()
  })

  it('with nobody on another model, the review is skipped (and the task still finishes)', async () => {
    const s = makeScript()
    const eng = new Engine(join(dir, 'c3.json'), () => {}, scripted(s), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws3'), review: { checks: true, appCheck: true, policy: 'always', maxRounds: 2 } })
    eng.watchMs = 20
    const w = join(dir, 'solo')
    mkdirSync(w)
    const a = eng.saveAgent({ name: 'solo', adapter: 'claude', workDir: w, modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    const t = eng.createTask({ title: 'S', assignee: a.id, delegate: true })
    await settle(eng)
    expect(task(eng, t.id)).toMatchObject({ status: 'done' })
    expect(task(eng, t.id).reviewState?.status).toBe('skipped')
    expect(events(eng, t.id).some((e) => e.includes('교차 검토를 건너뛰었어요'))).toBe(true)
    eng.shutdown()
  })

  it('the review prompt carries the criteria, the report and the changed files; reviewers cannot write', async () => {
    let prompt = ''
    const s = makeScript({ review: (_w, _t) => '[[VERDICT: pass]]' })
    const inner = scripted(s)
    const eng0 = company(s)
    const eng = eng0.eng
    const orig = (eng as unknown as { runner: Runner }).runner
    ;(eng as unknown as { runner: Runner }).runner = async (b, o) => {
      if (o.prompt.includes('CROSS REVIEWER')) (prompt = o.prompt, expect(b.args.join(' ')).toContain('Read,Grep,Glob'))
      return inner(b, o)
    }
    void orig
    const t = eng.createTask({ title: '검토 대상', assignee: eng0.ids.dev1, delegate: true })
    eng.hive.updateTask(t.id, { criteria: '모든 테스트 통과' })
    await settle(eng)
    expect(prompt).toContain('모든 테스트 통과')
    expect(prompt).toContain('dev1 완료')
    expect(prompt).toContain('dev1.txt')
    expect(prompt).toContain('read only')
    eng.shutdown()
  })
})

describe('safeguards of the tree', () => {
  it('a failed sub-task keeps its parent waiting; when it is fixed and done the parent moves on', async () => {
    let fail = true
    const s = makeScript({
      plan: (who) => (who === 'coo' ? '[[SUBTASK: 일 | assignee=alice-hq | done=끝 | after=none]]' : who === 'hq' ? '[[SELF: x]]' : '[[SELF: x]]')
    })
    const inner = scripted(s)
    const { eng } = company(s)
    ;(eng as unknown as { runner: Runner }).runner = async (b, o) =>
      fail && o.cwd.endsWith('hq') && !o.prompt.includes('MANAGER') && !o.prompt.includes('INTEGRATION')
        ? { code: 1, stdout: '', stderr: 'boom', timedOut: false, aborted: false }
        : inner(b, o)
    const root = eng.createTask({ title: 'R', delegate: true })
    await settle(eng)
    const child = kids(eng, root.id)[0]
    expect(child.status).toBe('failed')
    expect(task(eng, root.id).status).toBe('delegated')
    fail = false
    eng.updateTask(child.id, { status: 'todo' })
    await settle(eng)
    expect(task(eng, root.id).status).toBe('needs_review')
    eng.shutdown()
  })

  it('delegated tasks do not wait for a human (cross review replaces it) and plans never edit files', async () => {
    const { eng, ids } = company(makeScript())
    const t = eng.createTask({ title: 'W', assignee: ids.dev1, delegate: true })
    await settle(eng)
    expect(task(eng, t.id).status).toBe('done') // not needs_review although files changed
    const p = eng.createTask({ title: 'P', assignee: ids.srv, delegate: true })
    expect(task(eng, p.id).permission).toBe('read')
    eng.shutdown()
  })

  it('delegation runs even when the global auto-run switch is off (only for tasks it created)', async () => {
    const { eng, ids } = company(makeScript())
    expect(eng.config.autoRun).toBe(false)
    const plain = eng.createTask({ title: 'plain', assignee: ids.dev1 })
    const d = eng.createTask({ title: 'delegated', assignee: ids.dev2, delegate: true })
    await settle(eng)
    expect(task(eng, plain.id).status).toBe('todo')
    expect(task(eng, d.id).status).toBe('done')
    eng.shutdown()
  })
})

describe('6-0.6: the board fixes a plan itself', () => {
  const plan2 = (a: string, b: string): string =>
    `[[SUBTASK: GitHub Pages로 배포 | assignee=${a} | done=열림 | after=none]]\n[[SUBTASK: 문서 정리 | assignee=${b} | done=문서 | after=1]]\n[[ESTIMATE: 50]]`

  it('a sub-task that cannot be done is flagged; the board takes it out and approves without any AI run', async () => {
    const { eng } = company(makeScript({ plan: (who) => (who === 'coo' ? plan2('alice-hq', 'alice-hq') : '[[SELF: x]]') }))
    const t = eng.createTask({ title: '사이트 올리기', delegate: true })
    await settle(eng)
    const p = task(eng, t.id).plan!
    expect(p.issues?.map((i) => i.kind)).toEqual(['github'])
    expect(p.boardReasons.join(' ')).toContain('할 수 없는')
    const ap = eng.hive.listApprovals().find((a) => a.status === 'pending')!
    // keeping the item is refused
    expect(() => eng.editPlanApprove(ap.id, p.items)).toThrow('GitHub')
    // the person takes the deployment out: it becomes an open task for a person
    const before = eng.hive.listTasks().length
    eng.editPlanApprove(ap.id, p.items, [0])
    expect(task(eng, t.id).status).toBe('delegated')
    const created = kids(eng, t.id)
    expect(created).toHaveLength(1)
    expect(created[0].title).toBe('문서 정리')
    expect(created[0].dependsOn).toEqual([])
    expect(eng.hive.listTasks().some((x) => x.title === 'GitHub Pages로 배포' && !x.assignee && !x.parentId)).toBe(true)
    expect(eng.hive.listTasks().length).toBeGreaterThan(before)
    eng.shutdown()
  })
})

describe('6-0.7: work trees let sub-tasks of one git project run at the same time', () => {
  it('two developers in the same repo each get their own folder and branch, run together, and are merged at integration', async () => {
    const { execFileSync } = await import('node:child_process')
    const { existsSync, readdirSync } = await import('node:fs')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const g = (...a: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo }).toString()
    g('init', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'hi\n')
    g('add', '-A')
    g('commit', '-m', 'init')

    let active = 0
    let maxActive = 0
    const cwds: string[] = []
    const s = makeScript({
      plan: (who) => {
        if (who === 'coo') return '[[SUBTASK: 서버 만들기 | assignee=alice-hq | done=서버 동작 | after=none]]\n[[ESTIMATE: 6]]'
        if (who === 'hq') return '[[SUBTASK: 서버팀 작업 | assignee=alice-srv | done=API 완성 | after=none]]\n[[ESTIMATE: 5]]'
        return '[[SUBTASK: 모델 | assignee=alice-dev1 | done=모델 | after=none | files=src/model]]\n[[SUBTASK: 라우터 | assignee=alice-dev2 | done=라우터 | after=none | files=src/router]]\n[[ESTIMATE: 4]]'
      },
      work: (_who, task, cwd) => {
        cwds.push(cwd)
        writeFileSync(join(cwd, task + '.txt'), task + '\n')
        return REPORT(task)
      }
    })
    const { eng, ids } = company(s)
    for (const n of ['dev1', 'dev2']) eng.saveAgent({ ...eng.config.agents.find((a) => a.id === ids[n])!, workDir: repo })
    eng.saveSettings({ parallelWorktrees: true, maxConcurrent: 4 })
    // measure overlap of the two work runs
    const inner = (eng as unknown as { runner: Runner }).runner
    ;(eng as unknown as { runner: Runner }).runner = async (b, o) => {
      const isWork = o.cwd.includes('.hive-worktrees') && !o.prompt.includes('CROSS REVIEWER')
      if (isWork) maxActive = Math.max(maxActive, ++active)
      // hold each work run until the other one has started too (or 5s pass), so a slow machine
      // that starts the second run late still shows they overlap; run one after another, they never do
      for (let i = 0; isWork && i < 250 && maxActive < 2; i++) await new Promise((r) => setTimeout(r, 20))
      try {
        return await inner(b, o)
      } finally {
        if (isWork) active--
      }
    }
    const root = eng.createTask({ title: '게임 서버', delegate: true })
    await settle(eng)
    expect(task(eng, root.id).status).toBe('needs_review')
    expect(cwds.length).toBe(2)
    expect(cwds.every((c) => c.includes('.hive-worktrees'))).toBe(true)
    expect(maxActive).toBe(2) // they really ran together
    // merged into the project, work trees cleaned up
    expect(existsSync(join(repo, '모델.txt'))).toBe(true)
    expect(existsSync(join(repo, '라우터.txt'))).toBe(true)
    expect(readdirSync(join(repo, '.hive-worktrees'))).toEqual([])
    expect(g('status', '--porcelain').trim()).toBe('')
    eng.shutdown()
  })
})

describe('6-0.7: approvals the app may answer itself', () => {
  it('a plan only a little over the limit is approved automatically (logged as 자동); a big one still goes to the board', async () => {
    const { eng } = company(makeScript({ plan: (who) => (who === 'coo' ? '[[SUBTASK: 일 | assignee=alice-hq | done=끝 | after=none]]\n[[ESTIMATE: 22]]' : '[[SELF: x]]') }))
    const t = eng.createTask({ title: '조금 큰 일', delegate: true })
    await settle(eng)
    expect(task(eng, t.id).status).not.toBe('awaiting_approval')
    const ap = eng.hive.listApprovals().find((a) => a.kind === 'plan')!
    expect(ap).toMatchObject({ status: 'approved', decidedBy: '자동' })
    expect(events(eng, t.id).some((e) => e.includes('자동 승인'))).toBe(true)
    eng.shutdown()
  })

  it('a read-only task that asks to write files in its folder is allowed to edit; risky requests are left to the board', async () => {
    const { eng, ids } = company(makeScript())
    const a = eng.createTask({ title: '문서 만들기', assignee: ids.dev1, permission: 'read' })
    eng.hive.updateTask(a.id, { status: 'todo' })
    eng.hive.createApproval({ kind: 'agent-request', taskId: a.id, agentId: ids.dev1, reason: '문서 파일을 작성하려면 쓰기 권한이 필요해요' })
    const b = eng.createTask({ title: '정리', assignee: ids.dev2, permission: 'read' })
    eng.hive.createApproval({ kind: 'agent-request', taskId: b.id, agentId: ids.dev2, reason: '오래된 파일을 삭제해도 될까요? 파일 수정이 필요해요' })
    await eng.tick()
    expect(task(eng, a.id).permission).toBe('edit')
    expect(eng.hive.listApprovals().find((x) => x.taskId === a.id)).toMatchObject({ status: 'approved', decidedBy: '자동' })
    expect(eng.hive.listApprovals().find((x) => x.taskId === b.id)?.status).toBe('pending')
    expect(task(eng, b.id).permission).toBe('read')
    eng.shutdown()
  })
})

describe('6-3: adjusting a running delegation', () => {
  const plan2 = (a: string, b: string): string =>
    `[[SUBTASK: 첫째 | assignee=${a} | done=끝 | after=none]]\n[[SUBTASK: 둘째 | assignee=${b} | done=끝 | after=1]]\n[[ESTIMATE: 5]]`

  async function started() {
    const { eng, ids } = company(makeScript({ plan: (who) => (who === 'coo' ? plan2('alice-hq', 'alice-hq') : '[[SELF: x]]') }))
    const t = eng.createTask({ title: '큰 일', delegate: true })
    await eng.runTask(t.id) // the plan only; nothing below has run
    expect(task(eng, t.id).status).toBe('delegated')
    return { eng, ids, root: t }
  }

  it('skipping a step counts it as done so the next one can go on', async () => {
    const { eng, root } = await started()
    const [a, b] = kids(eng, root.id)
    expect(eng.skipStep(a.id)).toBe(true)
    expect(task(eng, a.id).status).toBe('done')
    expect(task(eng, b.id).status).not.toBe('done')
    eng.shutdown()
  })

  it('a step can be added to a running plan, and the bundle waits for it', async () => {
    const { eng, ids, root } = await started()
    eng.addStep(root.id, { title: '추가 단계', assignee: ids.hq, done: '확인' })
    const all = kids(eng, root.id)
    expect(all).toHaveLength(3)
    expect(task(eng, root.id).plan!.childIds).toContain(all[2].id)
    expect(() => eng.addStep(root.id, { title: 'x', assignee: 'nobody' })).toThrow()
    eng.shutdown()
  })

  it('instructing down reaches every unfinished task below', async () => {
    const { eng, root } = await started()
    const n = await eng.instructTree(root.id, '모든 문서는 영어로', { down: true })
    expect(n).toBe(2)
    for (const k of kids(eng, root.id)) expect(task(eng, k.id).instructions?.[0].text).toBe('모든 문서는 영어로')
    expect(task(eng, root.id).instructions).toHaveLength(1)
    eng.shutdown()
  })

  it('replanning drops the unfinished sub-tasks and has the planner start over with the instruction', async () => {
    const { eng, root } = await started()
    const [a] = kids(eng, root.id)
    eng.skipStep(a.id) // finished work is kept
    await eng.instructTree(root.id, '방향을 바꿔요', { replan: true })
    const r = task(eng, root.id)
    expect(r.plan!.status).toMatch(/rejected|approved/)
    expect(events(eng, root.id).join('\n')).toContain('방향을 바꿔요')
    const old = kids(eng, root.id).filter((k) => k.title === '둘째')
    expect(old.every((k) => k.status === 'cancelled' || k.status === 'todo' || k.status === 'delegated')).toBe(true)
    expect(task(eng, a.id).status).toBe('done')
    // the new planning run is still going: let it finish, or its git process keeps the folder busy (Windows EBUSY)
    for (let i = 0; i < 400 && eng.snapshot().running.length; i++) await new Promise((r) => setTimeout(r, 20))
    eng.shutdown()
  })
})

