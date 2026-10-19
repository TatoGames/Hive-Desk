import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BENCH_TASKS, benchPrompt, extractCode } from '../src/shared/bench'
import { fitNote, guessParamsB, normalizeUrl, parseCandidates, recommendTier, tierOfParams, type PcInfo } from '../src/shared/localai'
import { runBench, runCheck } from '../src/main/bench'
import { Engine } from '../src/main/engine'
import { chatStream, explainFetchError, ollamaDelete, ollamaPull, parsePullLine, probe, speedTest, SseParser } from '../src/main/openai'
import { diagnosePc, parseNvidia } from '../src/main/pcinfo'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A fake Ollama / OpenAI-compatible engine on a local port. */
interface Fake {
  url: string
  server: Server
  installed: string[]
  pulls: number
  deleted: string[]
  answer: (prompt: string, model: string) => string
  /** Break the next pull after this many progress lines. */
  breakPullAfter?: number
  token?: string
  ollama: boolean
  chatCalls: number
  slow?: boolean
}

async function fake(o: Partial<Pick<Fake, 'ollama' | 'token' | 'answer' | 'installed'>> = {}): Promise<Fake> {
  const f: Fake = { url: '', server: undefined as unknown as Server, installed: o.installed ?? ['qwen2.5-coder:7b'], pulls: 0, deleted: [], answer: o.answer ?? (() => '안녕하세요'), token: o.token, ollama: o.ollama ?? true, chatCalls: 0 }
  const body = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((res) => {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => res(b ? JSON.parse(b) : {}))
    })
  f.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (f.token && req.headers.authorization !== `Bearer ${f.token}`) {
      res.writeHead(401).end()
      return
    }
    const path = req.url ?? ''
    if (path === '/api/version') {
      if (!f.ollama) return void res.writeHead(404).end()
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '0.5.0' }))
    }
    if (path === '/api/tags') return void res.writeHead(200).end(JSON.stringify({ models: f.installed.map((name) => ({ name, size: 4_700_000_000, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' } })) }))
    if (path === '/v1/models') return void res.writeHead(200).end(JSON.stringify({ data: f.installed.map((id) => ({ id })) }))
    if (path === '/api/pull') {
      const b = await body(req)
      f.pulls++
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      const lines = [{ status: 'pulling manifest' }, { status: 'pulling abc', total: 100, completed: 30 }, { status: 'pulling abc', total: 100, completed: 70 }, { status: 'verifying sha256 digest' }, { status: 'success' }]
      for (const [i, l] of lines.entries()) {
        if (f.breakPullAfter !== undefined && i >= f.breakPullAfter) {
          f.breakPullAfter = undefined
          await wait(30)
          res.destroy()
          return
        }
        res.write(JSON.stringify(l) + '\n')
        if (f.slow) await wait(80)
      }
      if (res.destroyed) return
      f.installed.push(String(b.name))
      return void res.end()
    }
    if (path === '/api/delete' && req.method === 'DELETE') {
      const b = await body(req)
      if (!f.installed.includes(String(b.name))) return void res.writeHead(404).end()
      f.installed = f.installed.filter((x) => x !== b.name)
      f.deleted.push(String(b.name))
      return void res.writeHead(200).end()
    }
    if (path === '/v1/chat/completions') {
      const b = await body(req)
      f.chatCalls++
      const msgs = b.messages as { content: string }[]
      const text = f.answer(msgs[msgs.length - 1].content, String(b.model))
      if (!f.installed.includes(String(b.model))) return void res.writeHead(404).end(JSON.stringify({ error: { message: `model '${b.model}' not found` } }))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const parts = text.match(/[\s\S]{1,6}/g) ?? ['']
      for (const p of parts) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
        if (f.slow) await wait(60)
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: parts.length } })}\n\n`)
      res.write('data: [DONE]\n\n')
      return void res.end()
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r))
  f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`
  return f
}

let dir: string
let fakes: Fake[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s112-'))
})
afterEach(async () => {
  for (const f of fakes) {
    f.server.closeAllConnections()
    await new Promise((r) => f.server.close(r))
  }
  fakes = []
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})
const mk = async (...a: Parameters<typeof fake>): Promise<Fake> => {
  const f = await fake(...a)
  fakes.push(f)
  return f
}

describe('8-2: addresses, sizes and the tier of a PC', () => {
  it('addresses are read leniently; a bare host gets the usual port', () => {
    expect(normalizeUrl('localhost')).toBe('http://127.0.0.1:11434')
    expect(normalizeUrl('localhost:1234')).toBe('http://127.0.0.1:1234')
    expect(normalizeUrl('http://192.168.0.5:1234/v1/')).toBe('http://192.168.0.5:1234')
    expect(normalizeUrl('https://box.example/ollama/v1')).toBe('https://box.example/ollama')
    expect(normalizeUrl('  ')).toBeUndefined()
  })

  it('sizes come from names; tiers follow the size', () => {
    expect(guessParamsB('qwen2.5-coder:7b')).toBe(7)
    expect(guessParamsB('llama3.2:3b')).toBe(3)
    expect(guessParamsB('mixtral-8x7b-instruct')).toBe(56)
    expect(guessParamsB('gemma:e4b')).toBe(4)
    expect(guessParamsB('qwen:0.5b')).toBe(0.5)
    expect(guessParamsB('phi3:mini')).toBeUndefined()
    expect([tierOfParams(3), tierOfParams(7), tierOfParams(32), tierOfParams(undefined)]).toEqual(['light', 'balanced', 'top', 'balanced'])
  })

  it('the tier follows the memory that matters, and the measured speed beats the specification', () => {
    const base: PcInfo = { platform: 'linux', arch: 'x64', ramGB: 16, cores: 8, appleSilicon: false }
    expect(recommendTier(base).tier).toBe('light')
    expect(recommendTier({ ...base, ramGB: 64 }).tier).toBe('balanced')
    expect(recommendTier({ ...base, gpu: { name: 'RTX 4090', vramGB: 24 } }).tier).toBe('top')
    expect(recommendTier({ ...base, ramGB: 32, appleSilicon: true, platform: 'darwin', arch: 'arm64' }).where).toBe('unified')
    const big = { ...base, gpu: { name: 'RTX 4090', vramGB: 24 } }
    expect(recommendTier(big, { firstMs: 1, perSec: 3, tokens: 50, estimated: false }).tier).toBe('light')
    expect(recommendTier(big, { firstMs: 1, perSec: 8, tokens: 50, estimated: false }).tier).toBe('balanced')
    expect(recommendTier(big, { firstMs: 1, perSec: 40, tokens: 50, estimated: false }).tier).toBe('top')
    const a = recommendTier(base)
    expect(fitNote({ name: 'x:70b', paramsB: 70 }, a)).toMatch(/큰 모델/)
    expect(fitNote({ name: 'x:3b', paramsB: 3 }, a)).toBeUndefined()
  })

  it('the candidate file is parsed without throwing and unchecked licenses stay marked', () => {
    const f = parseCandidates({ updatedAt: 'x', models: [{ id: 'a:7b', paramsB: 7, licenseStatus: 'checked', licenseUrl: 'http://bad' }, { nope: 1 }, { id: 'b:3b', paramsB: 3 }] })
    expect(f.models.map((m) => [m.id, m.licenseStatus, m.tier, m.licenseUrl])).toEqual([['a:7b', 'checked', 'balanced', undefined], ['b:3b', 'unchecked', 'light', undefined]])
    expect(parseCandidates(null).models).toEqual([])
  })

  it('NVIDIA output and the diagnosis never throw', async () => {
    expect(parseNvidia('NVIDIA GeForce RTX 3060, 12288\n')).toEqual({ name: 'NVIDIA GeForce RTX 3060', vramGB: 12 })
    expect(parseNvidia('')).toBeUndefined()
    const sys = { totalmem: () => 32 * 1024 ** 3, cpus: () => new Array(8).fill({}) as never, platform: () => 'linux' as const, arch: () => 'x64' }
    const withGpu = await diagnosePc(async () => 'RTX 4070, 12282\n', sys)
    expect(withGpu).toMatchObject({ ramGB: 32, cores: 8, gpu: { vramGB: 12 }, appleSilicon: false })
    const none = await diagnosePc(async () => {
      throw new Error('no such command')
    }, sys)
    expect(none.gpu).toBeUndefined()
  })
})

describe('8-2: talking to an engine', () => {
  it('finds Ollama and its models; other engines through /v1/models; a token is asked for; a closed port is explained', async () => {
    const o = await mk()
    const r = await probe({ url: o.url })
    expect(r.kind).toBe('ollama')
    expect(r.models[0]).toMatchObject({ name: 'qwen2.5-coder:7b', paramsB: 7.6, quant: 'Q4_K_M' })
    const l = await mk({ ollama: false, installed: ['local-model'] })
    expect(await probe({ url: l.url })).toMatchObject({ kind: 'openai', models: [{ name: 'local-model' }] })
    const t = await mk({ token: 'sekret' })
    await expect(probe({ url: t.url })).rejects.toThrow('토큰이 필요')
    expect((await probe({ url: t.url, token: 'sekret' })).kind).toBe('ollama')
    const dead = await mk()
    const gone = dead.url
    await new Promise((r) => dead.server.close(r))
    await expect(probe({ url: gone })).rejects.toThrow('연결할 수 없어요')
  })

  it('explains a refused connection by port', () => {
    const e = { cause: { code: 'ECONNREFUSED' } }
    expect(explainFetchError(e, 'http://localhost:11434')).toMatch(/연결할 수 없어요.*ollama\.com/)
    expect(explainFetchError(e, 'localhost:1234')).toMatch(/연결할 수 없어요.*LM Studio/)
    const other = explainFetchError(e, 'http://localhost:9999')
    expect(other).toMatch(/연결할 수 없어요/)
    expect(other).not.toMatch(/LM Studio|ollama\.com/)
  })

  it('streams the answer, reports it as it grows, and keeps what came when stopped', async () => {
    const f = await mk({ answer: () => '가나다라마바사아자차카타파하' })
    const seen: string[] = []
    const r = await chatStream({ url: f.url }, 'qwen2.5-coder:7b', [{ role: 'user', content: '안녕' }], { onText: (t) => seen.push(t) })
    expect(r.text).toBe('가나다라마바사아자차카타파하')
    expect(seen.length).toBeGreaterThan(1)
    expect(r.tokens).toBeGreaterThan(0)
    await expect(chatStream({ url: f.url }, 'nope:1b', [{ role: 'user', content: 'x' }])).rejects.toThrow('설치돼 있지 않아요')

    f.slow = true
    const ac = new AbortController()
    const p = chatStream({ url: f.url }, 'qwen2.5-coder:7b', [{ role: 'user', content: '안녕' }], { signal: ac.signal, onText: () => ac.abort() })
    const cut = await p
    expect(cut.text.length).toBeGreaterThan(0)
    expect(cut.text.length).toBeLessThan('가나다라마바사아자차카타파하'.length)
  })

  it('SSE events split across chunks are put together', () => {
    const p = new SseParser()
    expect(p.push('data: {"a":1}\n\nda')).toEqual(['{"a":1}'])
    expect(p.push('ta: [DONE]\r\n\r\n')).toEqual(['[DONE]'])
  })

  it('the speed test gives tokens per second and a load time', async () => {
    const f = await mk({ answer: () => '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20' })
    f.slow = true
    const s = await speedTest({ url: f.url }, 'qwen2.5-coder:7b')
    expect(s.perSec).toBeGreaterThan(1)
    expect(s.estimated).toBe(false)
    expect(s.loadMs).toBeGreaterThan(0)
  })
})

describe('8-1: the measurement tasks', () => {
  const refs: Record<string, string> = {
    'sum-off-by-one': 'function sum(arr){let t=0;for(let i=0;i<arr.length;i++)t+=arr[i];return t}\nmodule.exports={sum}',
    palindrome: "function isPalindrome(s){const t=s.toLowerCase().replace(/[^a-z0-9]/g,'');return t===[...t].reverse().join('')}\nmodule.exports={isPalindrome}",
    'greet-param': "function greet(name,punct='!'){return 'Hello, '+name+punct}\nmodule.exports={greet}",
    rename: 'function totalPrice(items){return items.reduce((s,x)=>s+x.price*x.qty,0)}\nmodule.exports={totalPrice}',
    'average-empty': 'function average(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}\nmodule.exports={average}',
    'group-by': 'function groupBy(a,f){const o={};for(const x of a){const k=f(x);(o[k]??=[]).push(x)}return o}\nmodule.exports={groupBy}',
    promisify: 'function readLater(v){return new Promise(r=>setTimeout(()=>r(v),1))}\nmodule.exports={readLater}',
    'csv-line': "function parseCsvLine(l){const out=[];let cur='',q=false;for(const c of l){if(c==='\"')q=!q;else if(c===','&&!q){out.push(cur);cur=''}else cur+=c}out.push(cur);return out}\nmodule.exports={parseCsvLine}",
    'uniq-order': 'function uniq(a){return a.filter((x,i)=>a.indexOf(x)===i)}\nmodule.exports={uniq}',
    'divide-guard': "function divide(a,b){if(b===0)throw new RangeError('zero');return a/b}\nmodule.exports={divide}"
  }

  it('every task has a reference answer that passes and a starting file that does not', async () => {
    expect(BENCH_TASKS.length).toBe(10)
    for (const t of BENCH_TASKS) {
      expect(await runCheck(refs[t.id], t.test), t.id + ' reference').toBeUndefined()
      if (t.start) expect(await runCheck(t.start, t.test), t.id + ' start').toBeDefined()
      expect(benchPrompt(t)).toContain(t.ask)
    }
  }, 60_000)

  it('code is taken from the last fenced block', () => {
    expect(extractCode('설명\n```js\nA\n```\n그리고\n```js\nB\n```')).toBe('B\n')
    expect(extractCode('아무 코드도 없어요')).toBeUndefined()
  })

  it('a run asks each task, checks the answer, and counts passes and time', async () => {
    const f = await mk({
      installed: ['m:7b'],
      answer: (prompt) => {
        const t = BENCH_TASKS.find((x) => prompt.includes(x.ask))!
        return t.id === 'palindrome' ? '```js\nmodule.exports = {}\n```' : '```js\n' + refs[t.id] + '\n```'
      }
    })
    const rows: string[] = []
    const s = await runBench({ url: f.url }, 'm:7b', { onRow: (r) => rows.push(`${r.id}:${r.ok}`) })
    expect(s.total).toBe(10)
    expect(s.passed).toBe(9)
    expect(s.rows.find((r) => !r.ok)).toMatchObject({ id: 'palindrome' })
    expect(rows.length).toBe(10)
  }, 60_000)

  it('stopping ends the run cleanly with what is done', async () => {
    const f = await mk({ installed: ['m:7b'], answer: () => '```js\nmodule.exports={}\n```' })
    const ac = new AbortController()
    const s = await runBench({ url: f.url }, 'm:7b', { signal: ac.signal, onRow: (_r, i) => i === 2 && ac.abort() })
    expect(s.rows.length).toBe(3)
  }, 60_000)
})

describe('8-2b: install, update, stop and resume, remove', () => {
  it('progress lines are read; an error line throws', () => {
    expect(parsePullLine('{"status":"pulling x","total":200,"completed":50}')).toMatchObject({ fraction: 0.25 })
    expect(parsePullLine('{"status":"success"}')?.done).toBe(true)
    expect(parsePullLine('not json')).toBeUndefined()
    expect(() => parsePullLine('{"error":"pull model manifest: file does not exist"}')).toThrow('file does not exist')
  })

  it('a pull reports progress; a cut connection says it can be resumed, and the second try finishes', async () => {
    const f = await mk({ installed: [] })
    const seen: (number | undefined)[] = []
    f.breakPullAfter = 2
    await expect(ollamaPull({ url: f.url }, 'llama3.2:3b', { onProgress: (p) => seen.push(p.fraction) })).rejects.toThrow('이어서 받아요')
    expect(seen).toContain(undefined)
    expect(f.installed).toEqual([])
    await ollamaPull({ url: f.url }, 'llama3.2:3b', { onProgress: (p) => seen.push(p.fraction) })
    expect(seen).toContain(0.7)
    expect(f.installed).toEqual(['llama3.2:3b'])
    await ollamaDelete({ url: f.url }, 'llama3.2:3b')
    expect(f.installed).toEqual([])
    await expect(ollamaDelete({ url: f.url }, 'llama3.2:3b')).rejects.toThrow('이미 없는')
  })
})

describe('8-2: the whole thing in the engine', () => {
  function engine(): Engine {
    const eng = new Engine(join(dir, 'c.json'), () => {}, async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    eng.cipher = { available: () => true, encrypt: (s) => 'enc:' + s, decrypt: (b) => b.slice(4) }
    return eng
  }

  it('an address is checked and kept; its models show in the chat list; a chat is answered by it; the token is kept encrypted', async () => {
    const f = await mk({ token: 'tok', answer: (p) => `내 PC가 답해요: ${p.slice(-4)}` })
    const eng = engine()
    await expect(eng.localAdd({ url: f.url })).rejects.toThrow('토큰')
    const ep = await eng.localAdd({ url: f.url, token: 'tok', name: '내 노트북' })
    expect(ep).toMatchObject({ name: '내 노트북', kind: 'ollama', hasToken: true })
    expect(JSON.stringify(eng.config)).not.toContain('tok"')
    expect(Object.values(eng.machine.secretBlobs())).toContain('enc:tok')
    await expect(eng.localAdd({ url: f.url, token: 'tok' })).rejects.toThrow('이미 연결')

    await eng.localRefresh()
    const models = eng.chatModels().filter((m) => m.where === 'local')
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ weight: 0, tier: 'balanced', ok: true })
    const c = eng.chatCreate({ model: models[0].model })
    const done = await eng.chatSend(c.id, '질문입니다')
    expect(done.messages[1]).toMatchObject({ role: 'assistant', status: 'done', text: '내 PC가 답해요: 문입니다' })
    // it is the lightest in cost but never the surprise default: nothing else here, so it is chosen
    expect(eng.chatCreate().model).toMatchObject({ kind: 'local' })
    eng.shutdown()
  })

  it('a stopped engine is shown as unreachable and the chat says why', async () => {
    const f = await mk()
    const eng = engine()
    await eng.localAdd({ url: f.url })
    await eng.localRefresh()
    const model = eng.chatModels().find((m) => m.where === 'local')!.model
    f.server.closeAllConnections()
    await new Promise((r) => f.server.close(r))
    fakes = fakes.filter((x) => x !== f)
    await eng.localRefresh()
    expect(eng.chatModels().find((m) => m.where === 'local')).toMatchObject({ ok: false })
    const c = eng.chatCreate({ model })
    const r = await eng.chatSend(c.id, '안녕')
    expect(r.messages[1]).toMatchObject({ status: 'failed' })
    expect(r.messages[1].error).toMatch(/연결할 수 없어요/)
    eng.shutdown()
  })

  it('speed test and measurement are kept and move the recommended tier; one measurement at a time', async () => {
    const f = await mk({ answer: (p) => (p.includes('Count') ? '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20' : 'OK') })
    f.slow = true
    const eng = engine()
    const ep = await eng.localAdd({ url: f.url })
    const sp = await eng.localSpeed(ep.id, 'qwen2.5-coder:7b')
    expect(sp.state).toBe('done')
    let st = await eng.localStatus()
    expect(Object.keys(st.speed)).toEqual([`${ep.id}|qwen2.5-coder:7b`])
    expect(st.advice.reasons.join(' ')).toContain('측정한 속도')
    expect(st.endpoints[0].state?.models[0].name).toBe('qwen2.5-coder:7b')

    f.slow = false
    f.answer = () => '```js\nmodule.exports={}\n```'
    const b = eng.localBench(ep.id, 'qwen2.5-coder:7b')
    await expect(eng.localBench(ep.id, 'qwen2.5-coder:7b')).rejects.toThrow('이미 하고 있어요')
    await expect(eng.localSpeed(ep.id, 'qwen2.5-coder:7b')).rejects.toThrow('한 번에 하나')
    const job = await b
    expect(job.state).toBe('done')
    st = await eng.localStatus()
    expect(st.bench[`${ep.id}|qwen2.5-coder:7b`].total).toBe(10)
    eng.shutdown()
  }, 60_000)

  it('install with progress; stop then resume; a model in use is not removed; remove; unknown engines cannot install', async () => {
    const f = await mk({ installed: [] })
    const eng = engine()
    const ep = await eng.localAdd({ url: f.url })
    f.slow = true
    const run = eng.localPull(ep.id, 'llama3.2:3b')
    await wait(120)
    let st = await eng.localStatus()
    expect(st.jobs[0]).toMatchObject({ kind: 'pull', state: 'running' })
    await expect(eng.localPull(ep.id, 'llama3.2:3b')).rejects.toThrow('이미 하고 있어요')
    eng.localStop(st.jobs[0].id)
    expect((await run).state).toBe('stopped')
    expect(f.installed).toEqual([])
    const again = await eng.localPull(ep.id, 'llama3.2:3b')
    expect(again.state).toBe('done')
    expect(f.installed).toEqual(['llama3.2:3b'])
    st = await eng.localStatus()
    expect(st.endpoints[0].state?.models.map((m) => m.name)).toEqual(['llama3.2:3b'])
    expect(st.candidates.models.length).toBeGreaterThan(0)
    expect(st.candidates.models.every((m) => m.licenseStatus === 'unchecked')).toBe(true)

    f.answer = () => '느린 답'.repeat(10)
    const c = eng.chatCreate({ model: { kind: 'local', endpointId: ep.id, model: 'llama3.2:3b' } })
    const sending = eng.chatSend(c.id, '안녕')
    await wait(150)
    await expect(eng.localDeleteModel(ep.id, 'llama3.2:3b')).rejects.toThrow('대화에 쓰이는 중')
    await sending
    await eng.localDeleteModel(ep.id, 'llama3.2:3b')
    expect(f.deleted).toEqual(['llama3.2:3b'])
    expect((await eng.localStatus()).endpoints[0].state?.models).toEqual([])

    const plain = await mk({ ollama: false, installed: ['m'] })
    const op = await eng.localAdd({ url: plain.url })
    await expect(eng.localPull(op.id, 'x:1b')).rejects.toThrow('Ollama에서만')
    eng.shutdown()
  }, 60_000)

  it('a replacement candidate file is used when present', async () => {
    const eng = engine()
    writeFileSync(join(dir, 'local-models.json'), JSON.stringify({ updatedAt: '2027-01-01', models: [{ id: 'new:9b', paramsB: 9, licenseStatus: 'checked' }] }))
    const st = await eng.localStatus()
    expect(st.candidates.models.map((m) => m.id)).toEqual(['new:9b'])
    writeFileSync(join(dir, 'local-models.json'), '{broken')
    expect((await eng.localStatus()).candidates.models.length).toBeGreaterThan(1)
    eng.shutdown()
  })
})
