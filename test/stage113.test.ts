import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/main/engine'
import { namedPaths, pickFiles, safeTarget, sensitivePath } from '../src/main/localWorker'
import { LOCAL_SCOPE, parseAnswer, redactSecrets } from '../src/shared/localwork'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const block = (files: Record<string, string>): string => Object.entries(files).map(([p, c]) => `=== FILE: ${p} ===\n\`\`\`js\n${c}\`\`\``).join('\n\n')

const BROKEN = 'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n'
const FIXED = 'function add(a, b) {\n  return a + b\n}\nmodule.exports = { add }\n'

/** A fake OpenAI-compatible engine whose answers the test chooses (per call). */
interface Fake {
  url: string
  server: Server
  calls: { role: string; content: string }[][]
  answer: (n: number, msgs: { role: string; content: string }[]) => string
  delayMs: number
}
async function fake(answer: Fake['answer']): Promise<Fake> {
  const f: Fake = { url: '', server: undefined as unknown as Server, calls: [], answer, delayMs: 0 }
  f.server = createServer((req, res) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', async () => {
      const u = req.url ?? ''
      if (u === '/api/version') return void res.end(JSON.stringify({ version: '0.5.0' }))
      if (u === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 4_700_000_000, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' } }] }))
      if (u === '/v1/chat/completions') {
        const msgs = (JSON.parse(b) as { messages: { role: string; content: string }[] }).messages
        f.calls.push(msgs)
        if (f.delayMs) await wait(f.delayMs)
        if (res.destroyed) return
        const text = f.answer(f.calls.length, msgs)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        return void res.end()
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r))
  f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`
  return f
}

let dir: string
let wd: string
let fakes: Fake[] = []
let engines: Engine[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s113-'))
  wd = join(dir, 'proj')
  mkdirSync(wd, { recursive: true })
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

/** A project with a test that fails until `add` adds. */
function project(withChecks = true): void {
  writeFileSync(join(wd, 'calc.js'), BROKEN)
  if (withChecks) {
    mkdirSync(join(wd, 'node_modules'), { recursive: true })
    writeFileSync(join(wd, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node check.js' } }))
    writeFileSync(join(wd, 'check.js'), "const {add}=require('./calc');if(add(2,3)!==5){console.error('AssertionError: expected 5 got '+add(2,3));process.exit(1)}")
  }
}

async function setup(answer: Fake['answer'], collect = false): Promise<{ eng: Engine; f: Fake; agent: string }> {
  const f = await fake(answer)
  fakes.push(f)
  const eng = new Engine(join(dir, 'c.json'), () => {}, async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }), dir)
  engines.push(eng)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'off', collectExamples: collect })
  const ep = await eng.localAdd({ url: f.url })
  const a = eng.saveAgent({ name: '작은손', adapter: 'claude', workDir: wd, localModel: { endpointId: ep.id, model: 'qwen2.5-coder:7b' } })
  return { eng, f, agent: a.id }
}

const task = (eng: Engine, agent: string, description = 'calc.js의 add가 뺄셈을 해요. 더하기로 고쳐 주세요.'): string => eng.createTask({ title: 'add 고치기', description, assignee: agent }).id
const events = (eng: Engine, id: string): string => eng.taskHistory(id).events.map((e) => e.text).join('\n')

describe('v6 4단계: 로컬 모델 직원', () => {
  it('an employee on a model of this PC: no CLI, adapter custom, no budget, left out of hand-overs', async () => {
    const { eng, agent } = await setup(() => '')
    const a = eng.snapshot().config.agents.find((x) => x.id === agent)!
    expect(a).toMatchObject({ adapter: 'custom', model: 'qwen2.5-coder:7b', dailyRunLimit: 0, dailyMinuteLimit: 0, localModel: { model: 'qwen2.5-coder:7b' } })
    expect(a.command).toBeUndefined()
    // renaming the owner rebuilds the ids but keeps the model
    eng.saveSettings({ memberName: 'bob' })
    expect(eng.snapshot().config.agents[0].localModel?.model).toBe('qwen2.5-coder:7b')
  })

  it('fixes the file, the checks pass, the work is recorded (cost, time, activity) and a checkpoint is kept', async () => {
    project()
    const { eng, f, agent } = await setup(() => block({ 'calc.js': FIXED }))
    const id = task(eng, agent)
    expect(await eng.runTask(id)).toBe('done')
    expect(readFileSync(join(wd, 'calc.js'), 'utf8')).toBe(FIXED)
    expect(eng.hive.getTask(id)).toMatchObject({ status: 'done' })
    expect(eng.hive.getTask(id)?.checks?.ok).toBe(true)
    expect(f.calls).toHaveLength(1)
    const ev = events(eng, id)
    expect(ev).toContain('고칠 파일을 골랐어요: calc.js')
    expect(ev).toContain('자동 검사를 통과했어요')
    expect(eng.taskCost(id).runs).toBe(1)
    const runs = eng.taskHistory(id).runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ outcome: 'done', model: 'qwen2.5-coder:7b' })
    expect(runs[0].checkpoint).toBeTruthy()
  }, 60_000)

  it('a failed check is sent back with the error; the second answer passes', async () => {
    project()
    const { eng, f, agent } = await setup((n) => block({ 'calc.js': n === 1 ? BROKEN.replace('a - b', 'a * b') : FIXED }))
    const id = task(eng, agent)
    expect(await eng.runTask(id)).toBe('done')
    expect(f.calls).toHaveLength(2)
    const second = f.calls[1].map((m) => m.content).join('\n')
    expect(second).toContain('checks failed')
    expect(second).toContain('AssertionError')
    expect(readFileSync(join(wd, 'calc.js'), 'utf8')).toBe(FIXED)
    expect(events(eng, id)).toContain('자동 검사에 실패했어요 (1/3번째 시도)')
    expect(eng.hive.getTask(id)?.result).toContain('2번째 시도')
  }, 60_000)

  it('out of tries: everything is undone and a person gets the number of tries and the last error', async () => {
    project()
    const { eng, f, agent } = await setup(() => block({ 'calc.js': BROKEN.replace('a - b', 'a * b') }))
    const id = task(eng, agent)
    expect(await eng.runTask(id)).toBe('needs_input')
    expect(f.calls).toHaveLength(1 + LOCAL_SCOPE.maxRetries)
    expect(readFileSync(join(wd, 'calc.js'), 'utf8')).toBe(BROKEN)
    const t = eng.hive.getTask(id)!
    expect(t.status).toBe('needs_input')
    expect(t.question).toMatch(/3번 시도/)
    expect(t.question).toContain('AssertionError')
    expect(t.question).toContain('원래대로')
    const run = eng.taskHistory(id).runs[0]
    expect(run).toMatchObject({ outcome: 'failed' })
    expect(run.rolledBackAt).toBeTruthy()
  }, 90_000)

  it('too big for a small model: more than 3 files, or too many characters, or no way to tell which file', async () => {
    project()
    for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(wd, `${n}.js`), `// ${n}\n`)
    const { eng, f, agent } = await setup(() => block({ 'calc.js': FIXED }))
    const id = task(eng, agent, 'a.js b.js c.js d.js 를 모두 정리해 주세요')
    expect(await eng.runTask(id)).toBe('needs_input')
    expect(eng.hive.getTask(id)?.question).toMatch(/이 일은 내 PC AI에 맡기기엔 커요: 파일이 4개/)
    // long files
    writeFileSync(join(wd, 'big1.js'), 'x'.repeat(20_000))
    writeFileSync(join(wd, 'big2.js'), 'y'.repeat(10_000))
    const id2 = task(eng, agent, 'big1.js 와 big2.js 를 고쳐 주세요')
    expect(await eng.runTask(id2)).toBe('needs_input')
    expect(eng.hive.getTask(id2)?.question).toMatch(/30,000자|자로 길어요/)
    // nothing to go on
    const id3 = task(eng, agent, '뭔가 좀 개선해 주세요')
    expect(await eng.runTask(id3)).toBe('needs_input')
    expect(eng.hive.getTask(id3)?.question).toContain('정하지 못했어요')
    expect(f.calls).toHaveLength(0)
    expect(readFileSync(join(wd, 'calc.js'), 'utf8')).toBe(BROKEN)
    // a person's reply names the file: the task goes on
    eng.replyToTask(id3, 'calc.js 의 add 를 고쳐 주세요')
    for (let i = 0; i < 100 && eng.hive.getTask(id3)?.status !== 'done'; i++) await wait(100)
    expect(f.calls.length).toBe(1)
    expect(readFileSync(join(wd, 'calc.js'), 'utf8')).toBe(FIXED)
  }, 60_000)

  it('files are found by a keyword search when the request names none (few matches only)', () => {
    project()
    writeFileSync(join(wd, 'other.js'), 'module.exports = 1\n')
    const p = pickFiles(wd, 'The calc module returns a wrong sum')
    expect(p.ok && p.files.map((x) => x.path)).toEqual(['calc.js'])
    expect(namedPaths('src/a.ts, README.md 와 e.g 그리고 v1.2')).toEqual(['src/a.ts', 'README.md'])
  })

  it('paths that leave the folder, link out of it, or hold secrets are refused — nothing is applied', async () => {
    project()
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(wd, 'link'))
    for (const bad of ['../evil.js', '/etc/evil.js', 'link/x.js', '.env', 'config/id_rsa', '.git/hooks/pre-commit', 'sub/../../up.js']) {
      const { eng, agent } = await setup(() => block({ 'calc.js': FIXED, [bad]: 'x\n' }))
      const id = task(eng, agent)
      expect(await eng.runTask(id), bad).toBe('needs_input')
      expect(eng.hive.getTask(id)?.question, bad).toContain('아무것도 적용하지 않았어요')
      expect(readFileSync(join(wd, 'calc.js'), 'utf8'), bad).toBe(BROKEN)
      eng.shutdown()
    }
    expect(readdirSync(outside)).toEqual([])
    expect(existsSync(join(dir, 'evil.js'))).toBe(false)
    // an existing file the model was not shown is not overwritten either
    writeFileSync(join(wd, 'keep.js'), 'keep\n')
    const { eng, agent } = await setup(() => block({ 'calc.js': FIXED, 'keep.js': 'gone\n' }))
    const id = task(eng, agent)
    expect(await eng.runTask(id)).toBe('needs_input')
    expect(readFileSync(join(wd, 'keep.js'), 'utf8')).toBe('keep\n')
    expect(safeTarget(wd, 'calc.js')).toMatchObject({ ok: true })
    expect(sensitivePath('.env.example')).toBe(false)
    expect(sensitivePath('.env.local')).toBe(true)
    // too many files in one answer
    const many: Record<string, string> = { 'calc.js': FIXED }
    for (let i = 0; i < 5; i++) many[`n${i}.js`] = 'x\n'
    const s = await setup(() => block(many))
    const id2 = task(s.eng, s.agent)
    expect(await s.eng.runTask(id2)).toBe('needs_input')
    expect(s.eng.hive.getTask(id2)?.question).toMatch(/6개를 고치려고/)
  }, 120_000)

  it('a wrong answer format gets one correction; a second wrong one goes to a person', async () => {
    project()
    const { eng, f, agent } = await setup((n) => (n === 1 ? '네, 고쳤어요! add 함수를 더하기로 바꿨습니다.' : block({ 'calc.js': FIXED })))
    const id = task(eng, agent)
    expect(await eng.runTask(id)).toBe('done')
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1][f.calls[1].length - 1].content).toContain('The format was wrong')
    expect(events(eng, id)).toContain('형식이 맞지 않아서 한 번만')

    const g = await setup(() => '고쳤어요')
    const id2 = task(g.eng, g.agent)
    expect(await g.eng.runTask(id2)).toBe('needs_input')
    expect(g.f.calls).toHaveLength(2)
    expect(g.eng.hive.getTask(id2)?.question).toContain('형식이 맞지 않아요')
  }, 90_000)

  it('stopping while the model thinks cancels the task and leaves the files alone', async () => {
    project()
    const { eng, f, agent } = await setup(() => block({ 'calc.js': FIXED }))
    f.delayMs = 3000
    const id = task(eng, agent)
    const run = eng.runTask(id)
    await wait(400)
    eng.stopTask(id, 'cancel')
    expect(await run).toBe('cancelled')
    expect(eng.hive.getTask(id)?.status).toBe('cancelled')
    expect(readFileSync(join(wd, 'calc.js'), 'utf8')).toBe(BROKEN)
  }, 30_000)

  it('a model that does not answer: the task fails with a plain reason, nothing changed', async () => {
    project()
    const { eng, f, agent } = await setup(() => '')
    f.server.closeAllConnections()
    await new Promise((r) => f.server.close(r))
    fakes = []
    const id = task(eng, agent)
    expect(await eng.runTask(id)).toBe('failed')
    expect(eng.hive.getTask(id)?.error).toMatch(/응답하지 않았어요|연결할 수 없어요/)
    expect(readFileSync(join(wd, 'calc.js'), 'utf8')).toBe(BROKEN)
  }, 30_000)

  it('without any check in the folder it still works, but a person must look at the result', async () => {
    project(false)
    const { eng, agent } = await setup(() => block({ 'calc.js': FIXED }))
    const id = task(eng, agent)
    expect(await eng.runTask(id)).toBe('done')
    expect(eng.hive.getTask(id)?.status).toBe('needs_review')
    expect(events(eng, id)).toContain('자동 검사가 없어서')
    expect(readFileSync(join(wd, 'calc.js'), 'utf8')).toBe(FIXED)
  }, 30_000)

  it('a read-only task is not done by it', async () => {
    project()
    const { eng, f, agent } = await setup(() => block({ 'calc.js': FIXED }))
    const id = eng.createTask({ title: 'add 읽기', description: 'calc.js 확인', assignee: agent, permission: 'read' }).id
    expect(await eng.runTask(id)).toBe('needs_input')
    expect(f.calls).toHaveLength(0)
  })
})

describe('v6 4단계: 예시 모으기 (옵트인)', () => {
  const examples = (eng: Engine): string[] => {
    const d = join(eng.hive.root, '.local', 'examples')
    return existsSync(d) ? readdirSync(d).flatMap((f) => readFileSync(join(d, f), 'utf8').split('\n').filter(Boolean)) : []
  }

  it('off by default: nothing is written', async () => {
    project()
    const { eng, agent } = await setup(() => block({ 'calc.js': FIXED }))
    const id = task(eng, agent)
    await eng.runTask(id)
    expect(examples(eng)).toEqual([])
  }, 30_000)

  it('on: one line per job with secrets replaced; a person approving flips approved', async () => {
    project()
    writeFileSync(join(wd, 'calc.js'), BROKEN + "const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'\n")
    const { eng, agent } = await setup(() => block({ 'calc.js': FIXED + "const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'\n" }), true)
    eng.saveSettings({ humanReview: 'always' })
    const id = task(eng, agent, 'calc.js의 add를 고쳐 주세요. password=hunter2hunter2')
    await eng.runTask(id)
    expect(eng.hive.getTask(id)?.status).toBe('needs_review')
    let lines = examples(eng)
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('ghp_abc')
    expect(lines[0]).not.toContain('hunter2')
    const e = JSON.parse(lines[0])
    expect(e).toMatchObject({ taskId: id, attempts: 1, passed: true, approved: false, checks: { ran: true, ok: true } })
    expect(e.request).toContain('***')
    expect(e.given[0].path).toBe('calc.js')
    expect(e.received[0].content).toContain('a + b')
    eng.reviewTask(id, 'approve')
    lines = examples(eng)
    expect(JSON.parse(lines[0]).approved).toBe(true)
  }, 30_000)

  it('key-like text is replaced', () => {
    const s = redactSecrets(['sk-abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuv', 'AKIAABCDEFGHIJKLMNOP', 'password=abc123', 'api_key: "zzzz9999"', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'Bearer abcdefghijklmnopqrstuvwxyz'].join('\n'))
    expect(s).not.toMatch(/sk-abc|ghp_abc|AKIAABC|abc123|zzzz9999|MIIabc|abcdefghijklmnopqrstuvwxyz/)
    expect(s.match(/\*\*\*/g)!.length).toBeGreaterThanOrEqual(7)
    expect(redactSecrets('const total = a + b')).toBe('const total = a + b')
  })

  it('the answer format is read whole, with fences inside a file', () => {
    const r = parseAnswer('=== FILE: a.md ===\n```md\n# t\n```js\nx\n```\nend\n```\n\n=== FILE: b.js ===\n```\nb\n```')
    expect(r.ok && r.files.map((f) => f.path)).toEqual(['a.md', 'b.js'])
    expect(r.ok && r.files[0].content).toContain('```js')
    expect(parseAnswer('=== FILE: a.js ===\n```\n```').ok).toBe(false)
  })
})

describe('v6 4단계: 링크를 거친 작업 폴더', () => {
  it('a new file is allowed in a work folder that is reached through a link (macOS /var → /private/var), a way out is not', () => {
    const base = mkdtempSync(join(tmpdir(), 'hivedesk-link-'))
    try {
      const real = join(base, 'real')
      const link = join(base, 'link')
      mkdirSync(real)
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
      expect(safeTarget(link, 'new.js')).toMatchObject({ ok: true, rel: 'new.js' })
      expect(safeTarget(link, 'sub/new.js')).toMatchObject({ ok: true })
      expect(safeTarget(link, '../x.js')).toMatchObject({ ok: false })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
