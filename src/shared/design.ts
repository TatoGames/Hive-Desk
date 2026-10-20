/**
 * Design directions: so every project does not come out as the same white-cards-and-emoji screen, a project that has
 * none gets one (concept, colours, type, layout, things to avoid) the first time a screen-related task of it runs.
 * It is picked from the project's own words and never repeats one a sibling project of the company already uses.
 */
export interface DesignDirection {
  key: string
  name: string
  /** words in the project text that make this direction fit */
  tags: string[]
  concept: string
  colors: string
  type: string
  layout: string
  avoid: string
}

export const DESIGN_DIRECTIONS: DesignDirection[] = [
  { key: 'retro-print', name: '낡은 인쇄 포스터', tags: ['카페', '가게', '골목', '식당', '레트로', '장사', '타이쿤'], concept: '오래된 종이 포스터와 활판 인쇄 느낌. 약간 어긋난 인쇄 질감과 굵은 제목.', colors: '배경 #f1e6d0(누런 종이), 글자 #2b2118, 포인트 #c0392b와 #2f5d62', type: '굵은 세리프 제목 + 얇은 본문 세리프, 제목은 크게 위로 정렬', layout: '신문처럼 칸을 나눈 단 구성, 가는 실선으로 구역을 가르기', avoid: '둥근 카드, 그림자, 이모지 아이콘, 파란 버튼' },
  { key: 'neon-arcade', name: '네온 아케이드', tags: ['아케이드', '슈팅', '액션', '레이싱', '우주', '속도', '타자'], concept: '어두운 오락실 화면. 빛나는 선과 점수판.', colors: '배경 #0b0b1a, 글자 #e8e8ff, 포인트 #ff2e97, #00e5ff, #fff200', type: '굵은 고정폭 또는 픽셀 느낌 글꼴, 숫자는 크게', layout: '화면 한가운데 게임판, 위에 점수, 아래에 조작 안내', avoid: '밝은 배경, 부드러운 파스텔, 둥근 카드 목록' },
  { key: 'watercolor-note', name: '수채화 노트', tags: ['정원', '식물', '온실', '요리', '동물', '힐링', '농장', '평화'], concept: '손으로 그린 수채화 노트. 번진 색과 손글씨.', colors: '배경 #fbf7ef, 글자 #3d3a35, 포인트 #7fb7a4, #e6a57e, #b7a1d8', type: '손글씨 느낌의 제목 + 읽기 편한 산세리프 본문', layout: '종이 위에 붙인 스티커처럼 약간 기울어진 요소', avoid: '직선 격자, 진한 검정 테두리, 금속 질감' },
  { key: 'blueprint', name: '청사진 설계도', tags: ['공장', '건설', '도시', '기계', '자동화', '로봇', '연구', '시뮬레이션'], concept: '설계 도면처럼 격자와 치수선이 있는 화면.', colors: '배경 #0e3b66, 선 #cfe8ff, 포인트 #ffd23f', type: '가는 고정폭 글꼴, 모든 글자는 대문자와 숫자 위주', layout: '격자 위에 구역을 놓고 치수 표시처럼 숫자를 붙이기', avoid: '채워진 색 면, 그라데이션, 이모지' },
  { key: 'paper-cut', name: '종이 오리기 입체', tags: ['동화', '모험', '퍼즐', '아이', '캐릭터', '마을', '이야기'], concept: '색종이를 오려 겹친 입체 무대.', colors: '배경 #ffe3b3, 겹치는 색 #ef476f, #06d6a0, #118ab2, #ffd166', type: '둥글고 통통한 제목 글꼴, 본문은 단순한 산세리프', layout: '앞뒤로 겹친 층, 층마다 부드러운 그림자', avoid: '가는 선 장식, 어두운 배경, 격자 표' },
  { key: 'terminal', name: '터미널 화면', tags: ['해킹', '코드', '개발', '로그', '도구', '데이터', '암호', '추리'], concept: '검은 터미널과 명령줄.', colors: '배경 #0c0f0c, 글자 #b7f7b0, 포인트 #f7d774, 경고 #ff6b6b', type: '고정폭 글꼴 하나만 사용', layout: '왼쪽 위부터 줄 단위로 출력하고 입력줄을 맨 아래에', avoid: '이미지, 둥근 모서리, 색이 많은 버튼' },
  { key: 'swiss-mono', name: '스위스 모노크롬', tags: ['비즈니스', '경영', '금융', '회계', '관리', '대시보드', '분석', '앱'], concept: '여백이 넓은 스위스 그리드 디자인.', colors: '배경 #ffffff, 글자 #111111, 포인트는 #e10600 하나만', type: '굵은 산세리프, 크기 차이로만 위계 표현', layout: '12칸 격자에 정렬, 큰 숫자와 작은 설명', avoid: '그림자, 그라데이션, 두 가지 이상의 포인트 색' },
  { key: 'dusk-gradient', name: '노을 그라데이션', tags: ['여행', '음악', '밤', '감성', '리듬', '바다', '우주', '산책'], concept: '해질녘 하늘색이 흐르는 부드러운 화면.', colors: '배경 #2b1b4a에서 #f2709c로, 글자 #fff4e6, 포인트 #ffb86b', type: '가는 둥근 산세리프, 글자 간격을 넓게', layout: '큰 유리 같은 반투명 패널을 겹치기', avoid: '진한 검정 테두리, 표 형태, 빽빽한 정보' },
  { key: 'pixel-8bit', name: '8비트 픽셀', tags: ['도트', '픽셀', 'rpg', '던전', '로그라이크', '전투', '몬스터', '모험'], concept: '옛 콘솔 게임 화면.', colors: '16색 팔레트: #1a1c2c, #5d275d, #b13e53, #ef7d57, #ffcd75, #a7f070, #38b764, #3b5dc9, #f4f4f4', type: '픽셀 글꼴, 글자는 정수 크기로', layout: '화면을 타일 격자로 나누고 상태창은 테두리 상자', avoid: '부드러운 곡선, 그림자, 매끄러운 그라데이션' },
  { key: 'brutalist', name: '거친 브루탈리즘', tags: ['실험', '도발', '코미디', '밈', '반전', '펑크', '파티'], concept: '꾸미지 않은 거친 웹 디자인. 큼직하고 어색한 배치.', colors: '배경 #f4f1e8, 글자 #000000, 포인트 #ff4d00과 #3a00ff를 번갈아', type: '아주 크고 굵은 글자, 일부러 줄바꿈이 어긋나게', layout: '두꺼운 검정 테두리 상자를 겹치고 약간 비껴 놓기', avoid: '부드러운 그림자, 파스텔, 둥근 모서리' },
  { key: 'glass-lab', name: '유리 실험실', tags: ['과학', '실험', '화학', '미래', 'ai', '분석', '연구', '시뮬레이션'], concept: '깨끗한 실험실 유리와 가는 선.', colors: '배경 #eef3f7, 글자 #1f2d3a, 포인트 #00a6a6와 #5b6cff', type: '가늘고 깔끔한 산세리프, 숫자는 고정폭', layout: '반투명 패널과 가는 눈금선, 데이터는 작은 그래프로', avoid: '진한 색 면, 이모지, 거친 질감' },
  { key: 'woodcut', name: '목판화', tags: ['전통', '역사', '전쟁', '신화', '탐험', '고전', '한국'], concept: '목판화처럼 굵은 선과 두 세 가지 색.', colors: '배경 #efe3c8, 선 #1d1a16, 포인트 #a3321f', type: '붓글씨 느낌의 제목 + 단단한 세리프 본문', layout: '굵은 테두리로 감싼 장면 패널, 위아래 장식 띠', avoid: '파란색, 반투명, 매끄러운 그림자' }
]

const MARK = '[디자인 지침:'
const MARK_RE = /\[디자인 지침:\s*([a-z0-9-]+)\]/g

/** A briefing that already has design rules (ours, or the person's own wording) is left alone. */
export function hasDesign(briefing: string): boolean {
  return briefing.includes(MARK) || /디자인\s*(지침|가이드)|design\s*(guide|direction)/i.test(briefing)
}

/** Does this task touch the screen? (its words, or the employee's job) */
export function looksVisual(text: string): boolean {
  return /화면|UI\b|UX\b|디자인|프론트|renderer|css|스타일|레이아웃|웹\s*페이지|웹페이지|인터페이스|HUD|html|게임/i.test(text)
}

export function usedDesigns(briefings: string[]): string[] {
  const out: string[] = []
  for (const b of briefings) for (const m of b.matchAll(MARK_RE)) out.push(m[1])
  return out
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** The direction that fits the project's words best among the ones its siblings do not use (ties: stable by the project name). */
export function pickDesign(project: { name: string; description?: string; briefing?: string }, used: string[], salt = ''): DesignDirection {
  const text = `${project.name} ${project.description ?? ''} ${project.briefing ?? ''}`.toLowerCase()
  const free = DESIGN_DIRECTIONS.filter((d) => !used.includes(d.key))
  const pool = free.length ? free : DESIGN_DIRECTIONS
  const score = (d: DesignDirection): number => d.tags.filter((t) => text.includes(t.toLowerCase())).length * 100 + (hash(d.key + project.name + salt) % 100)
  return [...pool].sort((a, b) => score(b) - score(a))[0]
}

export function designBlock(d: DesignDirection): string {
  return [
    `${MARK} ${d.key}] ${d.name}`,
    `- 콘셉트: ${d.concept}`,
    `- 색: ${d.colors}`,
    `- 글꼴: ${d.type}`,
    `- 구성: ${d.layout}`,
    `- 피할 것: ${d.avoid}`,
    '- 모든 화면 담당은 이 지침을 따르세요. 다른 프로젝트와 비슷해 보이면 안 돼요.'
  ].join('\n')
}
