import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Agent, AppConfig } from '../shared/types'
import { slug } from './hive'
import { defaultExtraArgs } from './adapters'

export function defaultConfig(home: string): AppConfig {
  return {
    humanReview: 'changes',
    attachShareMaxMB: 5,
    memberName: '',
    workspace: join(home, 'HiveDesk'),
    agents: [],
    stripApiKeys: true,
    autoRun: false,
    autoRunOrg: true,
    maxConcurrent: 2,
    syncIntervalMinutes: 0
  }
}

export function loadConfig(file: string, home: string): AppConfig {
  const base = defaultConfig(home)
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>
      const cfg = { ...base, ...raw, agents: raw.agents ?? [] }
      // before v4 the single switch only covered the person's own tasks; delegated work always moved on.
      // Keep that behaviour on upgrade, or every delegation would silently stop.
      if (raw.autoRunOrg === undefined) cfg.autoRunOrg = true
      return cfg
    }
  } catch {
    /* fall through to defaults */
  }
  return base
}

export function saveConfig(file: string, cfg: AppConfig): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

export function makeAgent(
  member: string,
  input: Partial<Agent> & { name: string; adapter: Agent['adapter'] },
  /** Company tag for ids of agents outside the first company (`c1a2b-`). */
  idTag = ''
): Agent {
  const owner = member || 'me'
  return {
    id: input.id ?? `${slug(owner)}-${idTag}${slug(input.name)}`,
    ...(input.companyId ? { companyId: input.companyId } : {}),
    name: input.name.trim(),
    owner,
    adapter: input.adapter,
    role: input.role ?? '',
    workDir: input.workDir ?? '',
    model: input.model || undefined,
    extraArgs: input.extraArgs ?? defaultExtraArgs(input.adapter),
    command: input.command,
    dailyRunLimit: input.dailyRunLimit ?? 20,
    dailyMinuteLimit: input.dailyMinuteLimit ?? 120,
    timeoutMinutes: input.timeoutMinutes ?? 15,
    requireApproval: input.requireApproval ?? false,
    ...(input.rankId ? { rankId: input.rankId } : {}),
    ...(input.unitId ? { unitId: input.unitId } : {}),
    ...(input.job ? { job: input.job } : {}),
    ...(input.modelRef ? { modelRef: input.modelRef } : {}),
    ...(input.permission ? { permission: input.permission } : {})
  }
}
