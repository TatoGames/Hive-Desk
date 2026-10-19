import { randomBytes } from 'node:crypto'
import { LOCAL_BUSY_FOR_CHAT } from '../shared/localqueue'
import { existsSync } from 'node:fs'
import type { Agent } from '../shared/types'
import { resolveModelArg, tierRank, type ModelEntry, type Tier } from '../shared/company'
import {
  chatMarkdown,
  chatPrompt,
  chatTitle,
  costFactor,
  sameModel,
  summarizeChat,
  type Chat,
  type ChatMessage,
  type ChatModel,
  type ChatSummary
} from '../shared/chat'
import { buildTaskContext, parsePolished, POLISH_PROMPT, TASK_GONE_CONTEXT, taskStatusLine, type TaskContext, type TaskDraft } from '../shared/chatTask'
import { adapterAccess, buildCommand, cleanEnv, defaultExtraArgs, type Runner } from './adapters'
import { createParser } from './activity'
import { detectLimit, type LimitInfo } from './limits'
import type { Hive } from './hive'

/** A model the person can pick in the chat. */
export interface ChatModelInfo {
  model: ChatModel
  label: string
  tier: Tier
  /** Relative usage-limit cost (1 = the lightest); 0 = costs nothing against a limit (a model of this PC). */
  weight: number
  /** `cli` / `local` — where it runs. */
  where: 'cli' | 'local'
  /** Checked and working (otherwise "not checked yet"). */
  ok: boolean
  /** A caveat shown next to the name (e.g. read-only cannot be enforced). */
  note?: string
  /** Its usage limit is reached right now. */
  limitUntil?: string
  /** A model of this PC: how well it fits this PC (B2). */
  fit?: string
  /** A model of this PC: how fast it answered when measured (B2). */
  speed?: string
}

export interface LocalTurn {
  prompt: string
  signal: AbortSignal
  onText: (textSoFar: string) => void
}

export interface ChatsCtx {
  hive: () => Hive
  runner: () => Runner
  stripApiKeys: () => boolean
  catalog: () => ModelEntry[]
  /** Models of the connections this person can use (checked ones first). */
  cliModels: () => { adapter: Agent['adapter']; modelId: string; ok: boolean }[]
  /** Models of this PC (8-2): list and a turn. */
  localModels?: () => ChatModelInfo[]
  localTurn?: (m: Extract<ChatModel, { kind: 'local' }>, t: LocalTurn) => Promise<{ text: string }>
  /** A task runs or waits for this model (A3): a chat turn on it is refused. */
  localBusy?: (m: Extract<ChatModel, { kind: 'local' }>) => boolean
  limitFor: (adapter: Agent['adapter']) => LimitInfo | undefined
  noteLimit: (adapter: Agent['adapter'], info: LimitInfo) => void
  lastModel: () => ChatModel | undefined
  setLastModel: (m: ChatModel) => void
  /** The confirm-first factor of the hand-over setting (default 2). */
  confirmAtCostX: () => number
  changed: () => void
  /** A finished or changed chat, for the open screen. */
  onChat: (id: string) => void
}

/** At most this many chat turns run at once (one per connection). Tasks are not counted. */
export const MAX_CHAT_TURNS = 2
const TURN_TIMEOUT_MS = 15 * 60_000
const TURN_IDLE_MS = 4 * 60_000

const newId = (): string => Date.now().toString(36) + randomBytes(3).toString('hex')

/** The connection a model uses: a turn of the same connection waits for the other one. */
const connOf = (m: ChatModel): string => (m.kind === 'cli' ? `cli:${m.adapter}` : `local:${m.endpointId}`)

/**
 * The chat: stored conversations, one run of a model per message. Nothing here changes a project: the work folder is
 * an empty folder of its own and the permission is read-only.
 */
export class Chats {
  private turns = new Map<string, { ac: AbortController; conn: string }>()

  constructor(private c: ChatsCtx) {}

  // ---- models ----
  models(): ChatModelInfo[] {
    const out: ChatModelInfo[] = []
    for (const m of this.c.cliModels()) {
      const e = this.c.catalog().find((x) => x.id === m.modelId)
      if (!e) continue
      const access = adapterAccess(m.adapter)
      out.push({
        model: { kind: 'cli', adapter: m.adapter, modelId: m.modelId },
        label: `${e.family} ${e.version}`,
        tier: e.tier,
        weight: e.weight,
        where: 'cli',
        ok: m.ok,
        note: access.permission === 'flag' ? undefined : '파일을 바꾸지 않도록 안내만 해요 (이 AI는 읽기 전용을 강제하지 못해요)',
        limitUntil: this.c.limitFor(m.adapter)?.until
      })
    }
    out.push(...(this.c.localModels?.() ?? []))
    return out.sort((a, b) => Number(b.ok) - Number(a.ok) || tierRank(a.tier) - tierRank(b.tier) || a.label.localeCompare(b.label))
  }

  info(m: ChatModel): ChatModelInfo | undefined {
    return this.models().find((x) => sameModel(x.model, m))
  }

  /** The model of a new conversation: the last one used, else the lightest one that works. */
  defaultModel(): ChatModel | undefined {
    const all = this.models()
    const last = this.c.lastModel()
    if (last && all.some((x) => sameModel(x.model, last))) return last
    // a model of this PC is never the surprise default (it may be slow): connections first
    const pick = [...all].sort((a, b) => Number(b.ok) - Number(a.ok) || Number(a.where === 'local') - Number(b.where === 'local') || a.weight - b.weight)[0]
    return pick?.model
  }

  // ---- conversations ----
  list(): ChatSummary[] {
    return this.hive.listChats().map(summarizeChat)
  }

  get(id: string): Chat | null {
    return this.hive.getChat(id)
  }

  create(o: { model?: ChatModel; folderRefs?: string[]; aboutTask?: string; title?: string; firstMessage?: string } = {}): Chat {
    const model = o.model ?? this.defaultModel()
    if (!model) throw new Error('쓸 수 있는 AI가 없어요. 먼저 AI 연결에서 로그인하고 연결 확인을 눌러 주세요.')
    const now = new Date().toISOString()
    const chat: Chat = {
      id: newId(),
      title: o.title ?? '새 대화',
      createdAt: now,
      updatedAt: now,
      model,
      folderRefs: (o.folderRefs ?? []).filter((f) => existsSync(f)),
      ...(o.aboutTask ? { aboutTask: o.aboutTask } : {}),
      messages: o.firstMessage ? [{ id: newId(), role: 'system', text: o.firstMessage, at: now, status: 'done' }] : []
    }
    this.hive.saveChat(chat)
    this.c.changed()
    return chat
  }

  rename(id: string, title: string): void {
    const c = this.must(id)
    this.save({ ...c, title: title.trim().slice(0, 80) || c.title })
  }

  delete(id: string): void {
    if (this.turns.has(id)) this.stop(id)
    this.hive.deleteChat(id)
    this.c.changed()
  }

  setFolders(id: string, folders: string[]): void {
    const c = this.must(id)
    this.save({ ...c, folderRefs: folders.filter((f) => existsSync(f)) })
  }

  /** Another model from now on. A session of the old model cannot go on, so the earlier messages are sent again. */
  setModel(id: string, model: ChatModel): Chat {
    const c = this.must(id)
    if (sameModel(c.model, model)) return c
    if (this.turns.has(id)) throw new Error('답을 쓰는 중에는 모델을 바꿀 수 없어요. 먼저 중지해 주세요.')
    const info = this.info(model)
    if (!info) throw new Error('쓸 수 없는 모델이에요.')
    const now = new Date().toISOString()
    const next: Chat = {
      ...c,
      model,
      sessionId: undefined,
      messages: [...c.messages, { id: newId(), role: 'system', text: `여기서 모델을 ${info.label}(으)로 바꿨어요.`, at: now, status: 'done' }]
    }
    this.save(next)
    this.c.setLastModel(model)
    return next
  }

  /** How many times more a turn costs against the limit after changing the model (for the question before). */
  costOfChange(id: string, to: ChatModel): number {
    const c = this.must(id)
    const a = this.info(c.model)?.weight ?? 1
    const b = this.info(to)?.weight ?? 1
    return costFactor(a, b)
  }

  confirmFactor(): number {
    return this.c.confirmAtCostX()
  }

  export(id: string): string {
    const c = this.must(id)
    return chatMarkdown(c, (m) => this.info(m)?.label ?? (m.kind === 'cli' ? m.modelId : m.model))
  }

  // ---- a turn ----
  /** A turn is running on this local connection (its models cannot be removed meanwhile). */
  usesLocal(endpointId: string): boolean {
    for (const t of this.turns.values()) if (t.conn === `local:${endpointId}`) return true
    return false
  }

  isRunning(id: string): boolean {
    return this.turns.has(id)
  }

  stop(id: string): void {
    this.turns.get(id)?.ac.abort()
  }

  /** Send a message and wait until the answer is done (the screen follows through `onChat`). */
  async send(id: string, text: string): Promise<Chat> {
    const clean = text.trim()
    if (!clean) throw new Error('보낼 내용을 적어 주세요.')
    const chat = this.must(id)
    this.canStart(chat)
    const now = new Date().toISOString()
    const user: ChatMessage = { id: newId(), role: 'user', text: clean, at: now, status: 'done' }
    const next: Chat = {
      ...chat,
      // a chat about a task keeps its name ("업무: …")
      title: chat.aboutTask || chat.messages.some((m) => m.role === 'user') ? chat.title : chatTitle(clean),
      messages: [...chat.messages, ...this.materialMark(chat), user]
    }
    this.save(next)
    return this.runTurn(id, clean, chat.messages)
  }

  /** The last answer failed or hit a limit: ask again (with another model when given). */
  async retry(id: string, model?: ChatModel): Promise<Chat> {
    let chat = this.must(id)
    const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) throw new Error('다시 보낼 질문이 없어요.')
    if (model && !sameModel(chat.model, model)) chat = this.setModel(id, model)
    this.canStart(chat)
    // drop everything after the question (the failed answer) and ask again
    const at = chat.messages.findIndex((m) => m.id === lastUser.id)
    // the marks after the question (a model change) stay; the failed answer goes
    const kept = [...chat.messages.slice(0, at + 1), ...chat.messages.slice(at + 1).filter((m) => m.role === 'system')]
    this.save({ ...chat, messages: kept })
    return this.runTurn(id, lastUser.text, chat.messages.slice(0, at))
  }

  private canStart(chat: Chat): void {
    if (this.turns.has(chat.id)) throw new Error('이 대화는 아직 답을 쓰는 중이에요.')
    const conn = connOf(chat.model)
    for (const t of this.turns.values()) if (t.conn === conn) throw new Error('다른 대화가 같은 AI를 쓰고 있어요. 끝나면 보내 주세요.')
    if (chat.model.kind === 'local' && this.c.localBusy?.(chat.model)) throw new Error(LOCAL_BUSY_FOR_CHAT)
    if (this.turns.size >= MAX_CHAT_TURNS) throw new Error('지금 답을 쓰는 대화가 많아요. 하나가 끝나면 보내 주세요.')
  }

  /** After a crash or a closed app, an answer that was still being written is marked as interrupted. */
  recover(): void {
    for (const c of this.hive.listChats()) {
      if (this.turns.has(c.id) || !c.messages.some((m) => m.status === 'streaming')) continue
      this.hive.saveChat({ ...c, messages: c.messages.map((m) => (m.status === 'streaming' ? { ...m, status: 'failed' as const, error: '앱이 닫혀서 답이 끊겼어요. 다시 보내 보세요.' } : m)) })
    }
  }

  private async runTurn(id: string, text: string, earlier: ChatMessage[]): Promise<Chat> {
    let chat = this.must(id)
    const model = chat.model
    const start = Date.now()
    const answer: ChatMessage = { id: newId(), role: 'assistant', text: '', at: new Date().toISOString(), model, status: 'streaming' }
    chat = { ...chat, messages: [...chat.messages, answer] }
    this.save(chat)
    const ac = new AbortController()
    this.turns.set(id, { ac, conn: connOf(model) })
    this.c.setLastModel(model)
    let live = ''
    let sessionId = chat.sessionId
    let state: Pick<ChatMessage, 'status' | 'error' | 'limitUntil'> = { status: 'done' }
    // keep what has come so far visible without saving on every chunk
    let lastSave = 0
    const update = (t: string, force = false): void => {
      live = t
      const now = Date.now()
      if (!force && now - lastSave < 250) return
      lastSave = now
      this.patchAnswer(id, answer.id, { text: t })
    }
    try {
      if (model.kind === 'cli') {
        const r = await this.runCli(chat, model, text, earlier, ac.signal, update)
        live = r.text
        sessionId = r.sessionId ?? sessionId
        state = r.state
      } else {
        if (!this.c.localTurn) throw new Error('내 PC AI 연결이 아직 준비되지 않았어요.')
        const prompt = chatPrompt(earlier, text, { budget: 12_000, folders: chat.folderRefs, ...this.taskMaterial(chat, true) }).text
        const r = await this.c.localTurn(model, { prompt, signal: ac.signal, onText: (t) => update(t) })
        live = r.text
      }
      if (ac.signal.aborted) state = { status: 'stopped' }
    } catch (e) {
      state = ac.signal.aborted ? { status: 'stopped' } : { status: 'failed', error: (e as Error).message.split('\n')[0].slice(0, 300) }
    } finally {
      this.turns.delete(id)
    }
    const fresh = this.hive.getChat(id)
    if (!fresh) return chat // deleted while it ran
    const done = fresh.messages.map((m) => (m.id === answer.id ? { ...m, text: live, ...state, usage: { ms: Date.now() - start } } : m))
    const final: Chat = { ...fresh, sessionId: state.status === 'done' ? sessionId : fresh.sessionId, messages: done }
    this.save(final)
    this.c.changed()
    return final
  }

  private async runCli(
    chat: Chat,
    model: Extract<ChatModel, { kind: 'cli' }>,
    text: string,
    earlier: ChatMessage[],
    signal: AbortSignal,
    update: (t: string, force?: boolean) => void
  ): Promise<{ text: string; sessionId?: string; state: Pick<ChatMessage, 'status' | 'error' | 'limitUntil'> }> {
    const entry = this.c.catalog().find((x) => x.id === model.modelId)
    if (!entry) throw new Error('카탈로그에 없는 모델이에요.')
    const agent = {
      id: 'chat',
      name: '챗',
      owner: '',
      adapter: model.adapter,
      role: '',
      workDir: '',
      model: resolveModelArg(entry, 'pinned'),
      extraArgs: defaultExtraArgs(model.adapter),
      dailyRunLimit: 0,
      dailyMinuteLimit: 0,
      timeoutMinutes: 15,
      requireApproval: false
    } as Agent
    const access = adapterAccess(model.adapter)
    const resume = access.resume === 'session' && !!chat.sessionId
    const folders = chat.folderRefs
    const built = buildCommand(agent, { stream: true, permission: 'read', refDirs: folders, effort: 'medium', ...(resume ? { resumeSession: chat.sessionId } : {}) })
    const prompt = chatPrompt(earlier, text, { resumed: built.resumed, folders: access.refDirs === 'prompt' || !built.resumed ? folders : [], ...this.taskMaterial(chat, !built.resumed) })
    const parser = createParser(built.stream ?? 'text')
    let raw = ''
    const res = await this.c.runner()(built, {
      cwd: this.hive.chatDir(),
      prompt: prompt.text,
      timeoutMs: TURN_TIMEOUT_MS,
      idleTimeoutMs: TURN_IDLE_MS,
      env: cleanEnv(process.env, this.c.stripApiKeys()),
      signal,
      onOutput: (chunk) => {
        raw += chunk
        parser.push(chunk)
        update(parser.finalText(raw))
      }
    })
    // a runner that only returns stdout (no chunks while running) is still understood
    if (!raw && res.stdout) parser.push(res.stdout)
    parser.end()
    const textOut = (parser.finalText(res.stdout || raw) || '').trim()
    update(textOut, true)
    const sessionId = parser.sessionId()
    if (res.aborted) return { text: textOut, sessionId, state: { status: 'stopped' } }
    if (res.spawnError) return { text: textOut, sessionId, state: { status: 'failed', error: `실행하지 못했어요: ${res.spawnError.split('\n')[0]}` } }
    if (res.timedOut) return { text: textOut, sessionId, state: { status: 'failed', error: res.timeoutKind === 'idle' ? '한동안 아무 응답이 없어서 멈췄어요.' : '시간이 너무 오래 걸려서 멈췄어요.' } }
    if (res.code !== 0 || !textOut) {
      const why = `${res.stderr}\n${res.stdout}`
      const limit = detectLimit(why)
      if (limit) {
        this.c.noteLimit(model.adapter, limit)
        return { text: textOut, sessionId, state: { status: 'limit', limitUntil: limit.until, error: limit.message } }
      }
      const line = res.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
      return { text: textOut, sessionId, state: { status: 'failed', error: line ? line.slice(0, 300) : '답을 받지 못했어요. AI 연결을 확인해 주세요.' } }
    }
    return { text: textOut, sessionId, state: { status: 'done' } }
  }

  // ---- 챗-2: a chat about a task ----
  /** What the app puts in front of the model for a chat about a task: the material (first turn / no session) and a status line. */
  private taskMaterial(chat: Chat, full: boolean): { taskContext?: string; taskStatus?: string } {
    if (!chat.aboutTask) return {}
    const t = this.hive.getTask(chat.aboutTask)
    return { taskStatus: taskStatusLine(t), ...(full ? { taskContext: this.contextOf(chat.aboutTask).text } : {}) }
  }

  /** The material of a task from this company's files only (a task of another company is never read). */
  contextOf(taskId: string): TaskContext {
    const t = this.hive.getTask(taskId)
    if (!t) return { text: TASK_GONE_CONTEXT, truncated: false }
    const last = this.hive.listRuns(taskId).slice(-1)[0]
    const run = last ? this.hive.getRun(taskId, last.id) : null
    return buildTaskContext({
      title: t.title,
      description: t.description,
      status: t.status,
      updatedAt: t.updatedAt,
      error: t.error,
      result: t.result,
      report: t.report,
      checks: t.checks,
      events: this.hive.listEvents(taskId).map((e) => ({ at: e.at, text: e.text })),
      diff: run?.diff
    })
  }

  /** The first message of a chat about a task: tell the person when the material is cut or missing (as a mark, not a person's words). */
  private materialMark(chat: Chat): ChatMessage[] {
    if (!chat.aboutTask || chat.messages.some((m) => m.role === 'user')) return []
    const t = this.hive.getTask(chat.aboutTask)
    const text = !t ? '이 업무를 찾지 못했어요. 지워졌거나 읽을 수 없어서 AI도 자료를 못 봐요.' : this.contextOf(chat.aboutTask).truncated ? '업무 자료가 길어서 일부만 AI에게 보내요 (잘렸어요). 보고서와 파일 목록은 먼저 들어가요.' : ''
    return text ? [{ id: newId(), role: 'system', text, at: new Date().toISOString(), status: 'done' }] : []
  }

  /** A task was handed over from this conversation. */
  noteMadeTask(id: string, taskId: string): void {
    const c = this.must(id)
    this.save({ ...c, madeTasks: [...new Set([...(c.madeTasks ?? []), taskId])] })
  }

  /**
   * "AI로 정리하기": the model of this chat words the draft as a task. One read-only question outside the conversation:
   * nothing is saved in the chat and no task is made; the person reads the result and confirms.
   */
  async polishDraft(id: string, draft: TaskDraft): Promise<{ title: string; description: string }> {
    const chat = this.must(id)
    this.canStart(chat)
    const model = chat.model
    const prompt = `${POLISH_PROMPT}\n\nDraft title: ${draft.title}\nDraft description:\n${draft.description}`
    const ac = new AbortController()
    this.turns.set(id, { ac, conn: connOf(model) })
    try {
      let out = ''
      if (model.kind === 'local') {
        if (!this.c.localTurn) throw new Error('내 PC AI 연결이 아직 준비되지 않았어요.')
        out = (await this.c.localTurn(model, { prompt, signal: ac.signal, onText: () => undefined })).text
      } else {
        const entry = this.c.catalog().find((x) => x.id === model.modelId)
        if (!entry) throw new Error('카탈로그에 없는 모델이에요.')
        const agent = { id: 'chat', name: '챗', owner: '', adapter: model.adapter, role: '', workDir: '', model: resolveModelArg(entry, 'pinned'), extraArgs: defaultExtraArgs(model.adapter), dailyRunLimit: 0, dailyMinuteLimit: 0, timeoutMinutes: 15, requireApproval: false } as Agent
        const built = buildCommand(agent, { stream: true, permission: 'read', refDirs: [], effort: 'low' })
        const parser = createParser(built.stream ?? 'text')
        let raw = ''
        const res = await this.c.runner()(built, {
          cwd: this.hive.chatDir(),
          prompt,
          timeoutMs: 5 * 60_000,
          idleTimeoutMs: TURN_IDLE_MS,
          env: cleanEnv(process.env, this.c.stripApiKeys()),
          signal: ac.signal,
          onOutput: (chunk) => {
            raw += chunk
            parser.push(chunk)
          }
        })
        if (!raw && res.stdout) parser.push(res.stdout)
        parser.end()
        out = (parser.finalText(res.stdout || raw) || '').trim()
        if (res.code !== 0 || !out) {
          const limit = detectLimit(`${res.stderr}\n${res.stdout}`)
          if (limit) this.c.noteLimit(model.adapter, limit)
          throw new Error(limit ? '이 AI는 지금 사용 한도예요. 기본 초안을 그대로 쓰거나 나중에 다시 눌러 주세요.' : '정리하지 못했어요. 기본 초안을 고쳐 쓰셔도 돼요.')
        }
      }
      return parsePolished(out) ?? (() => { throw new Error('정리한 내용을 읽지 못했어요. 기본 초안을 고쳐 쓰셔도 돼요.') })()
    } finally {
      this.turns.delete(id)
    }
  }

  // ---- helpers ----
  private get hive(): Hive {
    return this.c.hive()
  }

  private must(id: string): Chat {
    const c = this.hive.getChat(id)
    if (!c) throw new Error('없는 대화예요.')
    return c
  }

  private save(c: Chat): void {
    this.hive.saveChat({ ...c, updatedAt: new Date().toISOString() })
    this.c.onChat(c.id)
  }

  private patchAnswer(id: string, answerId: string, patch: Partial<ChatMessage>): void {
    const c = this.hive.getChat(id)
    if (!c) return
    this.save({ ...c, messages: c.messages.map((m) => (m.id === answerId ? { ...m, ...patch } : m)) })
  }
}
