import { existsSync, readFileSync } from 'node:fs'
import type { Tier } from '../shared/company'
import type { BenchSummary } from '../shared/bench'
import DEFAULT_CANDIDATES from '../shared/local-models.default.json'
import {
  fitNote,
  modelTier,
  normalizeUrl,
  parseCandidates,
  recommendTier,
  type CandidateFile,
  type EngineKind,
  type LocalCandidate,
  type LocalEndpoint,
  type LocalModelInfo,
  type LocalStore,
  type PcInfo,
  type SpeedResult,
  type TierAdvice
} from '../shared/localai'
import type { ChatModel } from '../shared/chat'
import { runBench } from './bench'
import type { ChatModelInfo, LocalTurn } from './chat'
import type { Cipher } from './external'
import { chatStream, ollamaDelete, ollamaPull, probe, speedTest, type ChatMsg, type Conn, type FetchFn, type PullProgress } from './openai'
import { diagnosePc, type Exec } from './pcinfo'

export interface LocalCtx {
  store: () => LocalStore
  saveStore: (s: LocalStore) => void
  cipher: () => Cipher | null
  secrets: () => Record<string, string>
  setSecret: (key: string, blob: string | null) => void
  /** A data file next to the settings that replaces the built-in candidate list (no app update needed). */
  candidatesPath: string
  /** The local connection is answering a chat right now. */
  busy: (endpointId: string) => boolean
  changed: () => void
  fetchFn?: FetchFn
  exec?: Exec
}

export interface EndpointState {
  ok: boolean
  checkedAt: string
  kind?: EngineKind
  version?: string
  models: LocalModelInfo[]
  error?: string
}

export interface LocalJob {
  id: string
  kind: 'pull' | 'bench' | 'speed'
  endpointId: string
  model: string
  /** One line for the screen. */
  text: string
  fraction?: number
  state: 'running' | 'done' | 'failed' | 'stopped'
  error?: string
  /** For `bench`: the finished summary. */
  bench?: BenchSummary
  speed?: SpeedResult & { loadMs: number }
}

export interface LocalStatus {
  endpoints: (LocalEndpoint & { state?: EndpointState })[]
  pc: PcInfo
  advice: TierAdvice
  jobs: LocalJob[]
  candidates: CandidateFile
  speed: Record<string, SpeedResult & { at: string }>
  bench: Record<string, BenchSummary>
}

const key = (endpointId: string, model: string): string => `${endpointId}|${model}`

export class LocalAi {
  private states = new Map<string, EndpointState>()
  private jobs = new Map<string, { job: LocalJob; ac: AbortController }>()
  private pc?: PcInfo
  private lastEmit = 0

  constructor(private c: LocalCtx) {}

  // ---- connections ----
  endpoints(): LocalEndpoint[] {
    return this.c.store().endpoints ?? []
  }

  private conn(id: string): Conn {
    const e = this.endpoints().find((x) => x.id === id)
    if (!e) throw new Error('없는 연결이에요.')
    return { url: e.url, token: this.token(id), fetchFn: this.c.fetchFn }
  }

  private token(id: string): string | undefined {
    const blob = this.c.secrets()['local:' + id]
    const cipher = this.c.cipher()
    if (!blob || !cipher?.available()) return undefined
    try {
      return cipher.decrypt(blob)
    } catch {
      return undefined
    }
  }

  /** Check the address, then keep it. Throws a readable reason when nothing answers. */
  async add(o: { name?: string; url: string; token?: string }): Promise<LocalEndpoint> {
    const url = normalizeUrl(o.url)
    if (!url) throw new Error('주소를 알아볼 수 없어요. 예: localhost:11434')
    if (this.endpoints().some((e) => e.url === url)) throw new Error('이미 연결된 주소예요.')
    const token = o.token?.trim() || undefined
    if (token && !this.c.cipher()?.available()) throw new Error('이 컴퓨터의 보안 저장소를 쓸 수 없어서 토큰을 저장하지 않았어요.')
    const r = await probe({ url, token, fetchFn: this.c.fetchFn })
    const id = 'lc-' + Math.random().toString(36).slice(2, 8)
    const e: LocalEndpoint = { id, name: o.name?.trim() || (r.kind === 'ollama' ? 'Ollama' : '내 PC AI'), url, kind: r.kind, hasToken: !!token }
    if (token) this.c.setSecret('local:' + id, this.c.cipher()!.encrypt(token))
    this.c.saveStore({ ...this.c.store(), endpoints: [...this.endpoints(), e] })
    this.states.set(id, { ok: true, checkedAt: new Date().toISOString(), kind: r.kind, version: r.version, models: r.models })
    this.c.changed()
    return e
  }

  /** Keep one connection with this name pointing at `url` (the app's own engine): update it when the port changed, never duplicate. */
  async ensure(name: string, url: string): Promise<LocalEndpoint> {
    const u = normalizeUrl(url)
    if (!u) throw new Error('주소를 알아볼 수 없어요.')
    const byName = this.endpoints().find((e) => e.name === name)
    if (byName) {
      if (byName.url !== u) {
        const next = { ...byName, url: u, kind: 'ollama' as const }
        this.c.saveStore({ ...this.c.store(), endpoints: this.endpoints().map((e) => (e.id === byName.id ? next : e)) })
        this.states.delete(byName.id)
      }
      await this.refresh(byName.id)
      return this.endpoints().find((e) => e.id === byName.id)!
    }
    const same = this.endpoints().find((e) => e.url === u)
    if (same) return same
    return this.add({ name, url: u })
  }

  remove(id: string): void {
    const j = [...this.jobs.values()].find((x) => x.job.endpointId === id && x.job.state === 'running')
    if (j) throw new Error('이 연결에서 내려받기·측정이 도는 중이에요. 먼저 중지해 주세요.')
    this.c.saveStore({ ...this.c.store(), endpoints: this.endpoints().filter((e) => e.id !== id) })
    this.c.setSecret('local:' + id, null)
    this.states.delete(id)
    this.c.changed()
  }

  /** Ask every connection (or one) what it has now. Never throws; a failure is kept as the connection's state. */
  async refresh(id?: string): Promise<void> {
    await this.diagnose().catch(() => undefined)
    await Promise.all(
      this.endpoints()
        .filter((e) => !id || e.id === id)
        .map(async (e) => {
          try {
            const r = await probe(this.conn(e.id))
            this.states.set(e.id, { ok: true, checkedAt: new Date().toISOString(), kind: r.kind, version: r.version, models: r.models })
          } catch (err) {
            this.states.set(e.id, { ok: false, checkedAt: new Date().toISOString(), models: this.states.get(e.id)?.models ?? [], error: (err as Error).message })
          }
        })
    )
    this.c.changed()
  }

  state(id: string): EndpointState | undefined {
    return this.states.get(id)
  }

  // ---- this PC ----
  async diagnose(force = false): Promise<{ pc: PcInfo; advice: TierAdvice }> {
    if (!this.pc || force) this.pc = await diagnosePc(this.c.exec)
    return { pc: this.pc, advice: this.advice() }
  }

  /** The tier for this PC, using the best (fastest-tier) speed measured so far. */
  advice(): TierAdvice {
    const pc = this.pc ?? { platform: '', arch: '', ramGB: 0, cores: 0, appleSilicon: false }
    const speeds = Object.values(this.c.store().speed ?? {})
    return recommendTier(pc, speeds.length ? speeds.sort((a, b) => b.perSec - a.perSec)[0] : undefined)
  }

  // ---- for the chat ----
  /** The engine answered at its last check and lists this model (A1: only then it may take over work). */
  modelReady(endpointId: string, model: string): boolean {
    const st = this.states.get(endpointId)
    return !!st?.ok && st.models.some((m) => m.name === model)
  }

  models(): ChatModelInfo[] {
    const advice = this.pc ? this.advice() : undefined
    const out: ChatModelInfo[] = []
    for (const e of this.endpoints()) {
      const st = this.states.get(e.id)
      for (const m of st?.models ?? []) {
        // Ollama can list embedding-only models too; a name with "embed" is not for chatting
        if (/embed/i.test(m.name)) continue
        out.push({
          model: { kind: 'local', endpointId: e.id, model: m.name },
          label: `${m.name} · ${e.name}`,
          tier: modelTier(m) as Tier,
          weight: 0,
          where: 'local',
          ok: !!st?.ok,
          note: st?.ok ? fitNote(m, advice) : (st?.error ?? '연결을 확인 중이에요')
        })
      }
    }
    return out
  }

  async turn(m: Extract<ChatModel, { kind: 'local' }>, t: LocalTurn): Promise<{ text: string }> {
    const r = await chatStream(this.conn(m.endpointId), m.model, [{ role: 'user', content: t.prompt }], { signal: t.signal, onText: t.onText, idleMs: 300_000 })
    return { text: r.text }
  }

  /** One answer for a task (the app leads the edit, see localWorker.ts). */
  async complete(m: { endpointId: string; model: string }, messages: ChatMsg[], o: { signal: AbortSignal; idleMs: number }): Promise<{ text: string }> {
    const r = await chatStream(this.conn(m.endpointId), m.model, messages, { signal: o.signal, idleMs: o.idleMs, temperature: 0, maxTokens: 8192 })
    return { text: r.text }
  }

  // ---- jobs (speed test, measurement, install) ----
  jobList(): LocalJob[] {
    return [...this.jobs.values()].map((x) => x.job)
  }

  private start(kind: LocalJob['kind'], endpointId: string, model: string, text: string): { job: LocalJob; ac: AbortController } {
    const id = `${kind}:${key(endpointId, model)}`
    const prev = this.jobs.get(id)
    if (prev?.job.state === 'running') throw new Error('이미 하고 있어요.')
    if (kind !== 'pull' && [...this.jobs.values()].some((x) => x.job.kind !== 'pull' && x.job.state === 'running')) throw new Error('측정은 한 번에 하나만 할 수 있어요. 끝나면 해 주세요.')
    const entry = { job: { id, kind, endpointId, model, text, state: 'running' as const }, ac: new AbortController() }
    this.jobs.set(id, entry)
    this.emitSoon(true)
    return entry
  }

  private emitSoon(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 300) return
    this.lastEmit = now
    this.c.changed()
  }

  stopJob(id: string): void {
    this.jobs.get(id)?.ac.abort()
  }

  async speed(endpointId: string, model: string): Promise<LocalJob> {
    await this.diagnose()
    const { job, ac } = this.start('speed', endpointId, model, '속도를 재는 중… (처음엔 모델을 불러오느라 오래 걸릴 수 있어요)')
    try {
      const r = await speedTest(this.conn(endpointId), model, ac.signal)
      job.speed = r
      job.state = 'done'
      job.text = `초당 약 ${r.perSec.toFixed(1)}토큰${r.estimated ? '(추정)' : ''} · 첫 글자까지 ${(r.firstMs / 1000).toFixed(1)}초 · 불러오기 ${(r.loadMs / 1000).toFixed(1)}초`
      const store = this.c.store()
      this.c.saveStore({ ...store, speed: { ...(store.speed ?? {}), [key(endpointId, model)]: { ...r, at: new Date().toISOString() } } })
    } catch (e) {
      job.state = ac.signal.aborted ? 'stopped' : 'failed'
      job.error = ac.signal.aborted ? undefined : (e as Error).message
      job.text = ac.signal.aborted ? '중지했어요.' : (e as Error).message
    }
    this.emitSoon(true)
    return job
  }

  /** Ten small edits with a check each (v6 8-1); the result is kept so the screen can show it later. */
  async bench(endpointId: string, model: string): Promise<LocalJob> {
    const { job, ac } = this.start('bench', endpointId, model, '측정 준비 중…')
    try {
      const summary = await runBench(this.conn(endpointId), model, {
        signal: ac.signal,
        onRow: (row, i, total) => {
          job.text = `${i + 1}/${total} ${row.ok ? '통과' : '실패'} — ${row.title}`
          job.fraction = (i + 1) / total
          this.emitSoon()
        }
      })
      if (ac.signal.aborted) {
        job.state = 'stopped'
        job.text = '중지했어요.'
      } else {
        job.bench = summary
        job.state = 'done'
        job.text = `${summary.total}개 중 ${summary.passed}개 통과 · 하나당 중간 ${(summary.medianMs / 1000).toFixed(0)}초`
        const store = this.c.store()
        this.c.saveStore({ ...store, bench: { ...(store.bench ?? {}), [key(endpointId, model)]: summary } })
      }
    } catch (e) {
      job.state = 'failed'
      job.error = (e as Error).message
      job.text = (e as Error).message
    }
    this.emitSoon(true)
    return job
  }

  // ---- 8-2b: install, update, remove (Ollama) ----
  candidates(): CandidateFile {
    const base = parseCandidates(DEFAULT_CANDIDATES)
    try {
      if (existsSync(this.c.candidatesPath)) {
        const over = parseCandidates(JSON.parse(readFileSync(this.c.candidatesPath, 'utf8')))
        if (over.models.length) return over
      }
    } catch {
      /* a broken data file falls back to the built-in list */
    }
    return base
  }

  private ollama(endpointId: string): Conn {
    const e = this.endpoints().find((x) => x.id === endpointId)
    if (!e) throw new Error('없는 연결이에요.')
    if ((this.states.get(endpointId)?.kind ?? e.kind) !== 'ollama') throw new Error('모델 설치·삭제는 Ollama에서만 할 수 있어요. 다른 엔진은 그 프로그램에서 설치해 주세요.')
    return this.conn(endpointId)
  }

  /** Download, update or resume a model. Starting again after a stop continues from the part already downloaded. */
  async pull(endpointId: string, name: string): Promise<LocalJob> {
    const c = this.ollama(endpointId)
    const clean = name.trim()
    if (!clean || /\s/.test(clean)) throw new Error('모델 이름을 확인해 주세요.')
    const { job, ac } = this.start('pull', endpointId, clean, '내려받기 시작…')
    try {
      await ollamaPull(c, clean, {
        signal: ac.signal,
        onProgress: (p: PullProgress) => {
          job.text = p.status
          if (p.fraction !== undefined) job.fraction = p.fraction
          this.emitSoon()
        }
      })
      job.state = 'done'
      job.fraction = 1
      job.text = '설치했어요.'
      await this.refresh(endpointId)
    } catch (e) {
      job.state = ac.signal.aborted ? 'stopped' : 'failed'
      job.error = ac.signal.aborted ? undefined : (e as Error).message
      job.text = ac.signal.aborted ? '중지했어요. 다시 누르면 이어서 받아요.' : (e as Error).message
    }
    this.emitSoon(true)
    return job
  }

  async deleteModel(endpointId: string, name: string): Promise<void> {
    const c = this.ollama(endpointId)
    if (this.c.busy(endpointId)) throw new Error('이 모델이 대화에 쓰이는 중이에요. 끝난 뒤 지워 주세요.')
    if ([...this.jobs.values()].some((x) => x.job.state === 'running' && x.job.endpointId === endpointId && x.job.model === name)) throw new Error('이 모델로 작업하는 중이에요.')
    await ollamaDelete(c, name)
    const store = this.c.store()
    const speed = { ...(store.speed ?? {}) }
    const bench = { ...(store.bench ?? {}) }
    delete speed[key(endpointId, name)]
    delete bench[key(endpointId, name)]
    this.c.saveStore({ ...store, speed, bench })
    await this.refresh(endpointId)
  }

  async status(): Promise<LocalStatus> {
    const { pc, advice } = await this.diagnose()
    const store = this.c.store()
    return {
      endpoints: this.endpoints().map((e) => ({ ...e, state: this.states.get(e.id) })),
      pc,
      advice,
      jobs: this.jobList(),
      candidates: this.candidates(),
      speed: store.speed ?? {},
      bench: store.bench ?? {}
    }
  }
}

export type { LocalCandidate }
