import { execFile } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tempDir } from './paths'
import { join } from 'node:path'
import { BENCH_TASKS, benchPrompt, extractCode, summarizeBench, type BenchRow, type BenchSummary, type BenchTask } from '../shared/bench'
import { chatStream, type Conn } from './openai'

/** Run a check script next to the answer with plain Node (Electron's own Node when packaged). Resolves to the failure line or undefined. */
export function runCheck(code: string, test: string, timeoutMs = 10_000): Promise<string | undefined> {
  const dir = tempDir('hivedesk-bench-')
  writeFileSync(join(dir, 'solution.js'), code)
  writeFileSync(join(dir, 'check.js'), test)
  return new Promise((resolve) => {
    execFile(process.execPath, ['check.js'], { cwd: dir, timeout: timeoutMs, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (err, _out, stderr) => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      if (!err) return resolve(undefined)
      const line = String(stderr).split('\n').find((l) => /Error|expected|actual/i.test(l)) ?? err.message
      resolve(line.trim().slice(0, 200))
    })
  })
}

export interface BenchOptions {
  tasks?: BenchTask[]
  signal?: AbortSignal
  onRow?: (row: BenchRow, index: number, total: number) => void
  /** Per task: how long a model may think (a slow PC fails the task rather than stalling the run). */
  taskTimeoutMs?: number
}

/** Ask the model ten small edits and run each check. Stops cleanly when aborted. */
export async function runBench(c: Conn, model: string, o: BenchOptions = {}): Promise<BenchSummary> {
  const tasks = o.tasks ?? BENCH_TASKS
  const rows: BenchRow[] = []
  for (const [i, t] of tasks.entries()) {
    if (o.signal?.aborted) break
    const start = Date.now()
    let row: BenchRow
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('시간 안에 끝내지 못했어요.')), o.taskTimeoutMs ?? 180_000)
      const stop = (): void => ac.abort(o.signal?.reason)
      o.signal?.addEventListener('abort', stop, { once: true })
      let r
      try {
        r = await chatStream(c, model, [{ role: 'user', content: benchPrompt(t) }], { signal: ac.signal, temperature: 0, maxTokens: 1200, idleMs: o.taskTimeoutMs ?? 180_000 })
      } finally {
        clearTimeout(timer)
        o.signal?.removeEventListener('abort', stop)
      }
      if (o.signal?.aborted) break
      const code = extractCode(r.text)
      const perSec = r.tokens && r.totalMs > r.firstMs ? r.tokens / ((r.totalMs - r.firstMs) / 1000) : undefined
      if (!code) row = { id: t.id, title: t.title, ok: false, ms: Date.now() - start, perSec, reason: '코드를 돌려주지 않았어요' }
      else {
        const fail = await runCheck(code, t.test)
        row = { id: t.id, title: t.title, ok: !fail, ms: Date.now() - start, perSec, reason: fail }
      }
    } catch (e) {
      if (o.signal?.aborted) break
      row = { id: t.id, title: t.title, ok: false, ms: Date.now() - start, reason: (e as Error).message.split('\n')[0].slice(0, 160) }
    }
    rows.push(row)
    o.onRow?.(row, i, tasks.length)
  }
  return summarizeBench(model, new Date().toISOString(), rows)
}
