import { describe, expect, it } from 'vitest'
import { KILL_GRACE_MS, runCli } from '../src/main/adapters'

describe('6-1: stopping a process', () => {
  it.skipIf(process.platform === 'win32')('a CLI that ignores SIGTERM is killed after the grace period', async () => {
    const ac = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ac.abort('cancel'), 300)
    const res = await runCli(
      { command: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], promptArg: false } as never,
      { cwd: process.cwd(), env: process.env, prompt: '', timeoutMs: 60000, signal: ac.signal } as never
    )
    const ms = Date.now() - t0
    expect(res.aborted).toBe(true)
    expect(ms).toBeGreaterThanOrEqual(KILL_GRACE_MS - 200)
    expect(ms).toBeLessThan(KILL_GRACE_MS + 4000)
  }, 20000)
  it.skipIf(process.platform === 'win32')('a polite CLI exits right away on SIGTERM', async () => {
    const ac = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ac.abort('hold'), 300)
    const res = await runCli(
      { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], promptArg: false } as never,
      { cwd: process.cwd(), env: process.env, prompt: '', timeoutMs: 60000, signal: ac.signal } as never
    )
    expect(res.aborted).toBe(true)
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})
