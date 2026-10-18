import type { Instruction, InstructionMode, Task } from '../shared/types'
import { newId, type Hive } from './hive'

const nowIso = (): string => new Date().toISOString()

export function queuedOf(t: Pick<Task, 'instructions'>): Instruction[] {
  return (t.instructions ?? []).filter((i) => i.state === 'queued')
}

export function addInstruction(hive: Hive, taskId: string, text: string, by: string, mode: InstructionMode): Instruction | null {
  const t = hive.getTask(taskId)
  const body = text.trim()
  if (!t || !body) return null
  const i: Instruction = { id: newId(), text: body, by, at: nowIso(), mode, state: 'queued', stateAt: nowIso() }
  hive.updateTask(taskId, { instructions: [...(t.instructions ?? []), i] })
  return i
}

function change(hive: Hive, taskId: string, f: (i: Instruction) => Instruction | null): void {
  const t = hive.getTask(taskId)
  if (!t?.instructions?.length) return
  let touched = false
  const next = t.instructions.map((i) => {
    const r = f(i)
    if (r) touched = true
    return r ?? i
  })
  if (touched) hive.updateTask(taskId, { instructions: next })
}

/** The queued instructions went into a run's first input. */
export function markSent(hive: Hive, taskId: string, runId: string): void {
  change(hive, taskId, (i) => (i.state === 'queued' ? { ...i, state: 'sent', runId, stateAt: nowIso() } : null))
}

/** A run ended before the AI applied what it was sent: it goes into the next run (nothing is lost). */
export function requeue(hive: Hive, taskId: string, runId?: string): void {
  change(hive, taskId, (i) =>
    i.state === 'sent' && (!runId || i.runId === runId) ? { ...i, state: 'queued', runId: undefined, stateAt: nowIso() } : null
  )
}

/** The AI wrote [[ACK: …]]: the instructions of this run count as applied. */
export function applyAcks(hive: Hive, taskId: string, runId: string, acks: string[]): void {
  if (!acks.length) return
  const ack = acks.join(' / ')
  change(hive, taskId, (i) =>
    (i.state === 'sent' || i.state === 'seen') && i.runId === runId ? { ...i, state: 'applied', ack, stateAt: nowIso() } : null
  )
}

export function dropInstruction(hive: Hive, taskId: string, id: string): void {
  change(hive, taskId, (i) => (i.id === id && i.state === 'queued' ? { ...i, state: 'dropped', stateAt: nowIso() } : null))
}

/** Several instructions that arrive together are sent as one numbered message. */
export function joinInstructions(list: Instruction[]): string {
  return list.map((x, k) => (list.length > 1 ? `${k + 1}. ` : '') + x.text).join('\n')
}
