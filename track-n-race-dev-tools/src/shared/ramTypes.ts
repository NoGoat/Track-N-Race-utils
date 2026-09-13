export interface RamProcessSample {
  pid: number
  type: string
  name: string | null
  workingSetKb: number
  privateKb: number | null
}

export interface RamCategoryComponent {
  key: string
  label: string
  retainedKb: number
}

export interface RamCategoryCounter {
  key: string
  label: string
  value: number
}

export interface RamCategorySample {
  key: string
  type: string
  name: string
  mode: string | null
  retainedKb: number
  alreadyIncludedInProcessTotals: boolean
  attributionScope: string | null
  rendererSampleAgeMs: number | null
  components: RamCategoryComponent[]
  counters: RamCategoryCounter[]
  nativeLiveHistoryEstimateBasis: string | null
}

export interface RamSample {
  timestamp: string
  elapsedMs: number
  totalWorkingSetKb: number
  totalPrivateKb: number | null
  processCount: number
  processes: RamProcessSample[]
  categoryCount: number
  categories: RamCategorySample[]
}

export interface ProcessSummary {
  pid: number
  type: string
  name: string | null
  sampleCount: number
  firstWorkingSetKb: number
  currentWorkingSetKb: number
  peakWorkingSetKb: number
  firstPrivateKb: number | null
  currentPrivateKb: number | null
  peakPrivateKb: number | null
}

export interface CategorySummary {
  key: string
  type: string
  name: string
  sampleCount: number
  currentRetainedKb: number
  peakRetainedKb: number
  alreadyIncludedInProcessTotals: boolean
}

export interface RamLogOverview {
  fileId: string
  path: string
  name: string
  fileSize: number
  invalidLines: number
  samples: RamSample[]
  processes: ProcessSummary[]
  categories: CategorySummary[]
  firstTimestamp: string
  lastTimestamp: string
  durationMs: number
  medianIntervalMs: number | null
  peakWorkingSetKb: number
  peakPrivateKb: number | null
}

export interface OpenResult {
  ok: boolean
  data?: RamLogOverview
  error?: string
}

export interface RamLogAppend {
  kind: 'append'
  fileId: string
  fileSize: number
  invalidLines: number
  samples: RamSample[]
  processes: ProcessSummary[]
  categories: CategorySummary[]
  lastTimestamp: string
  durationMs: number
  medianIntervalMs: number | null
  peakWorkingSetKb: number
  peakPrivateKb: number | null
}

export interface RamLogReplacement {
  kind: 'replace'
  data: RamLogOverview
}

export interface RamLogWatchError {
  kind: 'error'
  fileId: string
  error: string
}

export type RamLogUpdate = RamLogAppend | RamLogReplacement | RamLogWatchError

export interface RamViewerApi {
  openDialog(): Promise<OpenResult>
  openPath(path: string): Promise<OpenResult>
  pathForDroppedFile(file: File): string
  minimize(): void
  maximize(): void
  close(): void
  onMaximized(callback: (maximized: boolean) => void): () => void
  onOpenPath(callback: (path: string) => void): () => void
  onLogUpdate(callback: (update: RamLogUpdate) => void): () => void
}
