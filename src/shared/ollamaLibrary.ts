/**
 * J4: "다른 모델 찾기". The Ollama library page is read as text and turned into a list. The page has no
 * official interface, so the parser only trusts what is easy to see (the link to /library/<name>, the
 * size tags like `7b`, the capability words) and gives back an empty list when the page looks different.
 */
export interface LibraryItem {
  name: string
  description: string
  /** `tools`, `thinking`, `vision`, `embedding`, `cloud` as the page shows them. */
  caps: string[]
  /** Size tags such as `7b`, `14b`, `8x7b`, `270m`. */
  sizes: string[]
  pulls?: string
}

const CAPS = ['tools', 'thinking', 'vision', 'embedding', 'cloud', 'audio']
// sizes are written in lower case (`270m`, `7b`); pull counts in upper case (`22.3M`), which is how they are told apart
const SIZE = /^(?:\d+x)?\d+(?:\.\d+)?[bm]$/
const NAME = /^[a-z0-9][a-z0-9._-]*$/i

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')

export function parseLibrary(html: string): LibraryItem[] {
  if (typeof html !== 'string' || !html) return []
  const out: LibraryItem[] = []
  const seen = new Set<string>()
  // one block per link to a library page, up to the next such link
  const re = /<a\b[^>]*href="\/library\/([^"/?#]+)"[^>]*>/gi
  const hits: { name: string; at: number; end: number }[] = []
  for (let m = re.exec(html); m; m = re.exec(html)) hits.push({ name: decodeURIComponent(m[1]), at: m.index, end: m.index + m[0].length })
  hits.forEach((h, i) => {
    if (!NAME.test(h.name) || seen.has(h.name)) return
    const block = html.slice(h.end, i + 1 < hits.length ? hits[i + 1].at : Math.min(html.length, h.end + 6000))
    // words in the block, tags removed (each tag is a break so neighbouring spans do not stick together)
    const words = decode(block.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, '\n'))
      .split(/\n+/)
      .map((w) => w.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const caps: string[] = []
    const sizes: string[] = []
    let pulls: string | undefined
    const rest: string[] = []
    for (const w of words) {
      const lw = w.toLowerCase()
      if (CAPS.includes(lw)) caps.push(lw)
      else if (SIZE.test(w)) sizes.push(w)
      else if (/^[\d.,]+[KMB]?$/.test(w) && /[KMB]$|,/.test(w)) pulls ??= w
      else if (/^(pulls?|tags?|updated|downloads?)$/i.test(w) || /^\d+\s+(pulls?|tags?)$/i.test(w) || /ago$/i.test(w)) continue
      else rest.push(w)
    }
    // the name is itself the first text; the description is the first longer line after it
    const description = rest.find((w) => w !== h.name && w.length > 12) ?? ''
    seen.add(h.name)
    out.push({ name: h.name, description: description.slice(0, 200), caps: [...new Set(caps)], sizes: [...new Set(sizes)], ...(pulls ? { pulls } : {}) })
  })
  return out
}

/** Models for the staff list are text models: not search-only and not picture-only, and not only in the cloud. */
export function isStaffCandidate(i: LibraryItem): boolean {
  if (i.caps.includes('embedding')) return false
  if (i.caps.includes('cloud') && !i.sizes.length) return false // only runs on Ollama's servers
  if (i.caps.includes('vision') && !i.caps.includes('tools')) return false
  return true
}

/** `name:size` choices to install. A model with no size tags installs by its plain name (the default one). */
export function installChoices(i: LibraryItem): string[] {
  return i.sizes.length ? i.sizes.map((s) => `${i.name}:${s}`) : [i.name]
}

export const libraryUrl = (name: string): string => `https://ollama.com/library/${encodeURIComponent(name)}`

export const LIBRARY_SEARCH_URL = (q: string): string => `https://ollama.com/search?q=${encodeURIComponent(q.trim())}`
