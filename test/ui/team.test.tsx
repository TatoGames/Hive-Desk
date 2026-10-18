// @vitest-environment jsdom
import { join } from 'node:path'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, type Ui } from './harness'

let ui: Ui | undefined
afterEach(() => {
  ui?.done()
  ui = undefined
})

const connected = (eng: Parameters<Parameters<typeof mountApp>[0] & object>[0], dir: string): void => {
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
  const at = new Date().toISOString()
  eng.machine.saveModelAgents([
    { id: 'ma-claude-claude-opus-5-5', adapter: 'claude', modelId: 'claude-opus-5-5', createdAt: at },
    { id: 'ma-codex-openai-gpt-6-1-sol', adapter: 'codex', modelId: 'openai-gpt-6-1-sol', createdAt: at }
  ])
  eng.saveAgent({ name: '첫 직원', adapter: 'claude' })
}

describe('v0.6 UI: a team in one click', () => {
  it('the company tab builds the org chart and seats connected AIs with one button', async () => {
    ui = await mountApp(connected)
    fireEvent.click(screen.getByText('회사 · 조직도'))
    await ui.refresh()
    expect(screen.getByText('한 번에 팀 꾸리기')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '팀 꾸리기' }))
    await ui.refresh()
    // the screen turns into the new org chart
    expect(screen.getByText('추천 AI 자동 연결…')).toBeTruthy()
    expect(ui.eng.hive.listSeats().some((s) => s.agentId)).toBe(true)
    // the team can now be saved for another company
    fireEvent.change(screen.getByPlaceholderText(/저장할 팀 이름/), { target: { value: '기본 팀' } })
    fireEvent.click(screen.getByRole('button', { name: '지금 팀 저장' }))
    await ui.refresh()
    expect(ui.eng.listTeams().map((t) => t.name)).toEqual(['기본 팀'])
  })
})
