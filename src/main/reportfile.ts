import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reportFileName } from '../shared/names'
import type { Task } from '../shared/types'
import type { Hive } from './hive'

export const REPORT_DIR = '보고서'

function line(label: string, v?: string): string[] {
  return v && v.trim() && v.trim().toLowerCase() !== 'none' ? [`- **${label}**: ${v.trim().replace(/\n/g, '\n  ')}`] : []
}

/** The report of a finished task as a document a person can open: `보고서/2026-10-18_업무-이름.md`. Returns its path relative to the company folder. */
export function writeTaskReport(hive: Hive, task: Task, who: string): string | null {
  const t = hive.getTask(task.id)
  if (!t) return null
  const dir = join(hive.root, REPORT_DIR)
  mkdirSync(dir, { recursive: true })
  const date = (t.finishedAt || new Date().toISOString()).slice(0, 10)
  let rel = t.reportFile
  if (!rel) {
    // the same name may belong to another task: number it
    for (let n = 1; n < 200; n++) {
      const name = reportFileName(date, t.title, n)
      const abs = join(dir, name)
      if (!existsSync(abs) || readFileSync(abs, 'utf8').includes(`<!-- task:${t.id} -->`)) {
        rel = join(REPORT_DIR, name)
        break
      }
    }
  }
  if (!rel) return null
  const r = t.report
  const runs = hive.listSharedRuns(t.id)
  const files = new Map<string, string>()
  for (const run of runs) for (const f of run.files) files.set(f.path, f.status)
  const roster = hive.listRoster().find((x) => x.id === t.assignee)
  const project = hive.getProject(t.projectId)
  const md = [
    `<!-- task:${t.id} -->`,
    `# ${t.title}`,
    '',
    `- 담당: ${roster?.name ?? t.assignee ?? '-'}${roster?.model ? ` (${roster.model})` : ''}`,
    `- 끝난 때: ${(t.finishedAt ?? '').slice(0, 16).replace('T', ' ') || '-'}`,
    `- 상태: ${t.status === 'done' ? '완료' : t.status === 'needs_review' ? '사람 확인 대기' : t.status}`,
    ...(project ? [`- 프로젝트: ${project.name}`] : []),
    `- 정리한 사람: ${who}`,
    '',
    ...(t.description ? ['## 요청', t.description, ''] : []),
    '## 보고',
    ...(r ? [...line('한 일', r.did), ...line('바뀐 파일', r.files), ...line('확인 방법', r.verify), ...line('남은 위험', r.risks), ...line('다음 제안', r.next)] : ['(정해진 보고 형식이 없어요. 아래 결과를 보세요.)']),
    '',
    ...(files.size ? ['## 바뀐 파일', ...[...files].map(([p, s]) => `- ${s} ${p}`), ''] : []),
    ...(t.result ? ['## 결과', t.result, ''] : []),
    `실행 ${runs.length}회`
  ].join('\n')
  writeFileSync(join(hive.root, rel), md + '\n', 'utf8')
  if (t.reportFile !== rel) hive.updateTask(t.id, { reportFile: rel })
  return rel
}
