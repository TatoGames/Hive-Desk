import type {
  ActivityEvent,
  ActivityKind,
  DiffFile,
  LiveState,
  LiveSummary,
  PlanItem,
  RunDiff,
  TrackMode
} from '../shared/types'

/**
 * Turns what a CLI prints while it works into short human-readable lines
 * ("파일 읽음: src/a.ts", "수정: b.ts +3 −1", "명령: npm test").
 *
 * This is what the agent TELLS us it did. The folder diff (gitdiff.ts) is what actually changed;
 * the UI shows both so one can be checked against the other.
 */
export type StreamKind = 'claude' | 'codex' | 'text'

export interface StreamParser {
  /** Feed raw stdout; returns the feed lines that became complete. */
  push(chunk: string): ActivityEvent[]
  /** Flush a trailing partial line. */
  end(): ActivityEvent[]
  /** The agent's final answer (markers still inside), falling back to the raw stdout. */
  finalText(rawStdout: string): string
  sessionId(): string | undefined
  /** Tool calls the CLI refused because of the permission level. */
  denials(): string[]
  plan(): PlanItem[]
  /** Every tool call the AI made (name + input), for the external-connection log and the sources it read. */
  toolUses(): { name: string; input: Record<string, unknown> }[]
}

const MAX_TEXT = 300

function clip(s: string, n = MAX_TEXT): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function countLines(s: unknown): number {
  if (typeof s !== 'string' || !s) return 0
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
}

/** `[[PLAN: a | b | c]]` once, then `[[STEP: n]]` as steps finish. Works for every CLI. */
const PLAN_RE = /^[ \t]*\[\[PLAN[ \t]*:[ \t]*([\s\S]*?)\]\][ \t]*$/gm
const STEP_RE = /^[ \t]*\[\[STEP[ \t]*:[ \t]*(\d+)[ \t]*\]\][ \t]*$/gm

export function stripProgressMarkers(text: string): string {
  return text.replace(PLAN_RE, '').replace(STEP_RE, '')
}

class Base {
  protected n = 0
  protected planItems: PlanItem[] = []
  protected session?: string
  protected denied: string[] = []
  protected uses: { name: string; input: Record<string, unknown> }[] = []

  constructor(private now: () => Date) {}

  protected ev(kind: ActivityKind, text: string, extra: Partial<ActivityEvent> = {}): ActivityEvent {
    return { n: ++this.n, at: this.now().toISOString(), kind, text: clip(text), ...extra }
  }

  /** Reads PLAN/STEP markers out of agent prose; returns the feed lines for them. */
  protected scanProgress(text: string): ActivityEvent[] {
    const out: ActivityEvent[] = []
    for (const m of text.matchAll(PLAN_RE)) {
      const items = m[1]
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean)
      if (items.length) {
        this.planItems = items.slice(0, 30).map((t) => ({ text: t, done: false }))
        out.push(this.ev('plan', `계획 ${items.length}단계: ${items.join(' → ')}`))
      }
    }
    for (const m of text.matchAll(STEP_RE)) {
      const k = Number(m[1])
      if (k >= 1 && k <= this.planItems.length) {
        for (let i = 0; i < k; i++) this.planItems[i].done = true
        out.push(this.ev('plan', `${k}/${this.planItems.length} 단계 완료: ${this.planItems[k - 1].text}`))
      }
    }
    return out
  }

  /** A line of agent prose → feed line (progress markers are shown as plan lines instead). */
  protected message(text: string): ActivityEvent[] {
    const out = this.scanProgress(text)
    const rest = clip(stripProgressMarkers(text))
    if (rest) out.unshift(this.ev('message', rest))
    return out
  }

  sessionId(): string | undefined {
    return this.session
  }
  denials(): string[] {
    return this.denied
  }
  plan(): PlanItem[] {
    return this.planItems
  }
  toolUses(): { name: string; input: Record<string, unknown> }[] {
    return this.uses
  }
}

abstract class JsonLines extends Base {
  private buf = ''

  push(chunk: string): ActivityEvent[] {
    this.buf += chunk
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    return lines.flatMap((l) => this.line(l))
  }
  end(): ActivityEvent[] {
    const rest = this.buf
    this.buf = ''
    return this.line(rest)
  }
  private line(l: string): ActivityEvent[] {
    const t = l.trim()
    if (!t.startsWith('{')) return []
    try {
      return this.event(JSON.parse(t) as Record<string, unknown>)
    } catch {
      return [] // a CLI printing a non-JSON line (warning, banner) must never break the run
    }
  }
  protected abstract event(e: Record<string, unknown>): ActivityEvent[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** `claude -p --output-format stream-json --verbose` */
class ClaudeParser extends JsonLines implements StreamParser {
  private result?: string
  private lastText = ''

  protected event(e: Record<string, unknown>): ActivityEvent[] {
    const type = str(e.type)
    if (str(e.session_id)) this.session = str(e.session_id)

    if (type === 'assistant') {
      const out: ActivityEvent[] = []
      const content = rec(e.message).content
      for (const b of Array.isArray(content) ? content : []) {
        const block = rec(b)
        if (block.type === 'text') {
          this.lastText = str(block.text)
          out.push(...this.message(str(block.text)))
        } else if (block.type === 'tool_use') {
          this.uses.push({ name: str(block.name), input: rec(block.input) })
          out.push(...this.tool(str(block.name), rec(block.input)))
        }
      }
      return out
    }

    if (type === 'user') {
      const content = rec(e.message).content
      const out: ActivityEvent[] = []
      for (const b of Array.isArray(content) ? content : []) {
        const block = rec(b)
        if (block.type === 'tool_result' && block.is_error === true) {
          const body = Array.isArray(block.content)
            ? block.content.map((c) => str(rec(c).text)).join(' ')
            : str(block.content)
          out.push(this.ev('error', '도구 오류: ' + body))
        }
      }
      return out
    }

    if (type === 'result') {
      if (typeof e.result === 'string') this.result = e.result
      for (const d of Array.isArray(e.permission_denials) ? e.permission_denials : []) {
        const dd = rec(d)
        const input = rec(dd.tool_input)
        const target = str(input.file_path) || str(input.command) || str(input.path)
        this.denied.push(`${str(dd.tool_name) || '도구'}${target ? ' → ' + clip(target, 120) : ''}`)
      }
      return []
    }
    return []
  }

  private tool(name: string, input: Record<string, unknown>): ActivityEvent[] {
    const path = str(input.file_path) || str(input.notebook_path) || str(input.path) || undefined
    switch (name) {
      case 'Read':
        return [this.ev('read', `파일 읽음: ${path ?? ''}`, { path })]
      case 'Write': {
        const add = countLines(input.content)
        return [this.ev('write', `파일 작성: ${path ?? ''} +${add}`, { path, add })]
      }
      case 'Edit': {
        const add = countLines(input.new_string)
        const del = countLines(input.old_string)
        return [this.ev('edit', `수정: ${path ?? ''} +${add} −${del}`, { path, add, del })]
      }
      case 'MultiEdit': {
        const edits = Array.isArray(input.edits) ? input.edits.map(rec) : []
        const add = edits.reduce((n, x) => n + countLines(x.new_string), 0)
        const del = edits.reduce((n, x) => n + countLines(x.old_string), 0)
        return [this.ev('edit', `수정: ${path ?? ''} +${add} −${del}`, { path, add, del })]
      }
      case 'NotebookEdit':
        return [this.ev('edit', `노트북 수정: ${path ?? ''}`, { path })]
      case 'Bash':
        return [this.ev('command', `명령: ${str(input.command)}`)]
      case 'Grep':
        return [this.ev('search', `검색: ${str(input.pattern)}${path ? ' (' + path + ')' : ''}`)]
      case 'Glob':
        return [this.ev('search', `파일 찾기: ${str(input.pattern)}`)]
      case 'WebFetch':
      case 'WebSearch':
        return [this.ev('search', `웹: ${str(input.url) || str(input.query)}`)]
      case 'TodoWrite': {
        const todos = Array.isArray(input.todos) ? input.todos.map(rec) : []
        if (todos.length) {
          this.planItems = todos.map((t) => ({
            text: str(t.content) || str(t.subject),
            done: str(t.status) === 'completed'
          }))
        }
        const done = this.planItems.filter((p) => p.done).length
        return [this.ev('plan', `할 일 목록 ${done}/${this.planItems.length}`)]
      }
      default: {
        // MCP tools are named mcp__<server>__<tool>
        const m = name.match(/^mcp__(.+?)__(.+)$/)
        return [this.ev('tool', m ? `외부 앱 도구: ${m[2]}` : `도구: ${name}`)]
      }
    }
  }

  finalText(raw: string): string {
    if (this.result !== undefined) return this.result
    if (this.lastText) return this.lastText
    // Not stream-json after all (older CLI?): keep the plain text.
    return raw.split('\n').some((l) => l.trim().startsWith('{"type"')) ? '' : raw
  }
}

/** `codex exec --json` (JSONL). Field names differ slightly between versions, so be tolerant. */
class CodexParser extends JsonLines implements StreamParser {
  private lastMessage = ''
  private seen = new Set<string>()

  protected event(e: Record<string, unknown>): ActivityEvent[] {
    const type = str(e.type)
    if (type === 'thread.started') {
      this.session = str(e.thread_id) || str(e.session_id) || this.session
      return []
    }
    if (type === 'turn.failed' || type === 'error') {
      return [this.ev('error', str(rec(e.error).message) || str(e.message) || '오류')]
    }
    if (!type.startsWith('item.')) return []

    const item = rec(e.item)
    let kind = str(item.type) || str(item.item_type)
    if (kind === 'assistant_message') kind = 'agent_message'
    const id = str(item.id)
    const started = type === 'item.started'
    const done = type === 'item.completed'

    switch (kind) {
      case 'agent_message': {
        if (!done) return []
        this.lastMessage = str(item.text)
        return this.message(this.lastMessage)
      }
      case 'command_execution': {
        const out: ActivityEvent[] = []
        const key = 'cmd:' + id
        if ((started || done) && !this.seen.has(key)) {
          this.seen.add(key)
          out.push(this.ev('command', `명령: ${str(item.command)}`))
        }
        const code = item.exit_code
        if (done && typeof code === 'number' && code !== 0) {
          out.push(this.ev('error', `명령 실패(종료 코드 ${code}): ${str(item.command)}`))
        }
        return out
      }
      case 'file_change': {
        if (!done) return []
        const changes = Array.isArray(item.changes) ? item.changes.map(rec) : []
        return changes.map((c) => {
          const path = str(c.path)
          const k = str(c.kind)
          if (k === 'add') return this.ev('write', `파일 추가: ${path}`, { path })
          if (k === 'delete') return this.ev('edit', `파일 삭제: ${path}`, { path })
          return this.ev('edit', `수정: ${path}`, { path })
        })
      }
      case 'todo_list':
      case 'plan_update': {
        const items = Array.isArray(item.items) ? item.items.map(rec) : []
        if (items.length) {
          this.planItems = items.map((t) => ({
            text: str(t.text) || str(t.step),
            done: t.completed === true || str(t.status) === 'completed'
          }))
        }
        const doneN = this.planItems.filter((p) => p.done).length
        return this.planItems.length ? [this.ev('plan', `할 일 목록 ${doneN}/${this.planItems.length}`)] : []
      }
      case 'web_search':
        return started ? [this.ev('search', `웹: ${str(item.query)}`)] : []
      case 'mcp_tool_call':
        return started ? [this.ev('tool', `도구: ${str(item.server)}/${str(item.tool)}`)] : []
      case 'error':
        return [this.ev('error', str(item.message) || '오류')]
      default:
        return [] // reasoning etc.: too chatty for the feed
    }
  }

  finalText(raw: string): string {
    if (this.lastMessage) return this.lastMessage
    return raw.split('\n').some((l) => l.trim().startsWith('{"type"')) ? '' : raw
  }
}

/** Anything that just prints text (agy, Gemini, custom): each finished line is a feed line. */
class TextParser extends Base implements StreamParser {
  private buf = ''

  push(chunk: string): ActivityEvent[] {
    this.buf += chunk
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    return lines.flatMap((l) => this.one(l))
  }
  end(): ActivityEvent[] {
    const rest = this.buf
    this.buf = ''
    return this.one(rest)
  }
  private one(line: string): ActivityEvent[] {
    if (!line.trim()) return []
    // Other marker lines ([[MEMORY…]], [[DID…]]) are handled when the run ends.
    if (/^\s*\[\[(MEMORY|MSG|APPROVAL|NEED|DID|FILES|VERIFY|RISK|NEXT)\b/.test(line)) return []
    return this.message(line)
  }
  finalText(raw: string): string {
    return raw
  }
}

export function createParser(kind: StreamKind, now: () => Date = () => new Date()): StreamParser {
  if (kind === 'claude') return new ClaudeParser(now)
  if (kind === 'codex') return new CodexParser(now)
  return new TextParser(now)
}

/** The numbers and lists the UI shows while a task runs. One per run, lives in memory. */
export class LiveRun {
  private lastKind?: ActivityKind
  private events: ActivityEvent[] = []
  private dropped = 0
  private diff: RunDiff = { available: true, files: [], patch: '', truncated: false }
  private plan: PlanItem[] = []
  private tracking: TrackMode = 'none'
  private lastText?: string

  constructor(
    readonly taskId: string,
    readonly runId: string,
    readonly cwd: string,
    readonly startedAt: string
  ) {}

  setTracking(t: TrackMode): void {
    this.tracking = t
  }

  setPlan(p: PlanItem[]): void {
    this.plan = p.map((x) => ({ ...x }))
  }

  add(evs: ActivityEvent[]): void {
    if (!evs.length) return
    this.events.push(...evs)
    if (this.events.length > 1500) {
      this.dropped += this.events.length - 1000
      this.events = this.events.slice(-1000)
    }
    const last = [...evs].reverse().find((e) => e.kind !== 'plan')
    if (last) {
      this.lastText = last.text
      this.lastKind = last.kind
    }
  }

  setDiff(d: RunDiff): void {
    this.diff = d
  }

  /** The full feed so far (what gets stored with the run). */
  all(): ActivityEvent[] {
    return this.events
  }

  summary(): LiveSummary {
    const files = this.diff.files
    return {
      taskId: this.taskId,
      runId: this.runId,
      cwd: this.cwd,
      startedAt: this.startedAt,
      steps: this.events.filter((e) => e.kind !== 'message' && e.kind !== 'plan' && e.kind !== 'error').length,
      files: files.length,
      add: files.reduce((n, f) => n + f.additions, 0),
      del: files.reduce((n, f) => n + f.deletions, 0),
      plan: this.plan,
      tracking: this.tracking,
      last: this.lastText,
      ...(this.lastKind ? { lastKind: this.lastKind } : {})
    }
  }

  state(): LiveState {
    const changes: DiffFile[] = this.diff.files
    return {
      ...this.summary(),
      events: this.events.slice(-400),
      changes,
      patch: this.diff.patch,
      lines: this.diff.lines !== false,
      root: this.diff.root ?? this.cwd
    }
  }

  get droppedCount(): number {
    return this.dropped
  }
}
