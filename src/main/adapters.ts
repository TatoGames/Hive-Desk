import { spawn } from 'node:child_process'
import { defaultPermission } from '../shared/permission'
import { SECRET_READ_RULES } from './secrets'
import type { AdapterId, AdapterInfo, Agent, PermissionLevel } from '../shared/types'
import type { StreamKind } from './activity'

/**
 * Each adapter wraps a CLI the user is ALREADY logged into with their own
 * account (subscription or free tier). HiveDesk never sees or stores a key.
 * The prompt is always sent on stdin, so long prompts and quoting are safe.
 */
interface AdapterSpec {
  id: AdapterId
  label: string
  command: string
  /** Args that put the CLI into one-shot mode, reading the prompt from stdin. */
  baseArgs: string[]
  modelFlag?: string
  /** Args of the command that prints the models this account can use. */
  listModels?: string[]
  defaultExtraArgs: string
  install: string
  login: string
  note?: string
}

export const ADAPTERS: Record<AdapterId, AdapterSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    baseArgs: ['-p'],
    modelFlag: '--model',
    defaultExtraArgs: '--permission-mode acceptEdits',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    login: '터미널에서 `claude`를 한 번 실행해 Claude Pro/Max 계정으로 로그인하세요.',
    note: 'Claude Pro 이상 요금제가 필요해요.'
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex',
    command: 'codex',
    baseArgs: ['exec', '--skip-git-repo-check'],
    modelFlag: '-m',
    defaultExtraArgs: '--sandbox workspace-write',
    install: 'npm install -g --prefix ~/.npm-global @openai/codex',
    login: '`codex login`을 실행하고 "Sign in with ChatGPT"를 고르세요.',
    note: 'ChatGPT 계정으로 로그인해요.'
  },
  agy: {
    id: 'agy',
    label: 'Antigravity CLI (agy)',
    command: 'agy',
    // The prompt goes in as the -p value (see buildCommand): given only an
    // instruction to read stdin, agy tries a shell command to read it, which
    // headless mode denies, and the run ends with no output.
    baseArgs: [],
    modelFlag: '--model',
    /** Lists the models this login can use (one per line). */
    listModels: ['models'],
    defaultExtraArgs: '',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    login: '`agy`를 한 번 실행하면 브라우저가 열려 Google 계정으로 로그인해요. 무료 계정도 쓸 수 있어요.',
    note: '무료 Google 계정으로도 쓸 수 있어요.'
  },
  custom: {
    id: 'custom',
    label: 'Custom command',
    command: '',
    baseArgs: [],
    defaultExtraArgs: '',
    install: '',
    login: 'stdin으로 프롬프트를 받아 stdout으로 답을 출력하는 CLI라면 무엇이든 돼요 (예: ollama run 모델명).'
  }
}

export function defaultExtraArgs(id: AdapterId): string {
  return ADAPTERS[id]?.defaultExtraArgs ?? ''
}

/** Minimal shell-like splitter: spaces separate args, quotes group. */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let has = false
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
    } else cur += ch
  }
  if (cur || has) out.push(cur)
  return out
}

export interface BuiltCommand {
  command: string
  args: string[]
  /** Append the prompt as the last argument instead of writing it to stdin. */
  promptArg?: boolean
  /** How to read the CLI's stdout: structured events (claude/codex) or plain text. */
  stream?: StreamKind
  /** The CLI continues an earlier session; the prompt is only the new message. */
  resumed?: boolean
  /** Messages go in as stream-json lines and stdin stays open, so instructions can reach the run while it works. */
  live?: boolean
  /** Claude asks the app (control protocol on stdin/stdout) before a tool that is not allowed in advance. Needs `live`. */
  permissionPrompt?: boolean
}

/** What a caller can do to a run that is in progress (only runs started in live mode have one). */
export interface RunHandle {
  /** Write a new message into the running conversation. false = the run no longer takes input. */
  send(text: string): boolean
  /** Stop what the AI is doing right now but keep the process and the conversation. With `next`, it is sent as soon as the interrupt has landed; without, the run waits (paused). */
  interrupt(next?: string): boolean
  /** True while interrupted and waiting for a message. */
  paused(): boolean
}

export interface BuildOptions {
  /** Ask for the CLI's step-by-step event output (activity feed). Off for one-shot checks. */
  stream?: boolean
  permission?: PermissionLevel
  /** Extra folders the agent may read. */
  refDirs?: string[]
  /** Continue this CLI session instead of starting a new one. */
  resumeSession?: string
  /** How hard the model thinks (Claude `--effort`). Small jobs use `low`: faster and lighter on the limit. */
  effort?: 'low' | 'medium' | 'high'
  /** Let the file-reading tool open .env / key files (blocked by default). */
  allowSecrets?: boolean
  /** Claude only: keep stdin open and take messages as stream-json (instructions during a run). */
  live?: boolean
  /** External connections (Claude only): tools allowed without asking, tools always refused, extra args (MCP config). */
  external?: { allow: string[]; deny: string[]; args: string[]; ask: boolean }
}

/** What HiveDesk can really enforce per CLI (the pre-run check shows this honestly). */
export interface AdapterAccess {
  /** `flag` = the CLI itself enforces it; `prompt` = only asked for in the instructions. */
  permission: 'flag' | 'prompt'
  refDirs: 'flag' | 'prompt'
  /** `session` = same conversation continues; `replay` = a new run that is told what happened. */
  resume: 'session' | 'replay'
  stream: boolean
}

export function adapterAccess(id: AdapterId): AdapterAccess {
  switch (id) {
    case 'claude':
      return { permission: 'flag', refDirs: 'flag', resume: 'session', stream: true }
    case 'codex':
      // Reference folders: `--add-dir` would make them WRITABLE for the sandbox, so it is not used;
      // Codex's sandbox can read outside the work folder anyway (docs; not verified with a real CLI).
      return { permission: 'flag', refDirs: 'prompt', resume: 'replay', stream: true }
    default:
      return { permission: 'prompt', refDirs: 'prompt', resume: 'replay', stream: false }
  }
}

/**
 * The permission a task really runs with. Claude and Codex enforce levels themselves, so the
 * editing default is safe there. The other CLIs only get an instruction, so they start read-only
 * and a human has to pick editing on purpose (the pre-run check says so).
 */
export function effectivePermission(adapter: AdapterId, requested?: PermissionLevel): PermissionLevel {
  return requested ?? defaultPermission(adapter)
}

/** Commands the default level must not run: deleting, moving and resetting things. */
const DESTRUCTIVE_COMMANDS = [
  'rm',
  'rmdir',
  'mv',
  'unlink',
  'shred',
  'del',
  'erase',
  'rd',
  'Remove-Item',
  'git clean',
  'git reset'
]
export const DESTRUCTIVE_BASH_RULES = DESTRUCTIVE_COMMANDS.map((c) => `Bash(${c} *)`)

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

/** A Claude Code permission rule for everything under an absolute path (`//` = absolute; Windows drives become `/c/…`). */
export function claudePathRule(tool: string, abs: string): string {
  let p = abs.replace(/\\/g, '/')
  const m = p.match(/^([A-Za-z]):\/(.*)$/)
  if (m) p = `/${m[1].toLowerCase()}/${m[2]}`
  p = p.replace(/\/+$/, '')
  return `${tool}(/${p}/**)`
}

/** Remove `--flag value` (and `--flag=value`) pairs from an arg list. */
function dropFlag(args: string[], names: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (names.includes(a)) {
      i++ // skip its value
      continue
    }
    if (names.some((n) => a.startsWith(n + '='))) continue
    out.push(a)
  }
  return out
}

export function buildCommand(agent: Agent, opts: BuildOptions = {}): BuiltCommand {
  const spec = ADAPTERS[agent.adapter]
  // an old config may still name the removed Gemini CLI: say so instead of crashing
  if (!spec) throw new Error(`"${agent.adapter}" 연결은 더 이상 지원하지 않아요. Google 모델은 Antigravity(agy) 연결로 쓰세요. 에이전트의 AI 프로그램을 바꿔 주세요.`)
  const command = agent.adapter === 'custom' ? (agent.command ?? '').trim() : spec.command
  if (!command) throw new Error('이 에이전트에 실행할 명령이 지정되지 않았어요.')
  const parts = agent.adapter === 'custom' ? splitArgs(agent.extraArgs) : [...spec.baseArgs]
  const args: string[] = [...parts]
  const level = opts.permission ?? 'edit'
  const dirs = (opts.refDirs ?? []).filter(Boolean)
  let stream: StreamKind | undefined
  let resumed = false

  if (agent.adapter === 'claude') {
    let live = false
    if (opts.stream) {
      args.push('--output-format', 'stream-json', '--verbose')
      stream = 'claude'
      if (opts.live) {
        args.push('--input-format', 'stream-json', '--replay-user-messages')
        live = true
      }
    }
    if (agent.model && spec.modelFlag) args.push(spec.modelFlag, agent.model)
    let extra = splitArgs(agent.extraArgs)
    // Deny rules always win over allow rules, so they hold whatever the user's own settings say.
    const deny: string[] = []
    const allow: string[] = []
    if (level === 'read') {
      extra = dropFlag(extra, ['--permission-mode'])
      extra.push('--permission-mode', 'default')
      allow.push('Read', 'Grep', 'Glob')
      deny.push(...EDIT_TOOLS, 'Bash')
    } else if (level === 'exec') {
      extra = dropFlag(extra, ['--permission-mode'])
      extra.push('--permission-mode', 'acceptEdits')
      allow.push('Bash')
    } else {
      deny.push(...DESTRUCTIVE_BASH_RULES)
    }
    if (opts.external) {
      allow.push(...opts.external.allow)
      deny.push(...opts.external.deny)
    }
    if (allow.length) extra.push('--allowedTools', allow.join(','))
    if (!opts.allowSecrets) deny.push(...SECRET_READ_RULES)
    // Reference folders are opened with --add-dir, which also allows writing: take that back.
    for (const d of dirs) for (const tool of EDIT_TOOLS) deny.push(claudePathRule(tool, d))
    if (deny.length) extra.push('--disallowedTools', ...deny)
    args.push(...extra)
    for (const d of dirs) args.push(`--add-dir=${d}`)
    if (opts.effort && !splitArgs(agent.extraArgs).includes('--effort')) args.push('--effort', opts.effort)
    if (opts.resumeSession) {
      args.push('--resume', opts.resumeSession)
      resumed = true
    }
    if (opts.external) args.push(...opts.external.args)
    // the app answers permission requests (external connections) — only possible while stdin stays open
    const permissionPrompt = live && !!opts.external?.ask
    if (permissionPrompt) args.push('--permission-prompt-tool', 'stdio')
    return { command, args, stream, resumed, live, permissionPrompt }
  }

  if (agent.adapter === 'codex') {
    if (opts.stream) {
      args.push('--json')
      stream = 'codex'
    }
    if (agent.model && spec.modelFlag) args.push(spec.modelFlag, agent.model)
    let extra = splitArgs(agent.extraArgs)
    if (level === 'read') extra = [...dropFlag(extra, ['--sandbox', '-s']), '--sandbox', 'read-only']
    else if (level === 'exec') extra = [...dropFlag(extra, ['--sandbox', '-s']), '--sandbox', 'danger-full-access']
    args.push(...extra)
    // reference folders are read through the sandbox's normal read access; see adapterAccess
    args.push('-') // read prompt from stdin
    return { command, args, stream, resumed }
  }

  if (agent.adapter !== 'custom') {
    if (agent.model && spec.modelFlag) args.push(spec.modelFlag, agent.model)
    args.push(...splitArgs(agent.extraArgs))
    if (agent.adapter === 'agy') {
      // Headless agy auto-denies anything that needs a permission prompt. Only the command level
      // (which a human has to approve before the run) turns that off.
      if (level === 'exec') args.push('--dangerously-skip-permissions')
      if (process.platform === 'win32') {
        // cmd.exe cannot safely carry a long multi-line argument; use stdin there
        args.push('-p', 'Follow the task given on stdin.', '--input-format', 'text')
      } else {
        args.push('-p') // prompt is appended as this flag's value by runCli
        return { command, args, promptArg: true }
      }
    }
  }
  return { command, args }
}

const API_KEY_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY'
]

export function cleanEnv(
  base: NodeJS.ProcessEnv,
  stripApiKeys: boolean
): NodeJS.ProcessEnv {
  if (!stripApiKeys) return { ...base }
  const env = { ...base }
  for (const k of API_KEY_VARS) delete env[k]
  return env
}

/** cmd.exe quoting for the few args that may contain spaces. */
function winQuote(a: string): string {
  if (a === '' || /[\s"&|<>^]/.test(a)) return '"' + a.replace(/"/g, '\\"') + '"'
  return a
}

export interface RunOptions {
  cwd: string
  prompt: string
  /** Hard cap on the total run time. */
  timeoutMs: number
  /** Stop when nothing has happened (no output, no file change) for this long. 0/undefined = off. */
  idleTimeoutMs?: number
  /** Gives the caller a function to call whenever something happened outside the CLI's output (e.g. a file changed). */
  onTouchReady?: (touch: () => void) => void
  env: NodeJS.ProcessEnv
  onOutput?: (chunk: string) => void
  signal?: AbortSignal
  /** Live mode: called once with the handle that sends messages into the run. */
  onHandle?: (h: RunHandle) => void
  /** Live mode: the CLI echoed back a message we sent (it has been taken in). */
  onReplay?: (text: string) => void
  /** Permission-prompt mode: the AI wants a tool that was not allowed in advance. The run waits for the answer. */
  onPermission?: (req: PermissionRequest) => Promise<PermissionAnswer>
}

export interface PermissionRequest {
  tool: string
  input: Record<string, unknown>
}

export type PermissionAnswer = { allow: true; input?: Record<string, unknown> } | { allow: false; message: string }

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Why it timed out: no activity for a while, or the total time cap. */
  timeoutKind?: 'idle' | 'total'
  aborted: boolean
  spawnError?: string
}

const WIN_NOT_FOUND = /is not recognized as an internal or external command|내부 또는 외부 명령/i

/** How long a stopped CLI gets to exit on its own before it is killed. */
export const KILL_GRACE_MS = 5000

export type Runner = (built: BuiltCommand, opts: RunOptions) => Promise<RunResult>

/** Real process runner. npm-installed CLIs are .cmd shims on Windows, hence shell there. */
export const runCli: Runner = (built, opts) =>
  new Promise((resolve) => {
    const win = process.platform === 'win32'
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timeoutKind: 'idle' | 'total' | undefined
    let aborted = false
    let settled = false
    let idleTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    // live mode bookkeeping
    const live = !!built.live
    // a message injected mid-turn is folded into that turn, so results cannot be counted against messages: compare sent with echoed
    let sentCount = 0
    let echoCount = 0
    let busy = false
    let paused = false
    let afterInterrupt: string | undefined
    let interrupting = false
    let lineBuf = ''
    /** Permission requests waiting for the app's (or a person's) answer: no idle timeout meanwhile. */
    let asking = 0

    const done = (r: Partial<RunResult>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (idleTimer) clearTimeout(idleTimer)
      if (killTimer) clearTimeout(killTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code: null, stdout, stderr, timedOut, timeoutKind, aborted, ...r })
    }

    let child
    try {
      child = win
        ? spawn(built.command + ' ' + built.args.map(winQuote).join(' '), {
            cwd: opts.cwd,
            env: opts.env,
            shell: true,
            windowsHide: true
          })
        : spawn(built.command, built.promptArg ? [...built.args, opts.prompt] : built.args, {
            cwd: opts.cwd,
            env: opts.env
          })
    } catch (e) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        spawnError: (e as Error).message
      })
      return
    }

    const kill = (): void => {
      if (win && child.pid) {
        // With shell: true the CLI runs under cmd.exe; kill the whole tree.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
          'error',
          () => child.kill()
        )
        return
      }
      try {
        // Polite first (SIGTERM); a process that ignores it is killed 5 seconds later.
        child.kill('SIGTERM')
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, KILL_GRACE_MS)
        killTimer.unref()
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      timeoutKind = 'total'
      kill()
    }, opts.timeoutMs)
    // "Still alive" = it printed something or the caller saw files change; silence for too long ends the run.
    const touch = (): void => {
      if (!opts.idleTimeoutMs || settled || paused || asking > 0) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        timeoutKind = 'idle'
        kill()
      }, opts.idleTimeoutMs)
    }
    touch()
    opts.onTouchReady?.(touch)
    const onAbort = (): void => {
      aborted = true
      kill()
    }
    opts.signal?.addEventListener('abort', onAbort)

    const writeUser = (text: string): boolean => {
      const stdin = child.stdin
      if (!stdin || stdin.destroyed || !stdin.writable || stdinEnded) return false
      stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
      sentCount++
      busy = true
      paused = false
      touch()
      return true
    }
    let stdinEnded = false
    const endInput = (): void => {
      if (stdinEnded) return
      stdinEnded = true
      try {
        child.stdin?.end()
      } catch {
        /* already closed */
      }
    }
    /** A line of the CLI's output in live mode: results decide whether more input may still come. */
    const onLine = (line: string): void => {
      let e: { type?: string; subtype?: string; isReplay?: boolean; message?: { content?: unknown }; request_id?: string; request?: Record<string, unknown> }
      try {
        e = JSON.parse(line)
      } catch {
        return
      }
      if (e.type === 'control_request' && e.request?.subtype === 'can_use_tool' && e.request_id) {
        const id = e.request_id
        const tool = typeof e.request.tool_name === 'string' ? e.request.tool_name : ''
        const input = e.request.input && typeof e.request.input === 'object' ? (e.request.input as Record<string, unknown>) : {}
        asking++
        if (idleTimer) clearTimeout(idleTimer)
        const answer = opts.onPermission ? opts.onPermission({ tool, input }) : Promise.resolve<PermissionAnswer>({ allow: false, message: 'HiveDesk가 이 도구를 허용하지 않았어요.' })
        void answer
          .catch((err: Error): PermissionAnswer => ({ allow: false, message: err.message }))
          .then((a) => {
            asking--
            touch()
            const stdin = child.stdin
            if (settled || stdinEnded || !stdin || !stdin.writable) return
            const response = a.allow ? { behavior: 'allow', updatedInput: a.input ?? input } : { behavior: 'deny', message: a.message }
            stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } }) + '\n')
          })
        return
      }
      if (e.type === 'user' && e.isReplay) {
        const c = e.message?.content
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('') : ''
        if (text) opts.onReplay?.(text)
        echoCount++
      }
      const landed = (): boolean => {
        if (!interrupting) return false
        interrupting = false
        if (afterInterrupt !== undefined) {
          const next = afterInterrupt
          afterInterrupt = undefined
          if (writeUser(next)) return true
        }
        paused = true
        if (idleTimer) clearTimeout(idleTimer)
        return true
      }
      if (e.type === 'result') {
        // messages we wrote that the CLI has not echoed yet will start another turn
        busy = sentCount > echoCount
        if (landed()) return
        if (!busy && !paused) endInput()
      } else if (e.type === 'control_response' && !busy) {
        // the turn had already ended when the interrupt arrived
        landed()
      }
    }
    if (live) {
      opts.onHandle?.({
        send: (text) => {
          if (settled || interrupting) return false
          return writeUser(text)
        },
        interrupt: (next) => {
          const stdin = child.stdin
          if (settled || stdinEnded || !stdin || !stdin.writable) return false
          if (paused) {
            // already waiting: just deliver the message
            return next !== undefined ? writeUser(next) : true
          }
          if (!busy) return false
          interrupting = true
          afterInterrupt = next
          stdin.write(JSON.stringify({ type: 'control_request', request_id: `i${Date.now()}`, request: { subtype: 'interrupt' } }) + '\n')
          return true
        },
        paused: () => paused
      })
    }

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      stdout += s
      touch()
      opts.onOutput?.(s)
      if (live) {
        lineBuf += s
        let nl
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl)
          lineBuf = lineBuf.slice(nl + 1)
          if (line.trim()) onLine(line)
        }
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
      touch()
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      done({
        spawnError:
          e.code === 'ENOENT'
            ? `명령을 찾을 수 없어요: ${built.command}. 설치되어 있고 PATH에 잡혀 있는지 확인하세요.`
            : e.message
      })
    })
    child.on('close', (code) => {
      // cmd.exe reports a missing program as exit code 1 + a localized message
      if (win && code !== 0 && WIN_NOT_FOUND.test(stderr)) {
        return done({
          code,
          spawnError: `명령을 찾을 수 없어요: ${built.command}. 설치되어 있고 PATH에 잡혀 있는지 확인하세요.`
        })
      }
      done({ code })
    })
    child.stdin?.on('error', () => {
      /* EPIPE if the CLI exits before reading stdin */
    })
    if (live && built.permissionPrompt) {
      // the control protocol starts with an initialize request; tool permission requests come to us after it
      child.stdin?.write(JSON.stringify({ type: 'control_request', request_id: `init${Date.now()}`, request: { subtype: 'initialize', hooks: null } }) + '\n')
    }
    if (live) writeUser(opts.prompt)
    else child.stdin?.end(built.promptArg && !win ? '' : opts.prompt)
  })

/** Is the CLI installed? (`<cmd> --version`) */
export function detectAdapter(id: AdapterId, env: NodeJS.ProcessEnv = process.env): Promise<AdapterInfo> {
  const spec = ADAPTERS[id]
  const base: AdapterInfo = {
    id,
    label: spec.label,
    command: spec.command,
    found: false,
    install: spec.install,
    login: spec.login,
    note: spec.note
  }
  if (id === 'custom') return Promise.resolve({ ...base, found: true })
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    let out = ''
    let finished = false
    const finish = (v: Partial<AdapterInfo>): void => {
      if (finished) return
      finished = true
      resolve({ ...base, ...v })
    }
    try {
      const c = win
        ? spawn(spec.command + ' --version', { env, shell: true, windowsHide: true })
        : spawn(spec.command, ['--version'], { env })
      c.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      c.on('error', () => finish({ found: false }))
      c.on('close', (code) =>
        finish(code === 0 ? { found: true, version: out.trim().split('\n')[0] } : { found: false })
      )
      setTimeout(() => {
        c.kill()
        finish({ found: false })
      }, 8000).unref()
    } catch {
      finish({ found: false })
    }
  })
}

export function detectAll(env?: NodeJS.ProcessEnv): Promise<AdapterInfo[]> {
  const ids: AdapterId[] = ['claude', 'codex', 'agy']
  return Promise.all(ids.map((i) => detectAdapter(i, env)))
}
