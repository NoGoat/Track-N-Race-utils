import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { TnrdStore } from './tnrd'
import type { ControlRegionPageRequest, OpenResult, ProgressInfo, RawPageRequest } from '../shared/types'
import iconTransparent from '../../assets/icon_transparent.ico?asset'
import iconTransparentLight from '../../assets/icon_transparent_light.ico?asset'

const store = new TnrdStore()
let mainWindow: BrowserWindow | null = null
let pendingPath: string | null = null
let lastOpenDirectory: string | undefined

function lastOpenDirectoryPath(): string {
  return join(app.getPath('userData'), 'last-open-directory.txt')
}

async function loadLastOpenDirectory(): Promise<void> {
  try {
    const saved = (await readFile(lastOpenDirectoryPath(), 'utf8')).trim()
    if (saved) lastOpenDirectory = saved
  } catch {
    // The first launch has no saved directory yet.
  }
}

async function rememberOpenDirectory(filePath: string): Promise<void> {
  lastOpenDirectory = dirname(resolve(filePath))
  try {
    await writeFile(lastOpenDirectoryPath(), lastOpenDirectory, 'utf8')
  } catch {
    // Opening a recording should still succeed if preferences cannot be written.
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function candidateFromArgs(args: string[]): string | null {
  return args.find(argument => !argument.startsWith('-') && argument.toLocaleLowerCase().endsWith('.tnrd')) ?? null
}

async function openPath(path: string, sender: Electron.WebContents): Promise<OpenResult> {
  try {
    const data = await store.openFile(path, (progress: ProgressInfo) => sender.send('viewer:progress', progress))
    await rememberOpenDirectory(path)
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

function createWindow(): void {
  const iconPath = nativeTheme.shouldUseDarkColors ? iconTransparent : iconTransparentLight
  const window = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#0c0e14',
    title: 'Track N Race · TNRD Viewer',
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow = window
  window.on('ready-to-show', () => window.show())
  window.on('maximize', () => window.webContents.send('window:maximized', true))
  window.on('unmaximize', () => window.webContents.send('window:maximized', false))
  window.on('closed', () => { if (mainWindow === window) mainWindow = null })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))

  window.webContents.on('did-finish-load', () => {
    if (pendingPath) {
      window.webContents.send('viewer:open-path', pendingPath)
      pendingPath = null
    }
  })
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const path = candidateFromArgs(argv)
    if (path && mainWindow) mainWindow.webContents.send('viewer:open-path', path)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    pendingPath = candidateFromArgs(process.argv.slice(1))
    await loadLastOpenDirectory()

    ipcMain.handle('viewer:open-dialog', async event => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const result = await dialog.showOpenDialog(owner, {
        title: 'Open Track N Race recording',
        defaultPath: lastOpenDirectory,
        properties: ['openFile'],
        filters: [
          { name: 'Track N Race recordings', extensions: ['tnrd'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (result.canceled || !result.filePaths[0]) return { ok: false } satisfies OpenResult
      return openPath(result.filePaths[0], event.sender)
    })
    ipcMain.handle('viewer:open-path', (event, path: string) => openPath(path, event.sender))
    ipcMain.handle('viewer:raw-page', (_event, request: RawPageRequest) => store.rawPage(request))
    ipcMain.handle('viewer:control-region-page', (_event, request: ControlRegionPageRequest) => store.controlRegionPage(request))
    ipcMain.handle('viewer:export-chunk', async (_event, fileId: string, chunkId: string) => {
      try {
        const owner = mainWindow ?? undefined
        const result = await dialog.showSaveDialog(owner, {
          title: 'Export decompressed chunk',
          defaultPath: `tnrd-${chunkId.replace(/[^a-z0-9_-]/gi, '-')}.jsonl`,
          filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }, { name: 'Text', extensions: ['txt'] }],
        })
        if (result.canceled || !result.filePath) return { ok: false }
        await writeFile(result.filePath, await store.rawBuffer(fileId, chunkId))
        return { ok: true, path: result.filePath }
      } catch (error) {
        return { ok: false, error: message(error) }
      }
    })
    ipcMain.on('window:minimize', event => BrowserWindow.fromWebContents(event.sender)?.minimize())
    ipcMain.on('window:maximize', event => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    })
    ipcMain.on('window:close', event => BrowserWindow.fromWebContents(event.sender)?.close())

    createWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })
}

app.on('window-all-closed', () => {
  void store.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => { void store.close() })
