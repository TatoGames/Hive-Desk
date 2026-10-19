import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOTE_NOTICE, endpointProblem, endpointScope } from '../src/shared/localai'
import { Engine } from '../src/main/engine'
import { explainFetchError } from '../src/main/openai'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-a5-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

describe('A5: other computers', () => {
  it('tells this PC, the home network and the internet apart', () => {
    expect(endpointScope('http://127.0.0.1:11434')).toBe('this-pc')
    for (const u of ['http://192.168.0.5:11434', 'http://10.1.2.3:1234', 'http://172.16.0.9:1', 'http://172.31.255.1:1', 'http://100.101.1.1:11434', 'http://mypc.local:11434', 'http://gamingpc:11434']) expect(endpointScope(u), u).toBe('lan')
    for (const u of ['http://172.32.0.1:1', 'http://8.8.8.8:11434', 'https://ai.example.com', 'http://100.128.0.1:1']) expect(endpointScope(u), u).toBe('internet')
  })
  it('does not connect an address on the internet without https and a token', () => {
    expect(endpointProblem('http://ai.example.com:11434', true)).toContain('https')
    expect(endpointProblem('https://ai.example.com', false)).toContain('토큰')
    expect(endpointProblem('https://ai.example.com', true)).toBeUndefined()
    expect(endpointProblem('http://192.168.0.5:11434', false)).toBeUndefined()
    expect(endpointProblem('http://127.0.0.1:11434', false)).toBeUndefined()
  })
  it('explains a computer that does not answer in its own words', () => {
    const e = (code: string): Error => Object.assign(new Error('fetch failed'), { cause: { code } })
    expect(explainFetchError(e('ETIMEDOUT'), 'http://192.168.0.5:11434')).toContain('꺼져 있거나 절전')
    expect(explainFetchError(e('ECONNREFUSED'), 'http://192.168.0.5:11434')).toContain('OLLAMA_HOST')
    expect(explainFetchError(e('ECONNREFUSED'), 'http://127.0.0.1:11434')).toContain('Ollama가 켜져 있나요')
  })
  it('asks before the first connection to another computer, and never reaches out before that', async () => {
    const eng = new Engine(join(dir, 'c.json'), () => {}, async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }), dir)
    eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws') })
    await expect(eng.localAdd({ url: '192.168.0.5:11434' })).rejects.toThrow(REMOTE_NOTICE)
    await expect(eng.localAdd({ url: 'http://8.8.8.8:11434', acceptRemote: true })).rejects.toThrow('https')
  })
})
