import type { FailureKind } from '../shared/types'

export interface Failure {
  kind: FailureKind
  /** One plain sentence: what went wrong. */
  title: string
  /** What the human can do about it. */
  hint: string
}

const RULES: { kind: FailureKind; re: RegExp; title: string; hint: string }[] = [
  {
    kind: 'limit',
    re: /usage limit|hit your (usage |rate )?limit|rate[ _-]?limit(ed| exceeded)|quota (exceeded|exhausted)|too many requests|resource_exhausted/i,
    title: '사용량 한도에 도달했어요.',
    hint: '한도가 초기화될 때까지 기다리거나, 다른 AI 에이전트로 맡겨 보세요.'
  },
  {
    kind: 'login',
    re: /not logged in|please (run )?\/?login|log ?in required|sign ?in required|authentication (failed|error|required)|invalid (api key|token|credentials)|unauthori[sz]ed|\b401\b|token (has )?expired|session expired|oauth.*expired/i,
    title: '로그인이 필요하거나 만료됐어요.',
    hint: '에이전트 화면에서 이 AI의 [로그인]을 다시 한 뒤 [연결 확인]을 눌러 보세요.'
  },
  {
    kind: 'permission',
    re: /permission denied|eacces|eperm|operation not permitted|requires? (user )?permission|was denied|auto-denied|not allowed|read-only file system/i,
    title: '권한 때문에 막혔어요.',
    hint: '태스크의 권한 단계를 올리거나(읽기 → 수정 → 명령 실행) 필요한 폴더를 참고 폴더로 추가해 보세요.'
  },
  {
    kind: 'not_found',
    re: /command not found|enoent|is not recognized|명령을 찾을 수 없|no such file or directory: ['"]?(claude|codex|agy|gemini)/i,
    title: 'AI 프로그램을 찾을 수 없어요.',
    hint: '에이전트 화면에서 설치 상태를 확인하고, 없으면 [설치]를 눌러 주세요.'
  },
  {
    kind: 'network',
    re: /econnrefused|econnreset|etimedout|enotfound|eai_again|network (is )?(unreachable|error)|fetch failed|getaddrinfo|socket hang up|ssl|certificate|proxy error|connection (reset|refused|timed out)/i,
    title: '인터넷 연결에 문제가 있어요.',
    hint: '네트워크(와이파이, VPN, 회사 방화벽)를 확인한 뒤 다시 실행해 보세요.'
  }
]

/** Turn a CLI's raw failure text into a short Korean explanation with a next step. */
export function classifyFailure(text: string, opts: { timeout?: 'idle' | 'total'; minutes?: number } = {}): Failure {
  const m = opts.minutes
  if (opts.timeout === 'idle') {
    return {
      kind: 'timeout',
      title: m ? `${m}분 동안 아무 반응이 없어서 중지했어요.` : '한동안 아무 반응이 없어서 중지했어요.',
      hint: '에이전트 설정의 "무응답 제한(분)"을 늘리거나, 작업을 더 작게 나눠 보세요.'
    }
  }
  if (opts.timeout === 'total') {
    return {
      kind: 'timeout',
      title: m ? `총 시간 상한 ${m}분을 넘겨서 중지했어요.` : '정해 둔 총 시간 상한을 넘겨서 중지했어요.',
      hint: '태스크의 "총 시간 상한"을 늘리거나 작업을 나눠 보세요.'
    }
  }
  for (const r of RULES) if (r.re.test(text)) return { kind: r.kind, title: r.title, hint: r.hint }
  return {
    kind: 'unknown',
    title: 'AI 프로그램이 오류로 끝났어요.',
    hint: '아래 원문과 "실행 기록 → 응답"을 확인해 보세요. 같은 문제가 반복되면 에이전트 연결 확인을 다시 해 보세요.'
  }
}

/** The message stored on the task: friendly part first, the CLI's own words below it. */
export function failureMessage(f: Failure, raw: string): string {
  const detail = raw.trim()
  return `${f.title} ${f.hint}` + (detail ? `\n\n— 원문 —\n${detail}` : '')
}
