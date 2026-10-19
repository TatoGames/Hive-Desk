// @vitest-environment jsdom
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, ready, type Ui } from './harness'
import { OllamaEngine } from '../../src/main/ollamaEngine'
import { FAKE_OLLAMA, fakeDownloads, makeTgz, sha256 } from '../ollama-fixtures'

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

describe('J3 UI: 태그, 필터, 정렬', () => {
  it('tags show, filters narrow the list, size sort puts the small first, and models without tool calls say so', async () => {
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
      fireEvent.change(screen.getByPlaceholderText(/주소/), { target: { value: addr } })
      fireEvent.click(screen.getByRole('button', { name: '연결' }))
      await waitFor(() => expect(screen.getByRole('button', { name: '설치됨' })).toBeTruthy())
      const cands = (): string[] => Array.from(document.querySelectorAll('.local-cand > b')).map((e) => e.textContent ?? '')
      expect(cands()).toContain('Llama 3.2 3B')
      expect(screen.getAllByText('라이선스 확인 전').length).toBeGreaterThan(3)
      expect(screen.getAllByText(/쉬운 일만 범위에서만 직원으로 쓸 수 있어요/).length).toBeGreaterThan(0)
      expect(screen.getByText(/추천 후보/, { selector: '.local-filters div' })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: '설치됨' }))
      expect(cands()).toEqual(['Qwen2.5 Coder 7B'])
      fireEvent.click(screen.getByRole('button', { name: '설치됨' }))
      fireEvent.click(screen.getByRole('button', { name: '코딩' }))
      expect(cands().every((n) => /Coder|Qwen3|Devstral|Mistral|Phi-4|gpt-oss/.test(n))).toBe(true)
      expect(cands()).not.toContain('Llama 3.2 3B')
      fireEvent.click(screen.getByRole('button', { name: '코딩' }))

      fireEvent.change(screen.getByLabelText(/정렬/), { target: { value: 'size' } })
      expect(cands()[0]).toMatch(/3B|4B|3.8B/) // the small ones first
      expect(cands()[cands().length - 1]).toMatch(/Coder 32B|30B/) // the biggest last
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})

describe('v6 UI: HiveDesk 전용 Ollama', () => {
  const key = `${process.platform}-${process.arch}`
  const swap = (eng: import('../../src/main/engine').Engine, dir: string, url: string, sha: string | undefined): void => {
    Object.defineProperty(eng, 'ollama', {
      value: new OllamaEngine({
        homeDir: () => `${dir}/HiveDesk`,
        manifest: { version: '1.2.3', platforms: { [key]: { url, sha256: sha, format: 'tgz', exe: 'ollama', sizeBytes: 5_000_000 } } },
        changed: () => (eng as unknown as { emit: (e: { type: string }) => void }).emit({ type: 'local' }),
        connect: (u) => eng.local.ensure('HiveDesk Ollama', u),
        allowUrl: (u) => u.hostname === '127.0.0.1',
        defaultPort: 21434
      })
    })
  }

  it('an unverified download (no sha256) leaves the install button off and says why', async () => {
    ui = await mountApp((eng, dir) => {
      ready(eng, dir)
      eng.saveSettings({ uiMode: 'basic' })
      swap(eng, dir, 'https://example.invalid/x.tgz', undefined)
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'AI 연결' })[0])
    await ui.refresh()
    const btn = (await screen.findByRole('button', { name: /HiveDesk에 Ollama 설치하기/ })) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByText(/sha256 값이 확인되지 않아서/)).toBeTruthy()
  })

  it.skipIf(process.platform === 'win32')('install, start, and the connection appears by itself', async () => {
    const fake = await fakeDownloads()
    const tgz = makeTgz([{ name: 'ollama', data: FAKE_OLLAMA(), mode: 0o755 }])
    fake.files.set('/file', tgz)
    try {
      ui = await mountApp((eng, dir) => {
        ready(eng, dir)
        eng.saveSettings({ uiMode: 'basic' })
        swap(eng, dir, fake.base + '/file', sha256(tgz))
      })
      fireEvent.click(screen.getAllByRole('button', { name: 'AI 연결' })[0])
      await ui.refresh()
      fireEvent.click(await screen.findByRole('button', { name: /HiveDesk에 Ollama 설치하기/ }))
      // the test engine has no event channel to the page: nudge it to refresh
      await waitFor(async () => {
        await ui!.refresh()
        expect(screen.getByRole('button', { name: '시작' })).toBeTruthy()
      }, { timeout: 8000 })
      const start = screen.getByRole('button', { name: '시작' })
      expect(screen.getByText(/설치했어요/)).toBeTruthy()
      fireEvent.click(start)
      await waitFor(async () => {
        await ui!.refresh()
        expect(screen.getByText(/켜져 있어요 · 포트/)).toBeTruthy()
        expect(screen.getByText('HiveDesk Ollama')).toBeTruthy()
      }, { timeout: 10000 })
      expect(ui.eng.local.endpoints().filter((e) => e.name === 'HiveDesk Ollama')).toHaveLength(1)
    } finally {
      ui?.eng.ollama.shutdown()
      fake.close()
    }
  })
})
