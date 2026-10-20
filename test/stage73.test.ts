import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunOptions, Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s73-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = '[[DID: 마저 했어요]]\n[[FILES: b.txt]]\n[[VERIFY: 확인]]\n[[RISK: none]]\n[[NEXT: none]]'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await wait(20)
}
const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd }).toString()

/** Claude-style stream output with the given assistant texts. */
const stream = (...texts: string[]): string => texts.map((t) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })).join('\n') + '\n'

/**
 * claude: plans three steps, finishes step 1 (a.txt), is half way through step 2 (b.txt) and runs out of usage.
 * codex: carries on and finishes. `resetIn` sets what the limit message says about the reset.
 */
function runners(resetIn = 'try again in 5 hours') {
  const prompts: Record<string, string[]> = { claude: [], codex: [] }
  const runner: Runner = async (b, o: RunOptions) => {
    const who = b.command === 'codex' ? 'codex' : 'claude'
    prompts[who].push(o.prompt)
    if (who === 'claude') {
      writeFileSync(join(o.cwd, 'a.txt'), 'step one\n')
      o.onOutput?.(stream('[[PLAN: 맵 만들기 | 적 넣기 | 마무리]]', '[[STEP: 1]]'))
      await wait(150) // the step saving point is made in the background
      writeFileSync(join(o.cwd, 'b.txt'), 'half done\n')
      return { code: 1, stdout: '', stderr: `Claude usage limit reached. ${resetIn}`, timedOut: false, aborted: false }
    }
    writeFileSync(join(o.cwd, 'b.txt'), 'finished\n')
    return { code: 0, stdout: REPORT, stderr: '', timedOut: false, aborted: false }
  }
  return { runner, prompts }
}

function setup(runner: Runner, models: { claude?: string; codex?: string } = {}) {
  const work = join(dir, 'work')
  mkdirSync(work, { recursive: true })
  git(work, 'init', '-q', '-b', 'main')
  writeFileSync(join(work, 'README.md'), 'hi\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'init')
  const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'off' })
  eng.watchMs = 20
  const claude = eng.saveAgent({ name: '클로드', adapter: 'claude', workDir: work, modelRef: { id: models.claude ?? 'claude-sonnet-5-5', pin: 'pinned' } })
  const codex = eng.saveAgent({ name: '코덱스', adapter: 'codex', workDir: work, modelRef: { id: models.codex ?? 'openai-gpt-6-1-sol', pin: 'pinned' } })
  return { eng, claude, codex, work }
}

describe('7-3: a task carries on when its connection runs out of usage', () => {
  it('another connection takes over from the last step: the half-done step is put back, the note names the step', async () => {
    const { runner, prompts } = runners()
    // same tier (top), about 1.3x the usage: handed over without asking
    const { eng, claude, codex, work } = setup(runner, { claude: 'claude-opus-5-5', codex: 'openai-gpt-6-astra' })
    const t = eng.createTask({ title: '게임 만들기', assignee: claude.id })
    await eng.runTask(t.id)
    await waitFor(() => eng.hive.getTask(t.id)!.status === 'done')
    const done = eng.hive.getTask(t.id)!
    expect(done.status).toBe('done')
    expect(done.assignee).toBe(codex.id)
    expect(done.handoffs).toMatchObject([{ from: claude.id, to: codex.id, fromAdapter: 'claude', toAdapter: 'codex', reason: 'limit' }])
    expect(done.limitWait).toBeUndefined()
    // carried on from step 2, which was put back to how it was when it started (b.txt was half done)
    const p = prompts.codex[0]
    expect(p).toContain('[done] 맵 만들기')
    expect(p).toContain('[in progress] 적 넣기')
    expect(p).toContain('undone')
    expect(p).toContain('a.txt')
    expect(existsSync(join(work, 'a.txt'))).toBe(true)
    expect(eng.hive.listEvents(t.id).some((e) => e.text.includes('클로드 → 코덱스 (한도'))).toBe(true)
    // the limited run is not a failure of the model; the finishing model's record is kept apart
    const apt = eng.hive.listAptitude()
    expect(apt.find((r) => r.modelKey === 'claude-opus-5-5')?.runs ?? 0).toBe(0)
    expect(apt.find((r) => r.modelKey === 'openai-gpt-6-astra')?.handedOver).toBe(true)
    // the connection remembers how many runs it took to run out
    expect(eng.machine.limitRuns().claude.hits).toEqual([1])
    eng.shutdown()
  })

  it('by default it does not wait even when the limit ends in a few minutes (the reset time is often off)', async () => {
    const { runner, prompts } = runners('try again in 5 minutes')
    const { eng, claude, codex } = setup(runner, { claude: 'claude-opus-5-5', codex: 'openai-gpt-6-astra' })
    const t = eng.createTask({ title: '게임', assignee: claude.id })
    await eng.runTask(t.id)
    await waitFor(() => eng.hive.getTask(t.id)!.status === 'done')
    expect(eng.hive.getTask(t.id)!.assignee).toBe(codex.id)
    expect(prompts.codex.length).toBeGreaterThan(0)
    eng.shutdown()
  })

  it('waits instead when the person set a wait time and the limit is over in a few minutes (known time)', async () => {
    const { runner, prompts } = runners('try again in 5 minutes')
    const { eng, claude } = setup(runner)
    eng.saveSettings({ handoff: { auto: true, up: true, confirmAtCostX: 2, waitMinutes: 20, rollbackStep: true } })
    const t = eng.createTask({ title: '게임', assignee: claude.id })
    await eng.runTask(t.id)
    await wait(200)
    const cur = eng.hive.getTask(t.id)!
    expect(cur.assignee).toBe(claude.id)
    expect(cur.limitWait?.adapter).toBe('claude')
    expect(prompts.codex.length).toBe(0)
    eng.shutdown()
  })

  it('asks first when the taker costs much more; yes moves it on, the setting can turn hand-overs off', async () => {
    const { runner, prompts } = runners()
    // a light model (weight 1) out of usage; the only other connection is a balanced one (weight 4): 4x
    const { eng, claude, codex } = setup(runner, { claude: 'claude-haiku-5-5' })
    const t = eng.createTask({ title: '게임', assignee: claude.id })
    await eng.runTask(t.id)
    const a = eng.hive.listApprovals().find((x) => x.kind === 'handoff')!
    expect(a.handoff).toMatchObject({ to: codex.id, reason: 'limit' })
    expect(a.reason).toContain('배 비용')
    expect(eng.hive.getTask(t.id)!.assignee).toBe(claude.id)
    eng.decideApproval(a.id, 'approved')
    await waitFor(() => eng.hive.getTask(t.id)!.status === 'done')
    expect(eng.hive.getTask(t.id)!.assignee).toBe(codex.id)
    expect(prompts.codex.length).toBe(1)
    eng.shutdown()
  })

  it('switched off: the task waits for its own connection', async () => {
    const { runner, prompts } = runners()
    const { eng, claude } = setup(runner)
    eng.saveSettings({ handoff: { auto: false, up: true, confirmAtCostX: 2, waitMinutes: 20, rollbackStep: true } })
    const t = eng.createTask({ title: '게임', assignee: claude.id })
    await eng.runTask(t.id)
    await eng.tick()
    await wait(100)
    expect(eng.hive.getTask(t.id)!.assignee).toBe(claude.id)
    expect(prompts.codex.length).toBe(0)
    eng.shutdown()
  })

  it('a person can hand a stopped task to someone else, with the same note', async () => {
    const { runner, prompts } = runners()
    const { eng, claude, codex } = setup(runner, { claude: 'claude-opus-5-5', codex: 'openai-gpt-6-astra' })
    eng.saveSettings({ handoff: { auto: false, up: true, confirmAtCostX: 2, waitMinutes: 20, rollbackStep: true }, autoRun: true })
    const t = eng.createTask({ title: '게임', assignee: claude.id })
    await eng.runTask(t.id)
    const opts = eng.handoffOptions(t.id)
    expect(opts.find((o) => o.agentId === codex.id)?.why).toBeNull()
    await eng.handOver(t.id, codex.id)
    await waitFor(() => eng.hive.getTask(t.id)!.status === 'done')
    expect(eng.hive.getTask(t.id)!.handoffs![0].reason).toBe('manual')
    expect(prompts.codex[0]).toContain('handed to you by a person')
    eng.shutdown()
  })

  it('failures that look like a limit but are not recognised are kept, to fix the rules', async () => {
    const runner: Runner = async () => ({ code: 1, stdout: '', stderr: 'Error 429: slow down please', timedOut: false, aborted: false })
    const { eng, claude } = setup(runner)
    const t = eng.createTask({ title: '일', assignee: claude.id })
    await eng.runTask(t.id)
    expect(eng.limitSamples()[0]).toMatchObject({ adapter: 'claude' })
    expect(eng.limitSamples()[0].text).toContain('429')
    eng.shutdown()
  })
})
