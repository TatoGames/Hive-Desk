import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCommand, runCli, type Runner, type RunOptions, type RunResult } from '../src/main/adapters'
import { attachmentAdvice } from '../src/main/attachAdvice'
import { personalClaudeRules } from '../src/main/claudeSettings'
import { makeAgent } from '../src/main/config'
import { Engine } from '../src/main/engine'
import { classifyFailure } from '../src/main/failure'
import { findSecrets, looksSecret, SECRET_READ_RULES } from '../src/main/secrets'
import { checkForUpdate, compareVersions } from '../src/main/updates'
import type { Agent } from '../src/shared/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s2-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const ok = (stdout = 'done'): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false })
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr, timedOut: false, aborted: false })

function engine(runner: Runner, home = dir): Engine {
  const eng = new Engine(join(dir, 'config.json'), () => {}, runner, home)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
  eng.watchMs = 30
  return eng
}
function agentIn(eng: Engine, workDir: string, adapter: Agent['adapter'] = 'claude', name = 'dev'): Agent {
  return eng.saveAgent({ name, adapter, workDir })
}
function work(name = 'work'): string {
  const w = join(dir, name)
  mkdirSync(w, { recursive: true })
  return w
}

describe('C4: failures explained in plain language', () => {
  it('classifies the usual failures', () => {
    expect(classifyFailure('Error: Not logged in · Please run /login').kind).toBe('login')
    expect(classifyFailure('401 Unauthorized').kind).toBe('login')
    expect(classifyFailure('EACCES: permission denied, open x').kind).toBe('permission')
    expect(classifyFailure('claude: command not found').kind).toBe('not_found')
    expect(classifyFailure('명령을 찾을 수 없어요: claude').kind).toBe('not_found')
    expect(classifyFailure('getaddrinfo ENOTFOUND api.anthropic.com').kind).toBe('network')
    expect(classifyFailure('Claude AI usage limit reached').kind).toBe('limit')
    expect(classifyFailure('something weird').kind).toBe('unknown')
    expect(classifyFailure('', { timeout: 'idle', minutes: 15 }).title).toContain('15분 동안')
    expect(classifyFailure('', { timeout: 'total', minutes: 240 }).title).toContain('240분')
  })

  it('a failed task keeps the friendly explanation, the kind, and the raw text', async () => {
    const eng = engine(async () => fail('Error: Not logged in · Please run /login'))
    const t = eng.createTask({ title: 'x', assignee: agentIn(eng, work()).id })
    expect(await eng.runTask(t.id)).toBe('failed')
    const task = eng.hive.getTask(t.id)!
    expect(task.errorKind).toBe('login')
    expect(task.error).toMatch(/^로그인이 필요하거나 만료됐어요\./)
    expect(task.error).toContain('— 원문 —')
    expect(task.error).toContain('Not logged in')
    eng.shutdown()
  })

  it('a program that is not installed is told so', async () => {
    const eng = engine(async () => ({ ...fail(''), code: null, spawnError: '명령을 찾을 수 없어요: claude. 설치되어 있고 PATH에 잡혀 있는지 확인하세요.' }))
    const t = eng.createTask({ title: 'x', assignee: agentIn(eng, work()).id })
    expect(await eng.runTask(t.id)).toBe('failed')
    expect(eng.hive.getTask(t.id)!.errorKind).toBe('not_found')
    eng.shutdown()
  })
})

describe('C2: time limits count silence, not total time', () => {
  const node = (script: string): { command: string; args: string[] } => ({ command: 'node', args: ['-e', script] })
  const base = (over: Partial<RunOptions>): RunOptions => ({ cwd: dir, prompt: '', timeoutMs: 10_000, env: process.env, ...over })

  it('a CLI that keeps printing is never cut off for being slow', async () => {
    const r = await runCli(
      node("let n=0;const t=setInterval(()=>{console.log('tick');if(++n>=8){clearInterval(t)}},60)"),
      base({ idleTimeoutMs: 250 })
    )
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(0)
  })

  it('silence for too long ends the run, and says it was silence', async () => {
    const r = await runCli(node("console.log('hi');setTimeout(()=>{},5000)"), base({ idleTimeoutMs: 250 }))
    expect(r.timedOut).toBe(true)
    expect(r.timeoutKind).toBe('idle')
  })

  it('activity the CLI does not print (files changing) can keep it alive', async () => {
    const r = await runCli(
      node('setTimeout(()=>{},700)'),
      base({
        idleTimeoutMs: 250,
        onTouchReady: (touch) => {
          const t = setInterval(touch, 100)
          setTimeout(() => clearInterval(t), 800)
        }
      })
    )
    expect(r.timedOut).toBe(false)
  })

  it('the total cap still applies', async () => {
    const r = await runCli(
      node("setInterval(()=>console.log('x'),50)"),
      base({ idleTimeoutMs: 1000, timeoutMs: 400 })
    )
    expect(r.timedOut).toBe(true)
    expect(r.timeoutKind).toBe('total')
  })

  it('the run uses the agent setting for silence and the task setting for the total', async () => {
    const seen: RunOptions[] = []
    const eng = engine(async (_b, o) => {
      seen.push(o)
      return ok()
    })
    const a = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: work(), timeoutMinutes: 7 })
    const t = eng.createTask({ title: 'x', assignee: a.id })
    eng.updateTask(t.id, { maxMinutes: 30 })
    await eng.runTask(t.id)
    expect(seen[0].idleTimeoutMs).toBe(7 * 60_000)
    expect(seen[0].timeoutMs).toBe(30 * 60_000)
    eng.shutdown()
  })

  it('a timeout is reported with the right reason', async () => {
    const eng = engine(async () => ({ ...ok(''), code: null, timedOut: true, timeoutKind: 'idle' as const }))
    const t = eng.createTask({ title: 'x', assignee: agentIn(eng, work()).id })
    await eng.runTask(t.id)
    const task = eng.hive.getTask(t.id)!
    expect(task.errorKind).toBe('timeout')
    expect(task.error).toMatch(/15분 동안 아무 반응이 없어서/)
    eng.shutdown()
  })
})

describe('B3: a human looks at the result before it counts as done', () => {
  const edits: Runner = async (_b, o) => {
    writeFileSync(join(o.cwd, 'out.txt'), 'changed')
    return ok()
  }

  it('a run that changed files waits in "사람 확인"; the dependent task waits too', async () => {
    const eng = engine(edits)
    const a = agentIn(eng, work())
    const t = eng.createTask({ title: 'Make it', assignee: a.id })
    const next = eng.createTask({ title: 'Then this', assignee: a.id, dependsOn: [t.id] })
    expect(await eng.runTask(t.id)).toBe('done')
    expect(eng.hive.getTask(t.id)!.status).toBe('needs_review')
    expect(eng.hive.listEvents(t.id).some((e) => e.kind === 'review' && e.text.includes('파일 1개'))).toBe(true)
    expect(eng.hive.isReady(eng.hive.getTask(next.id)!, eng.hive.listTasks())).toBe(false)
    eng.reviewTask(t.id, 'approve')
    expect(eng.hive.getTask(t.id)!.status).toBe('done')
    expect(eng.hive.isReady(eng.hive.getTask(next.id)!, eng.hive.listTasks())).toBe(true)
    eng.shutdown()
  })

  it('"수정 요청" sends it back to the agent with the human\'s words', async () => {
    const prompts: string[] = []
    const eng = engine(async (b, o) => {
      prompts.push(o.prompt)
      return edits(b, o)
    })
    const t = eng.createTask({ title: 'Make it', assignee: agentIn(eng, work()).id })
    await eng.runTask(t.id)
    eng.reviewTask(t.id, 'changes', '파일 이름을 바꿔 주세요')
    // the re-run starts by itself
    for (let i = 0; i < 100 && prompts.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    expect(prompts[1]).toContain('파일 이름을 바꿔 주세요')
    expect(eng.hive.listEvents(t.id).some((e) => e.text.startsWith('수정을 요청했어요'))).toBe(true)
    for (let i = 0; i < 100 && eng.runningCount() > 0; i++) await new Promise((r) => setTimeout(r, 20))
    eng.shutdown()
  })

  it('nothing to look at means nothing to check; read-only tasks never wait', async () => {
    const eng = engine(async () => ok())
    const a = agentIn(eng, work())
    const t = eng.createTask({ title: 'Thinking only', assignee: a.id })
    await eng.runTask(t.id)
    expect(eng.hive.getTask(t.id)!.status).toBe('done')

    const eng2 = engine(edits)
    const ro = eng2.createTask({ title: 'Read', assignee: agentIn(eng2, work('w2'), 'claude', 'r').id, permission: 'read' })
    await eng2.runTask(ro.id)
    expect(eng2.hive.getTask(ro.id)!.status).toBe('done')
    eng.shutdown()
    eng2.shutdown()
  })

  it('the setting can turn it off or make it always apply', async () => {
    const off = engine(edits)
    off.saveSettings({ humanReview: 'off' })
    const t1 = off.createTask({ title: 'x', assignee: agentIn(off, work()).id })
    await off.runTask(t1.id)
    expect(off.hive.getTask(t1.id)!.status).toBe('done')
    off.shutdown()

    const always = engine(async () => ok(), dir)
    always.saveSettings({ humanReview: 'always' })
    const t2 = always.createTask({ title: 'y', assignee: agentIn(always, work('w3'), 'claude', 'z').id })
    await always.runTask(t2.id)
    expect(always.hive.getTask(t2.id)!.status).toBe('needs_review')
    always.shutdown()
  })

  it('undoing a run that waits for review reopens the task', async () => {
    const eng = engine(edits)
    const w = work()
    const t = eng.createTask({ title: 'x', assignee: agentIn(eng, w).id })
    await eng.runTask(t.id)
    expect(existsSync(join(w, 'out.txt'))).toBe(true)
    const rec = eng.hive.getRun(t.id, eng.hive.getTask(t.id)!.lastRunId!)!
    expect((await eng.rollbackRun(t.id, rec.id)).ok).toBe(true)
    expect(existsSync(join(w, 'out.txt'))).toBe(false)
    expect(eng.hive.getTask(t.id)!.status).toBe('todo')
    eng.shutdown()
  })
})

describe('B4: secret files', () => {
  it('recognises secret-looking names but not examples', () => {
    for (const n of ['.env', '.env.local', 'server.pem', 'api.key', 'id_rsa', 'id_ed25519', 'cert.p12', 'credentials.json']) {
      expect(looksSecret(n), n).toBe(true)
    }
    for (const n of ['.env.example', '.env.sample', 'README.md', 'main.ts', 'keyboard.ts', 'monkey.png']) {
      expect(looksSecret(n), n).toBe(false)
    }
  })

  it('finds them in the work folder, a few levels down, skipping node_modules', () => {
    const w = work()
    mkdirSync(join(w, 'config'), { recursive: true })
    mkdirSync(join(w, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(w, '.env'), 'A=1')
    writeFileSync(join(w, 'config', 'prod.pem'), 'k')
    writeFileSync(join(w, '.env.example'), 'A=')
    writeFileSync(join(w, 'node_modules', 'x', 'leak.key'), 'k')
    expect(findSecrets(w).sort()).toEqual(['.env', 'config/prod.pem'])
  })

  it('Claude may not read them unless the task says so', () => {
    const a = makeAgent('a', { name: 'c', adapter: 'claude' })
    const def = buildCommand(a, {}).args
    for (const r of SECRET_READ_RULES) expect(def).toContain(r)
    const allowed = buildCommand(a, { allowSecrets: true }).args
    for (const r of SECRET_READ_RULES) expect(allowed).not.toContain(r)
  })

  it('the pre-run check warns about them', async () => {
    const eng = engine(async () => ok())
    const w = work()
    writeFileSync(join(w, '.env'), 'A=1')
    const t = eng.createTask({ title: 'x', assignee: agentIn(eng, w).id })
    const pf = await eng.preflight(t.id)
    expect(pf.items.some((i) => i.level === 'warn' && i.text.includes('비밀번호·키') && i.text.includes('.env'))).toBe(true)
    eng.shutdown()
  })
})

describe('A5: attachment format advice', () => {
  it('suggests a better format for things the AI cannot open, and says nothing for the rest', () => {
    expect(attachmentAdvice('견적.xlsx')).toMatch(/CSV나 PDF/)
    expect(attachmentAdvice('기획서.docx')).toMatch(/PDF나 텍스트/)
    expect(attachmentAdvice('Level1.unity')).toMatch(/스크린샷/)
    expect(attachmentAdvice('logo.psd')).toMatch(/열 수 없는/)
    for (const n of ['spec.pdf', 'shot.png', 'notes.md', 'data.csv', 'main.ts', 'photo.JPG']) expect(attachmentAdvice(n), n).toBeNull()
  })

  it('attaching tells the person', () => {
    const eng = engine(async () => ok())
    const t = eng.createTask({ title: 'x', assignee: agentIn(eng, work()).id })
    const f = join(dir, '표.xlsx')
    writeFileSync(f, 'x')
    const r = eng.attachPaths(t.id, [f])
    expect(r.attached).toHaveLength(1)
    expect(r.notes[0]).toContain('엑셀')
    eng.shutdown()
  })
})

describe('A6: the person\'s own Claude settings', () => {
  it('lists personal allow rules and default modes, ignores files without them', () => {
    const home = join(dir, 'home')
    const w = work()
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(w, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm *)', 'Bash(git *)'], defaultMode: 'acceptEdits' } }))
    writeFileSync(join(w, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }))
    const found = personalClaudeRules(w, home)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('허용 규칙 2개')
    expect(found[0]).toContain('acceptEdits')
    expect(personalClaudeRules(w, join(dir, 'nohome'))).toEqual([])
  })

  it('the pre-run check says so for Claude agents', async () => {
    const home = join(dir, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }))
    const eng = engine(async () => ok(), home)
    const t = eng.createTask({ title: 'x', assignee: agentIn(eng, work()).id })
    const pf = await eng.preflight(t.id)
    expect(pf.items.some((i) => i.text.includes('개인 설정'))).toBe(true)
    eng.shutdown()
  })
})

describe('F1: update notice', () => {
  it('compares versions', () => {
    expect(compareVersions('0.2.0', '0.1.2')).toBeGreaterThan(0)
    expect(compareVersions('v0.1.2', '0.1.2')).toBe(0)
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.2', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(0)
  })

  const reply = (body: unknown, okFlag = true) => async () => ({ ok: okFlag, json: async () => body })

  it('offers a newer release with its page', async () => {
    const r = await checkForUpdate('0.1.2', reply({ tag_name: 'v0.2.0', html_url: 'https://github.com/TatoGames/Hive-Desk/releases/tag/v0.2.0', name: 'HiveDesk 0.2.0' }))
    expect(r).toMatchObject({ available: true, version: '0.2.0', url: 'https://github.com/TatoGames/Hive-Desk/releases/tag/v0.2.0' })
  })

  it('says nothing when up to date, older, a draft, a pre-release, or broken', async () => {
    expect((await checkForUpdate('0.2.0', reply({ tag_name: 'v0.2.0', html_url: 'https://github.com/x' }))).available).toBe(false)
    expect((await checkForUpdate('0.3.0', reply({ tag_name: 'v0.2.0', html_url: 'https://github.com/x' }))).available).toBe(false)
    expect((await checkForUpdate('0.1.0', reply({ tag_name: 'v0.2.0', draft: true }))).available).toBe(false)
    expect((await checkForUpdate('0.1.0', reply({ tag_name: 'v0.2.0', prerelease: true }))).available).toBe(false)
    expect((await checkForUpdate('0.1.0', reply({}, false))).available).toBe(false)
    expect((await checkForUpdate('0.1.0', async () => { throw new Error('offline') })).available).toBe(false)
  })

  it('never hands out a link that is not on github.com', async () => {
    const r = await checkForUpdate('0.1.0', reply({ tag_name: 'v0.2.0', html_url: 'https://evil.example/download' }))
    expect(r.available).toBe(true)
    expect(r.url).toBeUndefined()
  })
})
