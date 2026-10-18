import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { buildCommand, runCli, type RunHandle, type Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s62-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** A stand-in for `claude -p --input-format stream-json`: one result per user line, "SLOW" turns wait for an interrupt. */
const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin })
let slow = null
const out = (o) => console.log(JSON.stringify(o))
rl.on('line', (l) => {
  const m = JSON.parse(l)
  if (m.type === 'user') {
    out({ type: 'user', isReplay: true, message: m.message })
    const text = String(m.message.content)
    if (text.includes('SLOW')) { slow = setTimeout(() => out({ type: 'result', subtype: 'success', result: 'slow done' }), 4000); return }
    out({ type: 'result', subtype: 'success', result: 'echo:' + text.slice(0, 20) })
  } else if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } })
    if (slow) { clearTimeout(slow); slow = null; out({ type: 'result', subtype: 'error_during_execution' }) }
  }
})
`

function run(prompt: string, extra: Partial<Parameters<typeof runCli>[1]> = {}) {
  const script = join(dir, 'fake.js')
  writeFileSync(script, FAKE)
  return runCli({ command: process.execPath, args: [script], live: true } as never, { cwd: dir, env: process.env, prompt, timeoutMs: 30000, idleTimeoutMs: 20000, ...extra } as never)
}

describe('6-2: live runs', () => {
  it('claude gets the stream-json input flags only in live mode', () => {
    const a: never = { id: 'a', name: 'a', adapter: 'claude', model: '', extraArgs: '' } as never
    expect(buildCommand(a, { stream: true, live: true }).args).toContain('--replay-user-messages')
    expect(buildCommand(a, { stream: true, live: true }).live).toBe(true)
    expect(buildCommand(a, { stream: true }).args).not.toContain('--input-format')
    const codex: never = { id: 'c', name: 'c', adapter: 'codex', model: '', extraArgs: '' } as never
    expect(buildCommand(codex, { stream: true, live: true }).live).toBeFalsy()
  })

  it('closes the input after the last result so the process ends', async () => {
    const r = await run('hello')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('echo:hello')
  })

  it('a message sent while a turn is running is answered too, then the run ends', async () => {
    let h: RunHandle | undefined
    const seen: string[] = []
    const r = await run('SLOW first', { onHandle: (x) => (h = x), onReplay: (t) => seen.push(t) })
    // (the slow turn takes 4s; the second message queues behind it)
    expect(r.stdout).toContain('slow done')
    expect(h).toBeDefined()
    expect(seen[0]).toContain('SLOW first')
  }, 15000)

  it('interrupt with a message: the interrupted turn is cut and the new message is answered', async () => {
    let h: RunHandle | undefined
    const p = run('SLOW first', { onHandle: (x) => (h = x) })
    await new Promise((r) => setTimeout(r, 500))
    expect(h!.interrupt('instead do this')).toBe(true)
    const r = await p
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('error_during_execution')
    expect(r.stdout).toContain('echo:instead do this')
    expect(r.stdout).not.toContain('slow done')
  }, 15000)

  it('pause keeps the process waiting, and a later message continues it', async () => {
    let h: RunHandle | undefined
    const p = run('SLOW first', { onHandle: (x) => (h = x) })
    await new Promise((r) => setTimeout(r, 500))
    expect(h!.interrupt()).toBe(true)
    await new Promise((r) => setTimeout(r, 800))
    expect(h!.paused()).toBe(true)
    expect(h!.send('go on')).toBe(true)
    const r = await p
    expect(r.stdout).toContain('echo:go on')
    expect(h!.paused()).toBe(false)
  }, 15000)

  it('a paused run does not idle out, and stopping it ends it', async () => {
    const ac = new AbortController()
    let h: RunHandle | undefined
    const p = run('SLOW first', { onHandle: (x) => (h = x), idleTimeoutMs: 700, signal: ac.signal })
    await new Promise((r) => setTimeout(r, 300))
    h!.interrupt()
    await new Promise((r) => setTimeout(r, 1800)) // longer than the idle limit
    ac.abort('hold')
    const r = await p
    expect(r.timedOut).toBe(false)
    expect(r.aborted).toBe(true)
  }, 15000)
})

describe('6-2: the engine talks to a live run', () => {
  const REPORT = '[[DID: 했어요]]\n[[FILES: none]]\n[[VERIFY: 확인]]\n[[RISK: none]]\n[[NEXT: none]]'
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** A runner that hands out a handle, records what is written to it and ends when told. */
  function liveRunner() {
    const log: string[] = []
    let finish: (() => void) | undefined
    let pausedNow = false
    const runner: Runner = (_b, o) =>
      new Promise((resolve) => {
        const end = (): void => resolve({ code: 0, stdout: REPORT, stderr: '', timedOut: false, aborted: false })
        finish = end
        o.signal?.addEventListener('abort', () => resolve({ code: 1, stdout: '', stderr: '', timedOut: false, aborted: true }))
        o.onHandle?.({
          send: (t) => (log.push('send:' + t), (pausedNow = false), true),
          interrupt: (n) => (log.push('interrupt:' + (n ?? '')), (pausedNow = n === undefined), true),
          paused: () => pausedNow
        })
      })
    return { runner, log, finish: () => finish?.() }
  }
  function make(runner: Runner) {
    const eng = new Engine(join(dir, 'config.json'), () => {}, runner, dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    eng.watchMs = 20
    const work = join(dir, 'work')
    mkdirSync(work, { recursive: true })
    const agent = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: work })
    return { eng, agent }
  }

  it('live: the instruction is written into the run and tracked as sent', async () => {
    const lr = liveRunner()
    const { eng, agent } = make(lr.runner)
    const t = eng.createTask({ title: '긴 일', assignee: agent.id })
    const p = eng.runTask(t.id)
    await wait(80)
    expect(eng.hive.getTask(t.id)!.liveInput).toBe(true)
    eng.addInstruction(t.id, '표로 정리', 'live')
    expect(lr.log[0]).toContain('send:')
    expect(lr.log[0]).toContain('표로 정리')
    expect(eng.hive.getTask(t.id)!.instructions![0].state).toBe('sent')
    lr.finish()
    await p
    expect(eng.hive.getTask(t.id)!.liveInput).toBe(false)
  })

  it('interrupt mode cuts the current step and carries the instruction', async () => {
    const lr = liveRunner()
    const { eng, agent } = make(lr.runner)
    const t = eng.createTask({ title: '긴 일', assignee: agent.id })
    const p = eng.runTask(t.id)
    await wait(80)
    eng.addInstruction(t.id, '방향 바꿔', 'interrupt')
    expect(lr.log[0]).toMatch(/^interrupt:[\s\S]*방향 바꿔/)
    lr.finish()
    await p
  })

  it('after mode waits: nothing is written to the run', async () => {
    const lr = liveRunner()
    const { eng, agent } = make(lr.runner)
    const t = eng.createTask({ title: '긴 일', assignee: agent.id })
    const p = eng.runTask(t.id)
    await wait(80)
    eng.addInstruction(t.id, '나중에', 'after')
    expect(lr.log).toEqual([])
    expect(eng.hive.getTask(t.id)!.instructions![0].state).toBe('queued')
    lr.finish()
    await wait(200) // the queued instruction starts one more round
    lr.finish()
    await p
    expect(eng.hive.getTask(t.id)!.instructions![0].state).not.toBe('queued')
  })

  it('pause → instruct continues the same run; a plain message while paused resumes it', async () => {
    const lr = liveRunner()
    const { eng, agent } = make(lr.runner)
    const t = eng.createTask({ title: '긴 일', assignee: agent.id })
    const p = eng.runTask(t.id)
    await wait(80)
    expect(eng.pauseTask(t.id)).toBe(true)
    expect(eng.hive.getTask(t.id)!.paused).toBe(true)
    eng.addInstruction(t.id, '이렇게 해', 'after') // while paused any instruction resumes the run
    expect(lr.log[1]).toContain('send:')
    expect(lr.log[1]).toContain('이렇게 해')
    expect(eng.hive.getTask(t.id)!.paused).toBe(false)
    lr.finish()
    await p
  })

  it('the old mode (setting off) never builds a live command', async () => {
    let live: boolean | undefined
    const runner: Runner = (b) => {
      live = b.live
      return Promise.resolve({ code: 0, stdout: REPORT, stderr: '', timedOut: false, aborted: false })
    }
    const { eng, agent } = make(runner)
    eng.saveSettings({ liveInstructions: false })
    const t = eng.createTask({ title: '일', assignee: agent.id })
    await eng.runTask(t.id)
    expect(live).toBeFalsy()
  })
})
