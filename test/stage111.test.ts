import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BuiltCommand, RunOptions, Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { chatPrompt, chatTitle, type ChatMessage, type ChatModel } from '../src/shared/chat'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s111-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const msg = (role: ChatMessage['role'], text: string, status: ChatMessage['status'] = 'done'): ChatMessage => ({ id: text, role, text, at: '', status })

describe('챗-1: what is sent', () => {
  it('a model that cannot continue a session gets the earlier conversation; the newest messages win when it is too long', () => {
    const hist = [msg('user', 'a'.repeat(100)), msg('assistant', 'b'.repeat(100)), msg('system', '모델 바뀜'), msg('user', 'c'.repeat(100)), msg('assistant', 'x', 'failed'), msg('assistant', 'd'.repeat(100))]
    const p = chatPrompt(hist, '새 질문')
    expect(p.omitted).toBe(0)
    expect(p.text).toContain('Person: ' + 'a'.repeat(100))
    expect(p.text).not.toContain('모델 바뀜') // marks are for people, not for the model
    expect(p.text).not.toContain('Person: x')
    expect(p.text.endsWith('새 질문')).toBe(true)
    const cut = chatPrompt(hist, '새 질문', { budget: 260 })
    expect(cut.omitted).toBeGreaterThan(0)
    expect(cut.text).toContain('left out')
    expect(cut.text).toContain('d'.repeat(100)) // the newest is kept
    expect(cut.text).not.toContain('a'.repeat(100))
    // the new message is never cut, however small the budget
    expect(chatPrompt(hist, '새 질문', { budget: 1 }).text).toContain('새 질문')
  })

  it('a session that goes on gets only the new message; the folders are told in words; titles come from the first question', () => {
    expect(chatPrompt(hist(), '그다음은?', { resumed: true }).text).toBe('그다음은?')
    expect(chatPrompt([], '질문', { folders: ['/proj'] }).text).toContain('- /proj')
    expect(chatTitle('  이 에러가   무슨 뜻이야?  ')).toBe('이 에러가 무슨 뜻이야?')
    expect(chatTitle('가'.repeat(80)).length).toBe(40)
    expect(chatTitle('   ')).toBe('새 대화')
  })
})
function hist(): ChatMessage[] {
  return [msg('user', '안녕'), msg('assistant', '안녕하세요')]
}

/** claude answers in stream-json (with a session), codex in its JSON lines. */
function setup(over: { run?: (b: BuiltCommand, o: RunOptions) => Promise<Partial<Awaited<ReturnType<Runner>>>> } = {}) {
  const calls: { adapter: string; args: string[]; prompt: string; cwd: string }[] = []
  const runner: Runner = async (b, o) => {
    calls.push({ adapter: b.command, args: b.args, prompt: o.prompt, cwd: o.cwd })
    if (over.run) {
      const r = await over.run(b, o)
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...r }
    }
    const answer = `답변 ${calls.length}`
    const out =
      b.command === 'claude'
        ? JSON.stringify({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: answer }] } }) + '\n' + JSON.stringify({ type: 'result', result: answer, session_id: 'sess-1' }) + '\n'
        : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }) + '\n'
    o.onOutput?.(out)
    return { code: 0, stdout: out, stderr: '', timedOut: false, aborted: false }
  }
  const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
  const at = new Date().toISOString()
  eng.machine.saveModelAgents([
    { id: 'ma-claude-claude-haiku-5-5', adapter: 'claude', modelId: 'claude-haiku-5-5', createdAt: at },
    { id: 'ma-claude-claude-opus-5-5', adapter: 'claude', modelId: 'claude-opus-5-5', createdAt: at },
    { id: 'ma-codex-openai-gpt-6-1-sol', adapter: 'codex', modelId: 'openai-gpt-6-1-sol', createdAt: at }
  ])
  const haiku: ChatModel = { kind: 'cli', adapter: 'claude', modelId: 'claude-haiku-5-5' }
  const opus: ChatModel = { kind: 'cli', adapter: 'claude', modelId: 'claude-opus-5-5' }
  const sol: ChatModel = { kind: 'cli', adapter: 'codex', modelId: 'openai-gpt-6-1-sol' }
  return { eng, calls, haiku, opus, sol }
}

describe('챗-1: a conversation with a model', () => {
  it('starts with the lightest usable model; the second turn continues the Claude session with only the new message', async () => {
    const { eng, calls, haiku } = setup()
    expect(eng.chatModels().length).toBe(3)
    const c = eng.chatCreate()
    expect(c.model).toEqual(haiku)
    await eng.chatSend(c.id, '파이썬에서 리스트를 뒤집는 방법이 뭐야?')
    const second = await eng.chatSend(c.id, '그럼 문자열은?')
    expect(calls[0].args).not.toContain('--resume')
    expect(calls[1].args).toContain('--resume')
    expect(calls[1].args).toContain('sess-1')
    expect(calls[1].prompt).toBe('그럼 문자열은?')
    expect(second.messages.filter((m) => m.role !== 'system').map((m) => [m.role, m.status])).toEqual([['user', 'done'], ['assistant', 'done'], ['user', 'done'], ['assistant', 'done']])
    expect(second.messages[3].text).toBe('답변 2')
    expect(second.title).toBe('파이썬에서 리스트를 뒤집는 방법이 뭐야?')
    expect(eng.chatList()[0]).toMatchObject({ id: c.id, messages: 4, streaming: false })
    eng.shutdown()
  })

  it('it never changes files: an empty folder of its own, read-only, and nothing is counted as work', async () => {
    const { eng, calls, sol } = setup()
    const a = eng.chatCreate()
    await eng.chatSend(a.id, '안녕')
    const b = eng.chatCreate({ model: sol })
    await eng.chatSend(b.id, '안녕')
    expect(calls[0].cwd).toBe(eng.hive.chatDir())
    expect(calls[1].cwd).toBe(eng.hive.chatDir())
    const claudeArgs = calls[0].args.join(' ')
    expect(claudeArgs).toContain('--permission-mode default')
    expect(claudeArgs).toContain('--disallowedTools')
    expect(claudeArgs).toMatch(/Edit/)
    expect(calls[1].args.join(' ')).toContain('read-only')
    // no task, no run record, no aptitude (a chat must not inflate the estimates of real work)
    expect(eng.hive.listTasks()).toEqual([])
    expect(eng.hive.listAptitude()).toEqual([])
    eng.shutdown()
  })

  it('changing the model leaves a mark, ends the session, and the new model gets the earlier conversation', async () => {
    const { eng, calls, sol } = setup()
    const c = eng.chatCreate()
    await eng.chatSend(c.id, '첫 질문입니다')
    const changed = eng.chatSetModel(c.id, sol)
    expect(changed.sessionId).toBeUndefined()
    expect(changed.messages[changed.messages.length - 1]).toMatchObject({ role: 'system' })
    expect(changed.messages[changed.messages.length - 1].text).toContain('모델을')
    await eng.chatSend(c.id, '두 번째 질문입니다')
    expect(calls[1].prompt).toContain('Person: 첫 질문입니다')
    expect(calls[1].prompt).toContain('You: 답변 1')
    expect(calls[1].prompt.endsWith('두 번째 질문입니다')).toBe(true)
    const last = eng.chatGet(c.id)!.messages.filter((m) => m.role === 'assistant')
    expect(last[1].model).toEqual(sol)
    eng.shutdown()
  })

  it('the cost of switching is told before (the setting of hand-overs decides when it asks)', () => {
    const { eng, opus } = setup()
    const c = eng.chatCreate()
    const r = eng.chatCostOfChange(c.id, opus)
    expect(r.factor).toBeGreaterThan(1)
    expect(r.confirmAt).toBe(2)
    eng.shutdown()
  })

  it('a limit is shown with a way on — and the model is NOT changed by itself; retry with another model works', async () => {
    let n = 0
    const { eng, calls, sol } = setup({
      run: async (b) => (b.command === 'claude' ? { code: 1, stderr: 'Claude usage limit reached. Try again in 5 hours.' } : (n++, { code: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '코덱스 답' } }) + '\n' }))
    })
    const c = eng.chatCreate()
    const done = await eng.chatSend(c.id, '질문')
    const ans = done.messages[done.messages.length - 1]
    expect(ans.status).toBe('limit')
    expect(ans.limitUntil).toBeTruthy()
    expect(done.model.kind === 'cli' && done.model.adapter).toBe('claude') // not switched on its own
    expect(eng.limitFor('claude')).toBeTruthy()
    expect(eng.chatModels().find((m) => m.model.kind === 'cli' && m.model.adapter === 'claude')?.limitUntil).toBeTruthy()
    const again = await eng.chatRetry(c.id, sol)
    expect(again.model).toEqual(sol)
    const msgs = again.messages.filter((m) => m.role !== 'system')
    expect(msgs.map((m) => [m.role, m.status])).toEqual([['user', 'done'], ['assistant', 'done']]) // the limit answer is gone, the question stays
    expect(msgs[1].text).toBe('코덱스 답')
    expect(n).toBe(1)
    expect(calls.length).toBe(2)
    eng.shutdown()
  })

  it('stop keeps what came so far; a second conversation on the same connection waits its turn', async () => {
    const { eng } = setup({
      run: async (_b, o) => {
        o.onOutput?.(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '쓰는 중인 답' }] } }) + '\n')
        await new Promise<void>((r) => o.signal?.addEventListener('abort', () => r()))
        return { aborted: true, code: null }
      }
    })
    const a = eng.chatCreate()
    const b = eng.chatCreate()
    const p = eng.chatSend(a.id, '긴 질문')
    await wait(60)
    expect(eng.chats.isRunning(a.id)).toBe(true)
    // the answer so far is on screen while it runs
    expect(eng.chatGet(a.id)!.messages.slice(-1)[0]).toMatchObject({ status: 'streaming', text: '쓰는 중인 답' })
    await expect(eng.chatSend(b.id, '다른 질문')).rejects.toThrow('같은 AI를 쓰고 있어요')
    await expect(eng.chatSend(a.id, '같은 대화에 또')).rejects.toThrow('아직 답을 쓰는 중')
    eng.chatStop(a.id)
    const done = await p
    expect(done.messages.slice(-1)[0]).toMatchObject({ status: 'stopped', text: '쓰는 중인 답' })
    expect(eng.chats.isRunning(a.id)).toBe(false)
    eng.shutdown()
  })

  it('failures say why in one line; an answer cut by a closed app is marked when the list is opened; delete removes the file; export is markdown', async () => {
    const { eng } = setup({ run: async () => ({ code: 1, stderr: 'Error: not logged in\nmore' }) })
    const c = eng.chatCreate()
    const failed = await eng.chatSend(c.id, '질문')
    expect(failed.messages.slice(-1)[0]).toMatchObject({ status: 'failed', error: 'Error: not logged in' })

    const d = eng.chatCreate()
    eng.chatRename(d.id, '끊긴 대화')
    eng.hive.saveChat({ ...eng.chatGet(d.id)!, messages: [{ id: 'x', role: 'assistant', text: '반쯤', at: '', status: 'streaming' }] })
    eng.chatList()
    expect(eng.chatGet(d.id)!.messages[0]).toMatchObject({ status: 'failed' })
    expect(eng.chatGet(d.id)!.messages[0].error).toContain('앱이 닫혀서')

    const md = eng.chatExport(d.id)
    expect(md).toContain('# 끊긴 대화')
    expect(md).toContain('반쯤')
    eng.chatDelete(c.id)
    expect(eng.chatGet(c.id)).toBeNull()
    expect(eng.chatList().map((x) => x.id)).toEqual([d.id])
    eng.shutdown()
  })

  it('with no usable AI it says what to do', () => {
    const eng = new Engine(join(dir, 'c2.json'), () => {}, async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws2') })
    expect(() => eng.chatCreate()).toThrow('AI 연결에서 로그인')
    eng.shutdown()
  })
})
