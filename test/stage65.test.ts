import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PermissionAnswer, RunOptions, Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { htmlToText, readPage } from '../src/main/webread'
import { accessOf, domainOf, mcpKey, siteAllowed } from '../src/shared/external'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s65-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = '[[DID: 했어요]]\n[[FILES: none]]\n[[VERIFY: 확인]]\n[[RISK: none]]\n[[NEXT: none]]'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await wait(20)
}

/** What `claude -p --output-format stream-json` prints: one assistant turn with these tool calls, then the result. */
function stream(uses: { name: string; input: Record<string, unknown> }[], text = REPORT): string {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'assistant', message: { content: uses.map((u, i) => ({ type: 'tool_use', id: 't' + i, name: u.name, input: u.input })) } },
    { type: 'result', subtype: 'success', result: text, session_id: 's1' }
  ]
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

/** A fake cipher: the OS secure storage in tests. */
const cipher = {
  available: () => true,
  encrypt: (s: string) => 'enc:' + Buffer.from(s).toString('base64'),
  decrypt: (b: string) => Buffer.from(b.slice(4), 'base64').toString()
}

/** A runner that asks for the given tools (as Claude would) and records what it was started with and told. */
function asking(uses: { name: string; input: Record<string, unknown> }[]) {
  const seen: { args: string[]; answers: PermissionAnswer[]; opts?: RunOptions; mcp?: string } = { args: [], answers: [] }
  const runner: Runner = async (b, o) => {
    seen.args = b.args
    seen.opts = o
    const i = b.args.indexOf('--mcp-config')
    if (i >= 0) seen.mcp = readFileSync(b.args[i + 1], 'utf8')
    o.onHandle?.({ send: () => true, interrupt: () => true, paused: () => false })
    for (const u of uses) if (o.onPermission) seen.answers.push(await o.onPermission({ tool: u.name, input: u.input }))
    const out = stream(uses)
    o.onOutput?.(out)
    return { code: 0, stdout: out, stderr: '', timedOut: false, aborted: false }
  }
  return { runner, seen }
}

function setup(runner: Runner, adapter: 'claude' | 'codex' = 'claude') {
  const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
  eng.cipher = cipher
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'off' })
  eng.watchMs = 20
  const work = join(dir, 'work')
  mkdirSync(work, { recursive: true })
  const agent = eng.saveAgent({ name: 'dev', adapter, workDir: work })
  return { eng, agent }
}

describe('6-5: shared rules', () => {
  it('an employee line wins over the rank line; no line = none', () => {
    const c = { access: { 'rank:r1': 'read', 'agent:a': 'write-approve' } } as never
    expect(accessOf(c, { id: 'a', rankId: 'r1' })).toBe('write-approve')
    expect(accessOf(c, { id: 'b', rankId: 'r1' })).toBe('read')
    expect(accessOf(c, { id: 'c' })).toBe('none')
  })

  it('allowed sites cover sub-domains but not look-alikes', () => {
    expect(domainOf('https://WWW.Docs.Godotengine.org/en/stable')).toBe('docs.godotengine.org')
    expect(siteAllowed('https://docs.godotengine.org/x', ['docs.godotengine.org'])).toBe(true)
    expect(siteAllowed('https://api.docs.godotengine.org/x', ['docs.godotengine.org'])).toBe(true)
    expect(siteAllowed('https://evildocs.godotengine.org.attacker.com/', ['docs.godotengine.org'])).toBe(false)
    expect(siteAllowed('not a url', ['x.com'])).toBe(false)
  })

  it('a page becomes plain text without scripts and styles', () => {
    const r = htmlToText('<html><head><title>Doc &amp; more</title><style>x{}</style></head><body><nav>menu</nav><h2>Hi</h2><p>a&nbsp;b</p><script>evil()</script><li>one</li></body></html>')
    expect(r.title).toBe('Doc & more')
    expect(r.text).toContain('## Hi')
    expect(r.text).toContain('a b')
    expect(r.text).toContain('- one')
    expect(r.text).not.toContain('evil')
    expect(r.text).not.toContain('menu')
  })

  it('only http(s) pages are read, and binary answers are refused', async () => {
    await expect(readPage('file:///etc/passwd')).rejects.toThrow('http')
    const bin = async () => ({ ok: true, status: 200, headers: { get: () => 'image/png' }, text: async () => '' })
    await expect(readPage('https://x.com/a.png', bin)).rejects.toThrow('글이 아닌')
  })
})

describe('6-5: the web during a run (Claude)', () => {
  it('nothing is used until a person gives access: web tools are refused', async () => {
    const { runner, seen } = asking([])
    const { eng, agent } = setup(runner)
    eng.saveConnection({ kind: 'web', name: '웹', web: { search: true, fetch: true, sites: ['docs.godotengine.org'] } })
    const t = eng.createTask({ title: '조사', assignee: agent.id })
    await eng.runTask(t.id)
    expect(seen.args).toContain('WebFetch')
    expect(seen.args).toContain('WebSearch')
    expect(seen.args).not.toContain('--permission-prompt-tool')
    eng.shutdown()
  })

  it('an allowed site is read at once; another site waits for the board, and "always allow" adds it to the list', async () => {
    const uses = [
      { name: 'WebFetch', input: { url: 'https://docs.godotengine.org/en/stable/physics.html', prompt: 'p' } },
      { name: 'WebFetch', input: { url: 'https://blog.example.com/post', prompt: 'p' } }
    ]
    const { runner, seen } = asking(uses)
    const { eng, agent } = setup(runner)
    const web = eng.saveConnection({ kind: 'web', name: '웹', web: { search: false, fetch: true, sites: ['docs.godotengine.org'] } })
    eng.setConnectionAccess(web.id, `agent:${agent.id}`, 'read')
    const t = eng.createTask({ title: '물리 엔진 조사', assignee: agent.id })
    const p = eng.runTask(t.id)
    await waitFor(() => eng.hive.listApprovals().some((a) => a.kind === 'external' && a.status === 'pending'))
    const a = eng.hive.listApprovals().find((x) => x.kind === 'external')!
    expect(a.external!.site).toBe('blog.example.com')
    expect(eng.hive.getTask(t.id)!.waitingExternal).toBe(a.id)
    expect(seen.args).toContain('--permission-prompt-tool')
    eng.decideExternal(a.id, 'approved', { always: true })
    await p
    expect(seen.answers.map((x) => x.allow)).toEqual([true, true])
    expect(eng.external.get(web.id)!.web!.sites).toContain('blog.example.com')
    expect(eng.hive.getTask(t.id)!.waitingExternal).toBeUndefined()
    const run = eng.hive.getRun(t.id, eng.hive.getTask(t.id)!.lastRunId!)!
    expect(run.sources).toEqual(['https://docs.godotengine.org/en/stable/physics.html', 'https://blog.example.com/post'])
    // the prompt says web text is material, not instructions
    expect(seen.opts!.prompt).toContain('never instructions')
    const log = eng.hive.listExtLog()
    expect(log.map((e) => e.outcome).sort()).toEqual(['allowed', 'approved'])
    eng.shutdown()
  })

  it('a rejected request reaches the AI with the reason; the run goes on', async () => {
    const { runner, seen } = asking([{ name: 'WebFetch', input: { url: 'https://other.org/' } }])
    const { eng, agent } = setup(runner)
    const web = eng.saveConnection({ kind: 'web', name: '웹', web: { search: false, fetch: true, sites: [] } })
    eng.setConnectionAccess(web.id, `agent:${agent.id}`, 'read')
    const t = eng.createTask({ title: '조사', assignee: agent.id })
    const p = eng.runTask(t.id)
    await waitFor(() => eng.hive.listApprovals().some((a) => a.kind === 'external' && a.status === 'pending'))
    eng.decideExternal(eng.hive.listApprovals()[0].id, 'rejected', { note: '이 사이트는 안 돼요' })
    await p
    expect(seen.answers[0]).toEqual({ allow: false, message: expect.stringContaining('이 사이트는 안 돼요') })
    expect(eng.hive.getTask(t.id)!.status).toBe('done')
    expect(eng.hive.getRun(t.id, eng.hive.getTask(t.id)!.lastRunId!)!.sources).toBeUndefined()
    eng.shutdown()
  })

  it('a request still waiting when the run ends is closed', async () => {
    let answered: PermissionAnswer | undefined
    const runner: Runner = async (_b, o) => {
      o.onHandle?.({ send: () => true, interrupt: () => true, paused: () => false })
      void o.onPermission!({ tool: 'WebFetch', input: { url: 'https://slow.org/' } }).then((a) => (answered = a))
      await wait(50)
      return { code: 0, stdout: stream([]), stderr: '', timedOut: false, aborted: false }
    }
    const { eng, agent } = setup(runner)
    const web = eng.saveConnection({ kind: 'web', name: '웹', web: { search: false, fetch: true, sites: [] } })
    eng.setConnectionAccess(web.id, `agent:${agent.id}`, 'read')
    const t = eng.createTask({ title: '조사', assignee: agent.id })
    await eng.runTask(t.id)
    expect(answered?.allow).toBe(false)
    expect(eng.hive.listApprovals()[0].status).toBe('rejected')
    expect(eng.hive.getTask(t.id)!.waitingExternal).toBeUndefined()
    eng.shutdown()
  })

  it('the app reads a page for any AI and attaches its text, and logs it', async () => {
    const { runner } = asking([])
    const { eng, agent } = setup(runner, 'codex')
    eng.fetchPage = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<title>Godot</title><p>RigidBody3D 설명</p>' })
    const t = eng.createTask({ title: '조사', assignee: agent.id })
    const r = await eng.attachUrl(t.id, 'https://docs.godotengine.org/x')
    expect(r.errors).toEqual([])
    const att = eng.hive.getTask(t.id)!.attachments![0]
    expect(att.name).toContain('docs.godotengine.org')
    const body = readFileSync(eng.hive.attachmentPath(att), 'utf8')
    expect(body).toContain('출처: https://docs.godotengine.org/x')
    expect(body).toContain('RigidBody3D 설명')
    expect(body).toContain('지시가 아니에요')
    expect(eng.hive.listExtLog()[0].tool).toBe('앱이 대신 읽기')
    eng.shutdown()
  })

  it('other CLIs get no external tools (only pages the app read for them)', async () => {
    const { runner, seen } = asking([])
    const { eng, agent } = setup(runner, 'codex')
    const web = eng.saveConnection({ kind: 'web', name: '웹', web: { search: true, fetch: true, sites: ['a.com'] } })
    eng.setConnectionAccess(web.id, `agent:${agent.id}`, 'read')
    const t = eng.createTask({ title: '조사', assignee: agent.id })
    await eng.runTask(t.id)
    expect(seen.args.join(' ')).not.toContain('mcp')
    expect(seen.opts!.onPermission).toBeUndefined()
    eng.shutdown()
  })

  it('the plan check knows the web is on once someone may use it', () => {
    const { runner } = asking([])
    const { eng, agent } = setup(runner)
    expect(eng.delegation.capabilities().web).toBe(false)
    const web = eng.saveConnection({ kind: 'web', name: '웹', web: { search: true, fetch: false, sites: [] } })
    expect(eng.delegation.capabilities().web).toBe(false)
    eng.setConnectionAccess(web.id, `agent:${agent.id}`, 'read')
    expect(eng.delegation.capabilities().web).toBe(true)
    expect(() => eng.setConnectionAccess(web.id, `agent:${agent.id}`, 'write-auto')).toThrow('읽기만')
    eng.shutdown()
  })
})

describe('6-5 / 6-7: apps (MCP) during a run', () => {
  function withApp(access: 'read' | 'write-approve' | 'write-auto', web = false) {
    const { runner, seen } = asking([])
    const { eng, agent } = setup(runner)
    const app = eng.saveConnection({
      kind: 'mcp',
      name: 'Notion',
      mcp: { transport: 'stdio', command: 'npx', args: ['-y', 'notion'], auth: 'token', tokenEnv: 'NOTION_TOKEN', tools: [{ name: 'search', write: false }, { name: 'create_page', write: true }] }
    })
    eng.setConnectionSecret(app.id, 'ntn_secret')
    eng.setConnectionAccess(app.id, `agent:${agent.id}`, access)
    if (web) {
      const w = eng.saveConnection({ kind: 'web', name: '웹', web: { search: false, fetch: true, sites: ['a.com'] } })
      eng.setConnectionAccess(w.id, `agent:${agent.id}`, 'read')
    }
    const key = mcpKey(app)
    return { eng, agent, app, key, seen }
  }

  it("only the company's servers the employee may use are loaded, with the token; reading tools need no question", async () => {
    const { eng, agent, key, seen } = withApp('read')
    const t = eng.createTask({ title: '노션 읽기', assignee: agent.id })
    await eng.runTask(t.id)
    const cfg = JSON.parse(seen.mcp!)
    expect(Object.keys(cfg.mcpServers)).toEqual([key])
    expect(cfg.mcpServers[key].env.NOTION_TOKEN).toBe('ntn_secret')
    expect(seen.args).toContain('--strict-mcp-config')
    expect(seen.args.join(' ')).toContain(`mcp__${key}__search`)
    expect(seen.args.join(' ')).not.toContain(`mcp__${key}__create_page`)
    // the file with the token is gone after the run, and the token is never in the shared company folder
    expect(existsSync(seen.args[seen.args.indexOf('--mcp-config') + 1])).toBe(false)
    expect(JSON.stringify(eng.hive.listExtConnections())).not.toContain('ntn_secret')
    eng.shutdown()
  })

  it('read access refuses writing; write-approve asks; write-auto writes and the run records it as an outside action', async () => {
    for (const access of ['read', 'write-approve', 'write-auto'] as const) {
      let current: Runner = asking([]).runner
      const { eng, agent } = setup((b, o) => current(b, o))
      const app = eng.saveConnection({ kind: 'mcp', name: 'Slack', mcp: { transport: 'http', url: 'https://x/mcp', auth: 'none', tools: [{ name: 'post', write: true }] } })
      eng.setConnectionAccess(app.id, `agent:${agent.id}`, access)
      const fake = asking([{ name: `mcp__${mcpKey(app)}__post`, input: { channel: 'general', text: '배포 완료' } }])
      current = fake.runner
      // a different title each round: the same task within 5 seconds is merged into one (P21)
      const t = eng.createTask({ title: `알림 ${access}`, assignee: agent.id })
      const p = eng.runTask(t.id)
      if (access === 'write-approve') {
        await waitFor(() => eng.hive.listApprovals().some((a) => a.status === 'pending'))
        const a = eng.hive.listApprovals()[0]
        expect(a.external!.write).toBe(true)
        expect(a.external!.input).toContain('배포 완료')
        // the person changes what is sent
        eng.decideExternal(a.id, 'approved', { edited: JSON.stringify({ channel: 'general', text: '배포 완료 (확인함)' }) })
      }
      await p
      const ans = fake.seen.answers[0]
      expect(ans.allow).toBe(access !== 'read')
      if (access === 'write-approve') expect(ans).toEqual({ allow: true, input: { channel: 'general', text: '배포 완료 (확인함)' } })
      const run = eng.hive.getRun(t.id, eng.hive.getTask(t.id)!.lastRunId!)!
      expect(run.external?.length ?? 0).toBe(access === 'read' ? 0 : 1)
      expect(eng.hive.listExtLog()[0].outcome).toBe(access === 'read' ? 'denied' : access === 'write-approve' ? 'edited' : 'auto')
      eng.shutdown()
    }
  })

  it('after reading the web, an automatic write needs approval (a page cannot make the AI send things out)', async () => {
    let current: Runner = asking([]).runner
    const { eng, agent } = setup((b, o) => current(b, o))
    const app = eng.saveConnection({ kind: 'mcp', name: 'Slack', mcp: { transport: 'http', url: 'https://x/mcp', auth: 'none', tools: [{ name: 'post', write: true }] } })
    eng.setConnectionAccess(app.id, `agent:${agent.id}`, 'write-auto')
    const w = eng.saveConnection({ kind: 'web', name: '웹', web: { search: false, fetch: true, sites: ['a.com'] } })
    eng.setConnectionAccess(w.id, `agent:${agent.id}`, 'read')
    const fake = asking([
      { name: 'WebFetch', input: { url: 'https://a.com/page' } },
      { name: `mcp__${mcpKey(app)}__post`, input: { text: 'secret data' } }
    ])
    current = fake.runner
    const t = eng.createTask({ title: '조사 후 알림', assignee: agent.id })
    const p = eng.runTask(t.id)
    await waitFor(() => eng.hive.listApprovals().some((a) => a.status === 'pending'))
    const a = eng.hive.listApprovals()[0]
    expect(a.reason).toContain('웹을 읽어서')
    eng.decideExternal(a.id, 'rejected')
    await p
    expect(fake.seen.answers.map((x) => x.allow)).toEqual([true, false])
    eng.shutdown()
  })

  it('a request left from a closed app is closed by the next tick', async () => {
    const { runner } = asking([])
    const { eng, agent } = setup(runner)
    const t = eng.createTask({ title: '일', assignee: agent.id })
    const a = eng.hive.createApproval({ kind: 'external', taskId: t.id, agentId: agent.id, reason: '옛 요청' })
    eng.hive.updateTask(t.id, { waitingExternal: a.id })
    await eng.tick()
    expect(eng.hive.listApprovals()[0].status).toBe('rejected')
    expect(eng.hive.getTask(t.id)!.waitingExternal).toBeUndefined()
    eng.shutdown()
  })

  it('a token is refused when the computer has no secure storage', () => {
    const { runner } = asking([])
    const { eng } = setup(runner)
    eng.cipher = null
    const app = eng.saveConnection({ kind: 'mcp', name: 'X', mcp: { transport: 'http', url: 'https://x', auth: 'token', tools: [] } })
    expect(() => eng.setConnectionSecret(app.id, 'tok')).toThrow('보안 저장소')
    eng.shutdown()
  })

  it('pushing and gh are never left to the AI when the company has a GitHub connection', async () => {
    const { runner, seen } = asking([{ name: 'Bash', input: { command: 'git push origin main' } }])
    const { eng, agent } = setup(runner)
    eng.saveConnection({ kind: 'github', name: 'GitHub' })
    const t = eng.createTask({ title: '일', assignee: agent.id })
    await eng.runTask(t.id)
    expect(seen.args).toContain('Bash(git push *)')
    expect(seen.args).not.toContain('--permission-prompt-tool') // GitHub alone asks nothing
    expect(seen.answers[0]).toEqual({ allow: false, message: expect.stringContaining('HiveDesk가') })
    eng.shutdown()
  })
})

/** Stand-in for `claude -p --permission-prompt-tool stdio`: after initialize it asks before a tool and reports the answer. */
const FAKE_ASK = `
const rl = require('readline').createInterface({ input: process.stdin })
const out = (o) => console.log(JSON.stringify(o))
let inited = false
rl.on('line', (l) => {
  const m = JSON.parse(l)
  if (m.type === 'control_request' && m.request.subtype === 'initialize') { inited = true; out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } }); return }
  if (m.type === 'user') {
    out({ type: 'user', isReplay: true, message: m.message })
    if (!inited) { out({ type: 'result', subtype: 'success', result: 'NO INIT' }); return }
    out({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'WebFetch', input: { url: 'https://a.com' } } })
  } else if (m.type === 'control_response' && m.response.request_id === 'p1') {
    const r = m.response.response
    out({ type: 'result', subtype: 'success', result: r.behavior === 'allow' ? 'ALLOWED ' + JSON.stringify(r.updatedInput) : 'DENIED ' + r.message })
  }
})
`

describe('6-5: the permission protocol of the real runner', () => {
  const run = (answer: (req: { tool: string; input: Record<string, unknown> }) => Promise<PermissionAnswer>, idleTimeoutMs = 20000) => {
    const script = join(dir, 'fake-ask.js')
    writeFileSync(script, FAKE_ASK)
    return import('../src/main/adapters').then(({ runCli }) =>
      runCli({ command: process.execPath, args: [script], live: true, permissionPrompt: true } as never, { cwd: dir, env: process.env, prompt: 'go', timeoutMs: 30000, idleTimeoutMs, onPermission: answer } as never)
    )
  }

  it('initialize comes first, the answer goes back, and the run ends', async () => {
    const r = await run(async (req) => ({ allow: true, input: { ...req.input, url: 'https://b.com' } }))
    expect(r.code).toBe(0)
    // the answer (with the input the person changed) reached the CLI
    expect(r.stdout).toContain('ALLOWED {\\"url\\":\\"https://b.com\\"}')
  })

  it('a refusal carries its reason; a long wait for a person does not count as silence', async () => {
    const r = await run(async () => {
      await wait(1500)
      return { allow: false, message: '거절했어요' }
    }, 500)
    expect(r.timedOut).toBe(false)
    expect(r.stdout).toContain('DENIED 거절했어요')
  })
})
