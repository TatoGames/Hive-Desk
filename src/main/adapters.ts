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
}

export interface BuildOptions {
  /** Ask for the CLI's step-by-step event output (activity feed). Off for one-shot checks. */
  stream?: boolean
  permission?: PermissionLevel
  /** Extra folders the agent may read. */
  refDirs?: string[]
  /** Continue this CLI session instead of starting a new one. */
  resumeSession?: string
  /** Let the file-reading tool open .env / key files (blocked by default). */
  allowSecrets?: boolean
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
    if (opts.stream) {
      args.push('--output-format', 'stream-json', '--verbose')
      stream = 'claude'
    }
    if (agent.model && spec.modelFlag) args.push(spec.modelFlag, agent.model)
    let extra = splitArgs(agent.extraArgs)
    // Deny rules always win over allow rules, so they hold whatever the user's own settings say.
    const deny: string[] = []
    if (level === 'read') {
      extra = dropFlag(extra, ['--permission-mode'])
      extra.push('--permission-mode', 'default', '--allowedTools', 'Read,Grep,Glob')
      deny.push(...EDIT_TOOLS, 'Bash')
    } else if (level === 'exec') {
      extra = dropFlag(extra, ['--permission-mode'])
      extra.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash')
    } else {
      deny.push(...DESTRUCTIVE_BASH_RULES)
    }
    if (!opts.allowSecrets) deny.push(...SECRET_READ_RULES)
    // Reference folders are opened with --add-dir, which also allows writing: take that back.
    for (const d of dirs) for (const tool of EDIT_TOOLS) deny.push(claudePathRule(tool, d))
    if (deny.length) extra.push('--disallowedTools', ...deny)
    args.push(...extra)
    for (const d of dirs) args.push(`--add-dir=${d}`)
    if (opts.resumeSession) {
      args.push('--resume', opts.resumeSession)
      resumed = true
    }
    return { command, args, stream, resumed }
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
}

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

    const done = (r: Partial<RunResult>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (idleTimer) clearTimeout(idleTimer)
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
        child.kill('SIGTERM')
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, 3000).unref()
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
      if (!opts.idleTimeoutMs || settled) return
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

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      stdout += s
      touch()
      opts.onOutput?.(s)
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
    child.stdin?.end(built.promptArg && !win ? '' : opts.prompt)
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
