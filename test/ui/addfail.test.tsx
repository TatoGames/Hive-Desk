// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, ready, type Ui } from './harness'

let ui: Ui | undefined
afterEach(() => {
  ui?.done()
  ui = undefined
})

describe('v0.8.1 UI: a task that cannot be added says why', () => {
  it('shows the error under the form and keeps what was typed', async () => {
    ui = await mountApp((eng, dir) => void ready(eng, dir), {
      classifyInput: async () => ({ kind: 'task' }),
      createTask: async () => {
        throw new Error("Error invoking remote method 'task:create': Error: 총괄 본부장 자리에 에이전트를 배치해야 미지정 업무를 접수할 수 있어요.")
      }
    })
    fireEvent.click(screen.getByRole('button', { name: '목록' }))
    await ui.refresh()
    const input = screen.getByPlaceholderText(/새 태스크 제목/) as HTMLInputElement
    fireEvent.change(input, { target: { value: '안 되는 일' } })
    fireEvent.click(screen.getByRole('button', { name: '추가' }))
    await waitFor(() => expect(screen.getByText(/총괄 본부장 자리에 에이전트를 배치해야/)).toBeTruthy())
    expect(screen.queryByText(/Error invoking/)).toBeNull()
    expect((screen.getByPlaceholderText(/새 태스크 제목/) as HTMLInputElement).value).toBe('안 되는 일')
  })
})
