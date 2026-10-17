import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SyncResult } from '../shared/types'

function git(cwd: string, args: string[], timeout = 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true },
      (err, stdout, stderr) => {
        const out = (String(stdout) + String(stderr)).trim()
        resolve({ ok: !err, out: err && !out ? err.message : out })
      }
    )
  })
}

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, '.git'))
}

/** Turn the hive folder into a git repo, optionally linked to a (private) GitHub repo. */
export async function initSync(root: string, remoteUrl: string): Promise<SyncResult> {
  if (!isGitRepo(root)) {
    const r = await git(root, ['init', '-b', 'main'])
    if (!r.ok) return { ok: false, message: 'git 저장소를 만들지 못했어요: ' + r.out }
  }
  if (remoteUrl.trim()) {
    const has = await git(root, ['remote', 'get-url', 'origin'])
    const r = has.ok
      ? await git(root, ['remote', 'set-url', 'origin', remoteUrl.trim()])
      : await git(root, ['remote', 'add', 'origin', remoteUrl.trim()])
    if (!r.ok) return { ok: false, message: '공유 저장소 주소를 설정하지 못했어요: ' + r.out }
  }
  return { ok: true, message: '공유를 켰어요. "지금 동기화"를 눌러 첫 동기화를 하세요.' }
}

/** commit local changes → pull (rebase) → push. Aborts cleanly on conflict. */
export async function syncNow(root: string, member: string): Promise<SyncResult> {
  if (!isGitRepo(root)) return { ok: false, message: '이 작업공간은 아직 공유가 켜져 있지 않아요.' }
  const remote = await git(root, ['remote', 'get-url', 'origin'])
  if (!remote.ok) return { ok: false, message: '공유 저장소 주소가 없어요. 먼저 GitHub 저장소 주소를 넣어 주세요.' }

  await git(root, ['add', '-A'])
  const status = await git(root, ['status', '--porcelain'])
  if (status.out) {
    const c = await git(root, [
      '-c',
      `user.name=${member || 'hivedesk'}`,
      '-c',
      'user.email=hivedesk@users.noreply.github.com',
      'commit',
      '-m',
      `sync: ${member || 'hivedesk'} ${new Date().toISOString()}`
    ])
    if (!c.ok) return { ok: false, message: '변경 내용을 저장(commit)하지 못했어요: ' + c.out }
  }

  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'main'
  const hasUpstream = (await git(root, ['ls-remote', '--heads', 'origin', branch])).out.length > 0

  if (hasUpstream) {
    const p = await git(root, ['pull', '--rebase', '--autostash', 'origin', branch])
    if (!p.ok) {
      await git(root, ['rebase', '--abort'])
      return {
        ok: false,
        message:
          '팀원의 변경과 충돌했어요 (두 사람이 같은 태스크를 동시에 고쳤어요). ' +
          '동기화를 취소했고 잃어버린 내용은 없어요. 작업공간 폴더에서 git으로 충돌을 해결한 뒤 다시 동기화하세요.\n' +
          p.out.slice(-400)
      }
    }
  }
  const push = await git(root, ['push', '-u', 'origin', branch])
  if (!push.ok) return { ok: false, message: 'GitHub에 올리지 못했어요 (권한·로그인을 확인하세요): ' + push.out.slice(-400) }
  return { ok: true, message: '동기화했어요.' }
}
