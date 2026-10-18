import { execFile } from 'node:child_process'
import type { GhStatus } from '../shared/external'

/**
 * GitHub work is done by the app itself with the person's own `gh` login (stage 6-6), never by the AI:
 * that way every push, pull request and merge is recorded and only happens when a person said yes.
 */

export interface ExecResult {
  code: number | null
  out: string
  err: string
}
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; input?: string; timeoutMs?: number }) => Promise<ExecResult>

export const execTool: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } },
      (e, stdout, stderr) => {
        // a failed command carries its exit code; a missing program carries 'ENOENT'
        const c = (e as { code?: unknown } | null)?.code
        const code = !e ? 0 : typeof c === 'number' ? c : c === 'ENOENT' ? null : 1
        resolve({ code, out: String(stdout ?? ''), err: String(stderr ?? '') || (e && !stderr ? e.message : '') })
      }
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
    else child.stdin?.end()
  })

/** `owner/repo` (also from a github.com address). '' when it does not look like one. */
export function parseRepo(s: string): string {
  const t = s.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const m = t.match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/i) ?? t.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  return m ? `${m[1]}/${m[2]}` : ''
}

/** Is `gh` installed and logged in? */
export async function ghStatus(exec: Exec): Promise<GhStatus> {
  const at = new Date().toISOString()
  const v = await exec('gh', ['--version'], { timeoutMs: 15_000 })
  if (v.code !== 0) return { found: false, loggedIn: false, at, message: 'GitHub CLI(gh)가 없어요. https://cli.github.com 에서 설치하세요.' }
  const s = await exec('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 })
  if (s.code !== 0) return { found: true, loggedIn: false, at, message: '터미널에서 `gh auth login`을 한 번 실행해 GitHub 계정으로 로그인하세요 (무료 계정으로 충분해요).' }
  const u = await exec('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 15_000 })
  const user = u.code === 0 ? u.out.trim() : (s.out + s.err).match(/account\s+(\S+)/)?.[1]
  return { found: true, loggedIn: true, user, at, message: user ? `${user}(으)로 로그인돼 있어요.` : '로그인돼 있어요.' }
}

export interface Issue {
  number: number
  title: string
  body: string
  url: string
}

export async function listIssues(exec: Exec, repo: string, label: string): Promise<Issue[]> {
  const r = await exec('gh', ['issue', 'list', '--repo', repo, '--label', label, '--state', 'open', '--limit', '50', '--json', 'number,title,body,url'])
  if (r.code !== 0) throw new Error(firstLine(r.err) || '이슈를 가져오지 못했어요.')
  return JSON.parse(r.out || '[]') as Issue[]
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? ''

/** Push a task branch. The default branch is never pushed to directly. */
export async function pushBranch(exec: Exec, dir: string, branch: string, base: string): Promise<void> {
  if (!branch || branch === base || /^(main|master)$/.test(branch)) throw new Error(`기본 브랜치(${branch})에는 직접 올리지 않아요.`)
  const r = await exec('git', ['push', '-u', 'origin', `${branch}:${branch}`], { cwd: dir, timeoutMs: 120_000 })
  if (r.code !== 0) throw new Error(firstLine(r.err) || '브랜치를 올리지 못했어요.')
}

/** Open a pull request (or find the one that is already open for the branch). */
export async function createPr(exec: Exec, repo: string, base: string, branch: string, title: string, body: string): Promise<{ number: number; url: string }> {
  const have = await exec('gh', ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number,url'])
  if (have.code === 0) {
    const list = JSON.parse(have.out || '[]') as { number: number; url: string }[]
    if (list[0]) return list[0]
  }
  const r = await exec('gh', ['pr', 'create', '--repo', repo, '--base', base, '--head', branch, '--title', title, '--body-file', '-'], { input: body })
  if (r.code !== 0) throw new Error(firstLine(r.err) || 'PR을 만들지 못했어요.')
  const url = r.out.trim().split('\n').pop() ?? ''
  const n = Number(url.match(/\/pull\/(\d+)/)?.[1])
  if (!n) throw new Error('PR 주소를 읽지 못했어요: ' + url)
  return { number: n, url }
}

export interface PrState {
  state: 'open' | 'merged' | 'closed'
  checks: { state: 'pending' | 'pass' | 'fail' | 'none'; failing: string[] }
  /** Review texts and inline comments (newest last), with ids so each is taken in once. */
  comments: { id: string; author: string; body: string; where?: string }[]
}

type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string }

/** Sum up the checks of a PR (statusCheckRollup mixes check runs and commit statuses). */
export function checksOf(rollup: Check[]): PrState['checks'] {
  if (!rollup.length) return { state: 'none', failing: [] }
  const failing: string[] = []
  let pending = false
  for (const c of rollup) {
    const v = (c.conclusion || c.state || '').toUpperCase()
    const st = (c.status || '').toUpperCase()
    if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'].includes(v)) failing.push(c.name || c.context || '검사')
    else if ((st && st !== 'COMPLETED') || v === 'PENDING' || v === 'EXPECTED' || (!v && !st)) pending = true
  }
  return { state: failing.length ? 'fail' : pending ? 'pending' : 'pass', failing }
}

export async function prState(exec: Exec, repo: string, n: number): Promise<PrState> {
  const r = await exec('gh', ['pr', 'view', String(n), '--repo', repo, '--json', 'state,statusCheckRollup,reviews,comments'])
  if (r.code !== 0) throw new Error(firstLine(r.err) || 'PR 상태를 읽지 못했어요.')
  const j = JSON.parse(r.out) as {
    state: string
    statusCheckRollup?: Check[]
    reviews?: { id: string; author?: { login?: string }; body?: string; state?: string }[]
    comments?: { id: string; author?: { login?: string }; body?: string }[]
  }
  const comments: PrState['comments'] = []
  for (const x of j.reviews ?? []) if (x.body?.trim()) comments.push({ id: 'r' + x.id, author: x.author?.login ?? '', body: x.body.trim() })
  for (const x of j.comments ?? []) if (x.body?.trim()) comments.push({ id: 'c' + x.id, author: x.author?.login ?? '', body: x.body.trim() })
  // comments on lines of the code are only in the REST API
  const inline = await exec('gh', ['api', `repos/${repo}/pulls/${n}/comments`, '--paginate'])
  if (inline.code === 0) {
    try {
      for (const x of JSON.parse(inline.out || '[]') as { id: number; user?: { login?: string }; body?: string; path?: string; line?: number }[]) {
        if (x.body?.trim()) comments.push({ id: 'l' + x.id, author: x.user?.login ?? '', body: x.body.trim(), where: x.path ? `${x.path}${x.line ? ':' + x.line : ''}` : undefined })
      }
    } catch {
      /* several pages print several arrays: the first ones are still taken in next time */
    }
  }
  const state = j.state === 'MERGED' ? 'merged' : j.state === 'CLOSED' ? 'closed' : 'open'
  return { state, checks: checksOf(j.statusCheckRollup ?? []), comments }
}

export async function mergePr(exec: Exec, repo: string, n: number): Promise<void> {
  const r = await exec('gh', ['pr', 'merge', String(n), '--repo', repo, '--merge'])
  if (r.code !== 0) throw new Error(firstLine(r.err) || 'PR을 합치지 못했어요.')
}

export async function commentIssue(exec: Exec, repo: string, n: number, body: string): Promise<void> {
  const r = await exec('gh', ['issue', 'comment', String(n), '--repo', repo, '--body-file', '-'], { input: body })
  if (r.code !== 0) throw new Error(firstLine(r.err) || '이슈에 댓글을 달지 못했어요.')
}

/** `hive/<task title>-<id end>`: readable on GitHub, unique per task. */
export function taskBranch(title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `hive/${slug || 'task'}-${id.slice(-6)}`
}
