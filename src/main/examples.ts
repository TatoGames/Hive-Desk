import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets, type LocalExample } from '../shared/localwork'

/**
 * v6 4단계 (opt-in): what models on this PC did, kept as one JSON line each under `.local/examples/<date>.jsonl` of the
 * company folder, so there is something to learn from later. Nothing here sends anything anywhere; key-like text is
 * replaced by `***` before it is written.
 */
export const EXAMPLES_DIR = join('.local', 'examples')

const deep = <T>(v: T): T => {
  if (typeof v === 'string') return redactSecrets(v) as T
  if (Array.isArray(v)) return v.map(deep) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) as T
  return v
}

export function examplesDir(root: string): string {
  return join(root, EXAMPLES_DIR)
}

export function saveExample(root: string, e: LocalExample): void {
  const dir = examplesDir(root)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, `${e.at.slice(0, 10)}.jsonl`), JSON.stringify(deep(e)) + '\n')
}

/** A person approved the result of this task: mark its examples (never un-marks). Returns how many lines changed. */
export function approveExamples(root: string, taskId: string): number {
  const dir = examplesDir(root)
  if (!existsSync(dir)) return 0
  let n = 0
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const path = join(dir, f)
    let changed = false
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => {
        if (!line.trim()) return line
        try {
          const e = JSON.parse(line) as LocalExample
          if (e.taskId !== taskId || e.approved || !e.passed) return line
          changed = true
          n++
          return JSON.stringify({ ...e, approved: true })
        } catch {
          return line
        }
      })
    if (changed) writeFileSync(path, lines.join('\n'))
  }
  return n
}
