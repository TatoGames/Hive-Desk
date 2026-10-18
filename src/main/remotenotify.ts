/** Phone notifications through a Discord webhook or a Telegram bot (both optional, set in settings). */
export interface RemoteNotifyConfig {
  discordWebhook?: string
  telegram?: { token: string; chatId: string }
}

export interface RemoteRequest {
  url: string
  body: string
}

/** The HTTP requests to send for one notification (none when nothing is configured or the address is not https). */
export function remoteRequests(cfg: RemoteNotifyConfig, title: string, body: string): RemoteRequest[] {
  const out: RemoteRequest[] = []
  const text = `${title}\n${body}`.slice(0, 1800)
  const d = cfg.discordWebhook?.trim()
  if (d && /^https:\/\/(discord(app)?\.com)\/api\/webhooks\//.test(d)) out.push({ url: d, body: JSON.stringify({ content: `**HiveDesk** · ${text}` }) })
  const t = cfg.telegram
  if (t?.token && t.chatId && /^[\w:-]+$/.test(t.token)) {
    out.push({ url: `https://api.telegram.org/bot${t.token}/sendMessage`, body: JSON.stringify({ chat_id: t.chatId, text: `HiveDesk · ${text}` }) })
  }
  return out
}

export async function sendRemote(cfg: RemoteNotifyConfig, title: string, body: string, post: (r: RemoteRequest) => Promise<unknown> = defaultPost): Promise<void> {
  for (const r of remoteRequests(cfg, title, body)) {
    try {
      await post(r)
    } catch {
      /* a phone message that does not arrive must never break the app */
    }
  }
}

const defaultPost = (r: RemoteRequest): Promise<unknown> =>
  fetch(r.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: r.body, signal: AbortSignal.timeout(8000) })
