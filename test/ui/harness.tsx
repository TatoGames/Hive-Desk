import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, render, type RenderResult } from '@testing-library/react'
import type { Runner } from '../../src/main/adapters'
import { Engine } from '../../src/main/engine'
import App from '../../src/renderer/src/App'

/**
 * UI tests: the real renderer on a real engine (temp folder, fake CLI), with `window.hive` answered by the engine.
 * Calls the engine has under the same name go to it; the rest are recorded and resolve to nothing.
 */
export interface Ui {
  eng: Engine
  dir: string
  calls: { name: string; args: unknown[] }[]
  view: RenderResult
  /** Let the app pick up engine changes (it refreshes on events). */
  refresh: () => Promise<void>
  done: () => void
}

// jsdom has no layout: the office floor measures itself with this
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const idle: Runner = async () => ({ code: 0, stdout: '[[DID: ok]]', stderr: '', timedOut: false, aborted: false })

export function makeEngine(setup?: (eng: Engine, dir: string) => void): { eng: Engine; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hivedesk-ui-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  const eng = new Engine(join(dir, 'config.json'), () => {}, idle, dir)
  setup?.(eng, dir)
  return { eng, dir }
}

export async function mountApp(setup?: (eng: Engine, dir: string) => void, overrides: Record<string, (...a: unknown[]) => unknown> = {}): Promise<Ui> {
  const { eng, dir } = makeEngine(setup)
  const calls: Ui['calls'] = []
  const listeners: ((e: { type: string }) => void)[] = []
  const base: Record<string, (...a: unknown[]) => unknown> = {
    snapshot: () => eng.snapshot(),
    onEvent: (cb: unknown) => {
      listeners.push(cb as (e: { type: string }) => void)
      return () => undefined
    },
    checkUpdate: () => ({ available: false, current: '0.0.0' }),
    limitSamples: () => [],
    detectAdapters: () => [],
    officeFeed: () => [],
    listTeams: () => [],
    ...overrides
  }
  ;(window as unknown as { hive: unknown }).hive = new Proxy(
    {},
    {
      get: (_t, name: string) =>
        // event subscriptions answer at once (the app keeps the unsubscribe function)
        name === 'onEvent' || name.startsWith('on')
          ? (...args: unknown[]) => (base[name] ? base[name](...args) : () => undefined)
          : async (...args: unknown[]) => {
        calls.push({ name, args })
        if (base[name]) return base[name](...args)
        const fn = (eng as unknown as Record<string, unknown>)[name]
        if (typeof fn === 'function') {
          const r = await (fn as (...a: unknown[]) => unknown).apply(eng, args)
          for (const l of listeners) l({ type: 'changed' })
          return r
        }
        return undefined
      }
    }
  )
  let view!: RenderResult
  await act(async () => {
    view = render(<App />)
  })
  await act(async () => new Promise((r) => setTimeout(r, 30)))
  const refresh = async (): Promise<void> => {
    for (const l of listeners) l({ type: 'changed' })
    await act(async () => new Promise((r) => setTimeout(r, 250)))
  }
  return {
    eng,
    dir,
    calls,
    view,
    refresh,
    done: () => {
      cleanup()
      eng.shutdown()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
}

/** A company with a name set up, a worker and a reviewer on different connections. */
export function ready(eng: Engine, dir: string): { dev: string; rev: string } {
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'off' })
  const work = join(dir, 'work')
  mkdirSync(work, { recursive: true })
  const dev = eng.saveAgent({ name: '민수', adapter: 'claude', workDir: work, modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
  const rev = eng.saveAgent({ name: '지아', adapter: 'codex', workDir: work, modelRef: { id: 'openai-gpt-6-1-sol', pin: 'pinned' } })
  return { dev: dev.id, rev: rev.id }
}
