// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, ready, type Ui } from './harness'

let ui: Ui | undefined
afterEach(() => {
  ui?.done()
  ui = undefined
})

const haiku = { id: 'ma-claude-claude-haiku-5-5', adapter: 'claude' as const, modelId: 'claude-haiku-5-5', createdAt: new Date().toISOString() }

describe('챗-2 UI', () => {
  it('a task detail has "이 업무에 대해 물어보기": a chat about the task opens on the chat screen', async () => {
    ui = await mountApp((eng, dir) => {
      const { dev } = ready(eng, dir)
      eng.machine.saveModelAgents([haiku])
      const t = eng.createTask({ title: '계산기', assignee: dev })
      eng.hive.updateTask(t.id, { status: 'done', finishedAt: new Date().toISOString(), report: { did: '덧셈을 고쳤어요', files: 'calc.js', verify: 'none', risks: 'none', next: 'none' } })
    })
    fireEvent.click(screen.getByRole('button', { name: '목록' }))
    await ui.refresh()
    fireEvent.click(screen.getAllByText('기록·변경')[0])
    await ui.refresh()
    fireEvent.click(screen.getByRole('button', { name: '이 업무에 대해 물어보기' }))
    await waitFor(() => expect(ui!.eng.chatList().length).toBe(1))
    await ui.refresh()
    const chat = ui.eng.chatGet(ui.eng.chatList()[0].id)!
    expect(chat.aboutTask).toBe(ui.eng.hive.listTasks()[0].id)
    expect(chat.title).toBe('업무: 계산기')
    // the chat screen is open and shows the chat
    expect(screen.getAllByText('업무: 계산기').length).toBeGreaterThan(0)
    expect(screen.getByPlaceholderText(/질문을 적고/)).toBeTruthy()
  })

  it('a conversation makes a draft the person edits; nothing is handed over until "이 내용으로 맡길게요"', async () => {
    ui = await mountApp((eng, dir) => {
      ready(eng, dir)
      eng.machine.saveModelAgents([haiku])
    })
    const c = ui.eng.chatCreate()
    await ui.eng.chatSend(c.id, '로그인 오류 메시지를 고쳐 주세요')
    fireEvent.click(screen.getAllByRole('button', { name: '챗' })[0])
    await ui.refresh()
    fireEvent.click(screen.getAllByText('로그인 오류 메시지를 고쳐 주세요')[0])
    await ui.refresh()
    fireEvent.click(screen.getByRole('button', { name: '이 대화로 업무 만들기' }))
    const title = (await screen.findByLabelText('업무 제목')) as HTMLInputElement
    expect(title.value).toBe('로그인 오류 메시지를 고쳐 주세요')
    expect((screen.getByLabelText('업무 설명') as HTMLTextAreaElement).value).toContain('요청')
    expect(ui.eng.hive.listTasks().length).toBe(0)
    // cancel: still nothing
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    expect(ui.eng.hive.listTasks().length).toBe(0)
    // again, edit, confirm
    fireEvent.click(screen.getByRole('button', { name: '이 대화로 업무 만들기' }))
    const again = (await screen.findByLabelText('업무 제목')) as HTMLInputElement
    fireEvent.change(again, { target: { value: '로그인 오류 문구 고치기' } })
    expect(ui.eng.hive.listTasks().length).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '이 내용으로 맡길게요' }))
    await waitFor(() => expect(ui!.eng.hive.listTasks().length).toBe(1))
    const t = ui.eng.hive.listTasks()[0]
    expect(t.title).toBe('로그인 오류 문구 고치기')
    expect(t.fromChat).toBe(c.id)
    expect(await screen.findByText('업무를 맡겼어요')).toBeTruthy()
    await new Promise((r) => setTimeout(r, 300))
  })

  it('an empty conversation says there is nothing to make a task from', async () => {
    ui = await mountApp((eng, dir) => {
      ready(eng, dir)
      eng.machine.saveModelAgents([haiku])
    })
    const c = ui.eng.chatCreate()
    fireEvent.click(screen.getAllByRole('button', { name: '챗' })[0])
    await ui.refresh()
    fireEvent.click(screen.getAllByText('새 대화')[0])
    await ui.refresh()
    fireEvent.click(screen.getByRole('button', { name: '이 대화로 업무 만들기' }))
    expect(await screen.findByText(/업무로 만들 요청이 아직 없어요/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '이 내용으로 맡길게요' })).toBeNull()
    expect(c.id).toBeTruthy()
  })
})
