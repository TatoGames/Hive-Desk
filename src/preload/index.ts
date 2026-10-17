import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AutoRow } from '../shared/connections'
import type { Company, ModelEntry, OrgUnit, Seat } from '../shared/company'
import type {
  AdapterId,
  Agent,
  AppConfig,
  AdapterInfo,
  CompanySummary,
  AttachResult,
  EngineEvent,
  LiveState,
  PermissionLevel,
  Project,
  RunShared,
  Preflight,
  RunRecord,
  Snapshot,
  SyncResult,
  SetupCheck,
  Task,
  TaskHistory
} from '../shared/types'

const api = {
  snapshot: (): Promise<Snapshot> => ipcRenderer.invoke('snapshot'),
  saveSettings: (p: Partial<AppConfig>): Promise<void> => ipcRenderer.invoke('settings:save', p),
  saveAgent: (a: Partial<Agent> & { name: string; adapter: Agent['adapter'] }): Promise<Agent> =>
    ipcRenderer.invoke('agent:save', a),
  deleteAgent: (id: string): Promise<void> => ipcRenderer.invoke('agent:delete', id),
  createTask: (t: {
    title: string
    description?: string
    assignee?: string | null
    risky?: boolean
    dependsOn?: string[]
    permission?: PermissionLevel
    refDirs?: string[]
    projectId?: string
    delegate?: boolean
    unitId?: string
  }): Promise<Task> => ipcRenderer.invoke('task:create', t),
  updateTask: (id: string, patch: Partial<Task>): Promise<Task> =>
    ipcRenderer.invoke('task:update', id, patch),
  deleteTask: (id: string): Promise<void> => ipcRenderer.invoke('task:delete', id),
  taskHistory: (id: string): Promise<TaskHistory> => ipcRenderer.invoke('task:history', id),
  runDetail: (taskId: string, runId: string): Promise<RunRecord | null> =>
    ipcRenderer.invoke('task:run-detail', taskId, runId),
  liveState: (id: string): Promise<LiveState | null> => ipcRenderer.invoke('task:live', id),
  preflight: (id: string): Promise<Preflight> => ipcRenderer.invoke('task:preflight', id),
  enableTracking: (id: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('task:track', id),
  attachPaths: (id: string, paths: string[]): Promise<AttachResult> =>
    ipcRenderer.invoke('task:attach-paths', id, paths),
  attachData: (id: string, name: string, data: Uint8Array): Promise<AttachResult> =>
    ipcRenderer.invoke('task:attach-data', id, name, data),
  removeAttachment: (id: string, rel: string): Promise<void> => ipcRenderer.invoke('task:detach', id, rel),
  replyToTask: (id: string, text: string): Promise<void> => ipcRenderer.invoke('task:reply', id, text),
  addInstruction: (id: string, text: string): Promise<void> => ipcRenderer.invoke('task:instruct', id, text),
  rollbackRun: (taskId: string, runId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('task:rollback', taskId, runId),
  reviewTask: (id: string, decision: 'approve' | 'changes', text?: string): Promise<void> =>
    ipcRenderer.invoke('task:review', id, decision, text),
  checkUpdate: (): Promise<{ available: boolean; current: string; version?: string; url?: string; name?: string }> =>
    ipcRenderer.invoke('update:check'),
  openUrl: (url: string): Promise<void> => ipcRenderer.invoke('open:url', url),
  clearLimit: (adapter: AdapterId): Promise<void> => ipcRenderer.invoke('limit:clear', adapter),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:files'),
  /** Absolute path of a dropped File ('' if the browser gave no real file). */
  pathForFile: (f: File): string => {
    try {
      return webUtils.getPathForFile(f)
    } catch {
      return ''
    }
  },
  runTask: (id: string): Promise<string> => ipcRenderer.invoke('task:run', id),
  stopTask: (id: string): Promise<void> => ipcRenderer.invoke('task:stop', id),
  openAgenda: (title: string, body: string): Promise<void> => ipcRenderer.invoke('agenda:open', title, body),
  decideAgenda: (id: string, choice: number, note?: string): Promise<void> =>
    ipcRenderer.invoke('agenda:decide', id, choice, note),
  applyReassignment: (domain: string, from: string, to: string): Promise<number> =>
    ipcRenderer.invoke('reassign:apply', domain, from, to),
  refreshAccountModels: (adapter: Agent['adapter']): Promise<{ ok: boolean; count: number; message: string }> =>
    ipcRenderer.invoke('model:refresh', adapter),
  verifyAllModels: (adapter: Agent['adapter']): Promise<{ checked: number; ok: number }> => ipcRenderer.invoke('conn:verify-all', adapter),
  hire: (input: { modelAgentId: string; name?: string; seatId?: string; role?: string; workDir?: string }): Promise<Agent> =>
    ipcRenderer.invoke('conn:hire', input),
  hireToSeat: (seatId: string, modelAgentId: string): Promise<Agent> => ipcRenderer.invoke('conn:hire-seat', seatId, modelAgentId),
  autoConnectPreview: (): Promise<AutoRow[]> => ipcRenderer.invoke('conn:auto-preview'),
  autoConnectApply: (rows?: { seatId: string; modelAgentId: string }[]): Promise<number> => ipcRenderer.invoke('conn:auto-apply', rows),
  setCompanyOrder: (order: string[], adapter?: string): Promise<void> => ipcRenderer.invoke('conn:order', order, adapter),
  reassignTask: (id: string, agentId: string): Promise<Task> => ipcRenderer.invoke('office:reassign', id, agentId),
  officeFeed: (): Promise<{ at: string; taskId: string; taskTitle: string; actor: string; text: string }[]> => ipcRenderer.invoke('office:feed'),
  decideApproval: (id: string, d: 'approved' | 'rejected', note?: string): Promise<void> =>
    ipcRenderer.invoke('approval:decide', id, d, note),
  sendMessage: (from: string, to: string, body: string): Promise<void> =>
    ipcRenderer.invoke('message:send', from, to, body),
  addMemory: (text: string, kind?: 'fixed' | 'recent'): Promise<void> => ipcRenderer.invoke('memory:add', text, kind),
  setMemoryKind: (id: string, kind: 'fixed' | 'recent'): Promise<void> => ipcRenderer.invoke('memory:kind', id, kind),
  applyTemplate: (id: string, name: string, place?: boolean): Promise<Company> =>
    ipcRenderer.invoke('company:template', id, name, place),
  saveCompany: (patch: Partial<Company>): Promise<Company> => ipcRenderer.invoke('company:save', patch),
  saveUnit: (u: Partial<OrgUnit> & { name: string }): Promise<OrgUnit> => ipcRenderer.invoke('company:unit-save', u),
  deleteUnit: (id: string): Promise<void> => ipcRenderer.invoke('company:unit-delete', id),
  saveSeat: (s: Partial<Seat> & { unitId: string; title: string }): Promise<Seat> =>
    ipcRenderer.invoke('company:seat-save', s),
  deleteSeat: (id: string): Promise<void> => ipcRenderer.invoke('company:seat-delete', id),
  assignSeat: (seatId: string, agentId: string | null): Promise<void> => ipcRenderer.invoke('company:assign', seatId, agentId),
  placeModels: (onlyEmpty?: boolean): Promise<number> => ipcRenderer.invoke('company:place', onlyEmpty),
  saveModel: (m: ModelEntry): Promise<ModelEntry> => ipcRenderer.invoke('model:save', m),
  deleteModel: (id: string): Promise<void> => ipcRenderer.invoke('model:delete', id),
  verifyModel: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('model:verify', id),
  saveProject: (p: Partial<Project> & { name: string }): Promise<Project> => ipcRenderer.invoke('project:save', p),
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('project:delete', id),
  createCompany: (name: string, templateId?: string, place?: boolean): Promise<CompanySummary> =>
    ipcRenderer.invoke('company:create', name, templateId, place),
  switchCompany: (id: string): Promise<void> => ipcRenderer.invoke('company:switch', id),
  renameCompany: (id: string, name: string): Promise<void> => ipcRenderer.invoke('company:rename', id, name),
  setProjectPath: (id: string, path: string, force?: boolean): Promise<{ ok: boolean; warning?: string }> =>
    ipcRenderer.invoke('project:path', id, path, force),
  sharedRuns: (id: string): Promise<RunShared[]> => ipcRenderer.invoke('task:shared-runs', id),
  deleteMemory: (id: string): Promise<void> => ipcRenderer.invoke('memory:delete', id),
  detectAdapters: (): Promise<AdapterInfo[]> => ipcRenderer.invoke('adapters:detect'),
  installCli: (id: Agent['adapter']): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('setup:install', id),
  openLogin: (id: Agent['adapter']): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('setup:login', id),
  checkCli: (id: Agent['adapter']): Promise<SetupCheck> => ipcRenderer.invoke('setup:check', id),
  enableSharing: (url: string): Promise<SyncResult> => ipcRenderer.invoke('share:enable', url),
  sync: (): Promise<SyncResult> => ipcRenderer.invoke('share:sync'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:folder'),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('open:path', p),
  onEvent: (cb: (e: EngineEvent) => void): (() => void) => {
    const h = (_: unknown, e: EngineEvent): void => cb(e)
    ipcRenderer.on('engine:event', h)
    return () => ipcRenderer.removeListener('engine:event', h)
  }
}

contextBridge.exposeInMainWorld('hive', api)

export type HiveApi = typeof api
