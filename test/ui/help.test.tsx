// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountApp, ready, type Ui } from './harness'

let ui: Ui | undefined
beforeEach(() => localStorage.clear())
afterEach(() => {
  ui?.done()
  ui = undefined
})

describe('v0.6 UI: help where it is needed', () => {
  it('each main screen explains itself once; "알겠어요" hides it for good', async () => {
    ui = await mountApp((eng, dir) => void ready(eng, dir))
    expect(screen.getByText(/맡긴 일은 여기서 봐요/)).toBeTruthy()
    fireEvent.click(screen.getByText('알겠어요'))
    expect(screen.queryByText(/맡긴 일은 여기서 봐요/)).toBeNull()
    // the other board views share the same hint
    fireEvent.click(screen.getByRole('button', { name: '작업 현황' }))
    await ui.refresh()
    expect(screen.queryByText(/맡긴 일은 여기서 봐요/)).toBeNull()
    expect(localStorage.getItem('hivedesk.hint.board')).toBe('1')
  })

  it('a word behind "?" is explained in plain language', async () => {
    ui = await mountApp((eng, dir) => void ready(eng, dir))
    fireEvent.click(screen.getByText('AI 연결'))
    await ui.refresh()
    fireEvent.click(screen.getByLabelText('한도 설명'))
    expect(screen.getAllByText(/풀릴 때까지 그 연결은 쉬어요/).length).toBeGreaterThan(0)
  })
})
