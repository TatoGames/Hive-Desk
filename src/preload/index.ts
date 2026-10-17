import { contextBridge, ipcRenderer } from 'electron'
import type {
  Agent,
  AppConfig,
  AdapterInfo,
  EngineEvent,
  Snapshot,
  SyncResult,
  Task
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
  }): Promise<Task> => ipcRenderer.invoke('task:create', t),
  updateTask: (id: string, patch: Partial<Task>): Promise<Task> =>
    ipcRenderer.invoke('task:update', id, patch),
  deleteTask: (id: string): Promise<void> => ipcRenderer.invoke('task:delete', id),
  runTask: (id: string): Promise<string> => ipcRenderer.invoke('task:run', id),
  stopTask: (id: string): Promise<void> => ipcRenderer.invoke('task:stop', id),
  decideApproval: (id: string, d: 'approved' | 'rejected'): Promise<void> =>
    ipcRenderer.invoke('approval:decide', id, d),
  sendMessage: (from: string, to: string, body: string): Promise<void> =>
    ipcRenderer.invoke('message:send', from, to, body),
  addMemory: (text: string): Promise<void> => ipcRenderer.invoke('memory:add', text),
  deleteMemory: (id: string): Promise<void> => ipcRenderer.invoke('memory:delete', id),
  detectAdapters: (): Promise<AdapterInfo[]> => ipcRenderer.invoke('adapters:detect'),
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
