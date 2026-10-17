import { spawn } from 'node:child_process'
import type { AdapterId, AdapterInfo, Agent } from '../shared/types'

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
    note: '추가 인자에 --bare를 넣지 마세요. bare 모드는 구독 로그인을 쓰지 않고 API 키를 요구해요.'
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
    note: 'ChatGPT 요금제로 로그인하면 API 과금 없이 쓸 수 있어요.'
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    baseArgs: ['-p', 'Follow the task given on stdin.'],
    modelFlag: '-m',
    defaultExtraArgs: '',
    install: 'npm i -g @google/gemini-cli',
    login: '`gemini`를 한 번 실행해 Google 계정으로 로그인하세요.',
    note: '2026-06-18부터 무료·AI Pro·Ultra 개인 계정은 Antigravity(agy)로 옮겨졌어요. Gemini CLI는 Code Assist 라이선스·Vertex·API 키로만 계속 쓸 수 있어요.'
  },
  agy: {
    id: 'agy',
    label: 'Antigravity CLI (agy)',
    command: 'agy',
    baseArgs: ['-p', 'Follow the task given on stdin.', '--input-format', 'text'],
    defaultExtraArgs: '',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    login: '`agy`를 한 번 실행하면 브라우저가 열려 Google 계정으로 로그인해요. 무료 계정도 쓸 수 있어요.',
    note: 'stdin 입력 방식은 공식 문서에 자세히 나와 있지 않아요. 에이전트를 만든 뒤 "테스트" 버튼으로 먼저 확인하세요.'
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
  return ADAPTERS[id].defaultExtraArgs
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
}

export function buildCommand(agent: Agent): BuiltCommand {
  const spec = ADAPTERS[agent.adapter]
  const command = agent.adapter === 'custom' ? (agent.command ?? '').trim() : spec.command
  if (!command) throw new Error('이 에이전트에 실행할 명령이 지정되지 않았어요.')
  const parts = agent.adapter === 'custom' ? splitArgs(agent.extraArgs) : [...spec.baseArgs]
  const args: string[] = [...parts]
  if (agent.adapter !== 'custom') {
    if (agent.model && spec.modelFlag) args.push(spec.modelFlag, agent.model)
    args.push(...splitArgs(agent.extraArgs))
    if (agent.adapter === 'codex') args.push('-') // read prompt from stdin
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
  timeoutMs: number
  env: NodeJS.ProcessEnv
  onOutput?: (chunk: string) => void
  signal?: AbortSignal
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  spawnError?: string
}

export type Runner = (built: BuiltCommand, opts: RunOptions) => Promise<RunResult>

/** Real process runner. npm-installed CLIs are .cmd shims on Windows, hence shell there. */
export const runCli: Runner = (built, opts) =>
  new Promise((resolve) => {
    const win = process.platform === 'win32'
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const done = (r: Partial<RunResult>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code: null, stdout, stderr, timedOut, aborted, ...r })
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
        : spawn(built.command, built.args, { cwd: opts.cwd, env: opts.env })
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
      kill()
    }, opts.timeoutMs)
    const onAbort = (): void => {
      aborted = true
      kill()
    }
    opts.signal?.addEventListener('abort', onAbort)

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      stdout += s
      opts.onOutput?.(s)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      done({
        spawnError:
          e.code === 'ENOENT'
            ? `명령을 찾을 수 없어요: ${built.command}. 설치되어 있고 PATH에 잡혀 있는지 확인하세요.`
            : e.message
      })
    })
    child.on('close', (code) => done({ code }))
    child.stdin?.on('error', () => {
      /* EPIPE if the CLI exits before reading stdin */
    })
    child.stdin?.end(opts.prompt)
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
  const ids: AdapterId[] = ['claude', 'codex', 'gemini', 'agy']
  return Promise.all(ids.map((i) => detectAdapter(i, env)))
}
