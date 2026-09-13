import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from 'electron'
import type { WebContents } from 'electron'
import { unwatchFile, watchFile } from 'node:fs'
import { open, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { appendRamLogOverview, parseRamLog, parseRamLogLine } from './ramLog'
import { TnrdStore } from './tnrd'
import type { ControlRegionPageRequest, OpenResult as TnrdOpenResult, ProgressInfo, RawPageRequest } from '../shared/tnrdTypes'
import type { OpenResult as RamOpenResult, RamLogAppend, RamLogOverview, RamLogUpdate, RamSample } from '../shared/ramTypes'
import iconTransparent from '../../assets/icon_transparent.ico?asset'
import iconTransparentLight from '../../assets/icon_transparent_light.ico?asset'

type ToolPage = 'tnrd' | 'ram'

const tnrdStore = new TnrdStore()
let mainWindow: BrowserWindow | null = null
let pendingOpen: { page: ToolPage; path: string } | null = null
const lastOpenDirectories: Partial<Record<ToolPage, string>> = {}

interface RamWatchState {
  path: string
  fileId: string
  offset: number
  lastMtimeMs: number
  overview: RamLogOverview
  sender: WebContents
  reading: boolean
  pending: boolean
}

let ramWatchState: RamWatchState | null = null

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function preferencePath(page: ToolPage): string {
  return join(app.getPath('userData'), `last-${page}-open-directory.txt`)
}

async function loadLastOpenDirectories(): Promise<void> {
  await Promise.all((['tnrd', 'ram'] as ToolPage[]).map(async page => {
    try {
      const saved = (await readFile(preferencePath(page), 'utf8')).trim()
      if (saved) lastOpenDirectories[page] = saved
    } catch {
      // The first launch has no saved directory yet.
    }
  }))
}

async function rememberOpenDirectory(page: ToolPage, filePath: string): Promise<void> {
  const directory = dirname(resolve(filePath))
  lastOpenDirectories[page] = directory
  try {
    await writeFile(preferencePath(page), directory, 'utf8')
  } catch {
    // Preference failures must not prevent files from opening.
  }
}

function candidateFromArgs(args: string[]): { page: ToolPage; path: string } | null {
  for (const argument of args) {
    if (argument.startsWith('-')) continue
    if (/\.tnrd$/i.test(argument)) return { page: 'tnrd', path: argument }
    if (/(?:ram_usage\.log|\.jsonl?|\.log)$/i.test(argument)) return { page: 'ram', path: argument }
  }
  return null
}

function sendOpenRequest(target: WebContents, request: { page: ToolPage; path: string }): void {
  target.send('dev-tools:activate-page', request.page)
  target.send(request.page === 'tnrd' ? 'viewer:open-path' : 'ram-viewer:open-path', request.path)
}

async function openTnrdPath(path: string, sender: WebContents): Promise<TnrdOpenResult> {
  try {
    const data = await tnrdStore.openFile(path, (progress: ProgressInfo) => sender.send('viewer:progress', progress))
    await rememberOpenDirectory('tnrd', path)
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

function stopWatchingRam(): void {
  if (!ramWatchState) return
  unwatchFile(ramWatchState.path)
  ramWatchState = null
}

function sendRamUpdate(state: RamWatchState, update: RamLogUpdate): void {
  if (!state.sender.isDestroyed()) state.sender.send('ram-viewer:log-update', update)
}

async function readAppendedLines(path: string, offset: number, size: number): Promise<{ consumed: number; lines: string[] }> {
  const length = size - offset
  if (length <= 0) return { consumed: 0, lines: [] }
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    const data = buffer.subarray(0, bytesRead)
    const finalNewline = data.lastIndexOf(0x0a)
    if (finalNewline < 0) return { consumed: 0, lines: [] }
    return {
      consumed: finalNewline + 1,
      lines: data.subarray(0, finalNewline + 1).toString('utf8').split(/\r?\n/).filter(line => line.trim()),
    }
  } finally {
    await handle.close()
  }
}

function appendUpdate(overview: RamLogOverview, samples: RamSample[]): RamLogAppend {
  return {
    kind: 'append',
    fileId: overview.fileId,
    fileSize: overview.fileSize,
    invalidLines: overview.invalidLines,
    samples,
    processes: overview.processes,
    categories: overview.categories,
    lastTimestamp: overview.lastTimestamp,
    durationMs: overview.durationMs,
    medianIntervalMs: overview.medianIntervalMs,
    peakWorkingSetKb: overview.peakWorkingSetKb,
    peakPrivateKb: overview.peakPrivateKb,
  }
}

async function refreshWatchedRamFile(state: RamWatchState): Promise<void> {
  if (state.reading) {
    state.pending = true
    return
  }
  state.reading = true
  try {
    const file = await stat(state.path)
    if (ramWatchState !== state || !file.isFile()) return
    const fileId = `${state.path}:${file.dev}:${file.ino}`
    const needsReplacement = fileId !== state.fileId || file.size < state.offset || (file.size === state.offset && file.mtimeMs !== state.lastMtimeMs)
    if (needsReplacement) {
      const overview = await parseRamLog(state.path)
      if (ramWatchState !== state) return
      state.fileId = overview.fileId
      state.offset = overview.fileSize
      state.lastMtimeMs = file.mtimeMs
      state.overview = overview
      sendRamUpdate(state, { kind: 'replace', data: overview })
      return
    }
    if (file.size === state.offset) {
      state.lastMtimeMs = file.mtimeMs
      return
    }

    const appended = await readAppendedLines(state.path, state.offset, file.size)
    if (ramWatchState !== state || appended.consumed === 0) return
    const samples: RamSample[] = []
    let invalidLines = 0
    for (const line of appended.lines) {
      const sample = parseRamLogLine(line)
      if (sample) samples.push(sample)
      else invalidLines++
    }
    const currentLast = state.overview.samples.at(-1)
    if (currentLast && samples.some(sample => sample.elapsedMs <= currentLast.elapsedMs)) {
      const overview = await parseRamLog(state.path)
      if (ramWatchState !== state) return
      state.fileId = overview.fileId
      state.offset = overview.fileSize
      state.lastMtimeMs = file.mtimeMs
      state.overview = overview
      sendRamUpdate(state, { kind: 'replace', data: overview })
      return
    }

    state.offset += appended.consumed
    state.lastMtimeMs = file.mtimeMs
    state.overview = appendRamLogOverview(state.overview, samples, invalidLines, file.size)
    sendRamUpdate(state, appendUpdate(state.overview, samples))
  } catch (error) {
    if (ramWatchState === state) sendRamUpdate(state, { kind: 'error', fileId: state.fileId, error: message(error) })
  } finally {
    state.reading = false
    if (ramWatchState === state && state.pending) {
      state.pending = false
      void refreshWatchedRamFile(state)
    }
  }
}

async function startWatchingRam(path: string, overview: RamLogOverview, sender: WebContents): Promise<void> {
  stopWatchingRam()
  const file = await stat(path)
  const state: RamWatchState = {
    path,
    fileId: overview.fileId,
    offset: overview.fileSize,
    lastMtimeMs: file.mtimeMs,
    overview,
    sender,
    reading: false,
    pending: false,
  }
  ramWatchState = state
  watchFile(path, { interval: 500, persistent: false }, () => { void refreshWatchedRamFile(state) })
}

async function openRamPath(path: string, sender: WebContents): Promise<RamOpenResult> {
  try {
    const data = await parseRamLog(path)
    await rememberOpenDirectory('ram', path)
    await startWatchingRam(data.path, data, sender)
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#0c0e14',
    title: 'Track N Race · Dev Tools',
    icon: nativeTheme.shouldUseDarkColors ? iconTransparent : iconTransparentLight,
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
    if (!pendingOpen) return
    sendOpenRequest(window.webContents, pendingOpen)
    pendingOpen = null
  })
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const request = candidateFromArgs(argv)
    if (request && mainWindow) sendOpenRequest(mainWindow.webContents, request)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    pendingOpen = candidateFromArgs(process.argv.slice(1))
    await loadLastOpenDirectories()

    ipcMain.handle('viewer:open-dialog', async event => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const result = await dialog.showOpenDialog(owner, {
        title: 'Open Track N Race recording',
        defaultPath: lastOpenDirectories.tnrd,
        properties: ['openFile'],
        filters: [{ name: 'Track N Race recordings', extensions: ['tnrd'] }, { name: 'All files', extensions: ['*'] }],
      })
      if (result.canceled || !result.filePaths[0]) return { ok: false } satisfies TnrdOpenResult
      return openTnrdPath(result.filePaths[0], event.sender)
    })
    ipcMain.handle('viewer:open-path', (event, path: string) => openTnrdPath(path, event.sender))
    ipcMain.handle('viewer:raw-page', (_event, request: RawPageRequest) => tnrdStore.rawPage(request))
    ipcMain.handle('viewer:control-region-page', (_event, request: ControlRegionPageRequest) => tnrdStore.controlRegionPage(request))
    ipcMain.handle('viewer:export-chunk', async (_event, fileId: string, chunkId: string) => {
      try {
        const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
          title: 'Export decompressed chunk',
          defaultPath: `tnrd-${chunkId.replace(/[^a-z0-9_-]/gi, '-')}.jsonl`,
          filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }, { name: 'Text', extensions: ['txt'] }],
        })
        if (result.canceled || !result.filePath) return { ok: false }
        await writeFile(result.filePath, await tnrdStore.rawBuffer(fileId, chunkId))
        return { ok: true, path: result.filePath }
      } catch (error) {
        return { ok: false, error: message(error) }
      }
    })

    ipcMain.handle('ram-viewer:open-dialog', async event => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const result = await dialog.showOpenDialog(owner, {
        title: 'Open RAM usage log',
        defaultPath: lastOpenDirectories.ram,
        properties: ['openFile'],
        filters: [{ name: 'RAM usage logs', extensions: ['log', 'jsonl', 'json'] }, { name: 'All files', extensions: ['*'] }],
      })
      if (result.canceled || !result.filePaths[0]) return { ok: false } satisfies RamOpenResult
      return openRamPath(result.filePaths[0], event.sender)
    })
    ipcMain.handle('ram-viewer:open-path', (event, path: string) => openRamPath(path, event.sender))

    ipcMain.on('window:minimize', event => BrowserWindow.fromWebContents(event.sender)?.minimize())
    ipcMain.on('window:maximize', event => {
      const target = BrowserWindow.fromWebContents(event.sender)
      if (!target) return
      if (target.isMaximized()) target.unmaximize()
      else target.maximize()
    })
    ipcMain.on('window:close', event => BrowserWindow.fromWebContents(event.sender)?.close())

    createWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })
}

app.on('window-all-closed', () => {
  stopWatchingRam()
  void tnrdStore.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopWatchingRam()
  void tnrdStore.close()
})
