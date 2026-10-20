import { describe, it, expect } from 'vitest'
import { planIssues, withoutNegated } from '../src/shared/planedit'
import type { SubtaskSpec } from '../src/shared/types'

const item = (title: string, done: string): SubtaskSpec =>
  ({ title, done, assignee: 'a', access: 'edit', after: [], kind: 'edit' }) as unknown as SubtaskSpec

describe('v0.8.2 plan issues ignore things the plan says not to do', () => {
  it('"push는 하지 마" is not a GitHub need', () => {
    const items = [item('최소 버전 구현', 'index.html을 만든다. 새 브랜치·push는 하지 마.')]
    expect(planIssues(items, { github: false, web: true }, () => false)).toEqual([])
  })
  it('a real push still needs GitHub', () => {
    const items = [item('올리기', '완성되면 PR을 올린다')]
    expect(planIssues(items, { github: false, web: true }, () => false).map((i) => i.kind)).toEqual(['github'])
  })
  it('keeps unrelated clauses', () => {
    expect(withoutNegated('파일을 만든다. 외부 라이브러리 없이 실행')).toContain('파일을 만든다')
  })
})

import { checkCli } from '../src/main/setup'
describe('v0.8.2 codex check with an Ollama default model', () => {
  it('says the config is the problem, not the login', async () => {
    const r = await checkCli('codex', async () => ({ code: 1, stdout: '', stderr: 'ERROR: This model requires an Ollama account. Please sign in to Ollama to use this model.', timedOut: false }) as never)
    expect(r.needsLogin).toBe(false)
    expect(r.message).toContain('config.toml')
  })
})

import { Hive } from '../src/main/hive'
describe('v0.8.2 a deleted dependency does not block forever', () => {
  it('isReady ignores a dependency that no longer exists', () => {
    const h = Object.create(Hive.prototype) as InstanceType<typeof Hive>
    const t = { status: 'todo', dependsOn: ['gone'], blocked: undefined } as never
    expect(h.isReady(t, [])).toBe(true)
    expect(h.isReady({ status: 'todo', dependsOn: ['x'] } as never, [{ id: 'x', status: 'todo' } as never])).toBe(false)
  })
})
