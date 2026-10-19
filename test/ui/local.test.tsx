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

describe('8-2 UI: 내 PC AI', () => {
  it('connect an address, see its models with a tier, and installing needs the person to confirm the terms', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/version') return void res.end(JSON.stringify({ version: '0.5.0' }))
      if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 4_700_000_000, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' } }] }))
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = `127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      ui = await mountApp((eng, dir) => {
        ready(eng, dir)
        eng.saveSettings({ uiMode: 'basic' })
      })
      fireEvent.click(screen.getAllByRole('button', { name: 'AI 연결' })[0])
      await ui.refresh()
      expect(screen.getByText('내 PC AI')).toBeTruthy()
      expect(screen.getByText(/추천 등급/)).toBeTruthy()

      fireEvent.change(screen.getByPlaceholderText(/주소/), { target: { value: addr } })
      fireEvent.click(screen.getByRole('button', { name: '연결' }))
      await waitFor(() => expect(screen.getByText('qwen2.5-coder:7b')).toBeTruthy())
      expect(screen.getByText(/연결됨 · 0.5.0/)).toBeTruthy()
      expect(ui.eng.chatModels().some((m) => m.where === 'local')).toBe(true)

      // a candidate cannot be installed before the person says the terms were read
      const install = screen.getAllByRole('button', { name: '설치' })[0] as HTMLButtonElement
      expect(install.disabled).toBe(true)
      fireEvent.click(screen.getAllByLabelText(/조건을 직접 확인했어요/)[0])
      expect((screen.getAllByRole('button', { name: '설치' })[0] as HTMLButtonElement).disabled).toBe(false)
      expect(screen.getByText(/라이선스\)가 모델마다 달라요|라이선스/, { selector: '.license-note' })).toBeTruthy()
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
