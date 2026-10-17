import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Agent,
  AppConfig,
  AdapterInfo,
  AttachResult,
  EngineEvent,
  LiveState,
  PermissionLevel,
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
  decideApproval: (id: string, d: 'approved' | 'rejected'): Promise<void> =>
    ipcRenderer.invoke('approval:decide', id, d),
  sendMessage: (from: string, to: string, body: string): Promise<void> =>
    ipcRenderer.invoke('message:send', from, to, body),
  addMemory: (text: string): Promise<void> => ipcRenderer.invoke('memory:add', text),
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
