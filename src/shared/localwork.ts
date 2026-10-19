import type { CheckRun } from './types'

/**
 * v6 4단계: a model on this PC (3-8B) does small, checkable edits. The app leads (design 4-5): it picks the files,
 * shows them to the model, applies the answer, runs the project's checks and asks again with the error — at most twice.
 * Everything here is pure (prompts, parsing, limits, redaction); the file work is in main/localWorker.ts.
 */
export const LOCAL_SCOPE = {
  /** Files shown to the model. More than this = too big a job for a small model. */
  maxFiles: 3,
  /** Characters of those files together. */
  maxChars: 24_000,
  /** A single file bigger than this is never shown. */
  maxFileBytes: 60_000,
  /** Files the answer may write (new ones included). */
  maxWrite: 5,
  /** Fixing rounds after a failed check (so at most 1 + 2 tries). */
  maxRetries: 2,
  /** Characters of an error summary sent back. */
  errorChars: 1500
} as const

export const SYSTEM_PROMPT = [
  'You are a careful programmer. You edit the files you are given so that the request is done. Keep the style of the code. Change only what is needed.',
  'Answer ONLY in this format, no explanation:',
  '=== FILE: relative/path.ext ===',
  '```',
  '(the COMPLETE new content of that file)',
  '```',
  'Repeat for every file you change or create. Always give whole files, never a diff or "...". Do not touch files you were not given unless the request needs a new file.'
].join('\n')

export interface PromptFile {
  path: string
  /** null = does not exist yet (the model creates it). */
  content: string | null
}

export function workPrompt(request: string, files: PromptFile[]): string {
  const parts = [`요청 / Request:\n${request.trim()}`, '']
  for (const f of files) {
    parts.push(f.content === null ? `=== FILE: ${f.path} === (new file: create it)` : `=== FILE: ${f.path} ===`)
    if (f.content !== null) parts.push('```', f.content.replace(/\n$/, ''), '```')
    parts.push('')
  }
  parts.push('Answer with the changed files in the format above.')
  return parts.join('\n')
}

export type ParsedAnswer = { ok: true; files: { path: string; content: string }[] } | { ok: false; reason: string }

/** `=== FILE: path ===` followed by a code block with the whole file, once per file. */
export function parseAnswer(text: string): ParsedAnswer {
  const re = /^[ \t]*=== FILE: (.+?) ===[ \t]*$/gm
  const marks = [...text.matchAll(re)]
  if (!marks.length) return { ok: false, reason: '`=== FILE: 경로 ===` 줄이 없어요' }
  const files: { path: string; content: string }[] = []
  for (const [i, m] of marks.entries()) {
    const body = text.slice(m.index! + m[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined)
    const fence = /^\s*```[^\n]*\r?\n([\s\S]*)\r?\n[ \t]*```\s*$/.exec(body.trimEnd() + '\n')
    const path = m[1].trim().replace(/^`|`$/g, '')
    if (!fence) return { ok: false, reason: `${path}: 코드 블록(\`\`\`)으로 파일 전체를 주지 않았어요` }
    if (!fence[1].trim()) return { ok: false, reason: `${path}: 내용이 비어 있어요` }
    files.push({ path, content: fence[1].replace(/\s*$/, '') + '\n' })
  }
  return { ok: true, files }
}

export function formatFix(reason: string): string {
  return `The format was wrong: ${reason}. Answer again, ONLY in this format for every changed file:\n=== FILE: relative/path.ext ===\n\`\`\`\n(complete file)\n\`\`\``
}

/** What to show the model after the project's checks failed (short: small models lose track of long errors). */
export function retryPrompt(summary: string): string {
  return `The project's checks failed after your change:\n${summary}\n\nFix it. Answer again with the COMPLETE changed files in the same format (start from the original files you were given).`
}

/** The failing checks of a run, tails only, cut to a size a small model can use. */
export function errorSummary(c: CheckRun, max = LOCAL_SCOPE.errorChars): string {
  const bad = c.items.filter((i) => !i.ok && !i.skipped)
  const text = bad
    .map((i) => {
      const tail = i.tail.replace(/\u001b\[[0-9;]*m/g, '').trim().split('\n').slice(-25).join('\n')
      return `[${i.name}] ${i.cmd}\n${tail}`
    })
    .join('\n\n')
  return text.length > max ? '…' + text.slice(text.length - max) : text
}

/** Why a request is too big for a model on this PC, said to the person. */
export const TOO_BIG = '이 일은 내 PC AI에 맡기기엔 커요'

// ---- secrets ----
const SECRET_RES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '***'],
  [/-----BEGIN [A-Z ]*KEY-----[\s\S]*?(-----END [A-Z ]*KEY-----|$)/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '***'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '***'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 ***'],
  [/((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',;]{3,}/gi, '$1***']
]

/** Replace anything that looks like a key, token or password. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [re, to] of SECRET_RES) out = out.replace(re, to)
  return out
}

/** One saved example (a line of the .jsonl). */
export interface LocalExample {
  id: string
  taskId: string
  at: string
  model: string
  request: string
  given: { path: string; content: string | null }[]
  received: { path: string; content: string }[]
  checks: { ran: boolean; ok: boolean; summary: string }
  attempts: number
  /** Passed the checks in the end (otherwise the changes were undone). */
  passed: boolean
  /** A person approved the result (false until then). */
  approved: boolean
}
