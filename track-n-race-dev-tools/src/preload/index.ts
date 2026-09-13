import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ControlRegionPage, ControlRegionPageRequest, OpenResult as TnrdOpenResult, ProgressInfo, RawPage, RawPageRequest, ViewerApi } from '../shared/tnrdTypes'
import type { OpenResult as RamOpenResult, RamLogUpdate, RamViewerApi } from '../shared/ramTypes'

const tnrdApi: ViewerApi = {
  openDialog: (): Promise<TnrdOpenResult> => ipcRenderer.invoke('viewer:open-dialog'),
  openPath: (path: string): Promise<TnrdOpenResult> => ipcRenderer.invoke('viewer:open-path', path),
  pathForDroppedFile: (file: File): string => webUtils.getPathForFile(file),
  rawPage: (request: RawPageRequest): Promise<RawPage> => ipcRenderer.invoke('viewer:raw-page', request),
  controlRegionPage: (request: ControlRegionPageRequest): Promise<ControlRegionPage> => ipcRenderer.invoke('viewer:control-region-page', request),
  exportChunk: (fileId: string, chunkId: string) => ipcRenderer.invoke('viewer:export-chunk', fileId, chunkId),
  minimize: (): void => ipcRenderer.send('window:minimize'),
  maximize: (): void => ipcRenderer.send('window:maximize'),
  close: (): void => ipcRenderer.send('window:close'),
  onMaximized: callback => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  },
  onOpenPath: callback => {
    const listener = (_event: Electron.IpcRendererEvent, path: string): void => callback(path)
    ipcRenderer.on('viewer:open-path', listener)
    return () => ipcRenderer.removeListener('viewer:open-path', listener)
  },
  onProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ProgressInfo): void => callback(progress)
    ipcRenderer.on('viewer:progress', listener)
    return () => ipcRenderer.removeListener('viewer:progress', listener)
  },
}

const ramApi: RamViewerApi = {
  openDialog: (): Promise<RamOpenResult> => ipcRenderer.invoke('ram-viewer:open-dialog'),
  openPath: (path: string): Promise<RamOpenResult> => ipcRenderer.invoke('ram-viewer:open-path', path),
  pathForDroppedFile: (file: File): string => webUtils.getPathForFile(file),
  minimize: (): void => ipcRenderer.send('window:minimize'),
  maximize: (): void => ipcRenderer.send('window:maximize'),
  close: (): void => ipcRenderer.send('window:close'),
  onMaximized: callback => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  },
  onOpenPath: callback => {
    const listener = (_event: Electron.IpcRendererEvent, path: string): void => callback(path)
    ipcRenderer.on('ram-viewer:open-path', listener)
    return () => ipcRenderer.removeListener('ram-viewer:open-path', listener)
  },
  onLogUpdate: callback => {
    const listener = (_event: Electron.IpcRendererEvent, update: RamLogUpdate): void => callback(update)
    ipcRenderer.on('ram-viewer:log-update', listener)
    return () => ipcRenderer.removeListener('ram-viewer:log-update', listener)
  },
}

const devToolsApi = {
  onActivatePage: (callback: (page: 'tnrd' | 'ram') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, page: 'tnrd' | 'ram'): void => callback(page)
    ipcRenderer.on('dev-tools:activate-page', listener)
    return () => ipcRenderer.removeListener('dev-tools:activate-page', listener)
  },
}

contextBridge.exposeInMainWorld('tnrdViewer', tnrdApi)
contextBridge.exposeInMainWorld('ramViewer', ramApi)
contextBridge.exposeInMainWorld('devTools', devToolsApi)
