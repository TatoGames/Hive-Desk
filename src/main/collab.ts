import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AuditAction, AuditEntry, CollabChannel, CollabRequest } from '../shared/collab'

function id(): string {
  return Date.now().toString(36) + randomBytes(3).toString('hex')
}

function readJson<T>(f: string): T | null {
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * Workspace-level store for company-to-company collaboration: channels, AI requests and the audit log.
 * It lives outside every company's folder, so a company's own repo never carries another company's data.
 */
export class CollabStore {
  constructor(private root: string) {
    for (const d of ['channels', 'requests', 'audit']) mkdirSync(join(root, d), { recursive: true })
  }

  private list<T>(dir: string): T[] {
    let names: string[] = []
    try {
      names = readdirSync(join(this.root, dir)).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    return names.map((n) => readJson<T>(join(this.root, dir, n))).filter((x): x is T => !!x)
  }

  channels(): CollabChannel[] {
    return this.list<CollabChannel>('channels').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  channel(cid: string): CollabChannel | undefined {
    return readJson<CollabChannel>(join(this.root, 'channels', cid + '.json')) ?? undefined
  }
  saveChannel(c: CollabChannel): void {
    writeFileSync(join(this.root, 'channels', c.id + '.json'), JSON.stringify(c, null, 2))
  }
  newChannelId(): string {
    return id()
  }

  requests(): CollabRequest[] {
    return this.list<CollabRequest>('requests').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  request(rid: string): CollabRequest | undefined {
    return readJson<CollabRequest>(join(this.root, 'requests', rid + '.json')) ?? undefined
  }
  saveRequest(r: CollabRequest): void {
    writeFileSync(join(this.root, 'requests', r.id + '.json'), JSON.stringify(r, null, 2))
  }
  newRequestId(): string {
    return id()
  }

  audit(): AuditEntry[] {
    return this.list<AuditEntry>('audit').sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
  }
  log(action: AuditAction, text: string, extra: { channelId?: string; from?: string; to?: string } = {}): AuditEntry {
    const e: AuditEntry = { id: id(), at: new Date().toISOString(), action, text, ...extra }
    writeFileSync(join(this.root, 'audit', e.id + '.json'), JSON.stringify(e, null, 2))
    return e
  }
}
