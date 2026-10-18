import { describe, expect, it } from 'vitest'
import { remoteRequests, sendRemote } from '../src/main/remotenotify'

describe('6-0.7: phone notifications', () => {
  it('sends nothing when nothing is configured', () => {
    expect(remoteRequests({}, '제목', '내용')).toEqual([])
  })
  it('builds a Discord and a Telegram request', () => {
    const r = remoteRequests({ discordWebhook: 'https://discord.com/api/webhooks/1/x', telegram: { token: '123:abc', chatId: '9' } }, '결재', '확인해 주세요')
    expect(r).toHaveLength(2)
    expect(r[0].body).toContain('확인해 주세요')
    expect(r[1].url).toContain('/bot123:abc/sendMessage')
  })
  it('refuses addresses that are not the real services', () => {
    expect(remoteRequests({ discordWebhook: 'https://evil.example/api/webhooks/1' }, 'a', 'b')).toEqual([])
    expect(remoteRequests({ telegram: { token: 'a/../b', chatId: '1' } }, 'a', 'b')).toEqual([])
  })
  it('a failing post never throws', async () => {
    await expect(sendRemote({ discordWebhook: 'https://discord.com/api/webhooks/1/x' }, 'a', 'b', async () => { throw new Error('x') })).resolves.toBeUndefined()
  })
})
