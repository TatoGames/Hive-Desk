/** Names for folders and files that came from what a person typed (company names, task titles). */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** A folder/file name that every OS accepts: bad characters become `_`, trimmed, no trailing dot, Windows reserved names get a `_`. */
export function safeName(raw: string, max = 60, fallback = '이름 없음'): string {
  let s = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!s) s = fallback
  if ([...s].length > max) s = [...s].slice(0, max).join('').replace(/[.\s]+$/, '')
  if (RESERVED.test(s.split('.')[0])) s += '_'
  return s
}

/** A name that does not clash (case-insensitively: Windows and macOS) with the ones taken: `졸작팀`, `졸작팀 (2)`, … */
export function uniqueName(base: string, taken: string[], max = 60): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()))
  const b = safeName(base, max)
  if (!lower.has(b.toLowerCase())) return b
  for (let i = 2; i < 1000; i++) {
    const suffix = ` (${i})`
    const cand = [...b].slice(0, Math.max(1, max - suffix.length)).join('') + suffix
    if (!lower.has(cand.toLowerCase())) return cand
  }
  return b + ' ' + Date.now()
}

/** `2026-10-18_업무-이름.md` — spaces become dashes so it reads well in a file list. */
export function reportFileName(date: string, title: string, n = 1): string {
  const t = safeName(title, 50, '업무').replace(/\s+/g, '-')
  return `${date.slice(0, 10)}_${t}${n > 1 ? `_${n}` : ''}.md`
}
