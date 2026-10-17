import { useCallback, useEffect, useRef, useState } from 'react'
import type { Snapshot } from '@shared/types'

/** Keeps a fresh snapshot of the hive and a live output buffer per running task. */
export function useHive(): {
  snap: Snapshot | null
  output: Record<string, string>
  refresh: () => Promise<void>
} {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [output, setOutput] = useState<Record<string, string>>({})
  const pending = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    setSnap(await window.hive.snapshot())
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.hive.onEvent((e) => {
      if (e.type === 'output' && e.taskId) {
        const id = e.taskId
        setOutput((o) => ({ ...o, [id]: ((o[id] ?? '') + (e.chunk ?? '')).slice(-20000) }))
        return
      }
      if (e.type === 'setup') return
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

  return { snap, output, refresh }
}

export function fmtTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
