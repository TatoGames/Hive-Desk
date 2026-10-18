import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner, RunResult } from '../src/main/adapters'
import { Engine } from '../src/main/engine'
import {
  aptitudeBoard,
  recommendReassignments,
  scoreOf,
  type AptitudeRecord
} from '../src/shared/aptitude'
import {
  DEFAULT_RULES,
  isModelEntry,
  mergeCatalog,
  resolveModelArg,
  type ModelEntry,
  type Seat
} from '../src/shared/company'
import DEFAULT_MODELS from '../src/shared/models.default.json'
import { autoPlace, checkPlacement, recommendTier, type PlacementInput } from '../src/shared/placement'
import { TEMPLATES, buildFromTemplate } from '../src/shared/templates'

const CATALOG = DEFAULT_MODELS as ModelEntry[]
const CLAUDE_ONLY = CATALOG.filter((m) => m.adapter === 'claude')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivedesk-s2c-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

let n = 0
const id = (): string => 'id' + ++n
const REPORT = '[[DID: d]]\n[[FILES: none]]\n[[VERIFY: v]]\n[[RISK: none]]\n[[NEXT: none]]'
const ok = (stdout = 'OK\n' + REPORT): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false })

function engine(runner: Runner = async () => ok()): Engine {
  const eng = new Engine(join(dir, 'config.json'), () => {}, runner, dir)
  eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), humanReview: 'off' })
  eng.watchMs = 30
  return eng
}
function folder(name = 'w'): string {
  const w = join(dir, name)
  mkdirSync(w, { recursive: true })
  return w
}

describe('model catalog', () => {
  it('the bundled catalog is valid and has the Claude, OpenAI and Google models', () => {
    expect(CATALOG.every(isModelEntry)).toBe(true)
    expect(new Set(CATALOG.map((m) => m.id)).size).toBe(CATALOG.length)
    const names = CATALOG.filter((m) => m.company === 'Anthropic').map((m) => m.family)
    expect(names).toEqual(['Fable', 'Opus', 'Sonnet', 'Haiku'])
    expect(CATALOG.some((m) => m.company === 'OpenAI' && m.adapter === 'codex')).toBe(true)
    expect(CATALOG.some((m) => m.company === 'Google' && m.adapter === 'agy')).toBe(true)
    for (const tier of ['top', 'balanced', 'light'])
      expect(CATALOG.some((m) => m.tier === tier)).toBe(true)
  })

  it('alias follows the family, pinned is exact; no alias falls back to the exact id', () => {
    const sonnet = CATALOG.find((m) => m.id === 'claude-sonnet-5-5')!
    expect(resolveModelArg(sonnet, 'alias')).toBe('sonnet')
    expect(resolveModelArg(sonnet, 'pinned')).toBe('claude-sonnet-5-5')
    const fable = CATALOG.find((m) => m.id === 'claude-fable-5-1')!
    expect(resolveModelArg(fable, 'alias')).toBe('claude-fable-5-1')
  })

  it('a user entry with the same id replaces the default; broken entries are ignored', () => {
    const mine: ModelEntry = { ...CATALOG[0], version: '9', cliArg: 'x' }
    const merged = mergeCatalog(CATALOG, [mine, { id: 'bad' } as ModelEntry])
    expect(merged.find((m) => m.id === CATALOG[0].id)?.version).toBe('9')
    expect(merged.find((m) => m.id === CATALOG[0].id)?.custom).toBe(true)
    expect(merged.some((m) => m.id === 'bad')).toBe(false)
    expect(merged).toHaveLength(CATALOG.length)
  })
})

describe('templates', () => {
  for (const tpl of TEMPLATES) {
    it(`${tpl.name}: units, ranks and seats are consistent`, () => {
      const b = buildFromTemplate(tpl, 'X', id, '2026-01-01')
      const unitIds = new Set(b.units.map((u) => u.id))
      const rankIds = new Set(b.company.ranks.map((r) => r.id))
      expect(b.company.ranks.map((r) => r.level)).toEqual(tpl.ranks.map((_, i) => i + 1))
      for (const u of b.units) expect(u.parentId === null || unitIds.has(u.parentId)).toBe(true)
      for (const s of b.seats) {
        expect(unitIds.has(s.unitId)).toBe(true)
        expect(rankIds.has(s.rankId)).toBe(true)
      }
      if (tpl.id === 'blank') expect(b.units).toEqual([])
      else expect(b.seats.length).toBeGreaterThan(3)
    })
  }

  it('the game studio has the structure of the design doc', () => {
    const b = buildFromTemplate(TEMPLATES.find((t) => t.id === 'game-studio')!, 'S', id, '')
    const names = b.units.map((u) => u.name)
    for (const x of ['기획본부', '시스템기획팀', '레벨기획팀', '개발본부', '클라이언트팀', '게임플레이파트', 'UI파트', '서버팀', 'QA실', '사업본부', '마케팅팀'])
      expect(names).toContain(x)
    expect(b.seats.filter((s) => s.job === 'ceo')).toHaveLength(3)
    expect(b.seats.filter((s) => s.job === 'coo')).toHaveLength(1)
    const part = b.units.find((u) => u.name === '게임플레이파트')!
    expect(b.units.find((u) => u.id === part.parentId)?.name).toBe('클라이언트팀')
  })

  it('the team-project template has two ranks and three teams', () => {
    const b = buildFromTemplate(TEMPLATES.find((t) => t.id === 'team-project')!, 'S', id, '')
    expect(b.company.ranks).toHaveLength(2)
    expect(b.units).toHaveLength(3)
  })
})

describe('placement', () => {
  const place = (tplId: string, catalog: ModelEntry[]): { inp: PlacementInput; picks: Record<string, string> } => {
    const b = buildFromTemplate(TEMPLATES.find((t) => t.id === tplId)!, 'S', id, '')
    const inp: PlacementInput = { units: b.units, seats: b.seats, agents: [], catalog }
    const picks = autoPlace(inp, DEFAULT_RULES)
    inp.seats = b.seats.map((s) => ({ ...s, modelId: picks[s.id] }))
    return { inp, picks }
  }

  for (const tpl of TEMPLATES.filter((t) => t.id !== 'blank')) {
    it(`${tpl.name}: the recommended placement breaks no rule (all vendors)`, () => {
      const { inp } = place(tpl.id, CATALOG)
      expect(inp.seats.every((s) => s.modelId)).toBe(true)
      expect(checkPlacement({ rules: DEFAULT_RULES }, inp).filter((f) => f.level === 'warn')).toEqual([])
    })
    it(`${tpl.name}: ...and with Claude models only`, () => {
      const { inp } = place(tpl.id, CLAUDE_ONLY)
      expect(checkPlacement({ rules: DEFAULT_RULES }, inp).filter((f) => f.level === 'warn')).toEqual([])
    })
  }

  it('CEOs get the top tier and different models; with all vendors, different companies', () => {
    const { inp } = place('game-studio', CATALOG)
    const ceos = inp.seats.filter((s) => s.job === 'ceo').map((s) => CATALOG.find((m) => m.id === s.modelId)!)
    expect(new Set(ceos.map((m) => m.id)).size).toBe(3)
    expect(new Set(ceos.map((m) => m.company)).size).toBe(3)
    expect(ceos.every((m) => m.tier === 'top')).toBe(true)
  })

  it('with Claude only, the CEO trio is Fable / Opus / Sonnet', () => {
    const { inp } = place('game-studio', CLAUDE_ONLY)
    const fam = inp.seats.filter((s) => s.job === 'ceo').map((s) => CATALOG.find((m) => m.id === s.modelId)!.family)
    expect(new Set(fam)).toEqual(new Set(['Fable', 'Opus', 'Sonnet']))
  })

  it('routine seats get the light tier, hard work the balanced tier', () => {
    expect(recommendTier({ job: 'ops', difficulty: 'routine' })).toBe('light')
    expect(recommendTier({ job: 'build', difficulty: 'hard' })).toBe('balanced')
    expect(recommendTier({ job: 'coo', difficulty: 'hard' })).toBe('top')
    const { inp } = place('startup', CATALOG)
    const ops = inp.seats.find((s) => s.job === 'ops')!
    expect(CATALOG.find((m) => m.id === ops.modelId)!.tier).toBe('light')
  })

  it('the reviewer is a different model and not weaker than the workers', () => {
    const { inp } = place('startup', CATALOG)
    const dev = inp.units.find((u) => u.name === '개발')!
    const here = inp.seats.filter((s) => s.unitId === dev.id)
    const reviewer = here.find((s) => s.job === 'review')!
    const workers = here.filter((s) => s.job === 'build')
    const rank = { light: 1, balanced: 2, top: 3 } as const
    const rm = CATALOG.find((m) => m.id === reviewer.modelId)!
    for (const w of workers) {
      expect(w.modelId).not.toBe(reviewer.modelId)
      expect(rank[rm.tier]).toBeGreaterThanOrEqual(rank[CATALOG.find((m) => m.id === w.modelId)!.tier])
    }
  })

  it('a model that failed its availability check is never recommended', () => {
    const b = buildFromTemplate(TEMPLATES.find((t) => t.id === 'startup')!, 'S', id, '')
    const picks = autoPlace(
      { units: b.units, seats: b.seats, agents: [], catalog: CATALOG },
      DEFAULT_RULES,
      { 'claude-fable-5-1': { ok: false, at: '', message: 'no' } }
    )
    expect(Object.values(picks)).not.toContain('claude-fable-5-1')
  })

  it('only empty seats are filled by default; a seat held by an agent is never touched', () => {
    const b = buildFromTemplate(TEMPLATES.find((t) => t.id === 'startup')!, 'S', id, '')
    const seats: Seat[] = b.seats.map((s, i) => (i === 0 ? { ...s, modelId: 'claude-haiku-5-5' } : i === 1 ? { ...s, agentId: 'a' } : s))
    const picks = autoPlace(
      { units: b.units, seats, agents: [{ id: 'a', adapter: 'claude', modelId: 'claude-opus-5-5' }], catalog: CATALOG },
      DEFAULT_RULES
    )
    expect(picks[seats[0].id]).toBeUndefined()
    expect(picks[seats[1].id]).toBeUndefined()
    expect(picks[seats[2].id]).toBeDefined()
  })
})

describe('placement rules', () => {
  const b = buildFromTemplate(TEMPLATES.find((t) => t.id === 'startup')!, 'S', id, '')
  const dev = b.units.find((u) => u.name === '개발')!
  const withModels = (m: Record<string, string>): PlacementInput => ({
    units: b.units,
    seats: b.seats.map((s) => ({ ...s, modelId: m[s.title] })),
    agents: [],
    catalog: CATALOG
  })
  const find = (rules: Partial<typeof DEFAULT_RULES>, m: Record<string, string>) =>
    checkPlacement({ rules: { ...DEFAULT_RULES, ...rules } }, withModels(m))

  it('flags a team whose members all run the same model, and the switch turns it off', () => {
    const m = { '개발 리드': 'claude-sonnet-5-5', '개발 멤버 1': 'claude-sonnet-5-5', '개발 멤버 2': 'claude-sonnet-5-5' }
    expect(find({}, m).some((f) => f.rule === 'min-models' && f.unitId === dev.id)).toBe(true)
    expect(find({ minModelsPerTeam: false }, m).some((f) => f.rule === 'min-models')).toBe(false)
  })

  it('flags a reviewer on the same model as a worker', () => {
    const m = { '개발 멤버 1': 'claude-sonnet-5-5', '리뷰 멤버': 'claude-sonnet-5-5' }
    const f = find({}, m).filter((x) => x.rule === 'reviewer-differs')
    expect(f.length).toBe(1)
    expect(f[0].text).toContain('같은 모델')
    expect(find({ reviewerDiffers: false }, m).filter((x) => x.rule === 'reviewer-differs')).toEqual([])
  })

  it('flags a reviewer who is weaker than the worker', () => {
    const m = { '개발 멤버 1': 'claude-opus-5-5', '리뷰 멤버': 'claude-haiku-5-5' }
    expect(find({}, m).some((f) => f.text.includes('체급'))).toBe(true)
  })

  it('only counts seats whose model is known', () => {
    expect(find({}, {})).toEqual([])
  })

  it('an agent on a seat counts with its own model, not the seat\'s recommendation', () => {
    const seats = b.seats.map((s) =>
      s.title === '개발 멤버 1' ? { ...s, agentId: 'a1', modelId: 'claude-haiku-5-5' } : s.title === '리뷰 멤버' ? { ...s, modelId: 'claude-opus-5-5' } : s
    )
    const inp: PlacementInput = { units: b.units, seats, agents: [{ id: 'a1', adapter: 'claude', modelId: 'claude-opus-5-5' }], catalog: CATALOG }
    expect(checkPlacement({ rules: DEFAULT_RULES }, inp).some((f) => f.rule === 'reviewer-differs')).toBe(true)
  })

  it('CEO rule: duplicates warn; one vendor only is a hint; mixed vendors are fine', () => {
    const g = buildFromTemplate(TEMPLATES.find((t) => t.id === 'game-studio')!, 'S', id, '')
    const run = (models: string[]) => {
      let i = 0
      const seats = g.seats.map((s) => (s.job === 'ceo' ? { ...s, modelId: models[i++] } : s))
      return checkPlacement({ rules: DEFAULT_RULES }, { units: g.units, seats, agents: [], catalog: CATALOG }).filter((f) => f.rule === 'ceo-trio')
    }
    expect(run(['claude-opus-5-5', 'claude-opus-5-5', 'claude-fable-5-1'])[0].level).toBe('warn')
    expect(run(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'])[0].level).toBe('info')
    expect(run(['claude-opus-5-5', 'openai-gpt-6-astra', 'google-gemini-3-pro'])).toEqual([])
  })
})

describe('company in the engine', () => {
  it('applying a template stores the company, units and seats in shared files and fills model recommendations', () => {
    const eng = engine()
    const c = eng.applyTemplate('startup', '타토')
    expect(c.name).toBe('타토')
    const snap = eng.snapshot().company
    expect(snap.company?.templateId).toBe('startup')
    expect(snap.units.length).toBe(4)
    expect(snap.seats.every((s) => s.modelId)).toBe(true)
    expect(existsSync(join(eng.hive.root, 'company', 'company.json'))).toBe(true)
    expect(existsSync(join(eng.hive.root, 'company', 'units'))).toBe(true)
    eng.shutdown()
  })

  it('seats come back in template order', () => {
    const eng = engine()
    eng.applyTemplate('game-studio', 'G', false)
    const titles = eng.snapshot().company.seats.slice(0, 4).map((s) => s.title)
    expect(titles).toEqual(['CEO (제품·비전)', 'CEO (기술·실현 가능성)', 'CEO (사업·위험)', '총괄 본부장'])
    eng.shutdown()
  })

  it('applying another template replaces the org', () => {
    const eng = engine()
    eng.applyTemplate('startup', 'A')
    eng.applyTemplate('team-project', 'B')
    const s = eng.snapshot().company
    expect(s.company?.templateId).toBe('team-project')
    expect(s.units.map((u) => u.name).sort()).toEqual(['개발팀', '기획팀', '발표·문서팀'])
    eng.shutdown()
  })

  it('edits ranks, rules and units; deleting a unit removes everything below it; no unit can move below itself', () => {
    const eng = engine()
    eng.applyTemplate('game-studio', 'G', false)
    eng.saveCompany({ ranks: [{ id: 'r1', name: '대표', level: 9 }, { id: 'r2', name: '멤버', level: 9 }], rules: { ...DEFAULT_RULES, ceoTrioDiffers: false } })
    const c = eng.snapshot().company.company!
    expect(c.ranks.map((r) => r.level)).toEqual([1, 2])
    expect(c.rules.ceoTrioDiffers).toBe(false)
    expect(c.rules.minModelsPerTeam).toBe(true)

    const units = eng.snapshot().company.units
    const dev = units.find((u) => u.name === '개발본부')!
    const client = units.find((u) => u.name === '클라이언트팀')!
    expect(() => eng.saveUnit({ id: dev.id, name: dev.name, parentId: client.id })).toThrow('자기 아래')
    const renamed = eng.saveUnit({ id: dev.id, name: '개발센터' })
    expect(renamed.parentId).toBeNull()

    eng.deleteUnit(dev.id)
    const after = eng.snapshot().company
    for (const n of ['개발센터', '클라이언트팀', '게임플레이파트', 'UI파트', '서버팀']) expect(after.units.map((u) => u.name)).not.toContain(n)
    expect(after.units.map((u) => u.name)).toContain('QA실')
    const ids = new Set(after.units.map((u) => u.id))
    expect(after.seats.every((s) => ids.has(s.unitId))).toBe(true)
    eng.shutdown()
  })

  it('seats can be added by hand; the default rank is the lowest', () => {
    const eng = engine()
    eng.applyTemplate('blank', 'Mine')
    const u = eng.saveUnit({ name: '연구소', kind: '실' })
    const s = eng.saveSeat({ unitId: u.id, title: '연구원', job: 'research' })
    expect(s.rankId).toBe('rank-2')
    expect(eng.placeModels()).toBe(1)
    expect(eng.snapshot().company.seats[0].modelId).toBeTruthy()
    eng.deleteSeat(s.id)
    expect(eng.snapshot().company.seats).toEqual([])
    eng.shutdown()
  })

  it('an agent on a seat takes the seat\'s unit, rank and job, and the roster shows them', () => {
    const eng = engine()
    eng.applyTemplate('startup', 'A', false)
    const seat = eng.snapshot().company.seats.find((s) => s.job === 'build')!
    const a = eng.saveAgent({ name: 'dev', adapter: 'claude', workDir: folder() })
    eng.assignSeat(seat.id, a.id)
    const mine = eng.config.agents.find((x) => x.id === a.id)!
    expect(mine.unitId).toBe(seat.unitId)
    expect(mine.job).toBe('build')
    const r = eng.snapshot().roster.find((x) => x.id === a.id)!
    expect(r.job).toBe('build')
    expect(r.unitId).toBe(seat.unitId)
    // moving the agent to another seat empties the first
    const other = eng.snapshot().company.seats.find((s) => s.job === 'plan')!
    eng.assignSeat(other.id, a.id)
    const seats = eng.snapshot().company.seats
    expect(seats.find((s) => s.id === seat.id)!.agentId).toBeUndefined()
    expect(seats.find((s) => s.id === other.id)!.agentId).toBe(a.id)
    eng.shutdown()
  })
})

describe('exact model and version on an agent', () => {
  it('pinned uses the exact CLI argument, alias the family alias; the CLI really gets it', async () => {
    const args: string[][] = []
    const eng = engine(async (built) => {
      args.push(built.args)
      return ok()
    })
    const pinned = eng.saveAgent({ name: 'p', adapter: 'claude', workDir: folder('a'), modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    const alias = eng.saveAgent({ name: 'q', adapter: 'claude', workDir: folder('b'), modelRef: { id: 'claude-sonnet-5-5', pin: 'alias' } })
    expect(pinned.model).toBe('claude-sonnet-5-5')
    expect(alias.model).toBe('sonnet')
    const t = eng.createTask({ title: 'x', assignee: pinned.id })
    await eng.runTask(t.id)
    const i = args[0].indexOf('--model')
    expect(args[0][i + 1]).toBe('claude-sonnet-5-5')
    expect(eng.snapshot().roster.find((r) => r.id === pinned.id)!.modelId).toBe('claude-sonnet-5-5')
    eng.shutdown()
  })

  it('refuses a model for the wrong CLI or one that is not in the catalog', () => {
    const eng = engine()
    expect(() => eng.saveAgent({ name: 'x', adapter: 'codex', modelRef: { id: 'claude-opus-5-5', pin: 'pinned' } })).toThrow('claude용')
    expect(() => eng.saveAgent({ name: 'x', adapter: 'claude', modelRef: { id: 'nope', pin: 'pinned' } })).toThrow('카탈로그')
    eng.shutdown()
  })

  it('updating the catalog file moves alias agents to the new target and leaves pinned ones alone', () => {
    const eng = engine()
    const alias = eng.saveAgent({ name: 'q', adapter: 'claude', modelRef: { id: 'claude-sonnet-5-5', pin: 'alias' } })
    const pinned = eng.saveAgent({ name: 'p', adapter: 'claude', modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    const sonnet = CATALOG.find((m) => m.id === 'claude-sonnet-5-5')!
    eng.saveModel({ ...sonnet, aliasArg: 'sonnet-next', cliArg: 'claude-sonnet-5-6' })
    expect(eng.config.agents.find((a) => a.id === alias.id)!.model).toBe('sonnet-next')
    expect(eng.config.agents.find((a) => a.id === pinned.id)!.model).toBe('claude-sonnet-5-6')
    eng.shutdown()
  })

  it('the user can add a model (kept in a separate file) and remove it again', () => {
    const eng = engine()
    expect(() => eng.saveModel({ id: 'x' } as ModelEntry)).toThrow('부족')
    eng.saveModel({ id: 'my-local', company: 'Me', family: 'Local', version: '1', adapter: 'custom', cliArg: 'llama', tier: 'light', weight: 0, domains: ['docs'] })
    const m = eng.catalog().find((x) => x.id === 'my-local')!
    expect(m.custom).toBe(true)
    expect(m.weight).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'))).toHaveLength(1)
    expect(eng.catalog().length).toBe(CATALOG.length + 1)
    eng.deleteModel('my-local')
    expect(eng.catalog().length).toBe(CATALOG.length)
    eng.shutdown()
  })

  it('a hand-edited catalog file is picked up (the update path without a new app version)', () => {
    writeFileSync(join(dir, 'models.json'), JSON.stringify([{ ...CATALOG[2], id: 'claude-sonnet-5-5', version: '5.6' }]))
    const eng = engine()
    expect(eng.catalog().find((m) => m.id === 'claude-sonnet-5-5')!.version).toBe('5.6')
    writeFileSync(join(dir, 'models.json'), '{ broken')
    expect(eng.catalog().length).toBe(CATALOG.length)
    eng.shutdown()
  })

  it('the agent\'s permission level is the default for its tasks', async () => {
    const seen: string[][] = []
    const eng = engine(async (b) => (seen.push(b.args), ok()))
    const a = eng.saveAgent({ name: 'r', adapter: 'claude', workDir: folder(), permission: 'read' })
    const t = eng.createTask({ title: 'x', assignee: a.id })
    await eng.runTask(t.id)
    expect(seen[0].join(' ')).toContain('Read,Grep,Glob')
    // a task's own choice wins
    const t2 = eng.createTask({ title: 'y', assignee: a.id, permission: 'edit' })
    await eng.runTask(t2.id)
    expect(seen[1].join(' ')).not.toContain('--allowedTools Read,Grep,Glob')
    eng.shutdown()
  })
})

describe('model availability check', () => {
  it('runs the CLI with that model, records the result, and recommendations avoid unusable models', async () => {
    const used: string[][] = []
    const eng = engine(async (b) => {
      used.push(b.args)
      return b.args.includes('claude-fable-5-1')
        ? { code: 1, stdout: '', stderr: 'model not available for your plan', timedOut: false, aborted: false }
        : ok('OK')
    })
    const bad = await eng.verifyModel('claude-fable-5-1')
    const good = await eng.verifyModel('claude-opus-5-5')
    expect(bad.ok).toBe(false)
    expect(good.ok).toBe(true)
    expect(used[0]).toContain('claude-fable-5-1')
    const av = eng.snapshot().company.availability
    expect(av['claude-fable-5-1'].ok).toBe(false)
    expect(av['claude-opus-5-5'].ok).toBe(true)
    eng.applyTemplate('game-studio', 'G')
    expect(eng.snapshot().company.seats.some((s) => s.modelId === 'claude-fable-5-1')).toBe(false)
    expect((await eng.verifyModel('nope')).ok).toBe(false)
    eng.shutdown()
  })
})

describe('aptitude', () => {
  const rec = (over: Partial<AptitudeRecord>): AptitudeRecord => ({
    taskId: id(), modelKey: 'm1', modelLabel: 'M 1', domain: 'build', runs: 1, ms: 60_000, approved: 1, changes: 0, failed: 0, updatedAt: '', ...over
  })

  it('score: pass rate, minus change requests and slowness, kept within 0..100', () => {
    expect(scoreOf(1, 0, 0)).toBe(100)
    expect(scoreOf(0.5, 1, 0)).toBe(40)
    expect(scoreOf(0, 5, 100)).toBe(0)
    expect(scoreOf(1, 0, 30)).toBe(97)
  })

  it('groups by model version and domain, and marks thin evidence', () => {
    const rows = aptitudeBoard([
      ...Array.from({ length: 3 }, () => rec({})),
      rec({ modelKey: 'm2', modelLabel: 'M 2', approved: 0, changes: 2 }),
      rec({ approved: 0, changes: 0, failed: 0 }) // undecided: ignored
    ])
    const m1 = rows.find((r) => r.modelKey === 'm1')!
    expect(m1.tasks).toBe(3)
    expect(m1.enough).toBe(true)
    expect(m1.score).toBe(100)
    const m2 = rows.find((r) => r.modelKey === 'm2')!
    expect(m2.enough).toBe(false)
    expect(m2.passRate).toBe(0)
  })

  it('a new version starts with its own record and can be compared with the old one', () => {
    const rows = aptitudeBoard([
      ...Array.from({ length: 3 }, () => rec({ modelKey: 'sonnet-5-5', modelLabel: 'Sonnet 5.5', approved: 1, changes: 1 })),
      ...Array.from({ length: 3 }, () => rec({ modelKey: 'sonnet-5-6', modelLabel: 'Sonnet 5.6' }))
    ])
    expect(rows.map((r) => r.modelLabel).sort()).toEqual(['Sonnet 5.5', 'Sonnet 5.6'])
    expect(rows.find((r) => r.modelKey === 'sonnet-5-6')!.score).toBeGreaterThan(rows.find((r) => r.modelKey === 'sonnet-5-5')!.score)
  })

  it('recommends a switch only with enough evidence on both sides and a clear gain', () => {
    const good = Array.from({ length: 3 }, () => rec({ modelKey: 'good', modelLabel: 'Good' }))
    const weak = Array.from({ length: 3 }, () => rec({ modelKey: 'weak', modelLabel: 'Weak', approved: 1, changes: 2 }))
    const rows = aptitudeBoard([...good, ...weak])
    const now = [{ domain: 'build', modelKey: 'weak', modelLabel: 'Weak' }]
    const r = recommendReassignments(rows, now)
    expect(r).toHaveLength(1)
    expect(r[0].to).toBe('Good')
    expect(recommendReassignments(rows, [{ domain: 'build', modelKey: 'good', modelLabel: 'Good' }])).toEqual([])
    // too little evidence for the current model: no advice
    expect(recommendReassignments(aptitudeBoard([...good, weak[0]]), now)).toEqual([])
    // gain below the threshold: no advice
    expect(recommendReassignments(rows, now, 99)).toEqual([])
  })

  it('runs write the record: a clean finish counts as approved, a failure as failed', async () => {
    let fail = false
    const eng = engine(async () => (fail ? { code: 1, stdout: '', stderr: 'boom', timedOut: false, aborted: false } : ok()))
    const a = eng.saveAgent({ name: 'd', adapter: 'claude', workDir: folder(), job: 'build', modelRef: { id: 'claude-sonnet-5-5', pin: 'pinned' } })
    const t1 = eng.createTask({ title: '1', assignee: a.id })
    await eng.runTask(t1.id)
    fail = true
    const t2 = eng.createTask({ title: '2', assignee: a.id })
    await eng.runTask(t2.id)
    const recs = eng.snapshot().company.aptitude
    expect(recs).toHaveLength(2)
    const r1 = recs.find((r) => r.taskId === t1.id)!
    expect(r1).toMatchObject({ modelKey: 'claude-sonnet-5-5', modelLabel: 'Sonnet 5.5', domain: 'build', runs: 1, approved: 1, failed: 0 })
    expect(recs.find((r) => r.taskId === t2.id)).toMatchObject({ approved: 0, failed: 1 })
    eng.shutdown()
  })

  it('a result waiting for a human counts only after the human decides', async () => {
    const eng = engine(async (_b) => ok())
    eng.saveSettings({ humanReview: 'always' })
    const a = eng.saveAgent({ name: 'd', adapter: 'claude', workDir: folder(), modelRef: { id: 'claude-opus-5-5', pin: 'alias' } })
    const t = eng.createTask({ title: 'x', assignee: a.id })
    await eng.runTask(t.id)
    expect(eng.hive.getTask(t.id)!.status).toBe('needs_review')
    let rec = eng.hive.getAptitude(t.id)!
    expect(rec).toMatchObject({ approved: 0, changes: 0, runs: 1, domain: 'general' })
    eng.reviewTask(t.id, 'changes', '다시 해 주세요')
    await eng.recovering
    // the re-run is in flight in the background; wait for the task to settle
    for (let i = 0; i < 100 && eng.hive.getTask(t.id)!.status === 'todo'; i++) await new Promise((r) => setTimeout(r, 20))
    for (let i = 0; i < 100 && eng.hive.getTask(t.id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 20))
    eng.reviewTask(t.id, 'approve')
    rec = eng.hive.getAptitude(t.id)!
    expect(rec.changes).toBe(1)
    expect(rec.approved).toBe(1)
    expect(rec.runs).toBe(2)
    eng.shutdown()
  })

  it('records survive deleting the task (the model\'s history stays)', async () => {
    const eng = engine()
    const a = eng.saveAgent({ name: 'd', adapter: 'claude', workDir: folder() })
    const t = eng.createTask({ title: 'x', assignee: a.id })
    await eng.runTask(t.id)
    eng.deleteTask(t.id)
    expect(eng.snapshot().company.aptitude).toHaveLength(1)
    eng.shutdown()
  })
})
