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
    maxConcurrent: 2,
    syncIntervalMinutes: 0
  }
}

export function loadConfig(file: string, home: string): AppConfig {
  const base = defaultConfig(home)
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>
      return { ...base, ...raw, agents: raw.agents ?? [] }
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
  input: Partial<Agent> & { name: string; adapter: Agent['adapter'] }
): Agent {
  const owner = member || 'me'
  return {
    id: input.id ?? `${slug(owner)}-${slug(input.name)}`,
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
    requireApproval: input.requireApproval ?? false
  }
}
