import type { Company, OrgUnit, Seat } from './company'
import { DEFAULT_RULES } from './company'

interface TplSeat {
  title: string
  job: string
  /** Rank by level (1 = highest) in the template's rank list. */
  rank: number
  difficulty?: 'hard' | 'routine'
  count?: number
}
interface TplUnit {
  name: string
  kind: string
  seats?: TplSeat[]
  children?: TplUnit[]
}
export interface Template {
  id: string
  name: string
  description: string
  ranks: string[]
  units: TplUnit[]
}

const exec = (ceos: boolean): TplUnit => ({
  name: '경영진',
  kind: '경영',
  seats: [
    ...(ceos
      ? [
          { title: 'CEO (제품·비전)', job: 'ceo', rank: 1 },
          { title: 'CEO (기술·실현 가능성)', job: 'ceo', rank: 1 },
          { title: 'CEO (사업·위험)', job: 'ceo', rank: 1 }
        ]
      : []),
    { title: '총괄 본부장', job: 'coo', rank: 1 }
  ]
})
const lead = (title: string, rank: number): TplSeat => ({ title, job: 'lead', rank })
const work = (title: string, job: string, rank: number, count = 1, difficulty: 'hard' | 'routine' = 'hard'): TplSeat => ({
  title,
  job,
  rank,
  count,
  difficulty
})

export const TEMPLATES: Template[] = [
  {
    id: 'game-studio',
    name: '게임 스튜디오',
    description: '기획본부 / 개발본부(클라이언트·서버) / QA실 / 사업본부',
    ranks: ['본부장', '실장', '팀장', '파트장', '사원'],
    units: [
      exec(true),
      {
        name: '기획본부',
        kind: '본부',
        seats: [lead('기획본부장', 1)],
        children: [
          { name: '시스템기획팀', kind: '팀', seats: [lead('시스템기획 팀장', 3), work('시스템 기획자', 'plan', 5, 2)] },
          { name: '레벨기획팀', kind: '팀', seats: [lead('레벨기획 팀장', 3), work('레벨 기획자', 'plan', 5, 2)] }
        ]
      },
      {
        name: '개발본부',
        kind: '본부',
        seats: [lead('개발본부장', 1)],
        children: [
          {
            name: '클라이언트팀',
            kind: '팀',
            seats: [lead('클라이언트 팀장', 3)],
            children: [
              {
                name: '게임플레이파트',
                kind: '파트',
                seats: [lead('게임플레이 파트장', 4), work('게임플레이 개발자', 'build', 5, 2), work('코드 리뷰어', 'review', 5)]
              },
              { name: 'UI파트', kind: '파트', seats: [lead('UI 파트장', 4), work('UI 개발자', 'build', 5, 2), work('UI 리뷰어', 'review', 5)] }
            ]
          },
          {
            name: '서버팀',
            kind: '팀',
            seats: [lead('서버 팀장', 3), work('서버 개발자', 'build', 5, 2), work('서버 코드 리뷰어', 'review', 5)]
          }
        ]
      },
      { name: 'QA실', kind: '실', seats: [lead('QA 실장', 2), work('QA 담당', 'qa', 5, 2, 'routine')] },
      {
        name: '사업본부',
        kind: '본부',
        seats: [lead('사업본부장', 1)],
        children: [{ name: '마케팅팀', kind: '팀', seats: [lead('마케팅 팀장', 3), work('마케팅 담당', 'ops', 5, 2, 'routine')] }]
      }
    ]
  },
  {
    id: 'startup',
    name: '소규모 스타트업',
    description: '대표 - 리드 - 멤버, 기획·개발·운영',
    ranks: ['대표', '리드', '멤버'],
    units: [
      { name: '경영', kind: '경영', seats: [{ title: '대표', job: 'ceo', rank: 1 }] },
      { name: '기획', kind: '팀', seats: [lead('기획 리드', 2), work('기획 멤버', 'plan', 3)] },
      { name: '개발', kind: '팀', seats: [lead('개발 리드', 2), work('개발 멤버', 'build', 3, 2), work('리뷰 멤버', 'review', 3)] },
      { name: '운영', kind: '팀', seats: [lead('운영 리드', 2), work('운영 멤버', 'ops', 3, 1, 'routine')] }
    ]
  },
  {
    id: 'web-service',
    name: '웹 서비스 개발사',
    description: '제품본부 / 개발본부(프론트·백엔드) / QA실',
    ranks: ['본부장', '실장', '팀장', '사원'],
    units: [
      exec(true),
      {
        name: '제품본부',
        kind: '본부',
        seats: [lead('제품본부장', 1), work('제품 기획자', 'plan', 4, 2), work('리서처', 'research', 4, 1, 'routine')]
      },
      {
        name: '개발본부',
        kind: '본부',
        seats: [lead('개발본부장', 1)],
        children: [
          { name: '프론트팀', kind: '팀', seats: [lead('프론트 팀장', 3), work('프론트 개발자', 'build', 4, 2), work('프론트 리뷰어', 'review', 4)] },
          { name: '백엔드팀', kind: '팀', seats: [lead('백엔드 팀장', 3), work('백엔드 개발자', 'build', 4, 2), work('백엔드 리뷰어', 'review', 4)] }
        ]
      },
      { name: 'QA실', kind: '실', seats: [lead('QA 실장', 2), work('QA 담당', 'qa', 4, 2, 'routine')] }
    ]
  },
  {
    id: 'team-project',
    name: '팀 프로젝트 (졸업작품·공모전)',
    description: '기획·개발·발표/문서 3팀, 2단계 직급',
    ranks: ['팀장', '팀원'],
    units: [
      { name: '기획팀', kind: '팀', seats: [lead('기획 팀장', 1), work('기획 팀원', 'plan', 2, 2)] },
      { name: '개발팀', kind: '팀', seats: [lead('개발 팀장', 1), work('개발 팀원', 'build', 2, 2), work('리뷰 팀원', 'review', 2)] },
      { name: '발표·문서팀', kind: '팀', seats: [lead('문서 팀장', 1), work('문서 팀원', 'docs', 2, 2, 'routine')] }
    ]
  },
  {
    id: 'blank',
    name: '빈 회사',
    description: '직접 구성해요',
    ranks: ['리더', '멤버'],
    units: []
  }
]

export interface Built {
  company: Company
  units: OrgUnit[]
  seats: Seat[]
}

/** Turn a template into concrete units and seats (ids are produced by `newId`). */
export function buildFromTemplate(tpl: Template, name: string, newId: () => string, now: string): Built {
  const ranks = tpl.ranks.map((r, i) => ({ id: `rank-${i + 1}`, name: r, level: i + 1 }))
  const units: OrgUnit[] = []
  const seats: Seat[] = []
  const walk = (u: TplUnit, parentId: string | null, order: number): void => {
    const unit: OrgUnit = { id: newId(), name: u.name, kind: u.kind, parentId, mission: '', folderName: '', order }
    units.push(unit)
    for (const s of u.seats ?? []) {
      for (let i = 0; i < (s.count ?? 1); i++) {
        const rank = ranks[Math.min(s.rank, ranks.length) - 1]
        seats.push({
          id: newId(),
          unitId: unit.id,
          title: (s.count ?? 1) > 1 ? `${s.title} ${i + 1}` : s.title,
          rankId: rank.id,
          job: s.job,
          difficulty: s.difficulty ?? 'hard',
          order: seats.length
        })
      }
    }
    ;(u.children ?? []).forEach((c, i) => walk(c, unit.id, i))
  }
  tpl.units.forEach((u, i) => walk(u, null, i))
  return {
    company: { name, templateId: tpl.id, ranks, rules: { ...DEFAULT_RULES }, bigJobRuns: 20, createdAt: now },
    units,
    seats
  }
}
