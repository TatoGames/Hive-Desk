import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunOptions, Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { LocalQueue, QueueWaitTimeout, modelKey } from '../src/main/localQueue'
import { bubbleFor } from '../src/shared/bubble'
import { handoffNote, handoffReasonLabel, pickHandoff, whyNot, type HandoffCand, type HandoffNeed } from '../src/shared/handoff'
import { LOCAL_QUEUE, classifyLocalError, localErrorPolicy, queueLine } from '../src/shared/localqueue'
import type { Task } from '../src/shared/types'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await wait(15)
}

// ---------------- pure: error classes ----------------
describe('A3: 오류 분류', () => {
  it.each([
    ['model requires more system memory (12.0 GiB) than is available (7.9 GiB)', 'memory'],
    ['CUDA error: out of memory', 'memory'],
    ['엔진이 오류를 돌려줬어요 (HTTP 500): failed to allocate buffer', 'memory'],
    ['llama runner process has terminated: exit status 2', 'load'],
    ['error loading model: unsupported model architecture', 'load'],
    ['모델 "qwen"이 설치돼 있지 않아요. (model not found)', 'load'],
    ['http://127.0.0.1:11434와 연결이 끊겼어요.', 'disconnect'],
    ['http://127.0.0.1:11434에 연결할 수 없어요. Ollama가 켜져 있나요?', 'disconnect'],
    ['fetch failed', 'disconnect'],
    ['모델이 한참 답이 없어서 멈췄어요. 모델이 메모리에 올라오는 중이거나 PC가 모자랄 수 있어요.', 'timeout'],
    ['The operation timed out', 'timeout'],
    ['http://x에서 답이 없어요. 같은 네트워크인지 확인해 주세요.', 'timeout'],
    ['뭔가 이상해요', 'other']
  ])('%s -> %s', (msg, kind) => {
    expect(classifyLocalError(msg)).toBe(kind)
  })

  it('memory and load are never retried; a dropped connection only a few times', () => {
    expect(localErrorPolicy('memory')).toEqual({ retries: 0, passOn: true })
    expect(localErrorPolicy('load')).toEqual({ retries: 0, passOn: true })
    expect(localErrorPolicy('disconnect').retries).toBe(LOCAL_QUEUE.disconnectRetries)
    expect(localErrorPolicy('disconnect').retries).toBeLessThanOrEqual(3)
    expect(localErrorPolicy('timeout').retries).toBe(0)
    expect(localErrorPolicy('other')).toEqual({ retries: 0, passOn: false })
  })
})

// ---------------- pure: the queue ----------------
describe('A3: 대기열', () => {
  it('one at a time per model, in order; places are told; other models are free', async () => {
    const q = new LocalQueue(() => 1)
    const k = modelKey('e1', 'm')
    const order: string[] = []
    const places: Record<string, number[]> = { b: [], c: [] }
    const a = await q.acquire(k)
    const pb = q.acquire(k, { onPosition: (n) => places.b.push(n) }).then((r) => (order.push('b'), r))
    const pc = q.acquire(k, { onPosition: (n) => places.c.push(n) }).then((r) => (order.push('c'), r))
    expect(q.running(k)).toBe(1)
    expect(q.waiting(k)).toBe(2)
    // another model does not wait
    const other = await q.acquire(modelKey('e1', 'other'))
    other()
    a()
    const rb = await pb
    expect(order).toEqual(['b'])
    expect(places.b).toEqual([1])
    expect(places.c).toEqual([2, 1])
    rb()
    ;(await pc)()
    expect(order).toEqual(['b', 'c'])
    expect(q.running(k)).toBe(0)
    expect(q.endpointBusy('e1')).toBe(false)
  })

  it('the limit is respected (2 at once) and release is idempotent', async () => {
    const q = new LocalQueue(() => 2)
    const k = modelKey('e', 'm')
    const r1 = await q.acquire(k)
    const r2 = await q.acquire(k)
    expect(q.tryAcquire(k)).toBeNull()
    r1()
    r1()
    expect(q.running(k)).toBe(1)
    const r3 = q.tryAcquire(k)
    expect(r3).not.toBeNull()
    r2()
    r3!()
  })

  it('cancelling a waiter takes it out of the line and the next one moves up', async () => {
    const q = new LocalQueue(() => 1)
    const k = modelKey('e', 'm')
    const first = await q.acquire(k)
    const ac = new AbortController()
    const seen: number[] = []
    const gone = q.acquire(k, { signal: ac.signal }).catch((e) => e)
    const next = q.acquire(k, { onPosition: (n) => seen.push(n) })
    expect(q.waiting(k)).toBe(2)
    ac.abort('cancel')
    expect(await gone).toBe('cancel')
    expect(q.waiting(k)).toBe(1)
    expect(seen).toEqual([2, 1])
    first()
    ;(await next)()
    expect(q.running(k)).toBe(0)
    // an already aborted signal never queues
    await expect(q.acquire(k, { signal: AbortSignal.abort('hold') })).rejects.toBe('hold')
  })

  it('waits at most maxWaitMs, then leaves the line', async () => {
    const q = new LocalQueue(() => 1)
    const k = modelKey('e', 'm')
    const first = await q.acquire(k)
    await expect(q.acquire(k, { maxWaitMs: 30 })).rejects.toBeInstanceOf(QueueWaitTimeout)
    expect(q.waiting(k)).toBe(0)
    first()
  })

  it('a chat turn (tryAcquire) never jumps the line', async () => {
    const q = new LocalQueue(() => 1)
    const k = modelKey('e', 'm')
    const first = await q.acquire(k)
    const waiter = q.acquire(k)
    first()
    // the place went to the waiter, not to a chat that asks right after
    expect(q.tryAcquire(k)).toBeNull()
    ;(await waiter)()
    const chat = q.tryAcquire(k)
    expect(chat).not.toBeNull()
    expect(q.endpointBusy('e')).toBe(true)
    chat!()
    expect(q.endpointBusy('e')).toBe(false)
  })

  it('the bubble says where in line', () => {
    const t = { id: 't', localWait: { position: 2, since: '', model: 'm' }, handoffs: [] } as unknown as Task
    const b = bubbleFor({ state: 'working', task: t, nameOf: (x) => x })
    expect(b.text).toBe(queueLine(2))
    expect(b.text).toBe('로컬 대기 중 (2번째)')
  })
})

// ---------------- pure: the hand-over order ----------------
const need: HandoffNeed = { kind: 'work', permission: 'edit', minTier: 'light', usesExternal: false, avoidModels: [], triedAdapters: [] }
const cand = (o: Partial<HandoffCand> & { agentId: string }): HandoffCand => ({ name: o.agentId, adapter: 'codex', modelKey: o.agentId, tier: 'balanced', weight: 3, isManager: false, idle: true, limited: false, ...o })
const from = { agentId: 'from', adapter: 'claude' as const, tier: 'balanced' as const, weight: 3 }

describe('A1: 인계 후보 순서와 사유', () => {
  it('a model on this PC is taken only when no outside employee can', () => {
    const local = cand({ agentId: 'pc', adapter: 'custom', tier: 'light', weight: 0.1, local: true })
    const out = cand({ agentId: 'codex', adapter: 'codex' })
    expect(pickHandoff(from, [local, out], need).pick?.cand.agentId).toBe('codex')
    expect(pickHandoff(from, [local, { ...out, limited: true }], need).pick?.cand.agentId).toBe('pc')
    // even a stronger outside tier beats the PC
    expect(pickHandoff(from, [local, cand({ agentId: 'big', tier: 'top', weight: 8 })], need).pick?.cand.agentId).toBe('big')
  })

  it('a blocked local employee is skipped with its reason', () => {
    const local = cand({ agentId: 'pc', adapter: 'custom', tier: 'light', local: true, blocked: '내 PC의 모델이 떠 있지 않음' })
    const r = pickHandoff(from, [local], need)
    expect(r.pick).toBeNull()
    expect(r.skipped).toEqual([{ agentId: 'pc', why: '내 PC의 모델이 떠 있지 않음' }])
  })

  it('a read-only task and a task with outside connections are not for a local employee (existing rules)', () => {
    const local = cand({ agentId: 'pc', adapter: 'custom', tier: 'light', local: true })
    expect(whyNot(local, from, { ...need, permission: 'read' })).toMatch(/읽기만/)
    expect(whyNot(local, from, { ...need, usesExternal: true })).toMatch(/외부 연결/)
    expect(whyNot(local, from, { ...need, minTier: 'balanced' })).toMatch(/체급/)
  })

  it('reasons are told apart', () => {
    expect(handoffReasonLabel('limit')).toBe('구독 한도')
    expect(handoffReasonLabel('memory')).toBe('PC 메모리 부족')
    expect(handoffReasonLabel('queue')).toBe('로컬 대기열')
    expect(handoffNote({ fromName: 'a', fromModel: 'm', reason: 'memory', rolledBack: false })).toContain('memory')
  })
})

// ---------------- with the engine and a fake OpenAI-compatible server ----------------
interface Fake {
  url: string
  server: Server
  calls: number
  inFlight: number
  maxInFlight: number
  delayMs: number
  /** What the n-th call does: text answer, an HTTP error, or a dropped socket. */
  mode: (n: number) => { text: string } | { status: number; body: string } | 'drop'
}
const BROKEN = 'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n'
const FIXED = 'function add(a, b) {\n  return a + b\n}\nmodule.exports = { add }\n'
const answerFor = (file: string): string => `=== FILE: ${file} ===\n\`\`\`js\n${FIXED}\`\`\``

async function fake(mode: Fake['mode']): Promise<Fake> {
  const f: Fake = { url: '', server: undefined as unknown as Server, calls: 0, inFlight: 0, maxInFlight: 0, delayMs: 0, mode }
  f.server = createServer((req, res) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', async () => {
      const u = req.url ?? ''
      if (u === '/api/version') return void res.end(JSON.stringify({ version: '0.5.0' }))
      if (u === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 4_700_000_000, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' } }] }))
      if (u === '/v1/chat/completions') {
        const n = ++f.calls
        f.inFlight++
        f.maxInFlight = Math.max(f.maxInFlight, f.inFlight)
        try {
          if (f.delayMs) await wait(f.delayMs)
          const m = f.mode(n)
          if (m === 'drop') return void req.socket.destroy()
          if ('status' in m) return void res.writeHead(m.status, { 'content-type': 'application/json' }).end(m.body)
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: m.text } }] })}\n\n`)
          res.write('data: [DONE]\n\n')
          return void res.end()
        } finally {
          f.inFlight--
        }
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r))
  f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`
  return f
}

let dir: string
let fakes: Fake[] = []
let engines: Engine[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s120-'))
})
afterEach(async () => {
  for (const e of engines) e.shutdown()
  engines = []
  for (const f of fakes) {
    f.server.closeAllConnections()
    await new Promise((r) => f.server.close(r))
  }
  fakes = []
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** A work folder holding calc.js (no checks: the result waits for a person, which is fine here). */
function folder(name: string): string {
  const d = join(dir, name)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'calc.js'), BROKEN)
  return d
}
const noRun: Runner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false })
const events = (eng: Engine, id: string): string => eng.taskHistory(id).events.map((e) => e.text).join('\n')

async function setup(f: Fake, runner: Runner = noRun): Promise<{ eng: Engine; ep: string }> {
  fakes.push(f)
  const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
  engines.push(eng)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'off' })
  eng.watchMs = 20
  const ep = await eng.localAdd({ url: f.url })
  return { eng, ep: ep.id }
}
const localAgent = (eng: Engine, ep: string, name: string, wd: string): string => eng.saveAgent({ name, adapter: 'claude', workDir: wd, localModel: { endpointId: ep, model: 'qwen2.5-coder:7b' } }).id
const mk = (eng: Engine, assignee: string, description = 'calc.js의 add가 뺄셈을 해요. 더하기로 고쳐 주세요.'): string => eng.createTask({ title: 'add 고치기', description, assignee }).id

describe('A3: 같은 모델을 쓰는 업무 두 개', () => {
  it('run one after another, the second one is told its place, and the line is empty afterwards', async () => {
    const f = await fake(() => ({ text: answerFor('calc.js') }))
    f.delayMs = 120
    const { eng, ep } = await setup(f)
    const a = localAgent(eng, ep, '하나', folder('w1'))
    const b = localAgent(eng, ep, '둘', folder('w2'))
    const t1 = mk(eng, a)
    const t2 = mk(eng, b)
    const p1 = eng.runTask(t1)
    await waitFor(() => f.inFlight === 1)
    const p2 = eng.runTask(t2)
    await waitFor(() => !!eng.hive.getTask(t2)?.localWait)
    expect(eng.hive.getTask(t2)!.localWait).toMatchObject({ position: 1, model: 'qwen2.5-coder:7b' })
    expect(eng.localQueue.waiting(modelKey(ep, 'qwen2.5-coder:7b'))).toBe(1)
    expect(await p1).toBe('done')
    expect(await p2).toBe('done')
    expect(f.calls).toBe(2)
    expect(f.maxInFlight).toBe(1)
    expect(events(eng, t2)).toContain('로컬 대기 중 (1번째)')
    expect(eng.hive.getTask(t2)!.localWait).toBeUndefined()
    expect(eng.localQueue.endpointBusy(ep)).toBe(false)
  }, 60_000)

  it('cancelling the waiting one takes it out of the line; nothing was run for it', async () => {
    const f = await fake(() => ({ text: answerFor('calc.js') }))
    f.delayMs = 250
    const { eng, ep } = await setup(f)
    const a = localAgent(eng, ep, '하나', folder('w1'))
    const wd2 = folder('w2')
    const b = localAgent(eng, ep, '둘', wd2)
    const t1 = mk(eng, a)
    const t2 = mk(eng, b)
    const p1 = eng.runTask(t1)
    await waitFor(() => f.inFlight === 1)
    const p2 = eng.runTask(t2)
    await waitFor(() => !!eng.hive.getTask(t2)?.localWait)
    eng.stopTask(t2, 'cancel')
    expect(await p2).toBe('cancelled')
    expect(eng.hive.getTask(t2)!.status).toBe('cancelled')
    expect(eng.hive.getTask(t2)!.localWait).toBeUndefined()
    expect(eng.localQueue.waiting(modelKey(ep, 'qwen2.5-coder:7b'))).toBe(0)
    expect(await p1).toBe('done')
    expect(f.calls).toBe(1)
    expect(readFileSync(join(wd2, 'calc.js'), 'utf8')).toBe(BROKEN)
  }, 60_000)

  it('chat and task on the same model: the chat is refused while a task has it, and the task waits while a chat has it', async () => {
    const f = await fake(() => ({ text: answerFor('calc.js') }))
    f.delayMs = 200
    const { eng, ep } = await setup(f)
    const a = localAgent(eng, ep, '하나', folder('w1'))
    const t1 = mk(eng, a)
    const p1 = eng.runTask(t1)
    await waitFor(() => f.inFlight === 1)
    const chat = eng.chatCreate({ model: { kind: 'local', endpointId: ep, model: 'qwen2.5-coder:7b' } })
    await expect(eng.chats.send(chat.id, '안녕')).rejects.toThrow(/업무가 쓰고 있어요/)
    expect(await p1).toBe('done')
    // a chat holds the place: a task started meanwhile waits for it
    const release = eng.localQueue.tryAcquire(modelKey(ep, 'qwen2.5-coder:7b'))!
    const t2 = mk(eng, localAgent(eng, ep, '둘', folder('w2')))
    const p2 = eng.runTask(t2)
    await waitFor(() => !!eng.hive.getTask(t2)?.localWait)
    expect(f.calls).toBe(1)
    release()
    expect(await p2).toBe('done')
  }, 60_000)
})

describe('A3: 오류에 따른 처리', () => {
  it('out of memory: one call only, no retry, logged as a class, the task asks for a person', async () => {
    const f = await fake(() => ({ status: 500, body: JSON.stringify({ error: { message: 'model requires more system memory (12.0 GiB) than is available (7.9 GiB)' } }) }))
    const { eng, ep } = await setup(f)
    const wd = folder('w1')
    const a = localAgent(eng, ep, '하나', wd)
    const t = mk(eng, a)
    expect(await eng.runTask(t)).toBe('needs_input')
    expect(f.calls).toBe(1)
    expect(eng.hive.getTask(t)).toMatchObject({ status: 'needs_input', assignee: a })
    expect(events(eng, t)).toContain('오류 분류: PC 메모리 부족')
    expect(readFileSync(join(wd, 'calc.js'), 'utf8')).toBe(BROKEN)
    expect(eng.hive.getTask(t)!.question).toMatch(/되풀이하지 않았어요/)
  }, 60_000)

  it('out of memory with an outside employee free: handed over with the reason 메모리', async () => {
    const f = await fake(() => ({ status: 500, body: JSON.stringify({ error: 'failed to allocate memory for the model' }) }))
    const { eng, ep } = await setup(f)
    const wd = folder('w1')
    const a = localAgent(eng, ep, '하나', wd)
    const outside = eng.saveAgent({ name: '코덱스', adapter: 'claude', workDir: wd, modelRef: { id: 'claude-haiku-5-5', pin: 'pinned' } })
    const t = mk(eng, a)
    await eng.runTask(t)
    await waitFor(() => (eng.hive.getTask(t)?.handoffs ?? []).length > 0)
    const h = eng.hive.getTask(t)!.handoffs![0]
    expect(h).toMatchObject({ from: a, to: outside.id, reason: 'memory', toAdapter: 'claude' })
    expect(f.calls).toBe(1)
  }, 60_000)

  it('model cannot be loaded: no retry either', async () => {
    const f = await fake(() => ({ status: 500, body: JSON.stringify({ error: 'llama runner process has terminated: exit status 2' }) }))
    const { eng, ep } = await setup(f)
    const t = mk(eng, localAgent(eng, ep, '하나', folder('w1')))
    expect(await eng.runTask(t)).toBe('needs_input')
    expect(f.calls).toBe(1)
    expect(events(eng, t)).toContain('오류 분류: 모델 불러오기 실패')
  }, 60_000)

  it('a dropped connection is tried a limited number of times (never forever), then fails', async () => {
    const f = await fake(() => 'drop')
    const { eng, ep } = await setup(f)
    const a = localAgent(eng, ep, '하나', folder('w1'))
    const t = mk(eng, a)
    const p = eng.runTask(t)
    expect(await p).toBe('failed')
    expect(f.calls).toBe(1 + LOCAL_QUEUE.disconnectRetries)
    expect(eng.hive.getTask(t)).toMatchObject({ status: 'failed', errorKind: 'network' })
    expect(events(eng, t)).toContain('오류 분류: 연결 끊김')
  }, 60_000)
})

// ---------------- A1: a local employee takes over when a connection ran out of usage ----------------
const LIMIT: Runner = async (_b, _o: RunOptions) => ({ code: 1, stdout: '', stderr: 'Claude usage limit reached. try again in 5 hours', timedOut: false, aborted: false })

describe('A1: 한도 때문에 로컬로 이어받기', () => {
  async function limited(opts: { description?: string; permission?: 'read' | 'edit'; allowLocal?: boolean; modelOff?: boolean; fullLine?: boolean; scope?: 'off' | 'easy' | 'limit-only'; history?: { passed: number; failed: number } } = {}) {
    const f = await fake(() => ({ text: answerFor('calc.js') }))
    const { eng, ep } = await setup(f, LIMIT)
    const wd = folder('w1')
    if (opts.allowLocal === false) eng.saveSettings({ handoff: { auto: true, up: true, confirmAtCostX: 2, waitMinutes: 20, rollbackStep: true, allowLocal: false } })
    if (opts.scope) eng.saveSettings({ handoff: { auto: true, up: true, confirmAtCostX: 2, waitMinutes: 20, rollbackStep: true, localScope: opts.scope } })
    const claude = eng.saveAgent({ name: '클로드', adapter: 'claude', workDir: wd, modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    const pc = localAgent(eng, ep, '작은손', wd)
    // A2: an earlier record of the model on this PC (first-pass results)
    const hist = opts.history
    for (let i = 0; hist && i < hist.passed + hist.failed; i++) {
      const pass = i < hist.passed
      eng.hive.saveAptitude({ taskId: `old${i}`, modelKey: 'local:' + ep + '|qwen2.5-coder:7b', modelLabel: 'q', domain: 'general', runs: 1, ms: 1, approved: pass ? 1 : 0, changes: 0, failed: pass ? 0 : 1, updatedAt: '' })
    }
    if (opts.modelOff) {
      f.server.closeAllConnections()
      await new Promise((r) => f.server.close(r))
      await eng.localRefresh(ep).catch(() => undefined)
    }
    let holders: (() => void)[] = []
    if (opts.fullLine) {
      const k = modelKey(ep, 'qwen2.5-coder:7b')
      const first = eng.localQueue.tryAcquire(k)!
      for (let i = 0; i < LOCAL_QUEUE.maxWaiting; i++) void eng.localQueue.acquire(k).then((r) => holders.push(r))
      holders = [first]
    }
    const t = eng.createTask({ title: 'add 고치기', description: opts.description ?? 'calc.js의 add가 뺄셈을 해요. 더하기로 고쳐 주세요.', assignee: claude.id, permission: opts.permission })
    await eng.runTask(t.id)
    return { eng, f, t: t.id, claude: claude.id, pc, wd }
  }

  it('an easy task: the local employee takes it over (reason 구독 한도) and does it', async () => {
    const { eng, t, pc, claude, wd, f } = await limited()
    await waitFor(() => eng.hive.getTask(t)?.status === 'done' || eng.hive.getTask(t)?.status === 'needs_review')
    const task = eng.hive.getTask(t)!
    expect(task.handoffs).toHaveLength(1)
    expect(task.handoffs![0]).toMatchObject({ from: claude, to: pc, reason: 'limit', toAdapter: 'custom' })
    expect(readFileSync(join(wd, 'calc.js'), 'utf8')).toBe(FIXED)
    expect(f.calls).toBe(1)
  }, 60_000)

  const stays = async (r: Awaited<ReturnType<typeof limited>>): Promise<void> => {
    await wait(150)
    const task = r.eng.hive.getTask(r.t)!
    expect(task.assignee).toBe(r.claude)
    expect(task.handoffs ?? []).toHaveLength(0)
    expect(task.limitWait).toBeTruthy()
    expect(r.f.calls).toBe(0)
  }

  it('too big (more than 3 files): not forced onto the local employee', async () => {
    await stays(await limited({ description: 'a.js b.js c.js d.js 를 모두 고쳐 주세요.' }))
  }, 60_000)

  it('read-only task: not handed to the local employee', async () => {
    await stays(await limited({ permission: 'read' }))
  }, 60_000)

  it('the model is not running: not handed over', async () => {
    const r = await limited({ modelOff: true })
    await wait(150)
    const task = r.eng.hive.getTask(r.t)!
    expect(task.assignee).toBe(r.claude)
    expect(task.handoffs ?? []).toHaveLength(0)
  }, 60_000)

  it('allowLocal off: not handed over', async () => {
    await stays(await limited({ allowLocal: false }))
  }, 60_000)

  it('a long line for the model: not handed over', async () => {
    await stays(await limited({ fullLine: true }))
  }, 60_000)

  it('A2 scope off: not handed over (same as allowLocal false)', async () => {
    await stays(await limited({ scope: 'off' }))
  }, 60_000)

  it('A2 scope limit-only: a limit still hands the easy task over', async () => {
    const { eng, t, pc } = await limited({ scope: 'limit-only' })
    await waitFor(() => !!eng.hive.getTask(t)?.handoffs?.length)
    expect(eng.hive.getTask(t)!.handoffs![0].to).toBe(pc)
  }, 60_000)

  it('A2 a good record: handed over', async () => {
    const { eng, t, pc } = await limited({ history: { passed: 5, failed: 0 } })
    await waitFor(() => !!eng.hive.getTask(t)?.handoffs?.length)
    expect(eng.hive.getTask(t)!.handoffs![0].to).toBe(pc)
  }, 60_000)

  it('A2 a bad record: not handed over, and the reason is written on the task', async () => {
    const r = await limited({ history: { passed: 1, failed: 4 } })
    await stays(r)
    const text = r.eng.hive.listEvents(r.t).map((e) => e.text).join('\n')
    expect(text).toContain('내 PC AI에게 넘기지 않았어요')
    expect(text).toContain('통과율 20%(5건)')
    // the tick looks again: the line is not repeated
    await r.eng.handoffs.onLimit(r.t)
    expect(r.eng.hive.listEvents(r.t).filter((e) => e.text.includes('내 PC AI에게 넘기지 않았어요'))).toHaveLength(1)
  }, 60_000)

  it('A2 a thin record (2 tries, both failed) is only a hint: the default rate is used, so it is still handed over', async () => {
    const { eng, t, pc } = await limited({ history: { passed: 0, failed: 2 } })
    await waitFor(() => !!eng.hive.getTask(t)?.handoffs?.length)
    expect(eng.hive.getTask(t)!.handoffs![0].to).toBe(pc)
  }, 60_000)

  describe('A2 hint when a person gives a task to the local employee', () => {
    async function assigned(scope?: 'off' | 'easy' | 'limit-only') {
      const f = await fake(() => ({ text: answerFor('calc.js') }))
      const { eng, ep } = await setup(f, LIMIT)
      const wd = folder('w1')
      if (scope) eng.saveSettings({ handoff: { auto: true, up: true, confirmAtCostX: 2, waitMinutes: 20, rollbackStep: true, localScope: scope } })
      const pc = localAgent(eng, ep, '작은손', wd)
      const hard = eng.createTask({ title: 'add 고치기', description: 'a.js b.js c.js d.js 를 모두 고쳐 주세요.', assignee: pc })
      const easy = eng.createTask({ title: 'add 고치기', description: 'calc.js의 add가 뺄셈을 해요. 더하기로 고쳐 주세요.', assignee: pc })
      const texts = (id: string): string => eng.hive.listEvents(id).map((e) => e.text).join('\n')
      return { easy: texts(easy.id), hard: texts(hard.id), eng }
    }
    it('easy scope (default): an easy task gets the hint, a hard one does not', async () => {
      const r = await assigned()
      expect(r.easy).toContain('이 일은 내 PC AI로 해도 괜찮아 보여요')
      expect(r.easy).toContain('아직 이력이 적어요')
      expect(r.hard).not.toContain('내 PC AI로 해도 괜찮아 보여요')
    }, 60_000)
    it.each(['off', 'limit-only'] as const)('%s: no hint', async (scope) => {
      expect((await assigned(scope)).easy).not.toContain('내 PC AI로 해도 괜찮아 보여요')
    }, 60_000)
    it('the old setting allowLocal false: no hint', async () => {
      const f = await fake(() => ({ text: answerFor('calc.js') }))
      const { eng, ep } = await setup(f, LIMIT)
      const wd = folder('w1')
      eng.saveSettings({ handoff: { auto: true, up: true, confirmAtCostX: 2, waitMinutes: 20, rollbackStep: true, allowLocal: false } })
      const pc = localAgent(eng, ep, '작은손', wd)
      const t = eng.createTask({ title: 'add 고치기', description: 'calc.js의 add가 뺄셈을 해요.', assignee: pc })
      expect(eng.hive.listEvents(t.id).map((e) => e.text).join('\n')).not.toContain('괜찮아 보여요')
    }, 60_000)
  })
})
