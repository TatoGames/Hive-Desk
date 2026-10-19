import type { LocalModelInfo, EngineKind, SpeedResult } from '../shared/localai'
import { guessParamsB } from '../shared/localai'

/**
 * v6 8-2: a client for OpenAI-compatible engines on this PC (Ollama, LM Studio, ...) — no API key, a local address.
 * Plain `fetch`; every call takes an abort signal and a timeout.
 */

export type FetchFn = typeof fetch

export interface Conn {
  url: string
  token?: string
  fetchFn?: FetchFn
}

const headers = (c: Conn, json = false): Record<string, string> => ({
  ...(json ? { 'content-type': 'application/json' } : {}),
  ...(c.token ? { authorization: `Bearer ${c.token}` } : {})
})

function withTimeout(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(new Error('시간이 너무 오래 걸려서 멈췄어요.')), ms)
  const on = (): void => ac.abort(outer?.reason)
  if (outer?.aborted) ac.abort(outer.reason)
  else outer?.addEventListener('abort', on, { once: true })
  return {
    signal: ac.signal,
    done: () => {
      clearTimeout(t)
      outer?.removeEventListener('abort', on)
    }
  }
}

/** A short, human reason for a failed call. */
export function explainFetchError(e: unknown, url: string): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string } }
  const code = err.cause?.code
  if (code === 'ECONNREFUSED') return `${url}에 연결할 수 없어요. 엔진(Ollama·LM Studio)이 켜져 있는지 확인해 주세요.`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${url} 주소를 찾을 수 없어요.`
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') return `${url}에서 답이 없어요. 같은 네트워크인지, 방화벽이 막고 있지 않은지 확인해 주세요.`
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return err.message && !/aborted/i.test(err.message) ? err.message : '중지했어요.'
  if (err.message === 'fetch failed' || err.message === 'terminated') return `${url}와 연결이 끊겼어요.`
  return (err.message ?? String(e)).split('\n')[0].slice(0, 200)
}

async function getJson(c: Conn, path: string, ms = 5000, outer?: AbortSignal): Promise<unknown> {
  const f = c.fetchFn ?? fetch
  const t = withTimeout(ms, outer)
  try {
    const r = await f(c.url + path, { headers: headers(c), signal: t.signal })
    if (r.status === 401 || r.status === 403) throw new Error('이 주소는 토큰이 필요해요. 토큰을 입력해 주세요.')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    t.done()
  }
}

export interface ProbeResult {
  kind: EngineKind
  version?: string
  models: LocalModelInfo[]
}

/** Is there an engine, which kind, and what models does it have. Throws a readable error. */
export async function probe(c: Conn, outer?: AbortSignal): Promise<ProbeResult> {
  try {
    let version: string | undefined
    let kind: EngineKind = 'openai'
    try {
      const v = (await getJson(c, '/api/version', 3000, outer)) as { version?: string }
      if (typeof v?.version === 'string') {
        kind = 'ollama'
        version = v.version
      }
    } catch (e) {
      if ((e as Error).message.includes('토큰')) throw e
    }
    if (kind === 'ollama') return { kind, version, models: await ollamaTags(c, outer) }
    const j = (await getJson(c, '/v1/models', 5000, outer)) as { data?: { id?: string }[] }
    const models = (j.data ?? []).filter((m) => typeof m.id === 'string').map((m) => ({ name: m.id!, paramsB: guessParamsB(m.id!) }))
    return { kind, models }
  } catch (e) {
    throw new Error(explainFetchError(e, c.url))
  }
}

/** Ollama's list of installed models. */
export async function ollamaTags(c: Conn, outer?: AbortSignal): Promise<LocalModelInfo[]> {
  const j = (await getJson(c, '/api/tags', 5000, outer)) as { models?: { name?: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }[] }
  return (j.models ?? [])
    .filter((m) => typeof m.name === 'string')
    .map((m) => {
      const ps = m.details?.parameter_size?.match(/([\d.]+)\s*([BM])/i)
      const paramsB = ps ? (ps[2].toUpperCase() === 'M' ? Number(ps[1]) / 1000 : Number(ps[1])) : guessParamsB(m.name!)
      return { name: m.name!, sizeBytes: m.size, paramsB, quant: m.details?.quantization_level }
    })
}

/** Server-sent events: feed chunks, get the data payloads of the complete events. */
export class SseParser {
  private buf = ''
  push(chunk: string): string[] {
    this.buf += chunk.replace(/\r\n/g, '\n')
    const out: string[] = []
    let i: number
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const ev = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 2)
      const data = ev
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (data) out.push(data)
    }
    return out
  }
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamResult {
  text: string
  /** Output tokens when the engine says. */
  tokens?: number
  firstMs: number
  totalMs: number
}

export interface StreamOptions {
  signal?: AbortSignal
  onText?: (soFar: string) => void
  maxTokens?: number
  temperature?: number
  /** Give up after this long without any word (the model may be loading: first answers can take a while). */
  idleMs?: number
}

/** POST /v1/chat/completions with `stream: true`. */
export async function chatStream(c: Conn, model: string, messages: ChatMsg[], o: StreamOptions = {}): Promise<StreamResult> {
  const f = c.fetchFn ?? fetch
  const start = Date.now()
  const idleMs = o.idleMs ?? 120_000
  const ac = new AbortController()
  let idle: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => ac.abort(new Error('모델이 한참 답이 없어서 멈췄어요. 모델이 메모리에 올라오는 중이거나 PC가 모자랄 수 있어요.')), idleMs)
  }
  const outer = o.signal
  const on = (): void => ac.abort(outer?.reason)
  if (outer?.aborted) ac.abort(outer.reason)
  else outer?.addEventListener('abort', on, { once: true })
  arm()
  try {
    let r: Response
    try {
      r = await f(c.url + '/v1/chat/completions', {
        method: 'POST',
        headers: headers(c, true),
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
          ...(o.temperature !== undefined ? { temperature: o.temperature } : {})
        }),
        signal: ac.signal
      })
    } catch (e) {
      throw new Error(ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason.message : explainFetchError(e, c.url))
    }
    if (!r.ok) {
      let detail = ''
      try {
        const j = (await r.json()) as { error?: { message?: string } | string }
        detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? '')
      } catch {
        /* no body */
      }
      if (r.status === 401 || r.status === 403) throw new Error('이 주소는 토큰이 필요해요. 토큰을 입력해 주세요.')
      if (r.status === 404 && /not found/i.test(detail)) throw new Error(`모델 "${model}"이 설치돼 있지 않아요. (${detail.slice(0, 120)})`)
      throw new Error(`엔진이 오류를 돌려줬어요 (HTTP ${r.status})${detail ? ': ' + detail.slice(0, 160) : ''}`)
    }
    if (!r.body) throw new Error('엔진이 빈 답을 보냈어요.')
    const sse = new SseParser()
    const dec = new TextDecoder()
    const reader = r.body.getReader()
    let text = ''
    let firstMs = -1
    let tokens: number | undefined
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        for (const d of sse.push(dec.decode(value, { stream: true }))) {
          if (d === '[DONE]') continue
          try {
            const j = JSON.parse(d) as { choices?: { delta?: { content?: string } }[]; usage?: { completion_tokens?: number } }
            const piece = j.choices?.[0]?.delta?.content
            if (piece) {
              if (firstMs < 0) firstMs = Date.now() - start
              text += piece
              o.onText?.(text)
            }
            if (typeof j.usage?.completion_tokens === 'number') tokens = j.usage.completion_tokens
          } catch {
            /* a half line: skip */
          }
        }
      }
    } catch (e) {
      if (ac.signal.aborted && ac.signal.reason instanceof Error && outer?.aborted !== true) throw ac.signal.reason
      if (outer?.aborted) return { text, tokens, firstMs: Math.max(firstMs, 0), totalMs: Date.now() - start }
      throw new Error(explainFetchError(e, c.url))
    }
    return { text, tokens, firstMs: Math.max(firstMs, 0), totalMs: Date.now() - start }
  } finally {
    if (idle) clearTimeout(idle)
    outer?.removeEventListener('abort', on)
  }
}

/** A short answer to measure how fast this PC runs the model (the first call also loads it: that time is reported apart). */
export async function speedTest(c: Conn, model: string, outer?: AbortSignal): Promise<SpeedResult & { loadMs: number }> {
  const warm = await chatStream(c, model, [{ role: 'user', content: 'Say OK.' }], { signal: outer, maxTokens: 4, idleMs: 300_000 })
  const r = await chatStream(c, model, [{ role: 'user', content: 'Count from 1 to 40 separated by spaces, nothing else.' }], { signal: outer, maxTokens: 120, temperature: 0, idleMs: 120_000 })
  const estimated = r.tokens === undefined
  const tokens = r.tokens ?? Math.max(1, Math.round(r.text.length / 3))
  const secs = Math.max(0.05, (r.totalMs - r.firstMs) / 1000)
  return { firstMs: r.firstMs, perSec: Math.max(0, (tokens - 1) / secs), tokens, estimated, loadMs: warm.totalMs }
}

// ---- 8-2b: Ollama's own calls to install, update and remove models ----

export interface PullProgress {
  status: string
  /** 0..1 of the layer being downloaded, when known. */
  fraction?: number
  completed?: number
  total?: number
  done?: boolean
}

/** Parse one line of Ollama's `/api/pull` stream. */
export function parsePullLine(line: string): PullProgress | undefined {
  try {
    const j = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string }
    if (j.error) throw new Error(j.error)
    if (typeof j.status !== 'string') return undefined
    const total = typeof j.total === 'number' ? j.total : undefined
    const completed = typeof j.completed === 'number' ? j.completed : undefined
    return { status: j.status, total, completed, fraction: total && completed !== undefined ? Math.min(1, completed / total) : undefined, done: j.status === 'success' }
  } catch (e) {
    if (e instanceof SyntaxError) return undefined
    throw e
  }
}

/**
 * Download (or update, or resume) a model. Ollama keeps the parts already downloaded, so starting again after a
 * cancel or a lost connection continues where it stopped.
 */
export async function ollamaPull(c: Conn, name: string, o: { signal?: AbortSignal; onProgress?: (p: PullProgress) => void } = {}): Promise<void> {
  const f = c.fetchFn ?? fetch
  let r: Response
  try {
    r = await f(c.url + '/api/pull', { method: 'POST', headers: headers(c, true), body: JSON.stringify({ name, model: name, stream: true }), signal: o.signal })
  } catch (e) {
    if (o.signal?.aborted) throw new Error('중지했어요. 다시 누르면 이어서 받아요.')
    const why = explainFetchError(e, c.url)
    throw new Error(/끊겼어요/.test(why) ? why + ' 다시 누르면 이어서 받아요.' : why)
  }
  if (!r.ok || !r.body) throw new Error(`내려받기를 시작하지 못했어요 (HTTP ${r.status})`)
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let ended = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        const p = parsePullLine(line)
        if (p) {
          o.onProgress?.(p)
          if (p.done) ended = true
        }
      }
    }
  } catch (e) {
    if (o.signal?.aborted) throw new Error('중지했어요. 다시 누르면 이어서 받아요.')
    throw new Error(e instanceof Error && !(e.name === 'TypeError') ? e.message : '연결이 끊겼어요. 다시 누르면 이어서 받아요.')
  }
  if (!ended) throw new Error('내려받기가 끝나기 전에 연결이 끊겼어요. 다시 누르면 이어서 받아요.')
}

export async function ollamaDelete(c: Conn, name: string): Promise<void> {
  const f = c.fetchFn ?? fetch
  let r: Response
  try {
    r = await f(c.url + '/api/delete', { method: 'DELETE', headers: headers(c, true), body: JSON.stringify({ name, model: name }) })
  } catch (e) {
    throw new Error(explainFetchError(e, c.url))
  }
  if (r.status === 404) throw new Error('이미 없는 모델이에요.')
  if (!r.ok) throw new Error(`지우지 못했어요 (HTTP ${r.status})`)
}
