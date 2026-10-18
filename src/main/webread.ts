/**
 * "앱이 대신 읽어 주기": the app fetches a page a person attached and keeps only its text, so any AI
 * (also the ones that cannot browse) can use it. Read only: no forms, no logins, no cookies.
 */

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

/** Most text kept from one page (the AI reads it as an attachment). */
export const PAGE_TEXT_MAX = 200_000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–' }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** The readable text of an HTML page: no scripts, styles or navigation chrome; headings and list items on their own lines. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim())
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|table|ul|ol|dd|dt)>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
  s = decode(s)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text: s }
}

/** Fetch a page and return its text. Only http(s); a non-text answer is refused. */
export async function readPage(url: string, fetchFn: FetchFn = fetch as unknown as FetchFn, timeoutMs = 20_000): Promise<{ url: string; title: string; text: string }> {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    throw new Error('주소 형식이 아니에요.')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('http(s) 주소만 읽을 수 있어요.')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchFn(u.toString(), { headers: { 'User-Agent': 'HiveDesk (read-only page reader)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' }, signal: ac.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`페이지를 가져오지 못했어요 (HTTP ${res.status}).`)
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (type && !/(text\/|html|xml|json)/.test(type)) throw new Error(`글이 아닌 자료라서 읽지 않았어요 (${type.split(';')[0]}). 파일로 받아 첨부하세요.`)
    const body = await res.text()
    const isHtml = /html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(body)
    const page = isHtml ? htmlToText(body) : { title: '', text: body.trim() }
    const text = page.text.length > PAGE_TEXT_MAX ? page.text.slice(0, PAGE_TEXT_MAX) + `\n…(${page.text.length - PAGE_TEXT_MAX}자 생략)` : page.text
    return { url: u.toString(), title: page.title, text }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('페이지가 응답하지 않아요 (시간 초과).')
    throw e
  } finally {
    clearTimeout(timer)
  }
}
