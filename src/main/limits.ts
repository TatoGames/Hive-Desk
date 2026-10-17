/** Usage-limit messages of the AI CLIs, and when they say the limit resets. */

export interface LimitInfo {
  /** When runs can resume (ISO). A guess when the CLI did not say. */
  until: string
  /** The CLI's own words. */
  message: string
  /** true = `until` is a guess */
  guessed: boolean
}

const DEFAULT_WAIT_MIN = 60

const STRONG = [
  /usage limit (reached|exceeded|has been reached)/i,
  /hit your (usage |rate |weekly |daily )?limit/i,
  /(reached|exceeded) your (usage |rate |weekly |daily |message )?(limit|quota)/i,
  /you'?ve (hit|reached|used)[^.\n]{0,40}limit/i,
  /rate[ _-]?limit(ed| exceeded| reached)/i,
  /quota (exceeded|exhausted|reached)/i,
  /RESOURCE_EXHAUSTED/,
  /too many requests/i,
  /limit will reset/i
]

export function looksLikeLimit(text: string): boolean {
  return STRONG.some((r) => r.test(text))
}

function nextClock(h: number, m: number, now: Date): Date {
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d
}

/** Find the reset time in a message; `null` when it does not say. */
export function parseReset(text: string, now: Date = new Date()): Date | null {
  // "Claude AI usage limit reached|1760000000"
  const epoch = text.match(/limit reached\|(\d{10})/i)
  if (epoch) return new Date(Number(epoch[1]) * 1000)

  // "try again in 5 hours", "resets in 2 hours 10 minutes", "retry after 30 minutes"
  const hm = text.match(/\b(?:in|after)\s+(\d+)\s*(?:hours?|hrs?|h)\b(?:\s*(?:and\s+)?(\d+)\s*(?:minutes?|mins?|m)\b)?/i)
  if (hm) return new Date(now.getTime() + (Number(hm[1]) * 60 + Number(hm[2] ?? 0)) * 60_000)
  const mm = text.match(/\b(?:in|after)\s+(\d+)\s*(?:minutes?|mins?|m)\b/i)
  if (mm) return new Date(now.getTime() + Number(mm[1]) * 60_000)

  // "resets 3pm", "resets at 3:30 PM", "resets 15:00 (Asia/Seoul)"
  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (clock) {
    let h = Number(clock[1])
    const m = Number(clock[2] ?? 0)
    const ap = clock[3]?.toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (h <= 23 && m <= 59) return nextClock(h, m, now)
  }
  return null
}

/** Look at what a failed run printed and decide whether the usage limit is the reason. */
export function detectLimit(text: string, now: Date = new Date()): LimitInfo | null {
  if (!looksLikeLimit(text)) return null
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => looksLikeLimit(l)) ?? text.trim().slice(0, 200)
  const reset = parseReset(text, now)
  const until = reset ?? new Date(now.getTime() + DEFAULT_WAIT_MIN * 60_000)
  return { until: until.toISOString(), message: line.slice(0, 300), guessed: !reset }
}
