import type { Tier } from './company'
import type { BenchSummary } from './bench'

/**
 * v6 8-2: models that run on this PC (or a PC on the same network) through an OpenAI-compatible connection
 * (Ollama, LM Studio, ...). No API key: a local address, optionally a token for another PC.
 */

export type EngineKind = 'ollama' | 'openai'

export interface LocalEndpoint {
  id: string
  name: string
  /** Base address without `/v1`, e.g. `http://127.0.0.1:11434`. */
  url: string
  /** Guessed when the address was checked. */
  kind?: EngineKind
  /** A token is saved in the secure storage (another PC on the network may ask for one). */
  hasToken?: boolean
}

export interface LocalModelInfo {
  /** The name the engine uses (e.g. `qwen2.5-coder:7b`). */
  name: string
  /** Disk size in bytes, when the engine says (Ollama). */
  sizeBytes?: number
  /** Parameter count in billions, from the engine or the name. */
  paramsB?: number
  quant?: string
}

export const DEFAULT_PORTS = [11434, 1234]

/** `localhost`, `192.168.0.5:1234`, `http://x/v1/` → `http://127.0.0.1:11434` form. Undefined if it is not an address. */
export function normalizeUrl(input: string): string | undefined {
  let s = input.trim()
  if (!s) return undefined
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return undefined
  }
  if (!u.hostname) return undefined
  const hostPart = s.replace(/^https?:\/\//i, '').split('/')[0]
  if (u.protocol === 'http:' && !/:\d+$/.test(hostPart)) {
    // a bare host: Ollama's port is the usual one
    u.port = String(DEFAULT_PORTS[0])
  }
  // `localhost` can resolve to the IPv6 address first, while Ollama and LM Studio listen on IPv4 only
  if (u.hostname === 'localhost') u.hostname = '127.0.0.1'
  const path = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  return `${u.protocol}//${u.host}${path}`
}

export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
  } catch {
    return false
  }
}

/** A5: where an address points. `this-pc` = this computer, `lan` = a computer on the same network, `internet` = anywhere else. */
export type EndpointScope = 'this-pc' | 'lan' | 'internet'

export function endpointScope(input: string): EndpointScope {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}` // a bare `host:port` is read as http
  if (isLoopback(url)) return 'this-pc'
  let h: string
  try {
    h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return 'internet'
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'lan'
    if (a === 169 && b === 254) return 'lan' // link-local
    if (a === 100 && b >= 64 && b <= 127) return 'lan' // shared address space used by Tailscale and the like
    if (a === 127) return 'this-pc'
    return 'internet'
  }
  if (h.includes(':')) return /^(fe80|fc|fd)/.test(h) ? 'lan' : h === '::1' ? 'this-pc' : 'internet' // IPv6
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa') || !h.includes('.')) return 'lan' // a name only the home network knows
  return 'internet'
}

export const SCOPE_LABEL: Record<EndpointScope, string> = { 'this-pc': '이 PC', lan: '다른 PC', internet: '인터넷 주소' }

/** Why an address cannot be connected as it is. Undefined = fine (or fine once the person confirmed the notice). */
export function endpointProblem(url: string, hasToken: boolean): string | undefined {
  if (endpointScope(url) !== 'internet') return undefined
  if (!url.startsWith('https://')) return '인터넷에 있는 주소는 https 주소만 연결할 수 있어요. 요청한 내용이 그대로 노출될 수 있어요.'
  if (!hasToken) return '인터넷에 있는 주소는 토큰 없이 연결하지 않아요. 아무나 쓸 수 있는 주소일 수 있어요.'
  return undefined
}

/** Shown once, before the first connection to another computer. */
export const REMOTE_NOTICE = '이 연결을 쓰면 AI에게 보내는 내용(질문, 일의 설명, 고칠 파일의 글)이 이 PC가 아니라 그 PC로 가요. 그 PC가 믿을 수 있는 내 컴퓨터가 맞는지 확인해 주세요.'

/** Parameters in billions from a model name: `qwen2.5-coder:7b`, `llama3.1-70b-instruct`, `mixtral-8x7b`, `phi3:mini` (unknown). */
export function guessParamsB(name: string): number | undefined {
  const n = name.toLowerCase()
  const moe = n.match(/(\d+)x(\d+(?:\.\d+)?)b/)
  if (moe) return Number(moe[1]) * Number(moe[2])
  const m = n.match(/(?:^|[^a-z0-9.])e?(\d+(?:\.\d+)?)b(?![a-z])/)
  if (m) return Number(m[1])
  const mm = n.match(/(\d+(?:\.\d+)?)m(?![a-z])/)
  if (mm) return Number(mm[1]) / 1000
  return undefined
}

/** The tier a model of this size fits in (the PC decides what is comfortable; the size decides the place in the list). */
export function tierOfParams(b: number | undefined): Tier {
  if (b === undefined) return 'balanced'
  if (b <= 4.5) return 'light'
  if (b <= 16) return 'balanced'
  return 'top'
}

export const modelTier = (m: LocalModelInfo): Tier => tierOfParams(m.paramsB ?? guessParamsB(m.name))

export interface PcInfo {
  platform: string
  arch: string
  ramGB: number
  cores: number
  /** The first graphics card that tells its memory (NVIDIA), if any. */
  gpu?: { name: string; vramGB: number }
  /** Apple chips share memory between CPU and graphics. */
  appleSilicon: boolean
}

export interface SpeedResult {
  /** Time to the first word. */
  firstMs: number
  /** Words per second after the first (tokens when the engine says). */
  perSec: number
  tokens: number
  /** The engine did not say; characters/3 was used. */
  estimated: boolean
}

export interface TierAdvice {
  tier: Tier
  /** The biggest model (billions of parameters, 4-bit) that fits in the memory that matters. */
  maxParamsB: number
  /** Memory GB used for the guess and where it is. */
  memoryGB: number
  where: 'graphics' | 'unified' | 'ram'
  reasons: string[]
}

/**
 * The tier this PC suits, from its memory and (when measured) the real speed. The table is an example to be settled by
 * measurement (v6 design 2-1): speed beats the specification.
 */
export function recommendTier(pc: PcInfo, speed?: SpeedResult): TierAdvice {
  let memoryGB: number
  let where: TierAdvice['where']
  if (pc.gpu && pc.gpu.vramGB >= 4) {
    memoryGB = pc.gpu.vramGB
    where = 'graphics'
  } else if (pc.appleSilicon) {
    memoryGB = pc.ramGB * 0.65
    where = 'unified'
  } else {
    memoryGB = pc.ramGB * 0.45
    where = 'ram'
  }
  // 4-bit weights ≈ 0.6 GB per billion parameters, plus room for the conversation
  const maxParamsB = Math.max(0, Math.floor(((memoryGB - 1.5) / 0.6) * 10) / 10)
  // without a graphics card or shared memory the engine runs on the CPU: slower, so it never reaches the top tier
  let tier: Tier = where === 'ram' ? (pc.ramGB >= 24 ? 'balanced' : 'light') : maxParamsB >= 16 ? 'top' : maxParamsB >= 6 ? 'balanced' : 'light'
  const reasons = [
    where === 'graphics' ? `그래픽 메모리 ${pc.gpu!.vramGB}GB (${pc.gpu!.name})` : where === 'unified' ? `Apple 칩의 공유 메모리 ${pc.ramGB}GB` : `메모리 ${pc.ramGB}GB (그래픽 메모리를 알 수 없어 CPU로 계산해요)`,
    `4비트 모델 기준 약 ${maxParamsB}B까지 올라가요`
  ]
  if (speed) {
    reasons.push(`측정한 속도 초당 약 ${speed.perSec.toFixed(1)}${speed.estimated ? '(추정)' : ''}토큰`)
    if (speed.perSec < 4 && tier !== 'light') {
      tier = 'light'
      reasons.push('너무 느려서 경량으로 낮췄어요')
    } else if (speed.perSec < 10 && tier === 'top') {
      tier = 'balanced'
      reasons.push('큰 모델은 답이 늦을 것 같아 균형으로 낮췄어요')
    }
  } else reasons.push('속도를 재 보면 더 정확해져요')
  return { tier, maxParamsB, memoryGB: Math.round(memoryGB * 10) / 10, where, reasons }
}

/** One line for a model that may not suit this PC; undefined = fine. */
export function fitNote(m: LocalModelInfo, advice: TierAdvice | undefined): string | undefined {
  const b = m.paramsB ?? guessParamsB(m.name)
  if (!advice || b === undefined) return undefined
  if (b > advice.maxParamsB * 1.15) return `이 PC에는 큰 모델이에요(약 ${b}B) — 느리거나 메모리가 모자랄 수 있어요`
  return undefined
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'GB'
  if (n >= 1e6) return Math.round(n / 1e6) + 'MB'
  return Math.round(n / 1e3) + 'KB'
}

/** A model the app suggests to install. Names change every few months: the list is a data file, not code. */
export interface LocalCandidate {
  /** The engine's name for it (Ollama tag). */
  id: string
  label: string
  paramsB: number
  tier: Tier
  /** Download size from the model card; absent when the card was not read (never guessed). */
  approxGB?: number
  /** What the model is for. Hidden by default in the staff list: `embedding`, `vision`, `other`. */
  kind: CandidateKind
  /** Curated tags (ability, use, caution). Size, this-PC and state tags are computed by the app, never stored. */
  tags: CandidateTag[]
  /** Where the terms are. */
  licenseName: string
  licenseUrl?: string
  /** `checked` only after the terms were read for this app's kind of use. */
  licenseStatus: 'checked' | 'unchecked'
  note?: string
}

export type CandidateKind = 'text' | 'embedding' | 'vision' | 'other'
export const CANDIDATE_KINDS: CandidateKind[] = ['text', 'embedding', 'vision', 'other']

/** Tags kept in the data file (design J-2). Size / this-PC / state tags are computed. */
export const ABILITY_TAGS = ['도구 호출', '생각하며 풀기', '사진 보기', '검색용'] as const
export const USE_TAGS = ['코딩', '일반', '번역·다국어', '짧은 대화', '긴 글'] as const
export const CAUTION_TAGS = ['라이선스 확인 전', '영어 위주', '오래된 모델'] as const
export type CandidateTag = (typeof ABILITY_TAGS)[number] | (typeof USE_TAGS)[number] | (typeof CAUTION_TAGS)[number]
const ALL_TAGS: readonly string[] = [...ABILITY_TAGS, ...USE_TAGS, ...CAUTION_TAGS]

export interface CandidateFile {
  updatedAt: string
  models: LocalCandidate[]
}

export const LICENSE_NOTICE =
  '모델은 각 개발사가 만든 것이고, 쓸 때의 조건(라이선스)이 모델마다 달라요. 이 앱은 모델을 대신 허락해 주지 않아요. 내려받기 전에 아래 링크의 조건을 직접 읽어 보세요. "확인 전" 표시가 있는 모델은 앱이 아직 조건을 확인하지 않은 것이에요.'

/** Known tags only, no duplicates; anything else (wrong type, computed tags, typos) is dropped. */
function parseTags(raw: unknown): CandidateTag[] {
  if (!Array.isArray(raw)) return []
  const out: CandidateTag[] = []
  for (const t of raw) if (typeof t === 'string' && ALL_TAGS.includes(t) && !out.includes(t as CandidateTag)) out.push(t as CandidateTag)
  return out
}

/** Parse a candidate file; skip what is malformed, never throw. */
export function parseCandidates(raw: unknown): CandidateFile {
  const out: LocalCandidate[] = []
  const o = raw as { updatedAt?: unknown; models?: unknown }
  if (Array.isArray(o?.models)) {
    for (const x of o.models as Record<string, unknown>[]) {
      if (typeof x?.id !== 'string' || !x.id.trim() || typeof x.paramsB !== 'number') continue
      out.push({
        id: x.id.trim(),
        label: typeof x.label === 'string' ? x.label : x.id,
        paramsB: x.paramsB,
        tier: x.tier === 'light' || x.tier === 'top' || x.tier === 'balanced' ? x.tier : tierOfParams(x.paramsB),
        approxGB: typeof x.approxGB === 'number' && x.approxGB > 0 ? x.approxGB : undefined,
        kind: CANDIDATE_KINDS.includes(x.kind as CandidateKind) ? (x.kind as CandidateKind) : 'text',
        tags: parseTags(x.tags),
        licenseName: typeof x.licenseName === 'string' ? x.licenseName : '확인 필요',
        licenseUrl: typeof x.licenseUrl === 'string' && /^https:\/\//.test(x.licenseUrl) ? x.licenseUrl : undefined,
        licenseStatus: x.licenseStatus === 'checked' ? 'checked' : 'unchecked',
        note: typeof x.note === 'string' ? x.note : undefined
      })
    }
  }
  return { updatedAt: typeof o?.updatedAt === 'string' ? o.updatedAt : '', models: out }
}

/** What is kept between runs (in the app's settings, per computer). */
export interface LocalStore {
  endpoints?: LocalEndpoint[]
  speed?: Record<string, SpeedResult & { at: string }>
  bench?: Record<string, BenchSummary>
}

// ---- J3: tags the app computes, filters, sorting ----

export type PcFit = '잘 맞아요' | '빠듯해요' | '이 PC엔 무거워요'

/** Size relative to what the PC holds (maxParamsB): up to 80% is comfortable, up to 115% is tight (same 1.15 as `fitNote`). */
export const PC_FIT_GOOD_RATIO = 0.8
export const PC_FIT_TIGHT_RATIO = 1.15
/** 4-bit weights take about 0.6 GB per billion parameters (see `recommendTier`); used to read a download size as parameters. */
const GB_PER_B = 0.6

/** The `이 PC` tag. Compares the bigger of the parameter count and the size on disk with what this PC holds. Undefined until the PC is known. */
export function pcFit(c: Pick<LocalCandidate, 'paramsB' | 'approxGB'>, advice: TierAdvice | undefined): PcFit | undefined {
  if (!advice) return undefined
  const effectiveB = Math.max(c.paramsB, c.approxGB ? c.approxGB / GB_PER_B : 0)
  if (advice.maxParamsB <= 0) return '이 PC엔 무거워요'
  const ratio = effectiveB / advice.maxParamsB
  if (ratio <= PC_FIT_GOOD_RATIO) return '잘 맞아요'
  if (ratio <= PC_FIT_TIGHT_RATIO) return '빠듯해요'
  return '이 PC엔 무거워요'
}

/** The size tag, by size on disk when known (~4GB / ~10GB), else by the tier already in the file. */
export function sizeTag(c: Pick<LocalCandidate, 'approxGB' | 'tier'>): '경량' | '균형' | '상위' {
  if (c.approxGB) return c.approxGB <= 4 ? '경량' : c.approxGB <= 10 ? '균형' : '상위'
  return c.tier === 'light' ? '경량' : c.tier === 'balanced' ? '균형' : '상위'
}

/** Passing the app's own 10-edit test with 7 or more: most edits right, a bar to be settled by experience (design J-2). */
export const RECOMMEND_MIN_PASSED = 7

/**
 * `recommended` only when this PC fits it, it is for coding or general work, and the real test passed.
 * `candidate` = the same without a test yet (shown as "추천 후보", not as a recommendation). Failed test = neither.
 */
export function recommendState(c: Pick<LocalCandidate, 'paramsB' | 'approxGB' | 'tags' | 'kind'>, advice: TierAdvice | undefined, bench: Pick<BenchSummary, 'passed' | 'total'> | undefined): 'recommended' | 'candidate' | undefined {
  if (c.kind !== 'text' || pcFit(c, advice) !== '잘 맞아요') return undefined
  if (!c.tags.includes('코딩') && !c.tags.includes('일반')) return undefined
  if (!bench) return 'candidate'
  const need = bench.total ? Math.ceil((RECOMMEND_MIN_PASSED / 10) * bench.total) : Infinity
  return bench.passed >= need ? 'recommended' : undefined
}

/** Hidden in the staff list unless asked: search-only and picture-only models. */
export const isStaffKind = (c: Pick<LocalCandidate, 'kind' | 'tags'>): boolean => c.kind === 'text' && !c.tags.includes('검색용')

/** Without tool calling a model is only used for the "easy work" range (the app leads the edit). */
export const needsEasyOnly = (c: Pick<LocalCandidate, 'tags'>): boolean => !c.tags.includes('도구 호출')

export const CANDIDATE_FILTERS = ['코딩', '이 PC에 맞음', '설치됨', '도구 호출'] as const
export type CandidateFilter = (typeof CANDIDATE_FILTERS)[number]
export type CandidateSort = 'recommend' | 'size'

export interface CandidateView {
  c: LocalCandidate
  installed: boolean
  fit?: PcFit
  rec?: 'recommended' | 'candidate'
}

/** Every chosen filter must hold (AND). */
export function filterCandidates(items: CandidateView[], filters: CandidateFilter[], showAllKinds = false): CandidateView[] {
  return items.filter((v) => {
    if (!showAllKinds && !isStaffKind(v.c)) return false
    return filters.every((f) => (f === '코딩' ? v.c.tags.includes('코딩') : f === '이 PC에 맞음' ? v.fit === '잘 맞아요' : f === '설치됨' ? v.installed : v.c.tags.includes('도구 호출')))
  })
}

const FIT_RANK: Record<string, number> = { 잘: 0, 빠: 1, 이: 2 }
const sizeOf = (c: LocalCandidate): number => c.approxGB ?? Math.round(c.paramsB * GB_PER_B * 10) / 10

/** `recommend`: recommended, then candidates, then by fit; ties keep the file's order. `size`: smallest first. Stable. */
export function sortCandidates(items: CandidateView[], by: CandidateSort): CandidateView[] {
  const rank = (v: CandidateView): number => (v.rec === 'recommended' ? 0 : v.rec === 'candidate' ? 1 : 2 + (v.fit ? FIT_RANK[v.fit[0]] : 3))
  return items
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (by === 'size' ? sizeOf(a.v.c) - sizeOf(b.v.c) : rank(a.v) - rank(b.v)) || a.i - b.i)
    .map((x) => x.v)
}

/** B2 (챗-3): what the chat shows beside a model of this PC: how well it fits, and how fast it answered when it was measured. */
export function speedLine(sp: Pick<SpeedResult, 'firstMs' | 'perSec' | 'estimated'> | undefined): string | undefined {
  if (!sp) return undefined
  const first = sp.firstMs < 1000 ? `${Math.round(sp.firstMs)}ms` : `${(sp.firstMs / 1000).toFixed(1)}초`
  return `첫 응답 ${first} · 초당 ${sp.perSec.toFixed(1)}${sp.estimated ? '(추정)' : ''}`
}

/** Fit of an installed model by its listed size (parameters, or the size on disk). */
export function installedFit(m: Pick<LocalModelInfo, 'name' | 'paramsB' | 'sizeBytes'>, advice: TierAdvice | undefined): PcFit | undefined {
  const approxGB = m.sizeBytes ? m.sizeBytes / 1e9 : undefined
  const paramsB = m.paramsB ?? guessParamsB(m.name)
  if (paramsB === undefined && approxGB === undefined) return undefined
  return pcFit({ paramsB: paramsB ?? 0, approxGB }, advice)
}
