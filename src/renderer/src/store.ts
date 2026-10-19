import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveSummary, Snapshot } from '@shared/types'

/** Keeps a fresh snapshot of the hive and a live output buffer per running task. */
export function useHive(): {
  snap: Snapshot | null
  output: Record<string, string>
  /** Progress of running tasks, updated as the agent works. */
  live: Record<string, LiveSummary>
  refresh: () => Promise<void>
} {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [output, setOutput] = useState<Record<string, string>>({})
  const [live, setLive] = useState<Record<string, LiveSummary>>({})
  const pending = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    const next = await window.hive.snapshot()
    setSnap(next)
    // forget progress of runs that ended; adopt what the main process knows for the rest
    setLive((cur) => {
      const out: Record<string, LiveSummary> = {}
      for (const id of next.running) {
        const s = cur[id] ?? next.live[id]
        if (s) out[id] = s
      }
      return out
    })
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.hive.onEvent((e) => {
      if (e.type === 'output' && e.taskId) {
        const id = e.taskId
        setOutput((o) => ({ ...o, [id]: ((o[id] ?? '') + (e.chunk ?? '')).slice(-20000) }))
        return
      }
      if (e.type === 'setup' || e.type === 'chat' || e.type === 'local') return
      if (e.type === 'activity') {
        if (e.taskId && e.summary) {
          const id = e.taskId
          const sum = e.summary
          setLive((cur) => ({ ...cur, [id]: sum }))
        }
        return
      }
      if (pending.current) return
      pending.current = window.setTimeout(() => {
        pending.current = null
        void refresh()
      }, 150)
    })
    // teammates' changes arrive via git sync as plain file changes; poll lightly
    const poll = window.setInterval(() => void refresh(), 5000)
    return () => {
      off()
      window.clearInterval(poll)
    }
  }, [refresh])

  return { snap, output, live, refresh }
}

export function fmtTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Re-renders every second while `on`, so elapsed times tick. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [on])
  return now
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}
