import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ControlRegionPage, ControlRegionPageRequest, OpenResult, ProgressInfo, RawPage, RawPageRequest, ViewerApi } from '../shared/types'

const api: ViewerApi = {
  openDialog: (): Promise<OpenResult> => ipcRenderer.invoke('viewer:open-dialog'),
  openPath: (path: string): Promise<OpenResult> => ipcRenderer.invoke('viewer:open-path', path),
  pathForDroppedFile: (file: File): string => webUtils.getPathForFile(file),
  rawPage: (request: RawPageRequest): Promise<RawPage> => ipcRenderer.invoke('viewer:raw-page', request),
  controlRegionPage: (request: ControlRegionPageRequest): Promise<ControlRegionPage> => ipcRenderer.invoke('viewer:control-region-page', request),
  exportChunk: (fileId: string, chunkId: string) => ipcRenderer.invoke('viewer:export-chunk', fileId, chunkId),
  minimize: (): void => ipcRenderer.send('window:minimize'),
  maximize: (): void => ipcRenderer.send('window:maximize'),
  close: (): void => ipcRenderer.send('window:close'),
  onMaximized: (callback: (maximized: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  },
  onOpenPath: (callback: (path: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, path: string): void => callback(path)
    ipcRenderer.on('viewer:open-path', listener)
    return () => ipcRenderer.removeListener('viewer:open-path', listener)
  },
  onProgress: (callback: (progress: ProgressInfo) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ProgressInfo): void => callback(progress)
    ipcRenderer.on('viewer:progress', listener)
    return () => ipcRenderer.removeListener('viewer:progress', listener)
  },
}

contextBridge.exposeInMainWorld('tnrdViewer', api)
