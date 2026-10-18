/**
 * External connections (v4 stage 6-5 ~ 6-7): the web (read only), GitHub, and other apps over MCP.
 *
 * Rules: off until a person gives an employee access; per company (another company never sees them);
 * writing to the outside is approved by a person while the run waits; logins stay on this computer.
 */

export type ExtKind = 'web' | 'github' | 'mcp'

/** What an employee may do with one connection. */
export type ExtAccess = 'none' | 'read' | 'write-approve' | 'write-auto'

export const ACCESS_LABEL: Record<ExtAccess, string> = {
  none: '없음',
  read: '읽기',
  'write-approve': '쓰기(결재)',
  'write-auto': '쓰기(자동)'
}

export interface McpTool {
  name: string
  description?: string
  /** Changes something outside (sends, edits, deletes). Tools without a read-only hint count as writing. */
  write: boolean
  /** A person changed the automatic read/write guess. */
  manual?: boolean
}

export interface WebSettings {
  /** Web search (Claude WebSearch). */
  search: boolean
  /** Reading pages (Claude WebFetch). Only the sites listed; others are asked for while the run waits. */
  fetch: boolean
  /** Domains that may be read without asking (e.g. `docs.godotengine.org`). */
  sites: string[]
}

export interface GithubSettings {
  /** After the person's check passes, push the task branch and open a pull request without asking (merging always asks). */
  autoPr: boolean
  /** Open issues with this label become tasks (empty = no import). */
  issueLabel?: string
}

export interface McpSettings {
  /** Catalog entry it was made from (`notion`, `slack` ...), or absent when typed in. */
  preset?: string
  transport: 'stdio' | 'http'
  /** stdio: the program and its arguments. */
  command?: string
  args?: string[]
  /** http: the server address. */
  url?: string
  /** How it logs in. The secret itself never leaves this computer (OS secure storage). */
  auth: 'none' | 'token'
  /** stdio: the environment variable the token goes into. http: sent as `Authorization: Bearer`. */
  tokenEnv?: string
  /** Extra non-secret environment values for a stdio server (e.g. a team id). */
  env?: Record<string, string>
  tools: McpTool[]
  toolsAt?: string
}

/** One connection of a company. Shared with the team (no secrets in it). */
export interface ExtConnection {
  id: string
  kind: ExtKind
  name: string
  createdAt: string
  createdBy: string
  web?: WebSettings
  github?: GithubSettings
  mcp?: McpSettings
  /** `agent:<id>` or `rank:<rankId>` → access. An employee's own line wins over the rank's. */
  access: Record<string, ExtAccess>
}

/** The live answer to one tool request (also what the audit log keeps). */
export type ExtOutcome = 'allowed' | 'denied' | 'approved' | 'edited' | 'rejected' | 'timeout' | 'auto'

/** One thing an AI (or the app for it) did or tried with a connection. Append-only. */
export interface ExtLogEntry {
  id: string
  at: string
  connectionId: string
  connectionName: string
  kind: ExtKind
  agentId: string
  taskId: string
  runId?: string
  tool: string
  /** What was asked, short (the full input is in the approval / run record). */
  summary: string
  write: boolean
  outcome: ExtOutcome
  reason?: string
  /** By whom, for approvals. */
  by?: string
}

/** What an approval for a live tool request carries (the screen shows all of it). */
export interface ExtRequest {
  connectionId: string
  connectionName: string
  kind: ExtKind
  tool: string
  /** The tool input as the AI sent it (pretty JSON). */
  input: string
  write: boolean
  runId: string
  /** A web page outside the allowed sites: the domain, so the person can allow it for good. */
  site?: string
  /** When the request gives up by itself. */
  expiresAt: string
}

/** What a run may use: decided before the run from the connections, the employee and the task. */
export interface ExtGrant {
  connection: ExtConnection
  access: ExtAccess
}

const RANK: Record<ExtAccess, number> = { none: 0, read: 1, 'write-approve': 2, 'write-auto': 3 }

/** The access an employee has to a connection: their own line, else their rank's, else none. */
export function accessOf(c: ExtConnection, agent: { id: string; rankId?: string }): ExtAccess {
  const own = c.access[`agent:${agent.id}`]
  if (own) return own
  if (agent.rankId && c.access[`rank:${agent.rankId}`]) return c.access[`rank:${agent.rankId}`]
  return 'none'
}

export function atLeast(a: ExtAccess, b: ExtAccess): boolean {
  return RANK[a] >= RANK[b]
}

/** `https://Docs.Godotengine.org/en/` → `docs.godotengine.org`. Anything that is not a host gives ''. */
export function domainOf(urlOrHost: string): string {
  const s = urlOrHost.trim().toLowerCase()
  if (!s) return ''
  try {
    return new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Is the page on one of the allowed sites (the site itself or a sub-domain)? */
export function siteAllowed(url: string, sites: string[]): boolean {
  const d = domainOf(url)
  if (!d) return false
  return sites.some((s) => {
    const x = domainOf(s)
    return !!x && (d === x || d.endsWith('.' + x))
  })
}

/** Well-known documentation sites offered when the web is switched on. */
export const SUGGESTED_SITES = [
  'docs.godotengine.org',
  'docs.unity3d.com',
  'developer.mozilla.org',
  'docs.python.org',
  'nodejs.org',
  'react.dev',
  'learn.microsoft.com'
]

/** MCP server key used in tool names (`mcp__<key>__<tool>`): ASCII only, unique per connection. */
export function mcpKey(c: Pick<ExtConnection, 'id'>): string {
  return 'hd_' + c.id.replace(/[^a-zA-Z0-9]/g, '').slice(-12)
}

export interface McpPreset {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  auth: 'none' | 'token'
  tokenEnv?: string
  /** Non-secret values the person fills in (env var → label). */
  fields?: Record<string, string>
  /** Where the token comes from, what it needs, and what is not checked yet. */
  note: string
}

/**
 * Apps with an MCP server that works with a token or no login. Servers that only offer an OAuth login cannot
 * sign in from a headless run, so they are not offered here (see the "직접 입력" form and the docs).
 */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'notion',
    name: 'Notion',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    auth: 'token',
    tokenEnv: 'NOTION_TOKEN',
    note: 'Notion 설정 → 연결(Integrations)에서 내부 통합을 만들고 토큰(ntn_…)을 붙여 넣으세요. 읽게 할 페이지에 그 통합을 연결해야 해요. Node.js(npx)가 필요해요.'
  },
  {
    id: 'slack',
    name: 'Slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    auth: 'token',
    tokenEnv: 'SLACK_BOT_TOKEN',
    fields: { SLACK_TEAM_ID: '워크스페이스 ID (T로 시작)' },
    note: 'Slack 앱을 만들고 봇 토큰(xoxb-…)을 붙여 넣으세요. 메시지를 보낼 채널에 봇을 초대해야 해요. Node.js(npx)가 필요해요.'
  },
  {
    id: 'figma',
    name: 'Figma (데스크톱 Dev Mode)',
    transport: 'http',
    url: 'http://127.0.0.1:3845/mcp',
    auth: 'none',
    note: 'Figma 데스크톱 앱 → 환경설정에서 "Dev Mode MCP 서버"를 켜면 이 컴퓨터에서만 열리는 주소예요. 로그인은 Figma 앱이 해요.'
  },
  {
    id: 'linear',
    name: 'Linear',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'token',
    note: 'Linear 설정 → API에서 개인 API 키를 만들어 붙여 넣으세요 (Authorization 헤더로 보내요). 키 방식이 막혀 있으면 [도구 목록 읽기]에서 오류가 나요.'
  }
]

/** GitHub CLI on this computer. */
export interface GhStatus {
  found: boolean
  loggedIn: boolean
  user?: string
  message: string
  at: string
}

/** What the "외부 연결" tab shows. */
export interface ExtView {
  connections: (ExtConnection & { hasSecret: boolean })[]
  log: ExtLogEntry[]
  gh: GhStatus | null
  /** Can this computer keep tokens in the OS secure storage? */
  secureStorage: boolean
}
