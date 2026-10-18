// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, ready, type Ui } from './harness'

let ui: Ui | undefined
afterEach(() => {
  ui?.done()
  ui = undefined
})

describe('UI safety net: the core flow renders', () => {
  it('first run asks for a name before anything else', async () => {
    ui = await mountApp()
    expect(screen.getByText('HiveDesk 시작하기')).toBeTruthy()
  })

  it('the board lists a task given to an employee', async () => {
    ui = await mountApp((eng, dir) => {
      const { dev } = ready(eng, dir)
      eng.createTask({ title: '단위 변환기 만들기', assignee: dev })
    })
    expect(screen.getAllByText('단위 변환기 만들기').length).toBeGreaterThan(0)
  })

  it('a pending approval shows up where the person answers it', async () => {
    ui = await mountApp((eng, dir) => {
      const { dev } = ready(eng, dir)
      const t = eng.createTask({ title: '배포하기', assignee: dev })
      eng.hive.createApproval({ kind: 'agent-request', taskId: t.id, agentId: dev, reason: '배포해도 될까요?' })
    })
    fireEvent.click(screen.getByText(/승인·확인·자료 요청|내가 할 일/))
    await ui.refresh()
    expect(screen.getAllByText(/배포해도 될까요\?/).length).toBeGreaterThan(0)
  })

  it('the task detail opens with its report and checks', async () => {
    ui = await mountApp((eng, dir) => {
      const { dev } = ready(eng, dir)
      const t = eng.createTask({ title: '계산기', assignee: dev })
      eng.hive.updateTask(t.id, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        report: { did: '덧셈을 고쳤어요', files: 'calc.js', verify: 'npm test', risks: 'none', next: 'none' },
        checks: { at: new Date().toISOString(), ok: true, items: [{ name: 'test', cmd: 'npm test', ok: true, ms: 1200, tail: 'ok' }] }
      })
    })
    fireEvent.click(screen.getByRole('button', { name: '목록' }))
    await ui.refresh()
    fireEvent.click(screen.getAllByText('기록·변경')[0])
    await ui.refresh()
    expect(screen.getAllByText(/덧셈을 고쳤어요/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/자동 검사/).length).toBeGreaterThan(0)
    expect(screen.getByText('✅ 끝났어요')).toBeTruthy()
    expect(screen.getByText(/자동 검사 테스트/)).toBeTruthy()
  })

  it('내가 할 일 gathers what waits elsewhere, with a way there', async () => {
    ui = await mountApp((eng, dir) => {
      const { dev } = ready(eng, dir)
      const t = eng.createTask({ title: '빌드 고치기', assignee: dev })
      eng.hive.updateTask(t.id, { status: 'failed', error: '테스트 실패' })
    })
    fireEvent.click(screen.getByText('내가 할 일'))
    await ui.refresh()
    expect(screen.getByText('실패한 업무')).toBeTruthy()
    fireEvent.click(screen.getByText('보러 가기'))
    await ui.refresh()
    expect(screen.getAllByText('빌드 고치기').length).toBeGreaterThan(0)
  })
})
