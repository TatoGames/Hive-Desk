import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BuiltCommand, RunOptions, Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { chatPrompt, type ChatMessage } from '../src/shared/chat'
import { buildTaskContext, draftFromChat, DRAFT_TITLE_MAX, DRAFT_TOTAL_MAX, parsePolished, TASK_CONTEXT_CHARS } from '../src/shared/chatTask'
import type { RunRecord } from '../src/shared/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-chat2-'))
  mkdirSync(join(dir, 'work'), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const msg = (role: ChatMessage['role'], text: string, id = text): ChatMessage => ({ id, role, text, at: '', status: 'done' })

describe('챗-2: the task draft is made by rules', () => {
  it('the last request is the title and the request; the last answer is added short; the length is limited', () => {
    const d = draftFromChat([msg('user', '로그인 버그를 봐줘'), msg('assistant', '원인은 토큰 만료예요.'), msg('user', '로그인 화면의 오류 메시지를 고쳐 주세요. 그리고 테스트도요.'), msg('assistant', 'x'.repeat(5000))])
    expect(d.empty).toBe(false)
    expect(d.title).toBe('로그인 화면의 오류 메시지를 고쳐 주세요.')
    expect(d.description).toContain('로그인 화면의 오류 메시지를 고쳐 주세요. 그리고 테스트도요.')
    expect(d.description).not.toContain('로그인 버그를 봐줘')
    expect(d.description).toContain('챗에서 나온 답변')
    expect(d.description.length).toBeLessThanOrEqual(DRAFT_TOTAL_MAX)
    expect(d.description).not.toContain('x'.repeat(700))
    expect(draftFromChat([msg('user', '가'.repeat(300))]).title.length).toBeLessThanOrEqual(DRAFT_TITLE_MAX)
  })

  it('an empty conversation (or one with no request) gives an empty draft; marks, failed and streaming messages are ignored', () => {
    expect(draftFromChat([]).empty).toBe(true)
    expect(draftFromChat([msg('system', '모델 바뀜'), msg('assistant', '답')]).empty).toBe(true)
    const d = draftFromChat([{ ...msg('user', '실패한 질문'), status: 'failed' }, msg('user', '진짜 요청')])
    expect(d.title).toBe('진짜 요청')
    expect(d.description).not.toContain('실패한 질문')
  })

  it('picked messages: only those are used', () => {
    const all = [msg('user', '첫 요청', 'u1'), msg('assistant', '첫 답', 'a1'), msg('user', '둘째 요청', 'u2')]
    const d = draftFromChat(all, ['u1'])
    expect(d.title).toBe('첫 요청')
    expect(d.description).not.toContain('첫 답') // not picked
    expect(d.description).not.toContain('둘째 요청')
    expect(draftFromChat(all, ['u1', 'a1']).description).toContain('첫 답')
  })

  it('the answer of "AI로 정리하기" is read as title + description', () => {
    expect(parsePolished('제목: 로그인 오류 고치기\n설명: 메시지를 바꿔요.\n- 테스트 추가')).toEqual({ title: '로그인 오류 고치기', description: '메시지를 바꿔요.\n- 테스트 추가' })
    expect(parsePolished('   ')).toBeNull()
  })
})

describe('챗-2: what a chat about a task is shown', () => {
  const base = { title: '로그인 고치기', description: '오류 메시지를 고쳐요', status: 'done' as const, updatedAt: '2026-10-19T00:00:00Z', events: [{ at: '2026-10-19T00:00:00Z', text: '끝났어요' }] }

  it('the report, the changed files, the checks and the recent events are in; a long diff is cut and says so', () => {
    const files = [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1, binary: false }]
    const ok = buildTaskContext({ ...base, report: { did: '메시지를 바꿨어요', files: 'src/a.ts', verify: 'npm test', risks: 'none', next: 'none' }, checks: { at: '', ok: false, items: [{ name: 'test', cmd: 'npm test', ok: false, ms: 1, tail: '1 failed' }] }, diff: { available: true, files, patch: '+짧은 패치' } })
    for (const w of ['로그인 고치기', '메시지를 바꿨어요', 'src/a.ts', 'test: FAILED', '1 failed', '끝났어요', '+짧은 패치']) expect(ok.text).toContain(w)
    expect(ok.truncated).toBe(false)
    const big = buildTaskContext({ ...base, diff: { available: true, files, patch: '+' + 'z'.repeat(50_000) } })
    expect(big.truncated).toBe(true)
    expect(big.text.length).toBeLessThanOrEqual(TASK_CONTEXT_CHARS + 600)
    expect(big.text).toContain('cut:')
    expect(big.text).toContain('src/a.ts') // the file list stays
  })

  it('the prompt asks to answer from the material; a continued session gets only a status line', () => {
    const ctx = 'Task material (put together by the app; answer from it):\nTitle: T'
    const first = chatPrompt([], '왜 실패했어?', { taskContext: ctx, taskStatus: '(Task now: status=done)' }).text
    expect(first).toContain('answer from that material only')
    expect(first).toContain(ctx)
    expect(first.endsWith('왜 실패했어?')).toBe(true)
    const next = chatPrompt([], '그럼?', { resumed: true, taskStatus: '(Task now: status=done)' }).text
    expect(next).toBe('(Task now: status=done)\n\n그럼?')
  })
})

type Call = { adapter: string; args: string[]; prompt: string; cwd: string }
function setup(answer: (n: number) => string = (n) => `답변 ${n}`) {
  const calls: Call[] = []
  const runner: Runner = async (b: BuiltCommand, o: RunOptions) => {
    calls.push({ adapter: b.command, args: b.args, prompt: o.prompt, cwd: o.cwd })
    const text = answer(calls.length)
    const out = JSON.stringify({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text }] } }) + '\n' + JSON.stringify({ type: 'result', result: text, session_id: 'sess-1' }) + '\n'
    o.onOutput?.(out)
    return { code: 0, stdout: out, stderr: '', timedOut: false, aborted: false }
  }
  const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
  eng.machine.saveModelAgents([{ id: 'ma-claude-claude-haiku-5-5', adapter: 'claude', modelId: 'claude-haiku-5-5', createdAt: new Date().toISOString() }])
  return { eng, calls }
}

describe('챗-2: a task made from a conversation', () => {
  it('a draft makes no task; without the confirmation nothing is made; confirmed, it is made with its origin recorded', async () => {
    const { eng } = setup()
    const c = eng.chatCreate()
    await eng.chatSend(c.id, '로그인 오류 메시지를 고쳐 주세요')
    const d = eng.chatTaskDraft(c.id)
    expect(d.title).toBe('로그인 오류 메시지를 고쳐 주세요')
    expect(eng.hive.listTasks()).toEqual([])
    expect(() => eng.chatMakeTask(c.id, { confirmed: false, title: d.title, description: d.description })).toThrow(/확인/)
    expect(() => eng.chatMakeTask(c.id, { confirmed: true, title: '  ' })).toThrow(/제목/)
    expect(eng.hive.listTasks()).toEqual([])
    const worker = eng.saveAgent({ name: '민수', adapter: 'claude', workDir: join(dir, 'work'), modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    const t = eng.chatMakeTask(c.id, { confirmed: true, title: d.title + ' (고침)', description: d.description, agentId: worker.id })
    expect(t.title).toBe('로그인 오류 메시지를 고쳐 주세요 (고침)')
    expect(t.fromChat).toBe(c.id)
    expect(eng.hive.listTasks().length).toBe(1)
    expect(eng.hive.listEvents(t.id).some((e) => e.kind === 'created' && /챗에서 만든 업무/.test(e.text))).toBe(true)
    expect(eng.chatGet(c.id)!.madeTasks).toEqual([t.id])
    // the conversation itself is not saved into any memory
    expect(eng.chatGet(c.id)!.messages.length).toBe(2)
    await new Promise((r) => setTimeout(r, 300))
    eng.shutdown()
  })

  it('"AI로 정리하기" returns text for the person to edit: no task, no new message in the chat, read-only', async () => {
    const { eng, calls } = setup(() => '제목: 로그인 오류 문구 고치기\n설명: 문구를 바꾸고 테스트를 더해요.')
    const c = eng.chatCreate()
    await eng.chatSend(c.id, '로그인 오류 메시지를 고쳐 주세요')
    const before = eng.chatGet(c.id)!.messages.length
    const r = await eng.chatPolishDraft(c.id, eng.chatTaskDraft(c.id))
    expect(r.title).toBe('로그인 오류 문구 고치기')
    expect(eng.chatGet(c.id)!.messages.length).toBe(before)
    expect(eng.hive.listTasks()).toEqual([])
    expect(calls[1].args.join(' ')).toContain('--disallowedTools')
    expect(calls[1].cwd).toBe(eng.hive.chatDir())
    eng.shutdown()
  })
})

describe('챗-2: asking about a task', () => {
  function withFinishedTask(eng: Engine, patch: string) {
    const t = eng.createTask({ title: '버튼 색 바꾸기', description: '파란색으로 바꿔요' })
    eng.hive.updateTask(t.id, { status: 'done', report: { did: '버튼을 파란색으로 바꿨어요', files: 'ui.css', verify: 'none', risks: 'none', next: 'none' } })
    const run = { id: 'r1', taskId: t.id, agentId: 'x', adapter: 'claude', startedAt: '2026-10-19T00:00:00Z', finishedAt: '2026-10-19T00:01:00Z', durationMs: 1, outcome: 'done', exitCode: 0, prompt: '', response: '', stderr: '', cwd: dir, activity: [], diff: { available: true, files: [{ path: 'ui.css', status: 'M', additions: 1, deletions: 1, binary: false }], patch, truncated: false } } as unknown as RunRecord
    eng.hive.addRun(run)
    return t
  }

  it('the chat is named after the task; the first turn carries the material, the next only a status line; it stays read-only', async () => {
    const { eng, calls } = setup()
    const t = withFinishedTask(eng, '-color: red\n+color: blue')
    const c = eng.chatCreate({ aboutTask: t.id })
    expect(c.aboutTask).toBe(t.id)
    expect(c.title).toBe('업무: 버튼 색 바꾸기')
    expect(eng.chatList()[0].title).toBe('업무: 버튼 색 바꾸기')
    const r = await eng.chatSend(c.id, '무엇을 바꿨어?')
    expect(r.title).toBe('업무: 버튼 색 바꾸기') // not renamed by the first question
    for (const w of ['버튼 색 바꾸기', '버튼을 파란색으로 바꿨어요', 'ui.css', '+color: blue', 'answer from that material only']) expect(calls[0].prompt).toContain(w)
    await eng.chatSend(c.id, '검사는?')
    expect(calls[1].args).toContain('--resume')
    expect(calls[1].prompt).not.toContain('+color: blue')
    expect(calls[1].prompt).toContain('status=done')
    expect(calls[1].prompt.endsWith('검사는?')).toBe(true)
    // read-only like every chat: its own empty folder, edit tools off, no task run
    for (const k of calls) {
      expect(k.cwd).toBe(eng.hive.chatDir())
      expect(k.args.join(' ')).toContain('--disallowedTools')
    }
    expect(eng.hive.listTasks().length).toBe(1)
    expect(eng.hive.listRuns(t.id).length).toBe(1)
    eng.shutdown()
  })

  it('a very long diff is cut with a mark for the person', async () => {
    const { eng, calls } = setup()
    const t = withFinishedTask(eng, '+' + 'q'.repeat(60_000))
    const c = eng.chatCreate({ aboutTask: t.id })
    await eng.chatSend(c.id, '요약해 줘')
    expect(calls[0].prompt.length).toBeLessThan(TASK_CONTEXT_CHARS + 3000)
    expect(calls[0].prompt).toContain('cut:')
    expect(eng.chatGet(c.id)!.messages.some((m) => m.role === 'system' && /잘렸어요/.test(m.text))).toBe(true)
    eng.shutdown()
  })

  it('a task that is gone: said honestly in the chat and to the model; an unknown task cannot start a chat', async () => {
    const { eng, calls } = setup()
    expect(() => eng.chatCreate({ aboutTask: 'nope' })).toThrow(/없는 업무/)
    const t = withFinishedTask(eng, '+x')
    const c = eng.chatCreate({ aboutTask: t.id })
    eng.deleteTask(t.id)
    const r = await eng.chatSend(c.id, '무슨 일이었지?')
    expect(calls[0].prompt).toContain('NOT AVAILABLE')
    expect(r.messages.some((m) => m.role === 'system' && /찾지 못했어요/.test(m.text))).toBe(true)
    eng.shutdown()
  })
})
