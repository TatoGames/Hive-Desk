import { classifyInput } from '../shared/manage'
import { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, shell } from 'electron'
import { join } from 'node:path'
import type { AdapterId, Agent, AppConfig, EngineEvent, Project, Task } from '../shared/types'
import { detectAll } from './adapters'
import { cleanEnv } from './adapters'
import { Engine } from './engine'
import { checkForUpdate } from './updates'
import { fixPath } from './shellPath'
import { checkCli, installCli, installCommand, openLogin } from './setup'

let win: BrowserWindow | null = null
let engine: Engine

/** While tasks run the computer must not fall asleep, or the CLIs are cut off half way. */
let blockerId: number | null = null
function syncPowerBlocker(): void {
  const busy = !!engine && engine.runningCount() > 0
  if (busy && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  else if (!busy && blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

function emit(e: EngineEvent): void {
  win?.webContents.send('engine:event', e)
  if (e.type === 'notify' && engine?.config.notifications !== false && Notification.isSupported()) {
    const n = new Notification({ title: e.title, body: e.body })
    n.on('click', () => win?.show())
    n.show()
  }
  if (e.type === 'changed') syncPowerBlocker()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'HiveDesk',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('snapshot', () => engine.snapshot())
  ipcMain.handle('settings:save', (_e, patch: Partial<AppConfig>) => engine.saveSettings(patch))
  ipcMain.handle('agent:save', (_e, a: Partial<Agent> & { name: string; adapter: Agent['adapter'] }) =>
    engine.saveAgent(a)
  )
  ipcMain.handle('agent:delete', (_e, id: string) => engine.deleteAgent(id))
  ipcMain.handle('task:create', (_e, t) => engine.createTask(t))
  ipcMain.handle('task:update', (_e, id: string, patch: Partial<Task>) => engine.updateTask(id, patch))
  ipcMain.handle('task:delete', (_e, id: string) => engine.deleteTask(id))
  ipcMain.handle('task:history', (_e, id: string) => engine.taskHistory(id))
  ipcMain.handle('task:run-detail', (_e, taskId: string, runId: string) => engine.runDetail(taskId, runId))
  ipcMain.handle('task:live', (_e, id: string) => engine.liveState(id))
  ipcMain.handle('task:preflight', (_e, id: string) => engine.preflight(id))
  ipcMain.handle('task:track', (_e, id: string) => engine.enableTracking(id))
  ipcMain.handle('task:attach-paths', (_e, id: string, paths: string[]) => engine.attachPaths(id, paths))
  ipcMain.handle('task:attach-data', (_e, id: string, name: string, data: Uint8Array) =>
    engine.attachData(id, name, data)
  )
  ipcMain.handle('task:detach', (_e, id: string, rel: string) => engine.removeAttachment(id, rel))
  ipcMain.handle('task:reply', (_e, id: string, text: string) => engine.replyToTask(id, text))
  ipcMain.handle('task:instruct', (_e, id: string, text: string, mode?: 'live' | 'interrupt' | 'after') => engine.addInstruction(id, text, mode))
  ipcMain.handle('task:instruct-drop', (_e, id: string, instructionId: string) => engine.dropInstruction(id, instructionId))
  ipcMain.handle('task:cancel', (_e, id: string, opts: { scope: 'this' | 'tree' | 'pending'; files?: 'keep' | 'run' | 'task' }) => engine.cancelTask(id, opts))
  ipcMain.handle('task:cancel-preview', (_e, id: string, scope: 'this' | 'tree' | 'pending') => engine.cancelPreview(id, scope))
  ipcMain.handle('failure:resolve', (_e, id: string, choice: 'retry' | 'skip' | 'cancel-all') => engine.resolveFailure(id, choice))
  ipcMain.handle('task:resume', (_e, id: string, instruction?: string) => engine.resumeTask(id, instruction))
  ipcMain.handle('input:classify', (_e, text: string) => classifyInput(text))
  ipcMain.handle('app:emergency-stop', () => engine.emergencyStop())
  ipcMain.handle('task:rollback', (_e, taskId: string, runId: string) => engine.rollbackRun(taskId, runId))
  ipcMain.handle('limit:clear', (_e, adapter: AdapterId) => engine.clearLimit(adapter))
  ipcMain.handle('dialog:files', async () => {
    if (!win) return []
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('task:run', (_e, id: string) => engine.runTask(id))
  ipcMain.handle('task:stop', (_e, id: string, kind?: 'hold' | 'cancel') => engine.stopTask(id, kind))
  ipcMain.handle('approval:decide', (_e, id: string, d: 'approved' | 'rejected', note?: string, raise?: 'edit' | 'exec', runCap?: number) =>
    engine.decideApproval(id, d, note, raise, runCap)
  )
  ipcMain.handle('message:send', (_e, from: string, to: string, body: string) =>
    engine.sendMessage(from, to, body)
  )
  ipcMain.handle('memory:add', (_e, text: string, kind?: 'fixed' | 'recent') => engine.addMemory(text, kind))
  ipcMain.handle('memory:delete', (_e, id: string) => engine.deleteMemory(id))
  ipcMain.handle('adapters:detect', async () => {
    fixPath() // pick up CLIs installed while the app was open
    const infos = await detectAll(cleanEnv(process.env, false))
    return infos.map((i) => ({ ...i, canInstall: !!installCommand(i.id) }))
  })
  ipcMain.handle('setup:install', async (_e, id: AdapterId) => {
    const r = await installCli(id, (chunk) => emit({ type: 'setup', adapter: id, chunk }))
    fixPath()
    return r
  })
  ipcMain.handle('setup:login', (_e, id: AdapterId) => openLogin(id))
  ipcMain.handle('setup:check', async (_e, id: AdapterId) => {
    fixPath()
    const r = await checkCli(id)
    engine.recordCheck(id, r)
    if (r.ok) void engine.refreshAccountModels(id) // the account's own model list, when the CLI has one
    return r
  })
  ipcMain.handle('company:template', (_e, id: string, name: string, place?: boolean) => engine.applyTemplate(id, name, place))
  ipcMain.handle('company:save', (_e, patch) => engine.saveCompany(patch))
  ipcMain.handle('company:unit-save', (_e, u) => engine.saveUnit(u))
  ipcMain.handle('company:unit-delete', (_e, id: string) => engine.deleteUnit(id))
  ipcMain.handle('company:seat-save', (_e, s) => engine.saveSeat(s))
  ipcMain.handle('company:seat-delete', (_e, id: string) => engine.deleteSeat(id))
  ipcMain.handle('company:assign', (_e, seatId: string, agentId: string | null) => engine.assignSeat(seatId, agentId))
  ipcMain.handle('company:place', (_e, onlyEmpty?: boolean) => engine.placeModels(onlyEmpty))
  ipcMain.handle('model:save', (_e, m) => engine.saveModel(m))
  ipcMain.handle('model:delete', (_e, id: string) => engine.deleteModel(id))
  ipcMain.handle('model:refresh', (_e, adapter: AdapterId) => engine.refreshAccountModels(adapter))
  ipcMain.handle('model:verify', (_e, id: string) => engine.verifyModel(id))
  ipcMain.handle('project:save', (_e, p: Partial<Project> & { name: string }) => engine.saveProject(p))
  ipcMain.handle('project:delete', (_e, id: string) => engine.deleteProject(id))
  ipcMain.handle('project:path', (_e, id: string, path: string, force?: boolean) => engine.setProjectPath(id, path, force))
  ipcMain.handle('memory:kind', (_e, id: string, kind: 'fixed' | 'recent') => engine.setMemoryKind(id, kind))
  ipcMain.handle('task:shared-runs', (_e, id: string) => engine.sharedRuns(id))
  ipcMain.handle('share:enable', (_e, url: string) => engine.enableSharing(url))
  ipcMain.handle('share:sync', () => engine.sync())
  ipcMain.handle('dialog:folder', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('task:review', (_e, id: string, decision: 'approve' | 'changes', text?: string) =>
    engine.reviewTask(id, decision, text)
  )
  ipcMain.handle('company:create', (_e, name: string, templateId?: string, place?: boolean) => engine.createCompany(name, templateId, place))
  ipcMain.handle('company:switch', (_e, id: string) => engine.switchCompany(id))
  ipcMain.handle('company:rename', (_e, id: string, name: string) => engine.renameCompany(id, name))
  const me = (): string => engine.snapshot().config.memberName || '나'
  ipcMain.handle('collab:create', (_e, input) => engine.collab.createChannel(input, me()))
  ipcMain.handle('collab:close', (_e, id: string) => engine.collab.closeChannel(id, me()))
  ipcMain.handle('collab:shareable', (_e, companyId: string) => engine.collab.listShareable(companyId))
  ipcMain.handle('collab:send-material', (_e, channelId: string, sender: string, ref: string) => engine.collab.sendMaterial(channelId, sender, { ref }))
  ipcMain.handle('collab:send-message', (_e, channelId: string, sender: string, text: string) => engine.collab.sendMessage(channelId, sender, text))
  ipcMain.handle('collab:request-work', (_e, channelId: string, sender: string, title: string, body: string) => {
    engine.collab.requestWork(channelId, sender, title, body)
  })
  ipcMain.handle('collab:decide', (_e, id: string, decision: 'approved' | 'rejected', scope) => {
    engine.collab.decideRequest(id, decision, me(), scope)
  })
  ipcMain.handle('conn:verify-all', (_e, adapter: AdapterId) => engine.verifyAllModels(adapter))
  ipcMain.handle('conn:hire', (_e, input) => engine.hire(input))
  ipcMain.handle('conn:hire-seat', (_e, seatId: string, modelAgentId: string) => engine.hireToSeat(seatId, modelAgentId))
  ipcMain.handle('conn:auto-preview', () => engine.autoConnectPreview())
  ipcMain.handle('conn:auto-apply', (_e, rows) => engine.autoConnectApply(rows))
  ipcMain.handle('conn:order', (_e, order: string[], adapter?: string) => engine.setCompanyOrder(order, adapter))
  ipcMain.handle('office:reassign', (_e, id: string, agentId: string) => engine.reassignTask(id, agentId))
  ipcMain.handle('office:feed', () => engine.officeFeed())
  ipcMain.handle('agenda:open', (_e, title: string, body: string) => engine.openAgenda(title, body))
  ipcMain.handle('agenda:decide', (_e, id: string, choice: number, note?: string) => engine.decideAgenda(id, choice, note))
  ipcMain.handle('reassign:apply', (_e, domain: string, from: string, to: string) => engine.applyReassignment(domain, from, to))
  ipcMain.handle('update:check', () => checkForUpdate(app.getVersion()))
  ipcMain.handle('open:url', (_e, url: string) => {
    if (/^https:\/\/github\.com\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle('open:path', (_e, p: string) => shell.openPath(p))
}

app.whenReady().then(() => {
  fixPath()
  try {
    engine = new Engine(join(app.getPath('userData'), 'config.json'), emit)
  } catch (e) {
    dialog.showErrorBox('HiveDesk를 시작하지 못했어요', (e as Error).message)
    app.quit()
    return
  }
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitConfirmed = false
app.on('before-quit', (e) => {
  const n = engine?.runningCount() ?? 0
  if (n > 0 && !quitConfirmed) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['계속 실행하기', '그래도 종료'],
      defaultId: 0,
      cancelId: 0,
      title: 'HiveDesk',
      message: `실행 중인 작업이 ${n}개 있어요.`,
      detail: '지금 종료하면 작업이 중간에 끊기고, 일부 파일만 바뀐 채로 남을 수 있어요. (끊긴 작업은 다시 열면 보이고 [되돌리기]로 원래대로 돌릴 수 있어요.)'
    })
    if (choice === 0) {
      e.preventDefault()
      return
    }
    quitConfirmed = true
  }
  engine?.shutdown()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
