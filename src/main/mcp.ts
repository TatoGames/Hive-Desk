import { spawn } from 'node:child_process'
import type { McpSettings, McpTool } from '../shared/external'

/**
 * Just enough of an MCP client to list a server's tools when it is connected (stage 6-7): the app reads the
 * tool list and sorts the tools into reading and writing ones. Running the tools is Claude Code's job.
 */

interface RawTool {
  name?: unknown
  description?: unknown
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown }
}

/** Tools that say they only read are reading tools; everything else counts as writing (it may change things outside). */
export function classifyTools(list: RawTool[]): McpTool[] {
  return list
    .filter((t) => typeof t.name === 'string' && t.name)
    .map((t) => ({
      name: t.name as string,
      ...(typeof t.description === 'string' && t.description ? { description: t.description.slice(0, 300) } : {}),
      write: t.annotations?.readOnlyHint !== true
    }))
}

/** Keep what a person set by hand when the list is read again. */
export function mergeTools(old: McpTool[], fresh: McpTool[]): McpTool[] {
  return fresh.map((t) => {
    const o = old.find((x) => x.name === t.name && x.manual)
    return o ? { ...t, write: o.write, manual: true } : t
  })
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'HiveDesk', version: '0.4' } }
}

export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

/** A JSON-RPC answer from a plain JSON body or from an event stream (`data: {...}` lines). */
function rpcAnswer(body: string, id: number): Record<string, unknown> | null {
  const tries = body.trim().startsWith('{') ? [body] : body.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5))
  for (const t of tries) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>
      if (j.id === id) return j
    } catch {
      /* not this line */
    }
  }
  return null
}

async function listHttp(s: McpSettings, token: string | undefined, fetchFn: HttpFetch, timeoutMs: number): Promise<McpTool[]> {
  if (!s.url) throw new Error('서버 주소가 없어요.')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const post = async (msg: Record<string, unknown>): Promise<{ body: string; session: string | null }> => {
      const r = await fetchFn(s.url!, { method: 'POST', headers, body: JSON.stringify(msg), signal: ac.signal })
      if (r.status === 401 || r.status === 403) throw new Error(token ? '로그인 정보(토큰)가 맞지 않거나 권한이 없어요.' : '이 서버는 로그인이 필요해요. 토큰을 넣어 주세요.')
      if (!r.ok && r.status !== 202) throw new Error(`서버가 오류를 돌려줬어요 (HTTP ${r.status}).`)
      return { body: await r.text(), session: r.headers.get('mcp-session-id') }
    }
    const init = await post(INIT)
    if (init.session) headers['Mcp-Session-Id'] = init.session
    const ia = rpcAnswer(init.body, 1)
    if (!ia || ia.error) throw new Error('MCP 서버가 아니거나 연결을 받지 않았어요.')
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const la = rpcAnswer(list.body, 2)
    const tools = (la?.result as { tools?: RawTool[] } | undefined)?.tools
    if (!Array.isArray(tools)) throw new Error('도구 목록을 받지 못했어요.')
    return classifyTools(tools)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('서버가 응답하지 않아요 (시간 초과).')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function listStdio(s: McpSettings, token: string | undefined, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    if (!s.command) return reject(new Error('실행할 명령이 없어요.'))
    const win = process.platform === 'win32'
    const childEnv = { ...env, ...(s.env ?? {}), ...(token && s.tokenEnv ? { [s.tokenEnv]: token } : {}) }
    let child
    try {
      child = win
        ? spawn([s.command, ...(s.args ?? [])].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), { env: childEnv, shell: true, windowsHide: true })
        : spawn(s.command, s.args ?? [], { env: childEnv })
    } catch (e) {
      return reject(e as Error)
    }
    let buf = ''
    let err = ''
    let finished = false
    const finish = (f: () => void): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* gone */
      }
      f()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('서버가 응답하지 않아요 (시간 초과). 처음 실행이면 설치에 시간이 걸릴 수 있어요. 다시 해 보세요.'))), timeoutMs)
    const send = (m: Record<string, unknown>): void => {
      child.stdin?.write(JSON.stringify(m) + '\n')
    }
    child.on('error', (e: NodeJS.ErrnoException) => finish(() => reject(new Error(e.code === 'ENOENT' ? `명령을 찾을 수 없어요: ${s.command}` : e.message))))
    child.on('close', (code) => finish(() => reject(new Error(`서버가 끝났어요 (코드 ${code}). ${err.trim().split('\n').slice(-3).join(' ')}`.trim()))))
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    child.stdin?.on('error', () => {
      /* closed early */
    })
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let j: Record<string, unknown>
        try {
          j = JSON.parse(line)
        } catch {
          continue
        }
        if (j.id === 1) {
          if (j.error) return finish(() => reject(new Error('MCP 서버가 연결을 받지 않았어요.')))
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (j.id === 2) {
          const tools = (j.result as { tools?: RawTool[] } | undefined)?.tools
          if (!Array.isArray(tools)) return finish(() => reject(new Error('도구 목록을 받지 못했어요.')))
          return finish(() => resolve(classifyTools(tools)))
        }
      }
    })
    send(INIT)
  })
}

/** Ask the server for its tools (connect, initialize, tools/list) and sort them into reading and writing ones. */
export function listMcpTools(s: McpSettings, token: string | undefined, opts: { env?: NodeJS.ProcessEnv; fetchFn?: HttpFetch; timeoutMs?: number } = {}): Promise<McpTool[]> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  return s.transport === 'http'
    ? listHttp(s, token, opts.fetchFn ?? (fetch as unknown as HttpFetch), timeoutMs)
    : listStdio(s, token, opts.env ?? process.env, timeoutMs)
}

/** The `--mcp-config` content for one run: only this company's servers the employee may use, with the secrets filled in. */
export function mcpConfig(servers: { key: string; s: McpSettings; token?: string }[]): { mcpServers: Record<string, Record<string, unknown>> } {
  const out: Record<string, Record<string, unknown>> = {}
  for (const { key, s, token } of servers) {
    if (s.transport === 'http') {
      out[key] = { type: 'http', url: s.url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) }
    } else {
      out[key] = { type: 'stdio', command: s.command, args: s.args ?? [], env: { ...(s.env ?? {}), ...(token && s.tokenEnv ? { [s.tokenEnv]: token } : {}) } }
    }
  }
  return { mcpServers: out }
}
