/** v5 D5: the work-status floor is laid out in areas by job, like desks grouped by department. */
export interface Zone {
  id: string
  label: string
  jobs: string[]
}

export const ZONES: Zone[] = [
  { id: 'mgmt', label: '경영·관리', jobs: ['ceo', 'coo', 'lead'] },
  { id: 'make', label: '기획·구현', jobs: ['plan', 'build'] },
  { id: 'check', label: '검토·검수', jobs: ['review', 'qa'] },
  { id: 'support', label: '문서·리서치·운영', jobs: ['docs', 'research', 'ops'] },
  { id: 'other', label: '기타', jobs: [] }
]

export function zoneOf(job?: string): Zone {
  return ZONES.find((z) => job && z.jobs.includes(job)) ?? ZONES[ZONES.length - 1]
}

/** People grouped by area in floor order; empty areas are left out. Inside an area the order the list came in is kept. */
export function groupByZone<T extends { job?: string }>(people: T[]): { zone: Zone; people: T[] }[] {
  const by = new Map<string, T[]>()
  for (const p of people) {
    const z = zoneOf(p.job).id
    by.set(z, [...(by.get(z) ?? []), p])
  }
  return ZONES.filter((z) => by.has(z.id)).map((zone) => ({ zone, people: by.get(zone.id)! }))
}
