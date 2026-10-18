import { describe, expect, it } from 'vitest'
import { BubbleHold, bubbleFor, bubbleFromActivity, commandKind, fileName } from '../src/shared/bubble'
import type { Task } from '../src/shared/types'

describe('7-4: speech bubbles from what the CLI already reported', () => {
  it('file activities name only the file', () => {
    expect(fileName('C:\\proj\\src\\map.ts')).toBe('map.ts')
    expect(bubbleFromActivity('read', '파일 읽음: /home/me/secret-project/src/map.ts')).toBe('map.ts 파일 살펴보는 중…')
    expect(bubbleFromActivity('edit', '수정: src/game/player.ts +3 −1')).toBe('player.ts 고치는 중…')
    expect(bubbleFromActivity('write', '파일 작성: docs/plan.md +40')).toBe('plan.md 만드는 중…')
  })

  it('a command is shown only by its kind, never its text', () => {
    expect(commandKind('npm test -- --run')).toBe('테스트 돌려 보는 중…')
    expect(commandKind('pytest -q')).toBe('테스트 돌려 보는 중…')
    expect(commandKind('pnpm add lodash')).toBe('패키지 설치 중…')
    expect(commandKind('git commit -m x')).toBe('변경 정리 중…')
    expect(commandKind('npx tsc --noEmit')).toBe('빌드하는 중…')
    const secret = bubbleFromActivity('command', '명령: curl -H "Authorization: Bearer sk-abc123" https://api.x.com')
    expect(secret).toBe('명령 실행 중…')
    expect(secret).not.toContain('sk-abc123')
  })

  it('web, apps, plan progress, errors, the report and plain words', () => {
    expect(bubbleFromActivity('search', '웹: https://docs.godotengine.org')).toBe('자료 찾아보는 중…')
    expect(bubbleFromActivity('search', '검색: TODO (src)')).toBe('코드에서 찾아보는 중…')
    expect(bubbleFromActivity('tool', '외부 앱 도구: post_message')).toBe('다른 앱으로 작업하는 중…')
    expect(bubbleFromActivity('plan', '2/5 단계 완료: 적 넣기')).toBe('2/5단계 끝냈어요')
    expect(bubbleFromActivity('error', '도구 오류: ENOENT')).toBe('막힌 곳을 살펴보는 중…')
    expect(bubbleFromActivity('message', '[[DID: 했어요]]')).toBe('보고서 쓰는 중…')
    const long = bubbleFromActivity('message', '먼저 맵 생성 코드를 살펴보고 방과 복도를 만드는 함수를 고치겠습니다. 그다음 테스트를 돌릴게요.')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long).not.toContain('테스트를')
  })

  it('a state that stops the work wins; a fresh hand-over says who it came from', () => {
    const nameOf = (id: string): string => ({ a: '민수', b: '지아' })[id] ?? id
    expect(bubbleFor({ state: 'waiting-approval', nameOf }).text).toContain('결재 요청')
    expect(bubbleFor({ state: 'limit', nameOf, limitUntil: '2026-10-18T06:20:00Z' }).tone).toBe('limit')
    const t = { assignee: 'b', handoffs: [{ from: 'a', to: 'b', at: new Date().toISOString() }] } as unknown as Task
    expect(bubbleFor({ state: 'working', task: t, nameOf, last: '수정: x.ts' }).text).toBe('민수의 일을 이어받았어요')
    const old = { ...t, handoffs: [{ from: 'a', to: 'b', at: '2020-01-01T00:00:00Z' }] } as unknown as Task
    expect(bubbleFor({ state: 'working', task: old, nameOf, lastKind: 'edit', last: '수정: x.ts' }).text).toBe('x.ts 고치는 중…')
    expect(bubbleFor({ state: 'reviewing', nameOf }).text).toBe('결과 검토하는 중…')
  })

  it('a bubble stays at least 1.5 s; what came in between is merged; the same again becomes "계속 …"', () => {
    const h = new BubbleHold(1500)
    expect(h.next('a', 'map.ts 고치는 중…', 0)).toBe('map.ts 고치는 중…')
    expect(h.next('a', '테스트 돌려 보는 중…', 500)).toBe('map.ts 고치는 중…')
    expect(h.next('a', '패키지 설치 중…', 900)).toBe('map.ts 고치는 중…')
    expect(h.waiting('a')).toBe(true)
    // only the latest of the merged ones is shown
    expect(h.next('a', '패키지 설치 중…', 1600)).toBe('패키지 설치 중…')
    expect(h.next('a', '패키지 설치 중…', 2000)).toBe('패키지 설치 중…')
    expect(h.next('a', '패키지 설치 중…', 5000)).toBe('계속 패키지 설치 중…')
  })
})
