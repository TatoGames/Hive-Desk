import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import { checksOf, parseRepo, taskBranch, type Exec } from '../src/main/github'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s66-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const REPORT = '[[DID: 버튼을 고쳤어요]]\n[[FILES: ui.txt]]\n[[VERIFY: 버튼 누르기]]\n[[RISK: none]]\n[[NEXT: none]]'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await wait(20)
}

/** A fake `gh` / `git push`: answers like GitHub and remembers every call. The PR state is set by the test. */
function fakeGithub() {
  const calls: { cmd: string; args: string[]; input?: string; cwd?: string }[] = []
  const state = {
    pr: { state: 'OPEN', statusCheckRollup: [] as unknown[], reviews: [] as unknown[], comments: [] as unknown[] },
    inline: [] as unknown[],
    issues: [] as unknown[]
  }
  const ok = (out = ''): { code: number; out: string; err: string } => ({ code: 0, out, err: '' })
  const exec: Exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input, cwd: opts.cwd })
    const a = args.join(' ')
    if (cmd === 'git' && args[0] === 'push') return ok()
    if (cmd !== 'gh') return { code: 1, out: '', err: 'unexpected' }
    if (a === '--version') return ok('gh version 2.60.0')
    if (a.startsWith('auth status')) return ok('Logged in to github.com account alice')
    if (a.startsWith('api user')) return ok('alice\n')
    if (a.startsWith('pr list')) return ok('[]')
    if (a.startsWith('pr create')) return ok('https://github.com/o/r/pull/7\n')
    if (a.startsWith('pr view')) return ok(JSON.stringify(state.pr))
    if (a.startsWith('api repos/o/r/pulls/7/comments')) return ok(JSON.stringify(state.inline))
    if (a.startsWith('pr merge')) return ok()
    if (a.startsWith('issue list')) return ok(JSON.stringify(state.issues))
    if (a.startsWith('issue comment')) return ok()
    return { code: 1, out: '', err: 'unknown gh call: ' + a }
  }
  return { exec, calls, state }
}

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd }).toString()

function setup(opts: { autoPr?: boolean; label?: string } = {}) {
  const repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'hi\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  // the fake AI changes a file in the folder it runs in
  const runner: Runner = async (_b, o) => {
    writeFileSync(join(o.cwd, 'ui.txt'), 'fixed button\n')
    return { code: 0, stdout: REPORT, stderr: '', timedOut: false, aborted: false }
  }
  const eng = new Engine(join(dir, 'c.json'), () => {}, runner, dir)
  const gh = fakeGithub()
  eng.exec = gh.exec
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'changes' })
  eng.watchMs = 20
  const agent = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: repo })
  const p = eng.saveProject({ name: '게임' })
  eng.setProjectPath(p.id, repo)
  eng.setProjectGithub(p.id, 'https://github.com/o/r.git', 'main')
  eng.saveConnection({ kind: 'github', name: 'GitHub', github: { autoPr: opts.autoPr !== false, ...(opts.label ? { issueLabel: opts.label } : {}) } })
  return { eng, gh, agent, repo, project: p }
}

describe('6-6: GitHub helpers', () => {
  it('repository names and task branches', () => {
    expect(parseRepo('https://github.com/TatoGames/Hive-Desk.git')).toBe('TatoGames/Hive-Desk')
    expect(parseRepo('git@github.com:o/r.git')).toBe('o/r')
    expect(parseRepo('o/r')).toBe('o/r')
    expect(parseRepo('not a repo')).toBe('')
    expect(taskBranch('버튼 고치기!', 'abc-123456')).toBe('hive/버튼-고치기-123456')
  })

  it('CI: any failure fails, anything unfinished is pending, nothing is none', () => {
    expect(checksOf([])).toEqual({ state: 'none', failing: [] })
    expect(checksOf([{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }, { context: 'b', state: 'SUCCESS' }]).state).toBe('pass')
    expect(checksOf([{ name: 'a', status: 'IN_PROGRESS', conclusion: '' }]).state).toBe('pending')
    expect(checksOf([{ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'b', status: 'QUEUED' }])).toEqual({ state: 'fail', failing: ['a'] })
  })
})

describe('6-6: a task of a GitHub project', () => {
  it('runs on its own branch, commits with the report, and after the person check pushes and opens a PR (never main)', async () => {
    const { eng, gh, agent, repo, project } = setup()
    await eng.checkGithub()
    expect(eng.snapshot().ext.gh?.user).toBe('alice')
    const t = eng.createTask({ title: '버튼 고치기', assignee: agent.id, projectId: project.id })
    await eng.runTask(t.id)
    const after = eng.hive.getTask(t.id)!
    expect(after.github?.branch).toBe(taskBranch('버튼 고치기', t.id))
    expect(after.worktree?.path).toContain('.hive-worktrees')
    // the project folder itself is untouched; the change is a commit on the task branch with the report as message
    expect(existsSync(join(repo, 'ui.txt'))).toBe(false)
    expect(git(repo, 'log', '-1', '--format=%B', after.github!.branch!)).toContain('버튼을 고쳤어요')
    expect(after.status).toBe('needs_review')
    expect(gh.calls.some((c) => c.args[0] === 'push')).toBe(false)

    eng.reviewTask(t.id, 'approve')
    await waitFor(() => !!eng.hive.getTask(t.id)!.github?.pr)
    const push = gh.calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')!
    expect(push.args).toContain(`${after.github!.branch}:${after.github!.branch}`)
    const create = gh.calls.find((c) => c.args.slice(0, 2).join(' ') === 'pr create')!
    expect(create.args).toEqual(expect.arrayContaining(['--repo', 'o/r', '--base', 'main', '--head', after.github!.branch!]))
    expect(create.input).toContain('버튼을 고쳤어요')
    expect(eng.hive.getTask(t.id)!.github!.pr).toMatchObject({ number: 7, state: 'open' })
    // recorded in the connection log
    expect(eng.hive.listExtLog().some((e) => e.tool === 'pull-request' && e.outcome === 'auto')).toBe(true)
    eng.shutdown()
  })

  it('without automatic PRs the push waits for an approval, and the person can change the PR text', async () => {
    const { eng, gh, agent, project } = setup({ autoPr: false })
    eng.saveSettings({ humanReview: 'off' })
    const t = eng.createTask({ title: '문서', assignee: agent.id, projectId: project.id })
    await eng.runTask(t.id)
    const a = eng.hive.listApprovals().find((x) => x.kind === 'github')!
    expect(a.github!.action).toBe('push-pr')
    expect(gh.calls.some((c) => c.args[0] === 'push')).toBe(false)
    await eng.decideGithub(a.id, 'approved', '사람이 고친 PR 본문')
    expect(gh.calls.find((c) => c.args.slice(0, 2).join(' ') === 'pr create')!.input).toBe('사람이 고친 PR 본문')
    eng.shutdown()
  })

  it('CI results and review comments come back: a failure can be fixed, review comments become instructions, merging waits for green', async () => {
    const { eng, gh, agent, project } = setup()
    eng.saveSettings({ humanReview: 'off' })
    const t = eng.createTask({ title: '점수판', assignee: agent.id, projectId: project.id })
    await eng.runTask(t.id)
    await waitFor(() => !!eng.hive.getTask(t.id)!.github?.pr)
    // CI fails
    gh.state.pr.statusCheckRollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }]
    await eng.githubPoll()
    expect(eng.hive.getTask(t.id)!.github!.checks).toMatchObject({ state: 'fail', failing: ['test'] })
    expect((await eng.mergeTaskPr(t.id)).ok).toBe(false)
    // a review comment on a line arrives: it becomes an instruction and the task works again on its branch
    gh.state.inline = [{ id: 11, user: { login: 'bob' }, body: '이름을 바꿔 주세요', path: 'ui.txt', line: 1 }]
    await eng.githubPoll()
    await waitFor(() => (eng.hive.getTask(t.id)!.instructions ?? []).some((i) => i.text.includes('이름을 바꿔 주세요')))
    const ins = eng.hive.getTask(t.id)!.instructions!.find((i) => i.text.includes('이름을 바꿔 주세요'))!
    expect(ins.text).toContain('bob (ui.txt:1)')
    await waitFor(() => eng.hive.getTask(t.id)!.status === 'done' && !eng.snapshot().running.length)
    // the same comment is taken in only once
    await eng.githubPoll()
    expect(eng.hive.getTask(t.id)!.instructions!.filter((i) => i.text.includes('이름을 바꿔 주세요')).length).toBe(1)
    // fix CI: the failing checks go in as an instruction
    expect(eng.fixCi(t.id)).toBe(true)
    await waitFor(() => (eng.hive.getTask(t.id)!.instructions ?? []).some((i) => i.text.includes('CI 검사가 실패')))
    await waitFor(() => eng.hive.getTask(t.id)!.status === 'done' && !eng.snapshot().running.length)
    // green → a person may merge
    gh.state.pr.statusCheckRollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }]
    await eng.githubPoll()
    const m = await eng.mergeTaskPr(t.id)
    expect(m.ok).toBe(true)
    expect(gh.calls.some((c) => c.args.slice(0, 2).join(' ') === 'pr merge')).toBe(true)
    expect(eng.hive.getTask(t.id)!.github!.pr!.state).toBe('merged')
    eng.shutdown()
  })

  it('issues with the label become tasks once; a finished issue task offers a comment that waits for approval', async () => {
    const { eng, gh, agent } = setup({ label: 'hive' })
    eng.saveSettings({ humanReview: 'off' })
    gh.state.issues = [{ number: 3, title: '로그인 버그', body: '로그인이 안 돼요', url: 'https://github.com/o/r/issues/3' }]
    expect((await eng.githubPoll()).imported).toBe(1)
    expect((await eng.githubPoll()).imported).toBe(0)
    const t = eng.hive.listTasks().find((x) => x.github?.issue?.number === 3)!
    expect(t.title).toBe('#3 로그인 버그')
    expect(gh.calls.find((c) => c.args[0] === 'issue')!.args).toEqual(expect.arrayContaining(['--label', 'hive']))
    eng.reassignTask(t.id, agent.id)
    await eng.runTask(t.id)
    await waitFor(() => eng.hive.listApprovals().some((a) => a.kind === 'github' && a.github?.action === 'comment'))
    const a = eng.hive.listApprovals().find((x) => x.github?.action === 'comment')!
    expect(gh.calls.some((c) => c.args.slice(0, 2).join(' ') === 'issue comment')).toBe(false)
    expect(eng.hive.getTask(t.id)!.github!.pr).toBeDefined() // the PR body closes the issue
    expect(gh.calls.find((c) => c.args.slice(0, 2).join(' ') === 'pr create')!.input).toContain('Closes #3')
    await eng.decideGithub(a.id, 'approved')
    expect(gh.calls.some((c) => c.args.slice(0, 2).join(' ') === 'issue comment')).toBe(true)
    expect(eng.hive.getTask(t.id)!.github!.issue!.commented).toBe(true)
    eng.shutdown()
  })

  it('the code repository may not be the one the company data is shared through', () => {
    const { eng, project } = setup()
    git(eng.hive.root, 'init', '-q', '-b', 'main')
    git(eng.hive.root, 'remote', 'add', 'origin', 'https://github.com/team/data.git')
    expect(() => eng.setProjectGithub(project.id, 'team/data')).toThrow('팀 공유용')
    expect(() => eng.setProjectGithub(project.id, 'team/data-code')).not.toThrow()
    eng.shutdown()
  })

  it('the plan check knows GitHub only when the company has the connection and gh is logged in', async () => {
    const { eng } = setup()
    expect(eng.delegation.capabilities().github).toBe(false)
    await eng.checkGithub()
    expect(eng.delegation.capabilities().github).toBe(true)
    eng.shutdown()
  })
})
