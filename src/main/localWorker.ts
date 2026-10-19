import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Agent, CheckRun, HumanReview, PermissionLevel, RunDiff, RunRecord, RunResultKind, Task } from '../shared/types'
import { LOCAL_SCOPE, SYSTEM_PROMPT, TOO_BIG, errorSummary, formatFix, parseAnswer, retryPrompt, workPrompt, type LocalExample, type PromptFile } from '../shared/localwork'
import { rollback, createCheckpoint } from './checkpoint'
import { detectChecks } from './checks'
import { containsPath, trackChanges, unavailable } from './gitdiff'
import { newId, type Hive } from './hive'
import type { ChatMsg } from './openai'
import { DEFAULT_MAX_MINUTES, holdsAppData, needsReview, resolveCwd, shareRun, type RunOutcome } from './runner'
import { looksSecret } from './secrets'
import { writeTaskReport } from './reportfile'

/**
 * v6 4단계: one task done by a model on this PC. The app leads (design 4-5): it picks at most a few small files,
 * the model answers with the whole new files, the app applies them (after a checkpoint), runs the project's own
 * checks and, if they fail, asks the same model again — twice at most. Still failing: everything is undone and a
 * person decides. No tools, no outside model.
 */
export interface LocalWorkDeps {
  hive: Hive
  defaultCwd: string
  machine?: string
  signal?: AbortSignal
  now?: () => Date
  humanReview?: HumanReview
  /** One answer from the model (streaming is the caller's business). */
  chat: (m: { endpointId: string; model: string }, messages: ChatMsg[], o: { signal: AbortSignal; idleMs: number }) => Promise<{ text: string }>
  /** The project's checks on this folder (test / typecheck / ...). */
  runChecks: (dir: string, taskId: string) => Promise<CheckRun>
  /** Does the folder have any check at all? Default: look for the usual scripts. */
  hasChecks?: (dir: string) => boolean
  /** The `review.checks` setting. */
  checksEnabled?: boolean
  /** Which paths the checkpoint leaves out when undoing. */
  excludes?: (root: string) => string[]
  /** `collectExamples` is on. */
  collect?: () => boolean
  saveExample?: (e: LocalExample) => void
  onRunEnd?: (e: { agent: Agent; taskId: string; ms: number; result: 'approved' | 'pending' | 'failed' | 'limit' | 'other' }) => void
  /** Give up on a model that says nothing for this long (default: the agent's no-response limit). */
  idleMs?: number
}

// ---- which files ----
const TEXT_EXT = 'ts tsx js jsx mjs cjs py go rs java kt c h cpp hpp cs rb php swift json md css scss html vue svelte sh yml yaml toml txt sql lua dart'.split(' ')
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache', 'target', 'dist', 'build', 'out', 'coverage', 'Library', 'Temp', 'obj'])
/** Path pieces nothing may write into. */
const FORBIDDEN_SEGMENTS = new Set(['.git', '.local', '.hivedesk', 'node_modules'])
const STOP = new Set('the and for with this that from into have make add fix change update please file files code function when then also should would could need want use using create new test tests'.split(' '))

const extOf = (p: string): string => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? '').toLowerCase()
const slash = (p: string): string => p.replace(/\\/g, '/')

/** Secret-looking names: `.env*` (not the example), keys, certificates. */
export function sensitivePath(rel: string): boolean {
  const parts = slash(rel).split('/')
  if (parts.some((p) => FORBIDDEN_SEGMENTS.has(p))) return true
  const base = parts[parts.length - 1]
  if (/^\.env(\..+)?$/i.test(base) && !/\.(example|sample|template|dist)$/i.test(base)) return true
  return looksSecret(base) || /(^|[._-])(secrets?|credentials?)([._-]|$)/i.test(base)
}

export type Target = { ok: true; rel: string; abs: string } | { ok: false; reason: string }

/** A relative path inside the work folder that is allowed to be read / written. Follows links: nothing may leave the folder. */
export function safeTarget(cwd: string, input: string): Target {
  const rel0 = slash(input.trim()).replace(/^\.\//, '')
  if (!rel0 || rel0.includes('\0')) return { ok: false, reason: '경로가 비어 있어요' }
  if (isAbsolute(rel0) || /^[A-Za-z]:/.test(rel0) || rel0.startsWith('/')) return { ok: false, reason: `${rel0}: 작업 폴더 밖 경로예요` }
  if (rel0.split('/').some((p) => p === '..')) return { ok: false, reason: `${rel0}: 작업 폴더 밖으로 나가는 경로예요` }
  if (sensitivePath(rel0)) return { ok: false, reason: `${rel0}: 비밀번호·키가 들어갈 수 있는 파일이라 건드리지 않아요` }
  const abs = resolve(cwd, rel0)
  // a plain text check: containsPath resolves links only for paths that exist, so a new file would look "outside" in a folder reached through a link (macOS /var → /private/var). Links are checked below.
  const lex = relative(cwd, abs)
  if (lex === '..' || lex.startsWith('..' + sep) || isAbsolute(lex)) return { ok: false, reason: `${rel0}: 작업 폴더 밖 경로예요` }
  try {
    const root = realpathSync(cwd)
    // the deepest part that exists must really be inside (a link to the outside is a way out)
    let probe = abs
    while (!existsSync(probe) && !isLink(probe) && dirname(probe) !== probe) probe = dirname(probe)
    if (isLink(abs)) return { ok: false, reason: `${rel0}: 바로가기(심볼릭 링크)라서 건드리지 않아요` }
    if (!containsPath(root, realpathSync(probe))) return { ok: false, reason: `${rel0}: 작업 폴더 밖으로 이어지는 바로가기를 지나요` }
  } catch {
    return { ok: false, reason: `${rel0}: 경로를 확인하지 못했어요` }
  }
  return { ok: true, rel: slash(relative(cwd, abs)), abs }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** Text files of the folder a small model could be shown. */
function listFiles(cwd: string, limit = 4000): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit || depth > 8) return
    let names
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of names) {
      if (out.length >= limit) return
      if (e.isSymbolicLink()) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !(e.name.startsWith('.') && e.name !== '.github')) walk(full, depth + 1)
      } else if (e.isFile() && TEXT_EXT.includes(extOf(e.name)) && !sensitivePath(slash(relative(cwd, full)))) {
        try {
          if (statSync(full).size <= LOCAL_SCOPE.maxFileBytes) out.push(slash(relative(cwd, full)))
        } catch {
          /* gone meanwhile */
        }
      }
    }
  }
  walk(cwd, 0)
  return out
}

export type Pick = { ok: true; files: PromptFile[]; chars: number } | { ok: false; reason: string }

const PATH_RE = new RegExp(String.raw`(?:^|[\s\`'"(\[<])((?:[\w.-]+[/\\])*[\w.-]+\.(?:${TEXT_EXT.join('|')}))(?=$|[\s\`'",)\]>:;!?]|\.(?:\s|$))`, 'gi')

/** File paths the task text names. */
export function namedPaths(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(PATH_RE)) seen.add(slash(m[1]).replace(/^\.\//, ''))
  return [...seen]
}

function readText(abs: string): string | null {
  try {
    const buf = readFileSync(abs)
    if (buf.length > LOCAL_SCOPE.maxFileBytes || buf.includes(0)) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

/** Words of the request worth searching for. */
function keywords(text: string): string[] {
  const words = [...text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)].map((m) => m[0].toLowerCase()).filter((w) => !STOP.has(w))
  return [...new Set(words)].slice(0, 12)
}

/** The files this job is about: those the text names, otherwise the best matches of a keyword search. Few and small, or none. */
export function pickFiles(cwd: string, text: string): Pick {
  const big = (why: string): Pick => ({ ok: false, reason: `${TOO_BIG}: ${why}` })
  const named = namedPaths(text)
  const targets: { rel: string; abs: string; exists: boolean }[] = []
  let all: string[] | undefined
  for (const n of named) {
    let rel = n
    let t = safeTarget(cwd, rel)
    if (t.ok && !existsSync(t.abs) && !n.includes('/')) {
      // only a file name: take the one file with that name, if there is exactly one
      const same = (all ??= listFiles(cwd)).filter((f) => f.split('/').pop() === n)
      if (same.length > 1) return big(`${n}이(가) 여러 폴더에 있어서 어느 파일인지 정할 수 없어요 (경로까지 적어 주세요)`)
      if (same.length === 1) {
        rel = same[0]
        t = safeTarget(cwd, rel)
      }
    }
    if (!t.ok) return { ok: false, reason: `${TOO_BIG}: ${t.reason}` }
    if (!targets.some((x) => x.rel === t.rel)) targets.push({ rel: t.rel, abs: t.abs, exists: existsSync(t.abs) })
  }
  if (!targets.length) {
    const kws = keywords(text)
    const scored: { rel: string; score: number }[] = []
    let budget = 20_000_000
    if (kws.length) {
      for (const f of (all ??= listFiles(cwd))) {
        let score = kws.reduce((s, k) => s + (f.toLowerCase().includes(k) ? 3 : 0), 0)
        if (budget > 0) {
          const body = readText(join(cwd, f))
          if (body !== null) {
            budget -= body.length
            const low = body.toLowerCase()
            score += kws.reduce((s, k) => s + (low.includes(k) ? 1 : 0), 0)
          }
        }
        if (score > 0) scored.push({ rel: f, score })
      }
    }
    if (!scored.length) return big('어느 파일을 고쳐야 하는지 정하지 못했어요 (파일 경로를 적어 주세요)')
    const top = Math.max(...scored.map((s) => s.score))
    const near = scored.filter((s) => s.score >= Math.max(1, top * 0.6))
    if (near.length > LOCAL_SCOPE.maxFiles) return big(`관련 파일이 ${near.length}개로 많아요 (${LOCAL_SCOPE.maxFiles}개까지만 해요)`)
    for (const s of near) {
      const t = safeTarget(cwd, s.rel)
      if (t.ok) targets.push({ rel: t.rel, abs: t.abs, exists: true })
    }
    if (!targets.length) return big('어느 파일을 고쳐야 하는지 정하지 못했어요')
  }
  if (targets.length > LOCAL_SCOPE.maxFiles) return big(`파일이 ${targets.length}개예요 (${LOCAL_SCOPE.maxFiles}개까지만 해요)`)
  const files: PromptFile[] = []
  let chars = 0
  for (const t of targets) {
    if (!t.exists) {
      files.push({ path: t.rel, content: null })
      continue
    }
    if (!statSync(t.abs).isFile()) return big(`${t.rel}은(는) 파일이 아니에요`)
    const body = readText(t.abs)
    if (body === null) return big(`${t.rel}은(는) 너무 크거나 글자 파일이 아니에요`)
    chars += body.length
    files.push({ path: t.rel, content: body })
  }
  if (chars > LOCAL_SCOPE.maxChars) return big(`파일이 모두 ${chars.toLocaleString('ko-KR')}자로 길어요 (${LOCAL_SCOPE.maxChars.toLocaleString('ko-KR')}자까지만 해요)`)
  return { ok: true, files, chars }
}

// ---- applying ----
interface Touched {
  abs: string
  /** null = did not exist. */
  before: string | null
  madeDirs: string[]
}

function applyFile(abs: string, content: string, touched: Map<string, Touched>): void {
  let before: string | null = null
  try {
    before = existsSync(abs) ? readFileSync(abs, 'utf8') : null
  } catch {
    before = null
  }
  const madeDirs: string[] = []
  for (let d = dirname(abs); !existsSync(d) && dirname(d) !== d; d = dirname(d)) madeDirs.push(d)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  if (!touched.has(abs)) touched.set(abs, { abs, before, madeDirs })
}

/** Put every file this run wrote back to what it was (new files are removed). */
function restoreAll(touched: Map<string, Touched>): void {
  for (const t of touched.values()) {
    try {
      if (t.before === null) rmSync(t.abs, { force: true })
      else writeFileSync(t.abs, t.before)
      for (const d of t.madeDirs) {
        try {
          rmdirSync(d)
        } catch {
          /* not empty */
        }
      }
    } catch {
      /* best effort: the checkpoint is the other way back */
    }
  }
  touched.clear()
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** Run one task with a model on this PC. Never throws for a model or file problem: the task says what happened. */
export async function runLocalTask(agent: Agent, taskId: string, deps: LocalWorkDeps): Promise<RunOutcome> {
  const { hive } = deps
  const nowFn = deps.now ?? (() => new Date())
  const task = hive.getTask(taskId)
  const lm = agent.localModel
  if (!task || task.assignee !== agent.id || !lm) return 'not_ready'
  if (task.status !== 'todo') return 'not_ready'
  const level: PermissionLevel = task.permission ?? agent.permission ?? 'edit'

  // a risky task or a careful employee waits for a person first (same gate as a CLI employee)
  if ((task.risky || agent.requireApproval) && !task.cleared.includes('risky-task')) {
    if (!hive.hasPendingApproval(task.id, 'risky-task')) {
      hive.createApproval({
        kind: 'risky-task',
        taskId: task.id,
        agentId: agent.id,
        reason: task.risky ? '위험한 태스크로 표시되어 실행 전 승인이 필요해요.' : `${agent.name}은(는) 모든 태스크에 승인이 필요하도록 설정돼 있어요.`
      })
    }
    hive.updateTask(task.id, { status: 'awaiting_approval' })
    return 'awaiting_approval'
  }

  const cwd = resolveCwd(agent, deps.defaultCwd, hive.projectDir(task.projectId), task.worktree?.path)
  if (holdsAppData(hive, cwd)) {
    const error = `작업 폴더(${cwd})에 회사 데이터가 들어 있어서 실행하지 않았어요. 다른 작업 폴더를 지정하세요.`
    hive.addEvent(task.id, 'run_finished', agent.id, '실행 안 함 · ' + error)
    hive.updateTask(task.id, { status: 'failed', error, errorKind: 'permission', finishedAt: nowFn().toISOString() })
    return 'failed'
  }

  const request = [task.title, task.description, task.reply ? `추가 설명: ${task.reply}` : ''].filter(Boolean).join('\n')

  /** Not for this model: say why, in the task, and wait for a person. Nothing was changed. */
  const handBack = (question: string): RunOutcome => {
    hive.addEvent(task.id, 'need', agent.id, question)
    hive.updateTask(task.id, { status: 'needs_input', question, reply: undefined, finishedAt: nowFn().toISOString(), error: undefined })
    return 'needs_input'
  }

  if (level === 'read') return handBack('이 업무는 "읽기만" 권한이라 내 PC AI가 파일을 고치지 않았어요. 권한을 "파일 수정"으로 바꾸거나 다른 직원에게 맡겨 주세요.')
  const pick = pickFiles(cwd, request)
  if (!pick.ok) return handBack(`${pick.reason}. 이 일은 사람이나 다른 직원에게 맡겨 주세요 (내 PC AI는 파일 ${LOCAL_SCOPE.maxFiles}개 이하의 쉬운 수정만 해요).`)

  const checksOn = deps.checksEnabled !== false
  const hasChecks = checksOn && (deps.hasChecks ? deps.hasChecks(cwd) : detectChecks(cwd, { app: false }).specs.length > 0)

  // ---- start ----
  const started = nowFn()
  const runId = newId()
  hive.updateTask(task.id, { status: 'running', startedAt: started.toISOString(), error: undefined, result: undefined, report: undefined, restartNote: undefined, reply: undefined, question: undefined })
  hive.addEvent(task.id, 'run_started', agent.id, `${agent.name} 실행 시작 (내 PC AI · ${lm.model})`, runId)
  const log = (text: string): void => void hive.addEvent(task.id, 'status', 'system', text, runId)
  log(`고칠 파일을 골랐어요: ${pick.files.map((f) => f.path + (f.content === null ? ' (새 파일)' : '')).join(', ')} (${pick.chars.toLocaleString('ko-KR')}자)`)
  if (!hasChecks) log(checksOn ? '이 폴더에는 자동 검사가 없어서 결과를 꼭 사람이 확인해요.' : '자동 검사가 꺼져 있어서 결과를 꼭 사람이 확인해요.')

  const tracker = await trackChanges(cwd, { hiveRoot: hive.root })
  const cp = await createCheckpoint(hive, runId, tracker.source)
  log(cp.checkpoint ? '고치기 전 상태를 저장했어요 (되돌릴 수 있어요).' : '고치기 전 상태를 저장하지 못했어요: ' + (cp.note ?? ''))
  const baseRec = (): RunRecord => ({
    id: runId, taskId: task.id, agentId: agent.id, adapter: agent.adapter, model: lm.model,
    startedAt: started.toISOString(), finishedAt: '', durationMs: 0, outcome: 'running', exitCode: null,
    prompt: '', response: '', stderr: '', diff: unavailable('실행 중이에요.'), cwd, permission: level, activity: [],
    checkpoint: cp.checkpoint, checkpointNote: cp.note
  })
  hive.addRun(baseRec())

  // cancelling, a total time limit, and a model that says nothing
  const ac = new AbortController()
  const onOuter = (): void => ac.abort(deps.signal?.reason)
  if (deps.signal?.aborted) onOuter()
  else deps.signal?.addEventListener('abort', onOuter, { once: true })
  const deadline = setTimeout(() => ac.abort('deadline'), Math.max(1, task.maxMinutes ?? DEFAULT_MAX_MINUTES) * 60_000)
  const idleMs = deps.idleMs ?? Math.max(1, agent.timeoutMinutes || 15) * 60_000

  const touched = new Map<string, Touched>()
  const given = new Map(pick.files.map((f) => [f.path, f]))
  const prompt = workPrompt(request, pick.files)
  const transcript: string[] = []
  let messages: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }]
  let received: { path: string; content: string }[] = []
  let attempts = 0
  let formatFixed = false
  let lastError = ''
  let passed = false
  let lastChecks: CheckRun | undefined
  let hard: { error: string; kind?: 'timeout' | 'network' | 'permission' | 'unknown' } | undefined

  const ask = async (): Promise<string> => {
    const r = await deps.chat(lm, messages, { signal: ac.signal, idleMs })
    transcript.push(r.text)
    return r.text
  }

  try {
    for (let n = 1; n <= 1 + LOCAL_SCOPE.maxRetries && !passed; n++) {
      attempts = n
      log(n === 1 ? '내 PC AI에게 물어봐요…' : `다시 물어봐요 (${n}/${1 + LOCAL_SCOPE.maxRetries}번째 시도)…`)
      let answer = await ask()
      let parsed = parseAnswer(answer)
      if (!parsed.ok && !formatFixed) {
        formatFixed = true
        log(`답의 형식이 맞지 않아서 한 번만 고쳐 달라고 해요: ${parsed.reason}`)
        messages = [...messages, { role: 'assistant', content: answer }, { role: 'user', content: formatFix(parsed.reason) }]
        answer = await ask()
        parsed = parseAnswer(answer)
      }
      if (!parsed.ok) {
        lastError = '답의 형식이 맞지 않아요: ' + parsed.reason
        log(lastError)
        break
      }
      // what the model may write: the files it was given, or new files; never an existing file it did not see
      const writes: { rel: string; abs: string; content: string }[] = []
      for (const f of parsed.files) {
        const t = safeTarget(cwd, f.path)
        if (!t.ok) {
          hard = { error: `모델이 허용되지 않은 경로를 고치려고 해서 아무것도 적용하지 않았어요 (${t.reason}).`, kind: 'permission' }
          break
        }
        if (!given.has(t.rel) && existsSync(t.abs)) {
          hard = { error: `모델이 보여 주지 않은 기존 파일(${t.rel})을 고치려고 해서 아무것도 적용하지 않았어요.`, kind: 'permission' }
          break
        }
        if (!writes.some((w) => w.rel === t.rel)) writes.push({ rel: t.rel, abs: t.abs, content: f.content })
      }
      if (!hard && writes.length > LOCAL_SCOPE.maxWrite) hard = { error: `모델이 파일 ${writes.length}개를 고치려고 해서(${LOCAL_SCOPE.maxWrite}개까지만 해요) 아무것도 적용하지 않았어요.`, kind: 'permission' }
      if (hard) break
      received = writes.map((w) => ({ path: w.rel, content: w.content }))

      restoreAll(touched)
      const changed = writes.filter((w) => (given.get(w.rel)?.content ?? null) !== w.content)
      if (!changed.length) {
        lastError = '모델이 돌려준 파일이 원래 파일과 똑같아서 아무것도 바뀌지 않았어요.'
        log(lastError)
        messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }, { role: 'assistant', content: answer }, { role: 'user', content: retryPrompt(lastError) }]
        continue
      }
      for (const w of changed) applyFile(w.abs, w.content, touched)
      log(`파일 ${changed.length}개를 고쳤어요: ${changed.map((w) => w.rel).join(', ')}`)
      if (ac.signal.aborted) break

      if (!hasChecks) {
        passed = true
        break
      }
      log('자동 검사를 돌려요 (AI를 쓰지 않아요).')
      lastChecks = await deps.runChecks(cwd, task.id).catch((e) => ({ at: nowFn().toISOString(), ok: true, items: [{ name: 'checks', cmd: '', ok: true, ms: 0, tail: '', skipped: (e as Error).message }] }))
      if (ac.signal.aborted) break
      if (lastChecks.ok) {
        passed = true
        log('자동 검사를 통과했어요.')
        break
      }
      lastError = errorSummary(lastChecks)
      log(`자동 검사에 실패했어요 (${n}/${1 + LOCAL_SCOPE.maxRetries}번째 시도): ${clip(lastError.split('\n').slice(0, 3).join(' ⏎ '), 200)}`)
      messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }, { role: 'assistant', content: answer }, { role: 'user', content: retryPrompt(lastError) }]
    }
  } catch (e) {
    if (!ac.signal.aborted) {
      const msg = (e as Error).message.split('\n')[0]
      hard = { error: `내 PC AI가 응답하지 않았어요: ${msg}`, kind: /시간|응답|idle|timeout/i.test(msg) ? 'timeout' : 'network' }
    }
  } finally {
    clearTimeout(deadline)
    deps.signal?.removeEventListener('abort', onOuter)
  }

  // ---- end ----
  const finishedAt = nowFn().toISOString()
  const elapsed = nowFn().getTime() - started.getTime()
  hive.recordUsage(agent.id, elapsed, nowFn())
  const diff: RunDiff = await tracker.finish().catch(() => unavailable('변경 내용을 비교하지 못했어요.'))
  const aborted = ac.signal.aborted
  const timedOut = aborted && ac.signal.reason === 'deadline'
  const saveRun = (outcome: RunResultKind, extra: { error?: string; rolledBack?: boolean } = {}): string => {
    const rec: RunRecord = {
      ...baseRec(), finishedAt, durationMs: elapsed, outcome, exitCode: outcome === 'done' ? 0 : 1,
      prompt: clip(prompt, 100_000), response: clip(transcript.join('\n\n----\n\n'), 300_000), error: extra.error, diff,
      ...(extra.rolledBack ? { rolledBackAt: finishedAt } : {})
    }
    hive.addRun(rec)
    shareRun(hive, rec, deps.machine ?? '')
    hive.addEvent(task.id, 'run_finished', agent.id, `${outcome === 'done' ? '완료' : outcome === 'cancelled' ? '중지됨' : '실패'} · ${Math.max(1, Math.round(elapsed / 1000))}초 · 시도 ${attempts}번`, runId)
    return runId
  }
  const example = (ok: boolean): void => {
    if (!deps.collect?.() || !deps.saveExample) return
    try {
      deps.saveExample({
        id: runId, taskId: task.id, at: finishedAt, model: lm.model, request,
        given: pick.files, received,
        checks: { ran: hasChecks, ok: lastChecks ? lastChecks.ok : !hasChecks && ok, summary: lastChecks && !lastChecks.ok ? errorSummary(lastChecks) : lastError },
        attempts, passed: ok, approved: false
      })
    } catch {
      /* collecting examples must never stop the work */
    }
  }

  /** Back to how the folder was: the checkpoint when there is one (the usual undo), else the files this run wrote. */
  const undo = async (): Promise<boolean> => {
    if (touched.size && cp.checkpoint) {
      const r = await rollback(hive, cp.checkpoint, deps.excludes?.(cp.checkpoint.root) ?? []).catch(() => undefined)
      if (r?.ok) {
        touched.clear()
        return true
      }
    }
    restoreAll(touched)
    return true
  }

  if (aborted && !timedOut) {
    const why = typeof ac.signal.reason === 'string' ? ac.signal.reason : 'hold'
    const cancel = why === 'cancel'
    const had = touched.size > 0
    await undo()
    const error = (cancel ? '취소했어요.' : '사용자가 중지했어요.') + (had ? ' 고친 파일은 원래대로 돌려놨어요.' : '')
    hive.updateTask(task.id, {
      status: cancel ? 'cancelled' : 'held',
      stoppedBy: { by: deps.machine || 'me', at: finishedAt, kind: why === 'emergency' ? 'emergency' : cancel ? 'cancel' : 'hold' },
      error, finishedAt, lastRunId: saveRun('cancelled', { error, rolledBack: had })
    })
    return 'cancelled'
  }
  if (timedOut || hard?.kind === 'timeout' || hard?.kind === 'network') {
    const had = touched.size > 0
    await undo()
    const error = timedOut ? '정해 둔 최대 시간 안에 끝내지 못했어요.' : hard!.error
    log('실패: ' + error)
    deps.onRunEnd?.({ agent, taskId: task.id, ms: elapsed, result: 'failed' })
    hive.updateTask(task.id, { status: 'failed', error: error + (had ? ' 고친 파일은 원래대로 돌려놨어요.' : ''), errorKind: timedOut || hard?.kind === 'timeout' ? 'timeout' : 'network', finishedAt, lastRunId: saveRun('failed', { error, rolledBack: had }) })
    return 'failed'
  }

  if (passed) {
    const files = [...touched.values()].map((t) => slash(relative(cwd, t.abs)))
    // no check to trust = a person must look; otherwise the usual setting decides
    const review = !hasChecks || needsReview(deps.humanReview ?? 'off', level, diff)
    const lastRunId = saveRun('done')
    deps.onRunEnd?.({ agent, taskId: task.id, ms: elapsed, result: review || task.kind ? 'pending' : 'approved' })
    if (review) hive.addEvent(task.id, 'review', 'system', hasChecks ? `사람 확인을 기다려요: 파일 ${files.length}개가 바뀌었어요.` : '사람 확인을 기다려요: 자동 검사가 없어서 결과를 직접 봐야 해요.', runId)
    example(true)
    const result = `내 PC AI(${lm.model})가 파일 ${files.length}개를 고쳤어요: ${files.join(', ')}. ${hasChecks ? `자동 검사를 통과했어요${attempts > 1 ? ` (${attempts}번째 시도)` : ''}.` : '이 폴더에는 자동 검사가 없어서 확인이 필요해요.'}`
    hive.updateTask(task.id, { status: review ? 'needs_review' : 'done', result, error: undefined, errorKind: undefined, question: undefined, finishedAt, lastRunId, checks: lastChecks })
    try {
      writeTaskReport(hive, task as Task, agent.name)
    } catch {
      /* the readable copy is a convenience */
    }
    return 'done'
  }

  // did not pass (or must not be applied): undo, record the tries, and give it to a person
  const had = touched.size > 0
  const undone = await undo()
  const reason = hard?.error ?? lastError
  const history = hard ? reason : `내 PC AI가 ${attempts}번 시도했지만 ${lastChecks && !lastChecks.ok ? '자동 검사를 통과하지 못했어요' : '쓸 만한 결과를 만들지 못했어요'}. 마지막 오류: ${clip(reason, 600)}`
  log(`${history}${had ? (undone ? ' 고친 내용은 모두 되돌렸어요.' : ' 되돌리지 못한 파일이 있을 수 있어요. 실행 기록에서 되돌려 주세요.') : ''}`)
  example(false)
  const lastRunId = saveRun('failed', { error: reason, rolledBack: had })
  deps.onRunEnd?.({ agent, taskId: task.id, ms: elapsed, result: 'failed' })
  const question = `${history}${had && undone ? ' 파일은 원래대로 돌려놨어요.' : ''} 사람이 직접 하거나, 설명을 더해 답해 주시거나, 다른 직원에게 맡겨 주세요.`
  hive.addEvent(task.id, 'need', agent.id, question, runId)
  hive.updateTask(task.id, { status: 'needs_input', question, error: undefined, errorKind: undefined, finishedAt, lastRunId, checks: lastChecks })
  return 'needs_input'
}
