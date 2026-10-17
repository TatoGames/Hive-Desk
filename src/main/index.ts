import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { Agent, AppConfig, EngineEvent, Task } from '../shared/types'
import { detectAll } from './adapters'
import { cleanEnv } from './adapters'
import { Engine } from './engine'

let win: BrowserWindow | null = null
let engine: Engine

function emit(e: EngineEvent): void {
  win?.webContents.send('engine:event', e)
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
  ipcMain.handle('task:run', (_e, id: string) => engine.runTask(id))
  ipcMain.handle('task:stop', (_e, id: string) => engine.stopTask(id))
  ipcMain.handle('approval:decide', (_e, id: string, d: 'approved' | 'rejected') =>
    engine.decideApproval(id, d)
  )
  ipcMain.handle('message:send', (_e, from: string, to: string, body: string) =>
    engine.sendMessage(from, to, body)
  )
  ipcMain.handle('memory:add', (_e, text: string) => engine.addMemory(text))
  ipcMain.handle('memory:delete', (_e, id: string) => engine.deleteMemory(id))
  ipcMain.handle('adapters:detect', () =>
    detectAll(cleanEnv(process.env, false))
  )
  ipcMain.handle('share:enable', (_e, url: string) => engine.enableSharing(url))
  ipcMain.handle('share:sync', () => engine.sync())
  ipcMain.handle('dialog:folder', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('open:path', (_e, p: string) => shell.openPath(p))
}

app.whenReady().then(() => {
  engine = new Engine(join(app.getPath('userData'), 'config.json'), emit)
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => engine?.shutdown())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
