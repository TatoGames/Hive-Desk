// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, ready, type Ui } from './harness'

let ui: Ui | undefined
afterEach(() => {
  ui?.done()
  ui = undefined
})

describe('v0.6.1 UI: a task that waits for its folder says why and offers the fix', () => {
  it('the card shows the reason; the button asks twice, then turns parallel work on', async () => {
    let enabled = 0
    ui = await mountApp(
      (eng, dir) => {
        const { dev, rev } = ready(eng, dir)
        const a = eng.createTask({ title: '앞선 일', assignee: dev })
        const b = eng.createTask({ title: '기다리는 일', assignee: rev })
        eng.hive.updateTask(a.id, { status: 'running' })
        eng.hive.updateTask(b.id, { status: 'running' })
        ;(eng as unknown as { running: Map<string, unknown>; waiting: Map<string, string> }).running.set(a.id, new AbortController())
        ;(eng as unknown as { running: Map<string, unknown>; waiting: Map<string, string> }).running.set(b.id, new AbortController())
        ;(eng as unknown as { waiting: Map<string, string> }).waiting.set(b.id, a.id)
      },
      {
        parallelAdvice: () => ({ state: 'none', dir: '/proj', message: '이 폴더는 git 폴더가 아니라서 업무가 순서대로만 돌아요.' }),
        enableParallel: () => (enabled++, { ok: true, message: '이제 하위 업무는 폴더를 나눠 동시에 돌아요.' })
      }
    )
    fireEvent.click(screen.getByRole('button', { name: '목록' }))
    await ui.refresh()
    expect(screen.getByText(/폴더 대기: "앞선 일"/)).toBeTruthy()
    expect(screen.getByText(/git 폴더가 아니라서 업무가 순서대로만/)).toBeTruthy()
    const btn = screen.getByRole('button', { name: 'git 폴더로 만들고 병렬 켜기' })
    fireEvent.click(btn)
    expect(enabled).toBe(0) // the first click only arms it
    fireEvent.click(screen.getByRole('button', { name: /^정말 git 폴더로 만들고 병렬 켜기/ }))
    await ui.refresh()
    expect(enabled).toBe(1)
    expect(screen.getByText(/폴더를 나눠 동시에 돌아요/)).toBeTruthy()
  })
})
