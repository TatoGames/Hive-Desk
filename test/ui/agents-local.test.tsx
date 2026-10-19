// @vitest-environment jsdom
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, ready, type Ui } from './harness'

let ui: Ui | undefined
afterEach(() => {
  ui?.done()
  ui = undefined
})

describe('v6 4단계 UI: 직원이 쓸 내 PC AI 고르기', () => {
  it('pick a model of this PC for a new employee: grade and fit warning show, the saved employee has no CLI settings', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/version') return void res.end(JSON.stringify({ version: '0.5.0' }))
      if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 4_700_000_000, details: { parameter_size: '7.6B' } }, { name: 'llama3.3:70b', size: 40_000_000_000, details: { parameter_size: '70B' } }] }))
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      ui = await mountApp((eng, dir) => {
        ready(eng, dir)
        eng.saveSettings({ uiMode: 'advanced' })
      })
      await ui.eng.localAdd({ url: `127.0.0.1:${(server.address() as AddressInfo).port}` })
      await ui.eng.localRefresh()
      await ui.refresh()
      fireEvent.click(screen.getAllByRole('button', { name: /^에이전트/ })[0])
      await ui.refresh()
      fireEvent.click(screen.getByRole('button', { name: '+ 에이전트 추가' }))
      fireEvent.change(screen.getByPlaceholderText('예: 백엔드 개발자'), { target: { value: '작은손' } })
      const adapter = screen.getByLabelText(/사용할 AI/) as HTMLSelectElement
      fireEvent.change(adapter, { target: { value: 'local' } })
      const model = (await screen.findByLabelText(/내 PC AI 모델/)) as HTMLSelectElement
      await waitFor(() => expect(model.options.length).toBeGreaterThan(2))
      // no CLI command / extra args / daily budget for it
      expect(screen.queryByText(/실행할 명령/)).toBeNull()
      expect(screen.queryByText(/하루 최대 실행/)).toBeNull()
      // a model too big for this PC carries the warning
      const big = [...model.options].find((o) => o.textContent?.includes('llama3.3:70b'))!
      fireEvent.change(model, { target: { value: big.value } })
      await waitFor(() => expect(screen.getByText(/큰 모델이에요|느리거나/)).toBeTruthy())
      const small = [...model.options].find((o) => o.textContent?.includes('qwen2.5-coder:7b'))!
      expect(small.textContent).toMatch(/·/)
      fireEvent.change(model, { target: { value: small.value } })
      expect(screen.getByText(/쉬운 일만 맡겨요/)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '저장' }))
      await waitFor(() => expect(ui!.eng.snapshot().config.agents.some((a) => a.name === '작은손')).toBe(true))
      const a = ui.eng.snapshot().config.agents.find((x) => x.name === '작은손')!
      expect(a).toMatchObject({ adapter: 'custom', localModel: { model: 'qwen2.5-coder:7b' }, dailyRunLimit: 0 })
      await ui.refresh()
      expect(screen.getByText(/내 PC AI · qwen2.5-coder:7b/)).toBeTruthy()
    } finally {
      server.closeAllConnections()
      server.close()
    }
  }, 30_000)

  it('a measurement can be opened: passed and failed items with the reason', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/version') return void res.end(JSON.stringify({ version: '0.5.0' }))
      if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 4_700_000_000, details: { parameter_size: '7.6B' } }] }))
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      ui = await mountApp((eng, dir) => {
        ready(eng, dir)
        eng.saveSettings({ uiMode: 'basic' })
      })
      const ep = await ui.eng.localAdd({ url: `127.0.0.1:${(server.address() as AddressInfo).port}` })
      await ui.eng.localRefresh()
      const rows = [
        { id: 'a', title: '합계 버그 고치기', ok: true, ms: 4000 },
        { id: 'b', title: '회문 판별 만들기', ok: false, ms: 9000, reason: 'AssertionError: expected true' },
        { id: 'c', title: '인자 추가하기', ok: false, ms: 1000, reason: '코드를 돌려주지 않았어요' }
      ]
      ui.eng.saveSettings({ local: { ...ui.eng.config.local, bench: { [`${ep.id}|qwen2.5-coder:7b`]: { model: 'qwen2.5-coder:7b', at: new Date().toISOString(), passed: 1, total: 3, totalMs: 14000, medianMs: 4000, rows } } } })
      fireEvent.click(screen.getAllByRole('button', { name: 'AI 연결' })[0])
      await ui.refresh()
      expect(screen.getByText(/실측 1\/3개 통과/)).toBeTruthy()
      expect(screen.queryByText(/AssertionError/)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '결과 보기' }))
      expect(screen.getByText(/통과 · 합계 버그 고치기/)).toBeTruthy()
      expect(screen.getByText(/실패 · 회문 판별 만들기.*AssertionError: expected true/)).toBeTruthy()
      expect(screen.getByText(/실패 · 인자 추가하기.*코드를 돌려주지 않았어요/)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '결과 접기' }))
      expect(screen.queryByText(/AssertionError/)).toBeNull()
    } finally {
      server.closeAllConnections()
      server.close()
    }
  }, 30_000)
})
