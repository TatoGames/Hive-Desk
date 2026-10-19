import { LIBRARY_SEARCH_URL, parseLibrary, type LibraryItem } from '../shared/ollamaLibrary'

/** Search the Ollama library. Returns `null` (never throws) when the page cannot be read, so the screen can hide the search. */
export async function searchLibrary(query: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<LibraryItem[] | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 8000)
  signal?.addEventListener('abort', () => ac.abort(), { once: true })
  try {
    const r = await fetchFn(LIBRARY_SEARCH_URL(query), { signal: ac.signal, headers: { accept: 'text/html' } })
    if (!r.ok) return null
    const items = parseLibrary(await r.text())
    return items.length ? items : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}
