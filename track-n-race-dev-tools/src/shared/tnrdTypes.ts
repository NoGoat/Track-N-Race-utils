export type TnrdGeneration = 'TNRD_V1' | 'TNRD_V2' | 'TNRD_V3' | 'TNRD_V4' | 'TNRD_V5'
export type ChunkVisibility = 'active' | 'clipped' | 'superseded'
export type ViewMode = 'physical' | 'timeline' | 'sequence'

export interface IntegrityState {
  header: boolean | null
  metadata: boolean | null
  control: boolean | null
  invalidPrefixes: number
  recoveredCheckpoint: boolean
  partial: boolean
}

export interface LapInfo {
  number: number
  startTime: number
  endTime: number
  lapTimeMs: number
  flags: number
}

export interface BranchInfo {
  wallClockMs: number
  rewindSessionTime: number
}

export interface RegionInfo {
  name: string
  start: number
  size: number
  color: string
  detail?: string
}

export interface ChunkInfo {
  id: string
  index: number
  kind: 'container' | 'stream-block'
  lapNumber: number | null
  rowType: number
  rowTypeName: string
  typeCounts?: Record<string, number>
  sequence: number
  physicalStart: number | null
  physicalSize: number | null
  payloadOffset: number | null
  compressedSize: number
  uncompressedSize: number
  rowCount: number
  checksum: number | null
  prefixValid: boolean | null
  firstTime: number | null
  lastTime: number | null
  logicalLastTime: number | null
  timeEstimated: boolean
  minDistance: number | null
  maxDistance: number | null
  branchWallClockMs: number | null
  visibility: ChunkVisibility
}

export interface FileOverview {
  fileId: string
  path: string
  name: string
  fileSize: number
  generation: TnrdGeneration
  compression: 'gzip' | 'zstd'
  metadata: Record<string, unknown>
  summary: Record<string, unknown>
  integrity: IntegrityState
  laps: LapInfo[]
  branches: BranchInfo[]
  regions: RegionInfo[]
  chunks: ChunkInfo[]
  totalRows: number
  activeRows: number
  compressedPayloadBytes: number
  uncompressedPayloadBytes: number
  startTime: number | null
  endTime: number | null
}

export interface OpenResult {
  ok: boolean
  data?: FileOverview
  error?: string
}

export interface RawPageRequest {
  fileId: string
  chunkId: string
  page: number
  pageSize: number
  query?: string
}

export interface RawLine {
  number: number
  text: string
}

export interface RawPage {
  chunkId: string
  page: number
  pageSize: number
  totalLines: number
  filteredLines: number
  totalBytes: number
  lines: RawLine[]
  checksumValid: boolean | null
  rowCountValid: boolean | null
  firstTime: number | null
  lastTime: number | null
}

export interface ControlRegionPageRequest {
  fileId: string
  name: string
  start: number
  size: number
  page: number
  pageSize: number
}

export interface ControlRegionPage {
  name: string
  page: number
  pageSize: number
  totalBytes: number
  pageOffset: number
  lines: string[]
}

export interface ProgressInfo {
  phase: string
  fraction: number | null
  detail: string
}

export interface ViewerApi {
  openDialog(): Promise<OpenResult>
  openPath(path: string): Promise<OpenResult>
  pathForDroppedFile(file: File): string
  rawPage(request: RawPageRequest): Promise<RawPage>
  controlRegionPage(request: ControlRegionPageRequest): Promise<ControlRegionPage>
  exportChunk(fileId: string, chunkId: string): Promise<{ ok: boolean; path?: string; error?: string }>
  minimize(): void
  maximize(): void
  close(): void
  onMaximized(callback: (maximized: boolean) => void): () => void
  onOpenPath(callback: (path: string) => void): () => void
  onProgress(callback: (progress: ProgressInfo) => void): () => void
}
