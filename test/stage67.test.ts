import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/main/engine'
import { classifyTools, listMcpTools, mcpConfig, mergeTools, type HttpFetch } from '../src/main/mcp'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s67-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** A tiny MCP server on stdio: it answers initialize and tools/list, and shows whether it got the token. */
const SERVER = `
const rl = require('readline').createInterface({ input: process.stdin })
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (l) => {
  const m = JSON.parse(l)
  if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } })
  if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'search', description: 'find pages (token ' + (process.env.FAKE_TOKEN === 'tok-1' || process.env.FAKE_TOKEN === 'tok-2' ? 'received' : 'missing') + ')', annotations: { readOnlyHint: true } },
    { name: 'create_page', description: 'make a page' },
    { name: 'delete_page', annotations: { readOnlyHint: false, destructiveHint: true } }
  ] } })
})
`

describe('6-7: apps over MCP', () => {
  it('tools with a read-only hint read; everything else writes', () => {
    const t = classifyTools([{ name: 'a', annotations: { readOnlyHint: true } }, { name: 'b' }, { name: 'c', annotations: { readOnlyHint: false } }, { description: 'no name' }])
    expect(t.map((x) => [x.name, x.write])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true]
    ])
  })

  it('what a person set by hand survives reading the list again', () => {
    const merged = mergeTools([{ name: 'b', write: false, manual: true }], [{ name: 'b', write: true }, { name: 'd', write: true }])
    expect(merged).toEqual([{ name: 'b', write: false, manual: true }, { name: 'd', write: true }])
  })

  it('lists the tools of a local (stdio) server and hands it the token in its variable', async () => {
    const script = join(dir, 'server.js')
    writeFileSync(script, SERVER)
    const tools = await listMcpTools({ transport: 'stdio', command: process.execPath, args: [script], auth: 'token', tokenEnv: 'FAKE_TOKEN', tools: [] }, 'tok-1', { timeoutMs: 15000 })
    expect(tools.map((t) => [t.name, t.write])).toEqual([
      ['search', false],
      ['create_page', true],
      ['delete_page', true]
    ])
    expect(tools[0].description).toContain('token received')
  })

  it('a missing program says so', async () => {
    await expect(listMcpTools({ transport: 'stdio', command: 'no-such-mcp-program-xyz', auth: 'none', tools: [] }, undefined, { timeoutMs: 5000 })).rejects.toThrow()
  })

  it('lists the tools of a remote (http) server: event-stream answers, the session id and the bearer token', async () => {
    const calls: { headers: Record<string, string>; body: string }[] = []
    const fetchFn: HttpFetch = async (_url, init) => {
      calls.push({ headers: { ...init.headers }, body: init.body })
      const m = JSON.parse(init.body)
      const headers = { get: (n: string) => (n.toLowerCase() === 'mcp-session-id' ? 'sess-9' : n.toLowerCase() === 'content-type' ? 'text/event-stream' : null) }
      if (m.method === 'initialize') return { ok: true, status: 200, headers, text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n\n` }
      if (m.method === 'tools/list') return { ok: true, status: 200, headers, text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'post' }] } })}\n\n` }
      return { ok: true, status: 202, headers, text: async () => '' }
    }
    const tools = await listMcpTools({ transport: 'http', url: 'https://x/mcp', auth: 'token', tools: [] }, 'secret', { fetchFn })
    expect(tools).toEqual([{ name: 'post', write: true }])
    expect(calls[0].headers.Authorization).toBe('Bearer secret')
    expect(calls[2].headers['Mcp-Session-Id']).toBe('sess-9')
  })

  it('a refused login is explained', async () => {
    const fetchFn: HttpFetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => '' })
    await expect(listMcpTools({ transport: 'http', url: 'https://x/mcp', auth: 'none', tools: [] }, undefined, { fetchFn })).rejects.toThrow('로그인이 필요')
  })

  it('the run config holds only the given servers, with the secret where the server expects it', () => {
    const cfg = mcpConfig([
      { key: 'hd_a', s: { transport: 'stdio', command: 'npx', args: ['x'], auth: 'token', tokenEnv: 'T', env: { TEAM: '1' }, tools: [] }, token: 'tok' },
      { key: 'hd_b', s: { transport: 'http', url: 'https://b/mcp', auth: 'token', tools: [] }, token: 'tb' },
      { key: 'hd_c', s: { transport: 'http', url: 'http://127.0.0.1:3845/mcp', auth: 'none', tools: [] } }
    ])
    expect(cfg.mcpServers.hd_a).toEqual({ type: 'stdio', command: 'npx', args: ['x'], env: { TEAM: '1', T: 'tok' } })
    expect(cfg.mcpServers.hd_b).toEqual({ type: 'http', url: 'https://b/mcp', headers: { Authorization: 'Bearer tb' } })
    expect(cfg.mcpServers.hd_c).toEqual({ type: 'http', url: 'http://127.0.0.1:3845/mcp' })
  })

  it('the engine reads the tool list with the stored token and keeps manual choices', async () => {
    const script = join(dir, 'server.js')
    writeFileSync(script, SERVER)
    const eng = new Engine(join(dir, 'c.json'), () => {}, async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    eng.cipher = { available: () => true, encrypt: (s) => 'x' + s, decrypt: (b) => b.slice(1) }
    const c = eng.saveConnection({ kind: 'mcp', name: 'Fake', mcp: { transport: 'stdio', command: process.execPath, args: [script], auth: 'token', tokenEnv: 'FAKE_TOKEN', tools: [] } })
    expect((await eng.refreshMcpTools(c.id)).message).toContain('토큰')
    eng.setConnectionSecret(c.id, 'tok-2')
    const r = await eng.refreshMcpTools(c.id)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('도구 3개')
    eng.setMcpToolWrite(c.id, 'create_page', false)
    await eng.refreshMcpTools(c.id)
    const tools = eng.external.get(c.id)!.mcp!.tools
    expect(tools.find((t) => t.name === 'create_page')).toMatchObject({ write: false, manual: true })
    expect(tools[0].description).toContain('token received')
    // the view says a token is there, without showing it
    const v = eng.snapshot().ext.connections[0]
    expect(v.hasSecret).toBe(true)
    expect(JSON.stringify(eng.snapshot())).not.toContain('tok-2')
    eng.deleteConnection(c.id)
    expect(eng.machine.secretBlobs()).toEqual({})
    eng.shutdown()
  })
})
