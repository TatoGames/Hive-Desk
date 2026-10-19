import { LOCAL_QUEUE } from '../shared/localqueue'

/** The queue key of a model: the same endpoint + model name share one machine's memory. */
export const modelKey = (endpointId: string, model: string): string => `${endpointId}|${model}`

export class QueueWaitTimeout extends Error {
  constructor() {
    super('차례가 오기까지 너무 오래 기다렸어요.')
    this.name = 'QueueWaitTimeout'
  }
}

interface Waiter {
  go: () => void
  fail: (e: unknown) => void
  onPosition?: (n: number) => void
}

/**
 * A3: runs of one model on this PC go one after another (limit per model; default 1).
 * Whoever waits is told its place; cancelling or giving up takes it out of the line.
 * Chat turns use `tryAcquire`: they never wait behind tasks and never jump the line.
 */
export class LocalQueue {
  private active = new Map<string, number>()
  private line = new Map<string, Waiter[]>()

  constructor(private limit: () => number = () => LOCAL_QUEUE.perModel, private changed: () => void = () => undefined) {}

  private cap(): number {
    return Math.max(1, Math.floor(this.limit()))
  }

  running(key: string): number {
    return this.active.get(key) ?? 0
  }

  waiting(key: string): number {
    return this.line.get(key)?.length ?? 0
  }

  /** Something runs or waits on this endpoint (its models cannot be removed). */
  endpointBusy(endpointId: string): boolean {
    const p = endpointId + '|'
    for (const [k, n] of this.active) if (k.startsWith(p) && n > 0) return true
    for (const [k, w] of this.line) if (k.startsWith(p) && w.length > 0) return true
    return false
  }

  /** A free place right now, or null. Never takes a place ahead of those who wait. */
  tryAcquire(key: string): (() => void) | null {
    if (this.waiting(key) > 0 || this.running(key) >= this.cap()) return null
    return this.take(key)
  }

  private take(key: string): () => void {
    this.active.set(key, this.running(key) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active.set(key, Math.max(0, this.running(key) - 1))
      this.next(key)
      this.changed()
    }
  }

  private next(key: string): void {
    const w = this.line.get(key)
    while (w?.length && this.running(key) < this.cap()) {
      const first = w.shift()!
      first.go()
    }
    if (w && !w.length) this.line.delete(key)
    this.tell(key)
  }

  private tell(key: string): void {
    this.line.get(key)?.forEach((w, i) => w.onPosition?.(i + 1))
  }

  /**
   * Wait for a place. `onPosition(n)` is called with the place in line (1 = next) whenever it changes.
   * Rejects when `signal` aborts (with its reason) or after `maxWaitMs` (QueueWaitTimeout).
   */
  acquire(key: string, o: { signal?: AbortSignal; onPosition?: (n: number) => void; maxWaitMs?: number } = {}): Promise<() => void> {
    if (o.signal?.aborted) return Promise.reject(o.signal.reason)
    const free = this.tryAcquire(key)
    if (free) return Promise.resolve(free)
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        o.signal?.removeEventListener('abort', onAbort)
      }
      const leave = (): void => {
        const w = this.line.get(key)
        const i = w ? w.indexOf(waiter) : -1
        if (w && i >= 0) w.splice(i, 1)
        if (w && !w.length) this.line.delete(key)
        this.tell(key)
        this.changed()
      }
      const onAbort = (): void => {
        cleanup()
        leave()
        reject(o.signal!.reason)
      }
      const waiter: Waiter = {
        onPosition: o.onPosition,
        go: () => {
          cleanup()
          resolve(this.take(key))
        },
        fail: (e) => {
          cleanup()
          reject(e)
        }
      }
      o.signal?.addEventListener('abort', onAbort, { once: true })
      if (o.maxWaitMs && o.maxWaitMs > 0) {
        timer = setTimeout(() => {
          cleanup()
          leave()
          reject(new QueueWaitTimeout())
        }, o.maxWaitMs)
      }
      const w = this.line.get(key) ?? []
      w.push(waiter)
      this.line.set(key, w)
      o.onPosition?.(w.length)
      this.changed()
    })
  }
}
