// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, ready, type Ui } from './harness'

let ui: Ui | undefined
afterEach(() => {
  ui?.done()
  ui = undefined
})

describe('챗-1 UI', () => {
  it('without a login the chat says where to start', async () => {
    ui = await mountApp((eng, dir) => {
      ready(eng, dir)
      eng.saveSettings({ uiMode: 'basic' })
      eng.machine.saveModelAgents([])
    })
    fireEvent.click(screen.getAllByRole('button', { name: '챗' })[0])
    await ui.refresh()
    expect(screen.getByText(/쓸 수 있는 AI가 없어요/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'AI 연결로 가기' })).toBeTruthy()
  })

  it('a question makes a conversation; the answer and the list show it; delete removes it', async () => {
    ui = await mountApp((eng, dir) => {
      ready(eng, dir)
      eng.saveSettings({ uiMode: 'basic' })
      eng.machine.saveModelAgents([{ id: 'ma-claude-claude-haiku-5-5', adapter: 'claude', modelId: 'claude-haiku-5-5', createdAt: new Date().toISOString() }])
    })
    fireEvent.click(screen.getAllByRole('button', { name: '챗' })[0])
    await ui.refresh()
    const box = screen.getByPlaceholderText(/질문을 적고/)
    fireEvent.change(box, { target: { value: '이 에러가 무슨 뜻이야?' } })
    fireEvent.click(screen.getByRole('button', { name: '보내기' }))
    await waitFor(() => expect(ui!.eng.chatList().length).toBe(1))
    await ui.refresh()
    expect(screen.getAllByText('이 에러가 무슨 뜻이야?').length).toBeGreaterThan(0)
    const chat = ui.eng.chatGet(ui.eng.chatList()[0].id)!
    expect(chat.messages[0].role).toBe('user')
    expect(chat.messages.length).toBe(2)
    // the model list is there with its tier
    expect(screen.getByRole('combobox', { name: /모델/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '삭제' }))
    fireEvent.click(screen.getByRole('button', { name: '정말 삭제?' }))
    await waitFor(() => expect(ui!.eng.chatList().length).toBe(0))
  })
})
