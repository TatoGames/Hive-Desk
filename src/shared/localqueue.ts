/**
 * A3: sharing one model on this PC between employees (queue limits) and telling the reasons a local run
 * broke apart (so "out of memory" is never retried in a loop). Pure: no files, no network.
 */

export const LOCAL_QUEUE = {
  /** Runs of one model (endpoint + model name) at the same time. A small PC holds one model run at a time. */
  perModel: 1,
  /** More than this many waiting for one model: it is not offered as a hand-over target (A1). */
  maxWaiting: 2,
  /** A task waits at most this long for its turn, then a person / another employee decides. */
  maxWaitMinutes: 20,
  /** A dropped connection is tried again this many times only. */
  disconnectRetries: 2,
  /** Wait before such a retry. */
  retryDelayMs: 3000
} as const

/** A chat turn on a model that a task is using (or waiting for): chats are refused, they never wait behind tasks. */
export const LOCAL_BUSY_FOR_CHAT = '이 모델을 업무가 쓰고 있어요. 업무가 끝나면 보내 주세요.'

export type LocalErrorKind = 'memory' | 'load' | 'disconnect' | 'timeout' | 'other'

export const LOCAL_ERROR_LABEL: Record<LocalErrorKind, string> = {
  memory: 'PC 메모리 부족',
  load: '모델 불러오기 실패',
  disconnect: '연결 끊김',
  timeout: '시간 초과',
  other: '알 수 없는 오류'
}

const RULES: { kind: LocalErrorKind; re: RegExp }[] = [
  // the app's own "says nothing for a long time" message mentions memory, but it is a time-out
  { kind: 'timeout', re: /한참 답이 없|timed? ?out|timeout|deadline|ETIMEDOUT|시간 안에|시간이 지나|답이 없어요/i },
  {
    kind: 'memory',
    re: /out of memory|\boom\b|not enough (?:system )?memory|insufficient (?:system )?memory|requires more (?:system )?memory|failed to allocate|cuda error.*memory|cudamalloc|vram|메모리(?:가)? (?:부족|모자)|memory (?:allocation|alloc) fail|unable to allocate|std::bad_alloc|could not allocate/i
  },
  {
    kind: 'load',
    re: /failed to load|unable to load|error loading model|load(?:ing)? (?:the )?model.*(?:fail|error)|model runner has unexpectedly stopped|llama runner (?:process )?(?:has terminated|exited|error)|runner process|unsupported model|invalid model|corrupt|설치돼 있지 않|모델을 (?:불러|로드)|불러오지 못/i
  },
  {
    kind: 'disconnect',
    re: /끊겼어요|연결할 수 없어요|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|terminated|connection (?:refused|reset|closed|lost)|aborted by peer|빈 답/i
  }
]

/** Which kind of problem a local model's error message tells about. */
export function classifyLocalError(message: string): LocalErrorKind {
  const m = message ?? ''
  for (const r of RULES) if (r.re.test(m)) return r.kind
  return 'other'
}

export interface LocalErrorPolicy {
  /** Ask the same model again (limited). */
  retries: number
  /** Give the task to a person or another employee. */
  passOn: boolean
}

/** What to do about each kind. Memory and load problems repeat for sure: never retried. */
export function localErrorPolicy(kind: LocalErrorKind): LocalErrorPolicy {
  switch (kind) {
    case 'memory':
    case 'load':
      return { retries: 0, passOn: true }
    case 'disconnect':
      return { retries: LOCAL_QUEUE.disconnectRetries, passOn: false }
    default:
      return { retries: 0, passOn: false }
  }
}

/** "로컬 대기 중 (2번째)" */
export function queueLine(position: number): string {
  return `로컬 대기 중 (${position}번째)`
}
