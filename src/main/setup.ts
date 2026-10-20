import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  return runInstall(installCommand(id), onOutput, !!SETUP[id]?.needsNode)
}

/**
 * GitHub CLI (gh), used by the app itself for GitHub work (stage 6-6). Windows: winget.
 * macOS / Linux: the official release archive, unpacked into ~/.local/bin (no admin rights, no Homebrew needed).
 */
const GH_UNIX = [
  'set -e',
  // the latest release page redirects to .../tag/vX.Y.Z (no API call, so no API rate limit)
  'V=$(curl -fsSLI -o /dev/null -w "%{url_effective}" https://github.com/cli/cli/releases/latest | sed -n \'s#.*/tag/v##p\')',
  '[ -n "$V" ] || { echo "최신 버전을 알아내지 못했어요"; exit 1; }',
  'case "$(uname -m)" in x86_64|amd64) A=amd64;; arm64|aarch64) A=arm64;; *) echo "지원하지 않는 CPU: $(uname -m)"; exit 1;; esac',
  'T=$(mktemp -d); mkdir -p "$HOME/.local/bin"',
  'if [ "$(uname -s)" = Darwin ]; then N=gh_${V}_macOS_$A; curl -fsSL -o "$T/gh.zip" "https://github.com/cli/cli/releases/download/v$V/$N.zip"; (cd "$T" && unzip -q gh.zip);',
  'else N=gh_${V}_linux_$A; curl -fsSL "https://github.com/cli/cli/releases/download/v$V/$N.tar.gz" | tar -xz -C "$T"; fi',
  'cp "$T/$N/bin/gh" "$HOME/.local/bin/gh"; chmod +x "$HOME/.local/bin/gh"; rm -rf "$T"',
  '"$HOME/.local/bin/gh" --version'
].join('\n')
const GH_WIN = 'winget install --id GitHub.cli -e --source winget --accept-source-agreements --accept-package-agreements'

export function ghInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? GH_WIN : GH_UNIX
}

export async function installGh(onOutput: (chunk: string) => void): Promise<{ ok: boolean; message: string }> {
  const r = await runInstall(ghInstallCommand(), onOutput, false)
  if (!r.ok && process.platform === 'win32') {
    return { ok: false, message: r.message + ' winget이 없는 Windows라면 https://cli.github.com 에서 설치 파일을 받아 주세요.' }
  }
  return r.ok ? { ok: true, message: 'GitHub CLI를 설치했어요. 이제 [GitHub 로그인]을 눌러 주세요.' } : r
}

/** Open a terminal with gh's own browser login. */
export function openGhLogin(): { ok: boolean; message: string } {
  return openTerminal('gh auth login --hostname github.com --git-protocol https --web')
}

function runInstall(cmd: string | undefined, onOutput: (chunk: string) => void, needsNode: boolean): Promise<{ ok: boolean; message: string }> {
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
      const noNode = needsNode && /npm: (command )?not found|'npm'/i.test(tail)
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
  return openTerminal(spec.login)
}

function openTerminal(login: string): { ok: boolean; message: string } {
  const spec = { login }
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
  /(log ?in|sign ?in|authenticat|unauthori[sz]ed|credential|not logged|api[ _-]?key|oauth|\b401\b|\b403\b)/i

/** Ask the CLI for a one-word reply to prove install + login work. */
/** The top-level `model` and `model_provider` of a Codex config.toml (what a run without `-m` falls back to). */
export function codexConfigDefaults(toml: string): { model?: string; provider?: string } {
  const top = toml.split(/^\s*\[/m)[0]
  const pick = (key: string): string | undefined => top.match(new RegExp('^\\s*' + key + '\\s*=\\s*["\']([^"\']+)["\']', 'm'))?.[1]
  return { model: pick('model'), provider: pick('model_provider') }
}

export async function checkCli(
  id: AdapterId,
  runner: Runner = runCli,
  env: NodeJS.ProcessEnv = process.env,
  /** Check one specific model instead of the CLI's default. */
  model?: string
): Promise<SetupCheck> {
  const agent = makeAgent('check', { name: 'check', adapter: id, extraArgs: '', model })
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
  // Codex falls back to the default model of the user's own config; when that is an Ollama cloud model the CLI asks for an
  // Ollama account. The ChatGPT login is not the problem, so do not send the person to "로그인".
  if (id === 'codex' && /ollama account|sign in to ollama/i.test(out)) {
    let cfg = ''
    try {
      cfg = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8')
    } catch {
      /* no config file */
    }
    const set = codexConfigDefaults(cfg)
    const now = set.model || set.provider ? ` (지금 설정: ${[set.model && `model=${set.model}`, set.provider && `model_provider=${set.provider}`].filter(Boolean).join(', ')})` : ''
    return {
      ok: false,
      needsLogin: false,
      message:
        'Codex 설정(~/.codex/config.toml)의 기본 모델이 Ollama 계정이 필요한 모델이에요' + now + '. ChatGPT 로그인 문제가 아니에요. 설정의 model·model_provider를 바꾸거나, 에이전트에 모델(예: gpt-5)을 직접 지정해 주세요.'
    }
  }
  const needsLogin = AUTH_HINT.test(out)
  return {
    ok: false,
    needsLogin,
    message: needsLogin
      ? '로그인이 필요해요. "로그인"을 눌러 계정으로 로그인해 주세요. (CLI가 돌려준 말: ' + out.replace(/\s+/g, ' ').slice(-200) + ')'
      : '연결에 실패했어요: ' + out.slice(-300)
  }
}
