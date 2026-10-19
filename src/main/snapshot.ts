import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from '../shared/types'

/**
 * v0.6.1: what an AI would otherwise spend its first minutes finding out — the folder structure, how the project
 * is run and tested, what the README says, what was finished lately. Made by the app from the folder (no AI, no
 * tokens) and put at the top of the prompt, so employees do not each explore the whole folder again.
 */

const SKIP = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
  '.hive-worktrees', '.hivedesk', '.cache', 'coverage', 'target', '.turbo', '.DS_Store', 'Thumbs.db'
])
const MAX_ENTRIES = 400
const MAX_LINES = 45
const MAX_CHARS = 3200

function readText(p: string, max = 6000): string {
  try {
    return readFileSync(p, 'utf8').slice(0, max)
  } catch {
    return ''
  }
}

/** The folder as an indented list: top level fully, one more level for folders, with the number of files hidden below. */
export function folderTree(dir: string): { lines: string[]; files: number } {
  const lines: string[] = []
  let seen = 0
  const list = (d: string): { name: string; dir: boolean }[] => {
    try {
      return readdirSync(d, { withFileTypes: true })
        .filter((e) => !SKIP.has(e.name) && !(e.name.startsWith('.') && e.name !== '.github' && e.name !== '.gitignore'))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    } catch {
      return []
    }
  }
  const count = (d: string, depth = 0): number => {
    if (depth > 4 || seen > MAX_ENTRIES * 5) return 0
    let n = 0
    for (const e of list(d)) {
      seen++
      n += e.dir ? count(join(d, e.name), depth + 1) : 1
    }
    return n
  }
  let files = 0
  for (const e of list(dir)) {
    if (lines.length >= MAX_LINES) {
      lines.push('…')
      break
    }
    if (!e.dir) {
      files++
      lines.push(e.name)
      continue
    }
    const sub = list(join(dir, e.name))
    const inner = count(join(dir, e.name))
    files += inner
    lines.push(`${e.name}/  (${inner} files)`)
    for (const s of sub.slice(0, 8)) {
      if (lines.length >= MAX_LINES) break
      lines.push(`  ${s.name}${s.dir ? '/' : ''}`)
    }
    if (sub.length > 8) lines.push(`  … +${sub.length - 8} more`)
  }
  return { lines, files }
}

/** What kind of project it is and how it runs, from the usual files. */
export function projectFacts(dir: string): string[] {
  const out: string[] = []
  try {
    const pkg = JSON.parse(readText(join(dir, 'package.json'))) as {
      name?: string
      description?: string
      main?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const kinds = [
      deps.electron && 'Electron app',
      deps.react && 'React',
      deps.vue && 'Vue',
      deps.next && 'Next.js',
      deps.express && 'Express',
      deps.typescript && 'TypeScript',
      deps.vite && 'Vite',
      deps.vitest && 'Vitest',
      deps.jest && 'Jest'
    ].filter(Boolean)
    out.push(`Node project${pkg.name ? ` "${pkg.name}"` : ''}${kinds.length ? ` — ${kinds.join(', ')}` : ''}`)
    if (pkg.description) out.push(pkg.description.slice(0, 160))
    const sc = Object.entries(pkg.scripts ?? {}).filter(([k]) => /^(dev|start|build|test|lint|typecheck|dist|e2e)/.test(k)).slice(0, 8)
    if (sc.length) out.push('Scripts: ' + sc.map(([k, v]) => `${k} = ${v.slice(0, 60)}`).join(' | '))
    const top = Object.keys(pkg.dependencies ?? {}).slice(0, 12)
    if (top.length) out.push('Main dependencies: ' + top.join(', '))
  } catch {
    /* no package.json, or not readable */
  }
  const py = readText(join(dir, 'pyproject.toml'))
  if (py || existsSync(join(dir, 'requirements.txt'))) out.push('Python project' + (/pytest/.test(py) ? ' (pytest)' : ''))
  if (existsSync(join(dir, 'Cargo.toml'))) out.push('Rust project (cargo)')
  if (existsSync(join(dir, 'go.mod'))) out.push('Go project')
  if (existsSync(join(dir, 'project.godot'))) out.push('Godot project')
  if (existsSync(join(dir, 'index.html'))) out.push('Has index.html (static web page)')
  return out
}

function readmeHead(dir: string): string {
  for (const n of ['README.md', 'readme.md', 'README.txt', 'README']) {
    const t = readText(join(dir, n), 3000)
    if (t) {
      const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(!\[|\[!\[|<)/.test(l))
      return lines.slice(0, 8).join('\n').slice(0, 500)
    }
  }
  return ''
}

/** What was finished lately in this project (newest first). */
export function recentWork(tasks: Task[], projectId: string | undefined, selfId: string, limit = 5): string[] {
  return tasks
    .filter((t) => t.id !== selfId && t.status === 'done' && !t.hidden && !t.reviewOf && t.kind !== 'review' && (projectId ? t.projectId === projectId : false) && (t.report?.did || t.result))
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    .slice(0, limit)
    .map((t) => `- ${t.title}: ${(t.report?.did || t.result || '').replace(/\s+/g, ' ').slice(0, 140)}`)
}

const cache = new Map<string, { at: number; text: string }>()

/** The snapshot of a folder (empty when there is nothing worth saying). Looked at again at most every 30 seconds. */
export function folderSnapshot(dir: string, now = Date.now()): string {
  const hit = cache.get(dir)
  if (hit && now - hit.at < 30_000) return hit.text
  let text = ''
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      const { lines, files } = folderTree(dir)
      if (files >= 2 || lines.length >= 3) {
        const facts = projectFacts(dir)
        const readme = readmeHead(dir)
        text = [
          ...facts,
          ...(readme ? ['README (start):', readme] : []),
          'Files:',
          ...lines.map((l) => '  ' + l)
        ].join('\n')
      }
    }
  } catch {
    text = ''
  }
  text = text.slice(0, MAX_CHARS)
  cache.set(dir, { at: now, text })
  return text
}

export function clearSnapshotCache(): void {
  cache.clear()
}
