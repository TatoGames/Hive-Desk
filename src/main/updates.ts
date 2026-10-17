export interface UpdateInfo {
  available: boolean
  current: string
  version?: string
  url?: string
  name?: string
}

/** Compare dotted versions ("0.1.2" vs "v0.2.0"). >0 when a is newer. Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((x) => parseInt(x, 10) || 0)
  const x = norm(a)
  const y = norm(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

const LATEST = 'https://api.github.com/repos/TatoGames/Hive-Desk/releases/latest'

/** Ask GitHub for the newest published release. Never throws: offline simply means "no news". */
export async function checkForUpdate(
  current: string,
  fetchFn: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }> = (u, i) =>
    fetch(u, i as RequestInit)
): Promise<UpdateInfo> {
  const none: UpdateInfo = { available: false, current }
  try {
    const res = await fetchFn(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HiveDesk' } })
    if (!res.ok) return none
    const j = (await res.json()) as { tag_name?: string; html_url?: string; name?: string; draft?: boolean; prerelease?: boolean }
    if (!j.tag_name || j.draft || j.prerelease) return none
    if (compareVersions(j.tag_name, current) <= 0) return none
    const url = typeof j.html_url === 'string' && /^https:\/\/github\.com\//.test(j.html_url) ? j.html_url : undefined
    return { available: true, current, version: j.tag_name.replace(/^v/i, ''), url, name: j.name }
  } catch {
    return none
  }
}
