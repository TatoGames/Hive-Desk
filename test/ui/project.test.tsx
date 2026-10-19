// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, ready, type Ui } from './harness'

let ui: Ui | undefined
afterEach(() => {
  ui?.done()
  ui = undefined
})

describe('v0.6.1 UI: starting rules for a kind of project', () => {
  it('picking Electron fills the briefing without throwing away what was written', async () => {
    ui = await mountApp((eng, dir) => void ready(eng, dir))
    fireEvent.click(screen.getByRole('button', { name: '프로젝트' }))
    await ui.refresh()
    fireEvent.click(screen.getByRole('button', { name: /프로젝트 추가/ }))
    await ui.refresh()
    const briefing = screen.getByLabelText(/고정 브리핑/) as HTMLTextAreaElement
    fireEvent.change(briefing, { target: { value: '우리 팀 규칙: 한국어로 답해요' } })
    fireEvent.change(screen.getByLabelText(/시작 규칙 불러오기/), { target: { value: 'electron' } })
    await ui.refresh()
    const text = (screen.getByLabelText(/고정 브리핑/) as HTMLTextAreaElement).value
    expect(text).toContain('우리 팀 규칙: 한국어로 답해요')
    expect(text).toContain('contextIsolation: true')
  })
})
