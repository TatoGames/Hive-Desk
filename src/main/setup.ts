import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { AdapterId, SetupCheck } from '../shared/types'
import { buildCommand, cleanEnv, runCli, type Runner } from './adapters'
import { makeAgent } from './config'

/**
 * One-click setup for each AI CLI: install with the vendor's official command,
 * open the vendor's own login flow in a terminal window, and check the login works.
 * HiveDesk never sees passwords or tokens: login happens in the CLI itself.
 */
interface SetupSpec {
  /** Official install command per platform (run in a shell). */
  install: Partial<Record<'unix' | 'win32', string>>
  /** Command that starts the CLI's own login flow. */
  login: string
  needsNode?: boolean
}

export const SETUP: Partial<Record<AdapterId, SetupSpec>> = {
  claude: {
    install: {
      unix: 'curl -fsSL https://claude.ai/install.sh | bash',
      win32: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
    },
    login: 'claude'
  },
  codex: {
    install: {
      unix: 'npm install -g --prefix "$HOME/.npm-global" @openai/codex',
      win32: 'npm install -g @openai/codex'
    },
    login: 'codex login',
    needsNode: true
  },
  agy: {
    install: { unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    login: 'agy'
  },
  gemini: {
    install: {
      unix: 'npm install -g --prefix "$HOME/.npm-global" @google/gemini-cli',
      win32: 'npm install -g @google/gemini-cli'
    },
    login: 'gemini',
    needsNode: true
  }
}

function platformKey(): 'unix' | 'win32' {
  return process.platform === 'win32' ? 'win32' : 'unix'
}

export function installCommand(id: AdapterId): string | undefined {
  return SETUP[id]?.install[platformKey()]
}

/** Run the official installer, streaming its output. Resolves with success. */
export function installCli(
  id: AdapterId,
  onOutput: (chunk: string) => void
): Promise<{ ok: boolean; message: string }> {
  const cmd = installCommand(id)
  if (!cmd) {
    return Promise.resolve({
      ok: false,
      message: '이 운영체제에서는 자동 설치를 지원하지 않아요. 공식 설치 안내를 따라 주세요.'
    })
  }
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    const child = win
      ? spawn(cmd, { shell: true, windowsHide: true, env: process.env, cwd: homedir() })
      : spawn('/bin/bash', ['-lc', cmd], { env: process.env, cwd: homedir() })
    let tail = ''
    const take = (d: Buffer): void => {
      const s = d.toString('utf8')
      tail = (tail + s).slice(-2000)
      onOutput(s)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const timer = setTimeout(() => child.kill(), 10 * 60_000)
    child.on('error', (e) =>
      resolve({ ok: false, message: '설치를 시작하지 못했어요: ' + e.message })
    )
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ ok: true, message: '설치를 마쳤어요.' })
      const noNode = SETUP[id]?.needsNode && /npm: (command )?not found|'npm'/i.test(tail)
      resolve({
        ok: false,
        message: noNode
          ? '이 CLI는 Node.js가 필요해요. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 눌러 주세요.'
          : `설치에 실패했어요 (코드 ${code}). 아래 기록을 확인해 주세요.`
      })
    })
  })
}

function appleScriptString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** Open a terminal window running the CLI's own login flow. */
export function openLogin(id: AdapterId): { ok: boolean; message: string } {
  const spec = SETUP[id]
  if (!spec) return { ok: false, message: '로그인 안내가 없는 CLI예요.' }
  const path = process.env.PATH ?? ''
  try {
    if (process.platform === 'darwin') {
      const line = `export PATH=${JSON.stringify(path)}; clear; echo "로그인을 마치면 이 창을 닫아도 돼요."; ${spec.login}`
      spawn(
        'osascript',
        [
          '-e',
          'tell application "Terminal"',
          '-e',
          'activate',
          '-e',
          `do script ${appleScriptString(line)}`,
          '-e',
          'end tell'
        ],
        { detached: true, stdio: 'ignore' }
      ).unref()
    } else if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'HiveDesk 로그인', 'cmd', '/k', spec.login], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      }).unref()
    } else {
      const sh = `${spec.login}; exec bash`
      const child = spawn('x-terminal-emulator', ['-e', 'bash', '-lc', sh], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      child.on('error', () => {
        /* no terminal emulator: the UI shows the command to run manually */
      })
      child.unref()
    }
    return { ok: true, message: '터미널 창을 열었어요. 안내에 따라 로그인한 뒤 "연결 확인"을 눌러 주세요.' }
  } catch (e) {
    return { ok: false, message: `터미널을 열지 못했어요. 직접 \`${spec.login}\`을 실행해 주세요.` }
  }
}

const AUTH_HINT =
  /(log ?in|sign ?in|authenticat|unauthori[sz]ed|credential|not logged|api[ _-]?key|oauth|401|403)/i

/** Ask the CLI for a one-word reply to prove install + login work. */
export async function checkCli(
  id: AdapterId,
  runner: Runner = runCli,
  env: NodeJS.ProcessEnv = process.env
): Promise<SetupCheck> {
  const agent = makeAgent('check', { name: 'check', adapter: id, extraArgs: '' })
  const built = buildCommand(agent)
  const res = await runner(built, {
    cwd: homedir(),
    prompt: 'This is a connection check. Reply with exactly one word: OK',
    timeoutMs: 120_000,
    env: cleanEnv(env, true)
  })
  const out = (res.stdout + '\n' + res.stderr).trim()
  if (res.spawnError) return { ok: false, needsLogin: false, message: res.spawnError }
  if (res.timedOut) {
    return {
      ok: false,
      needsLogin: true,
      message: '응답이 없어요. 아직 로그인하지 않았거나 로그인 창이 열려 있을 수 있어요.'
    }
  }
  if (res.code === 0 && res.stdout.trim() && !/error/i.test(res.stdout.slice(0, 80))) {
    return { ok: true, needsLogin: false, message: '연결됐어요: ' + res.stdout.trim().slice(0, 80) }
  }
  const needsLogin = AUTH_HINT.test(out)
  return {
    ok: false,
    needsLogin,
    message: needsLogin
      ? '로그인이 필요해요. "로그인"을 눌러 계정으로 로그인해 주세요.'
      : '연결에 실패했어요: ' + out.slice(-300)
  }
}
