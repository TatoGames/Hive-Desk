import type { Approval, GithubAction, Task } from '../shared/types'
import type { ExtConnection, GhStatus } from '../shared/external'
import { commentIssue, createPr, ghStatus, listIssues, mergePr, prState, pushBranch, taskBranch, type Exec } from './github'
import type { Hive } from './hive'
import { addWorktree, commitWorktree, removeWorktree } from './worktree'

export interface GithubCtx {
  readonly hive: Hive
  /** Every company (the poll looks at all of them). */
  hives: () => Hive[]
  inCompany: <T>(h: Hive, fn: () => T) => T
  exec: () => Exec
  me: () => string
  changed: () => void
  notify: (title: string, body: string) => void
  /** Turn a review comment into an instruction for the task (and run it again when its employee is on this computer). */
  instruct: (taskId: string, text: string) => void
  log: (e: { connection: ExtConnection; taskId: string; tool: string; summary: string; write: boolean; by: string; outcome: 'allowed' | 'approved' | 'auto' | 'rejected'; reason?: string }) => void
}

/**
 * The GitHub side of a task (stage 6-6), done by the app with the person's `gh` login:
 * its own branch, a commit per run, push + pull request after the person's check, merge only when CI passed
 * and a person says so, issues in, a comment on the issue out, review comments and CI results back as instructions.
 */
export class GithubFlow {
  private gh: GhStatus | null = null

  constructor(private c: GithubCtx) {}

  status(): GhStatus | null {
    return this.gh
  }

  async check(): Promise<GhStatus> {
    this.gh = await ghStatus(this.c.exec())
    this.c.changed()
    return this.gh
  }

  connection(h: Hive = this.c.hive): ExtConnection | undefined {
    return h.listExtConnections().find((x) => x.kind === 'github')
  }

  /** The repository a task's work goes to: its project's, when the company has a GitHub connection. */
  repoFor(t: Task, h: Hive = this.c.hive): { repo: string; base: string; dir: string } | null {
    if (!this.connection(h)) return null
    const p = h.getProject(t.projectId)
    const dir = h.projectDir(t.projectId)
    if (!p?.github?.repo || !dir) return null
    return { repo: p.github.repo, base: p.github.base || 'main', dir }
  }

  /** Before a run: a plain task of a GitHub project works on its own branch (`hive/<task>`) in its own folder. */
  async prepare(id: string): Promise<void> {
    const h = this.c.hive
    const t = h.getTask(id)
    if (!t || t.kind || t.worktree) return
    const r = this.repoFor(t, h)
    if (!r) return
    const branch = t.github?.branch ?? taskBranch(t.title, t.id)
    const wt = await addWorktree(r.dir, t.id, branch).catch(() => null)
    if (!wt) {
      h.addEvent(id, 'status', 'system', `GitHub 브랜치를 만들지 못해서 프로젝트 폴더에서 바로 실행해요 (${r.dir}이 커밋이 있는 git 저장소인지 확인하세요).`)
      return
    }
    h.updateTask(id, { worktree: wt, github: { ...(t.github ?? {}), repo: r.repo, branch } })
    h.addEvent(id, 'status', 'system', `GitHub 업무 브랜치 ${branch}에서 실행해요. 끝나면 보고서를 커밋 메시지로 커밋해요.`)
  }

  /** After a run: what the AI changed is committed on the task branch, with the report as the message. */
  async commit(id: string): Promise<void> {
    const t = this.c.hive.getTask(id)
    if (!t?.github?.branch || !t.worktree || t.worktree.merged) return
    const r = t.report
    const msg = [t.title, '', ...(r ? [r.did, r.files && r.files !== 'none' ? `\nFiles:\n${r.files}` : '', r.verify ? `\nVerify: ${r.verify}` : ''] : []), '', `HiveDesk task ${t.id}`].join('\n').trim()
    await commitWorktree(t.worktree, msg).catch(() => false)
  }

  /** The task passed the person's check (or needed none): push + PR (or ask first), and offer the issue comment. */
  async onDone(id: string): Promise<void> {
    const h = this.c.hive
    const t = h.getTask(id)
    if (!t || t.status !== 'done' || !t.github?.branch || !t.worktree) return
    const conn = this.connection(h)
    const r = this.repoFor(t, h)
    if (!conn || !r) return
    await this.commit(id)
    const action: GithubAction = { action: 'push-pr', repo: r.repo, branch: t.github.branch, ...(t.github.pr ? { pr: t.github.pr.number } : {}), title: t.title, body: prBody(h, t) }
    if (conn.github?.autoPr !== false && this.gh?.loggedIn !== false) {
      await this.run(h, t.id, action, '자동')
    } else if (!this.pending(h, t.id, 'push-pr')) {
      this.request(h, t, action, t.github.pr ? `PR #${t.github.pr.number}에 새 커밋을 올릴까요?` : `브랜치 ${t.github.branch}를 올리고 PR을 만들까요?`)
    }
    const after = h.getTask(id)
    if (after?.github?.issue && !after.github.issue.commented && !this.pending(h, id, 'comment')) {
      this.request(h, after, { action: 'comment', repo: r.repo, issue: after.github.issue.number, body: issueComment(h, after) }, `이슈 #${after.github.issue.number}에 결과를 댓글로 남길까요?`)
    }
  }

  private pending(h: Hive, taskId: string, action: GithubAction['action']): boolean {
    return h.listApprovals().some((a) => a.taskId === taskId && a.kind === 'github' && a.status === 'pending' && a.github?.action === action)
  }

  private request(h: Hive, t: Task, action: GithubAction, reason: string): void {
    const a = h.createApproval({ kind: 'github', taskId: t.id, agentId: t.assignee ?? 'system', reason })
    h.saveApproval({ ...a, github: action })
    this.c.changed()
  }

  /** A person answered a GitHub approval (`body` = the text they edited). */
  async decide(a: Approval, approved: boolean, body?: string): Promise<void> {
    const h = this.c.hive
    if (!a.github) return
    const conn = this.connection(h)
    if (!approved) {
      if (conn) this.c.log({ connection: conn, taskId: a.taskId, tool: a.github.action, summary: a.reason, write: true, by: this.c.me(), outcome: 'rejected' })
      return
    }
    await this.run(h, a.taskId, { ...a.github, ...(body !== undefined ? { body } : {}) }, this.c.me())
  }

  /** Do one GitHub step for a task and record it. Failures go on the task's timeline and to the person. */
  async run(h: Hive, taskId: string, action: GithubAction, by: string): Promise<boolean> {
    const exec = this.c.exec()
    const t = h.getTask(taskId)
    const conn = this.connection(h)
    if (!t || !conn) return false
    const auto = by === '자동'
    try {
      if (action.action === 'push-pr') {
        if (!t.worktree || !action.branch) throw new Error('이 업무에는 올릴 브랜치가 없어요.')
        const base = this.repoFor(t, h)?.base ?? 'main'
        await pushBranch(exec, t.worktree.path, action.branch, base)
        const pr = await createPr(exec, action.repo, base, action.branch, action.title || t.title, action.body ?? prBody(h, t))
        const was = t.github?.pr
        h.updateTask(taskId, { github: { ...(t.github ?? { repo: action.repo }), pr: { number: pr.number, url: pr.url, state: 'open' }, seen: t.github?.seen ?? [], checks: { state: 'pending', at: new Date().toISOString(), failing: [] } } })
        h.addEvent(taskId, 'status', by, was ? `PR #${pr.number}에 새 커밋을 올렸어요.` : `브랜치 ${action.branch}를 올리고 PR #${pr.number}을 만들었어요: ${pr.url}`)
        this.c.log({ connection: conn, taskId, tool: was ? 'push' : 'pull-request', summary: `${action.repo} ${action.branch} → PR #${pr.number}`, write: true, by, outcome: auto ? 'auto' : 'approved' })
      } else if (action.action === 'merge') {
        if (!action.pr) throw new Error('합칠 PR이 없어요.')
        await mergePr(exec, action.repo, action.pr)
        const cur = h.getTask(taskId)!
        h.updateTask(taskId, { github: { ...(cur.github ?? { repo: action.repo }), pr: { ...cur.github!.pr!, state: 'merged' } } })
        if (cur.worktree) {
          await removeWorktree(cur.worktree).catch(() => undefined)
          h.updateTask(taskId, { worktree: { ...cur.worktree, merged: true } })
        }
        h.addEvent(taskId, 'status', by, `PR #${action.pr}을 합쳤어요.`)
        this.c.log({ connection: conn, taskId, tool: 'merge', summary: `${action.repo} PR #${action.pr}`, write: true, by, outcome: 'approved' })
      } else if (action.action === 'comment') {
        if (!action.issue) throw new Error('댓글을 달 이슈가 없어요.')
        await commentIssue(exec, action.repo, action.issue, action.body ?? issueComment(h, t))
        const cur = h.getTask(taskId)!
        if (cur.github?.issue) h.updateTask(taskId, { github: { ...cur.github, issue: { ...cur.github.issue, commented: true } } })
        h.addEvent(taskId, 'status', by, `이슈 #${action.issue}에 결과를 댓글로 남겼어요.`)
        this.c.log({ connection: conn, taskId, tool: 'issue-comment', summary: `${action.repo} #${action.issue}`, write: true, by, outcome: auto ? 'auto' : 'approved' })
      }
      this.c.changed()
      return true
    } catch (e) {
      const msg = (e as Error).message
      h.addEvent(taskId, 'status', 'system', `GitHub 작업 실패 (${action.action}): ${msg}`)
      this.c.notify('GitHub 작업 실패', `${t.title}: ${msg}`)
      this.c.changed()
      return false
    }
  }

  /** Merging always needs a person and passed checks. */
  async merge(taskId: string): Promise<{ ok: boolean; message: string }> {
    const h = this.c.hive
    const t = h.getTask(taskId)
    const pr = t?.github?.pr
    if (!t || !pr || pr.state !== 'open') return { ok: false, message: '열린 PR이 없어요.' }
    if (t.github?.checks?.state !== 'pass' && t.github?.checks?.state !== 'none') return { ok: false, message: 'CI 검사가 통과해야 합칠 수 있어요.' }
    const ok = await this.run(h, taskId, { action: 'merge', repo: t.github!.repo, pr: pr.number }, this.c.me())
    return { ok, message: ok ? `PR #${pr.number}을 합쳤어요.` : '합치지 못했어요. 업무 기록을 보세요.' }
  }

  /** Look at GitHub for every company: new issues, and the pull requests of open tasks (state, checks, review comments). */
  async poll(): Promise<{ imported: number; updated: number }> {
    if (!this.gh) await this.check()
    if (!this.gh?.loggedIn) return { imported: 0, updated: 0 }
    let imported = 0
    let updated = 0
    for (const h of this.c.hives()) {
      const conn = this.connection(h)
      if (!conn) continue
      await this.c.inCompany(h, async () => {
        imported += await this.importIssues(h, conn)
        for (const t of h.listTasks()) {
          if (t.github?.pr?.state !== 'open') continue
          if (await this.refreshPr(h, t)) updated++
        }
      })
    }
    if (imported || updated) this.c.changed()
    return { imported, updated }
  }

  private async importIssues(h: Hive, conn: ExtConnection): Promise<number> {
    const label = conn.github?.issueLabel?.trim()
    if (!label) return 0
    let n = 0
    const tasks = h.listTasks()
    for (const p of h.listProjects()) {
      if (!p.github?.repo) continue
      let issues
      try {
        issues = await listIssues(this.c.exec(), p.github.repo, label)
      } catch {
        continue
      }
      for (const i of issues) {
        if (tasks.some((t) => t.github?.repo === p.github!.repo && t.github.issue?.number === i.number)) continue
        const t = h.createTask({ title: `#${i.number} ${i.title}`, description: `${i.body ?? ''}\n\n(GitHub 이슈: ${i.url})`.trim(), projectId: p.id, createdBy: 'GitHub' })
        h.updateTask(t.id, { github: { repo: p.github.repo, issue: { number: i.number, url: i.url } } })
        h.addEvent(t.id, 'status', 'GitHub', `라벨 '${label}'이 붙은 이슈 #${i.number}을 업무로 가져왔어요. 담당을 정하면 실행돼요.`)
        this.c.log({ connection: conn, taskId: t.id, tool: 'issue-import', summary: `${p.github.repo} #${i.number} ${i.title}`, write: false, by: 'GitHub', outcome: 'allowed' })
        n++
      }
    }
    return n
  }

  /** One PR: merged/closed, CI result, new review comments → instructions. True when something changed. */
  async refreshPr(h: Hive, t: Task): Promise<boolean> {
    const gh = t.github!
    let st
    try {
      st = await prState(this.c.exec(), gh.repo, gh.pr!.number)
    } catch {
      return false
    }
    let changed = false
    const before = gh.checks?.state
    const seen = new Set(gh.seen ?? [])
    const fresh = st.comments.filter((x) => !seen.has(x.id))
    const next = { ...gh, pr: { ...gh.pr!, state: st.state }, checks: { state: st.checks.state, failing: st.checks.failing, at: new Date().toISOString() }, seen: [...seen, ...fresh.map((x) => x.id)] }
    if (st.state !== gh.pr!.state || st.checks.state !== before || fresh.length) {
      h.updateTask(t.id, { github: next })
      changed = true
    }
    if (st.state !== gh.pr!.state) {
      h.addEvent(t.id, 'status', 'GitHub', st.state === 'merged' ? `PR #${gh.pr!.number}이 합쳐졌어요.` : `PR #${gh.pr!.number}이 닫혔어요.`)
      // merged on GitHub: the task's own folder is no longer needed (the branch lives on in the repository)
      if (st.state === 'merged' && t.worktree && !t.worktree.merged) {
        await removeWorktree(t.worktree).catch(() => undefined)
        h.updateTask(t.id, { worktree: { ...t.worktree, merged: true } })
      }
    }
    if (st.checks.state !== before && (st.checks.state === 'pass' || st.checks.state === 'fail')) {
      h.addEvent(t.id, 'status', 'GitHub', st.checks.state === 'pass' ? 'CI 검사를 통과했어요. 합칠 수 있어요.' : `CI 검사가 실패했어요: ${st.checks.failing.join(', ')}`)
      if (st.checks.state === 'fail') this.c.notify('CI 실패', `${t.title}: ${st.checks.failing.join(', ')}`)
    }
    // the first look only remembers what is already there: earlier comments were written before HiveDesk watched
    if (fresh.length && gh.seen) {
      const text = fresh.map((x) => `- ${x.author}${x.where ? ` (${x.where})` : ''}: ${x.body}`).join('\n')
      this.c.inCompany(h, () => this.c.instruct(t.id, `PR #${gh.pr!.number} 리뷰 의견을 반영하세요:\n${text}`))
    }
    return changed
  }

  /** CI failed: give the task the failing checks as an instruction and run it again on the same branch. */
  fixCi(taskId: string): boolean {
    const t = this.c.hive.getTask(taskId)
    const failing = t?.github?.checks?.state === 'fail' ? t.github.checks.failing : []
    if (!t || !failing.length) return false
    this.c.instruct(taskId, `PR #${t.github!.pr?.number}의 CI 검사가 실패했어요: ${failing.join(', ')}. 원인을 찾아 고치세요 (테스트를 끄거나 건너뛰지 말고).`)
    return true
  }
}

/** PR text: the task's report, the changed files and the cross review. */
export function prBody(h: Hive, t: Task): string {
  const r = t.report
  const files = new Map<string, string>()
  for (const run of h.listSharedRuns(t.id)) for (const f of run.files) files.set(f.path, f.status)
  const review = t.reviewState?.note ? [`## 교차 검토`, `${t.reviewState.status === 'passed' ? '통과' : t.reviewState.status}: ${t.reviewState.note}`, ''] : []
  return [
    ...(t.description ? ['## 요청', t.description, ''] : []),
    '## 보고',
    ...(r ? [`- 한 일: ${r.did}`, `- 확인 방법: ${r.verify}`, ...(r.risks && r.risks !== 'none' ? [`- 남은 위험: ${r.risks}`] : [])] : ['(보고 없음)']),
    '',
    ...(files.size ? ['## 바뀐 파일', ...[...files].map(([p, s]) => `- ${s} ${p}`), ''] : []),
    ...review,
    ...(t.github?.issue ? [`Closes #${t.github.issue.number}`, ''] : []),
    '---',
    '_HiveDesk에서 AI 직원이 만든 변경이에요. 사람 확인을 거쳤어요._'
  ].join('\n')
}

function issueComment(h: Hive, t: Task): string {
  const r = t.report
  return [`HiveDesk 업무 "${t.title}"가 끝났어요.`, '', ...(r ? [`- 한 일: ${r.did}`, `- 확인 방법: ${r.verify}`] : []), ...(t.github?.pr ? ['', `PR: ${t.github.pr.url}`] : [])].join('\n')
}
