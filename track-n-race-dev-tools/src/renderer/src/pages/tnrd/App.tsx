import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { createPortal } from 'react-dom'
import type { SingleValue } from 'react-select'
import AnimatedSelect from '../../AnimatedSelect'
import { ChunkMap } from './chunkMap'
import { buildSelectStyles } from '../../selectStyles'
import type { ChunkInfo, ControlRegionPage, FileOverview, OpenResult, RawPage, RegionInfo, ViewMode } from '../../../../shared/tnrdTypes'
import reactLicense from './assets/licenses/react.txt?raw'
import reactDomLicense from './assets/licenses/react-dom.txt?raw'
import reactSelectLicense from './assets/licenses/react-select.txt?raw'
import cascadiaLicense from './assets/licenses/cascadia-code.txt?raw'
import type { Theme } from '../../types'

const PAGE_SIZE = 250
const RAW_PAGE_SIZE = 400
const CONTROL_PAGE_SIZE = 4096
type SortKey = keyof Pick<ChunkInfo, 'index' | 'lapNumber' | 'rowType' | 'sequence' | 'firstTime' | 'payloadOffset' | 'compressedSize' | 'uncompressedSize' | 'rowCount' | 'prefixValid'>
interface Option { value: string; label: string }

const familyColors: Record<number, string> = {
  1: '#5794f2', 2: '#73bf69', 3: '#f2495c', 4: '#fade2a', 5: '#b877d9',
  6: '#ff9830', 7: '#33b5e5', 11: '#56d4dd', 12: '#a48ad4', 13: '#ff7383',
}

const thirdPartyNotices = `React 19.2.7 — MIT\n\n${reactLicense}\n\nReact DOM 19.2.7 — MIT\n\n${reactDomLicense}\n\nreact-select 5.10.2 — MIT\n\n${reactSelectLicense}\n\nCascadia Code — SIL Open Font License 1.1\n\n${cascadiaLicense}`

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++ }
  return unit ? `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[unit]}` : `${value.toLocaleString()} B`
}

function formatTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const seconds = value % 60
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds.toFixed(3).padStart(6, '0')}` : `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`
}

function formatOffset(value: number | null): string {
  return value === null ? 'Logical block' : `${value.toLocaleString()} · 0x${value.toString(16).toUpperCase()}`
}

function compressionRatio(chunk: ChunkInfo): string {
  return chunk.uncompressedSize ? `${(chunk.compressedSize / chunk.uncompressedSize * 100).toFixed(1)}%` : '—'
}

function selectedValue(options: Option[], value: string): Option {
  return options.find(option => option.value === value) ?? options[0]
}

function decodedRegionContent(region: RegionInfo | null, overview: FileOverview | null): string {
  if (!region || !overview) return ''
  if (region.name === 'Session metadata') return JSON.stringify(overview.metadata, null, 2)
  if (region.name === 'Control summary') return JSON.stringify(overview.summary, null, 2)
  if (region.name === 'Lap table') return JSON.stringify(overview.laps, null, 2)
  if (region.name === 'Branch table') return JSON.stringify(overview.branches, null, 2)
  if (region.name === 'Chunk directory') return `${overview.chunks.length.toLocaleString()} chunk entries`
  return ''
}

function ChunkCanvas({ overview, filtered, selectedId, selectedRegion, mode, fitVersion, onSelect, onSelectRegion, onOpenRegion, onOpenRaw, onClearSelection }: {
  overview: FileOverview
  filtered: ChunkInfo[]
  selectedId: string | null
  selectedRegion: RegionInfo | null
  mode: ViewMode
  fitVersion: number
  onSelect: (chunk: ChunkInfo, reveal: boolean) => void
  onSelectRegion: (region: RegionInfo) => void
  onOpenRegion: (region: RegionInfo) => void
  onOpenRaw: (chunk: ChunkInfo) => void
  onClearSelection: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<ChunkMap | null>(null)
  const selectRef = useRef(onSelect)
  const selectRegionRef = useRef(onSelectRegion)
  const openRegionRef = useRef(onOpenRegion)
  const rawRef = useRef(onOpenRaw)
  const clearSelectionRef = useRef(onClearSelection)
  selectRef.current = onSelect
  selectRegionRef.current = onSelectRegion
  openRegionRef.current = onOpenRegion
  rawRef.current = onOpenRaw
  clearSelectionRef.current = onClearSelection

  useEffect(() => {
    if (!canvasRef.current || !tooltipRef.current) return
    const map = new ChunkMap(
      canvasRef.current,
      tooltipRef.current,
      chunk => selectRef.current(chunk, true),
      region => selectRegionRef.current(region),
      region => openRegionRef.current(region),
      chunk => rawRef.current(chunk),
      () => clearSelectionRef.current(),
    )
    mapRef.current = map
    return () => { map.destroy(); mapRef.current = null }
  }, [overview.fileId])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.setData(overview)
    map.setMode(mode)
    map.setFiltered(filtered)
    map.select(selectedId, selectedRegion)
  }, [overview])
  useEffect(() => { mapRef.current?.setMode(mode) }, [mode])
  useEffect(() => { mapRef.current?.setFiltered(filtered) }, [filtered])
  useEffect(() => { mapRef.current?.select(selectedId, selectedRegion) }, [selectedId, selectedRegion])
  useEffect(() => { if (fitVersion) mapRef.current?.fit() }, [fitVersion])

  const laneCount = new Set(overview.chunks.map(chunk => chunk.rowType)).size
  const canvasMinHeight = (mode === 'physical' ? 52 : 16) + Math.max(1, laneCount) * 22 + 24

  return (
    <div className="canvas-viewport">
      <div className="canvas-wrap" style={{ minHeight: canvasMinHeight }}>
        <canvas ref={canvasRef} id="chunk-canvas" />
      </div>
      {createPortal(<div ref={tooltipRef} className="chunk-tooltip" role="tooltip" hidden />, document.body)}
    </div>
  )
}

function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  return (
    <div className="pager">
      <button className="icon-button" disabled={page <= 0} onClick={() => onChange(page - 1)} aria-label="Previous page">‹</button>
      <span>{page + 1} / {pages}</span>
      <button className="icon-button" disabled={page >= pages - 1} onClick={() => onChange(page + 1)} aria-label="Next page">›</button>
    </div>
  )
}

export default function App({ active, theme, openRequest: shellOpenRequest, onFileNameChange }: { active: boolean; theme: Theme; openRequest: number; onFileNameChange: (name: string | null) => void }) {
  const [overview, setOverview] = useState<FileOverview | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRegion, setSelectedRegion] = useState<RegionInfo | null>(null)
  const [lapFilter, setLapFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [chunkSearch, setChunkSearch] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('physical')
  const [sortKey, setSortKey] = useState<SortKey>('index')
  const [sortDirection, setSortDirection] = useState<1 | -1>(1)
  const [tablePage, setTablePage] = useState(0)
  const [fitVersion, setFitVersion] = useState(0)
  const [status, setStatus] = useState('Ready')
  const [progress, setProgress] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  const [rawChunk, setRawChunk] = useState<ChunkInfo | null>(null)
  const [rawPageIndex, setRawPageIndex] = useState(0)
  const [rawQuery, setRawQuery] = useState('')
  const [rawResult, setRawResult] = useState<RawPage | null>(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  const [controlRegion, setControlRegion] = useState<RegionInfo | null>(null)
  const [controlPageIndex, setControlPageIndex] = useState(0)
  const [controlPage, setControlPage] = useState<ControlRegionPage | null>(null)
  const [controlLoading, setControlLoading] = useState(false)
  const [controlError, setControlError] = useState<string | null>(null)
  const openRequest = useRef(0)
  const handledShellOpenRequest = useRef(shellOpenRequest)
  const rawRequest = useRef(0)

  const showToast = useCallback((text: string, error = false) => setToast({ text, error }), [])

  const openRecording = useCallback(async (promise: Promise<OpenResult>) => {
    const request = ++openRequest.current
    setStatus('Opening recording…')
    setProgress(0)
    const result = await promise
    if (request !== openRequest.current) return
    setProgress(null)
    if (!result.ok || !result.data) {
      setStatus(result.error ? `Open failed: ${result.error}` : 'Ready')
      if (result.error) showToast(result.error, true)
      return
    }
    const data = result.data
    setOverview(data)
    setSelectedId(null)
    setSelectedRegion(null)
    setLapFilter('all')
    setTypeFilter('all')
    setChunkSearch('')
    setViewMode('physical')
    setTablePage(0)
    setStatus(`Opened ${data.name} · ${data.chunks.length.toLocaleString()} ${data.chunks[0]?.kind === 'stream-block' ? 'logical blocks' : 'chunks'}`)
    onFileNameChange(data.name)
  }, [onFileNameChange, showToast])

  useEffect(() => {
    if (!active || handledShellOpenRequest.current === shellOpenRequest) return
    handledShellOpenRequest.current = shellOpenRequest
    void openRecording(window.tnrdViewer.openDialog())
  }, [active, openRecording, shellOpenRequest])

  useEffect(() => {
    setFitVersion(value => value + 1)
  }, [theme])

  useEffect(() => {
    const removeProgress = window.tnrdViewer.onProgress(value => {
      setStatus(value.detail)
      setProgress(value.fraction)
    })
    const removeOpen = window.tnrdViewer.onOpenPath(path => { void openRecording(window.tnrdViewer.openPath(path)) })
    const keydown = (event: KeyboardEvent): void => {
      if (!active) return
      if (event.key === 'Escape') {
        setRawChunk(null)
        setControlRegion(null)
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      removeProgress(); removeOpen()
      window.removeEventListener('keydown', keydown)
    }
  }, [active, openRecording])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const lapOptions = useMemo<Option[]>(() => {
    if (!overview) return [{ value: 'all', label: 'All laps' }]
    const options: Option[] = [{ value: 'all', label: 'All laps' }]
    if (overview.chunks.some(chunk => chunk.lapNumber === 0)) options.push({ value: '0', label: 'Session scope' })
    const laps = [...new Set([...overview.laps.map(lap => lap.number), ...overview.chunks.flatMap(chunk => chunk.lapNumber === null ? [] : [chunk.lapNumber])])]
      .filter(value => value > 0).sort((a, b) => a - b)
    options.push(...laps.map(lap => ({ value: String(lap), label: `Lap ${lap}` })))
    return options
  }, [overview])

  const typeOptions = useMemo<Option[]>(() => {
    const options = new Map<string, string>([['all', 'All families']])
    for (const chunk of overview?.chunks ?? []) {
      if (chunk.typeCounts) for (const name of Object.keys(chunk.typeCounts)) options.set(`contains:${name}`, name)
      else options.set(String(chunk.rowType), `${String(chunk.rowType).padStart(2, '0')} · ${chunk.rowTypeName}`)
    }
    return [...options].map(([value, label]) => ({ value, label })).sort((a, b) => a.value === 'all' ? -1 : b.value === 'all' ? 1 : a.label.localeCompare(b.label))
  }, [overview])

  const filteredChunks = useMemo(() => {
    if (!overview) return []
    const query = chunkSearch.trim().toLocaleLowerCase()
    const chunks = overview.chunks.filter(chunk => {
      if (lapFilter !== 'all' && chunk.lapNumber !== Number(lapFilter)) return false
      if (typeFilter.startsWith('contains:')) {
        if (!chunk.typeCounts?.[typeFilter.slice('contains:'.length)]) return false
      } else if (typeFilter !== 'all' && chunk.rowType !== Number(typeFilter)) return false
      if (!query) return true
      return `${chunk.index} ${chunk.id} ${chunk.rowTypeName} ${Object.keys(chunk.typeCounts ?? {}).join(' ')} ${chunk.rowType} ${chunk.sequence} ${chunk.lapNumber ?? ''} ${chunk.visibility}`.toLocaleLowerCase().includes(query)
    })
    return chunks.sort((a, b) => {
      const left = a[sortKey]
      const right = b[sortKey]
      if (left === right) return (a.index - b.index) * sortDirection
      if (left === null) return 1
      if (right === null) return -1
      if (typeof left === 'boolean' && typeof right === 'boolean') return (Number(left) - Number(right)) * sortDirection
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * sortDirection
      return String(left).localeCompare(String(right)) * sortDirection
    })
  }, [chunkSearch, lapFilter, overview, sortDirection, sortKey, typeFilter])

  const selectedChunk = overview?.chunks.find(chunk => chunk.id === selectedId) ?? null
  const tablePages = Math.max(1, Math.ceil(filteredChunks.length / PAGE_SIZE))
  const visibleRows = filteredChunks.slice(tablePage * PAGE_SIZE, (tablePage + 1) * PAGE_SIZE)
  const selectStyles = useMemo(() => buildSelectStyles(theme !== 'light', { solidBg: true, controlHeight: 28 }), [theme])

  useEffect(() => setTablePage(page => Math.min(page, tablePages - 1)), [tablePages])

  const selectChunk = useCallback((chunk: ChunkInfo, reveal: boolean) => {
    setSelectedId(chunk.id)
    setSelectedRegion(null)
    if (reveal) {
      const position = filteredChunks.findIndex(item => item.id === chunk.id)
      if (position >= 0) setTablePage(Math.floor(position / PAGE_SIZE))
    }
  }, [filteredChunks])

  const selectRegion = useCallback((region: RegionInfo) => {
    setSelectedId(null)
    setSelectedRegion(region)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedId(null)
    setSelectedRegion(null)
  }, [])

  const openRaw = useCallback((chunk: ChunkInfo) => {
    setControlRegion(null)
    setRawChunk(chunk)
    setRawPageIndex(0)
    setRawQuery('')
    setRawResult(null)
    setRawError(null)
  }, [])

  const openControlRegion = useCallback((region: RegionInfo) => {
    setRawChunk(null)
    setSelectedId(null)
    setSelectedRegion(region)
    setControlRegion(region)
    setControlPageIndex(0)
    setControlPage(null)
    setControlError(null)
  }, [])

  useEffect(() => {
    if (!overview || !rawChunk) return
    const timer = window.setTimeout(() => {
      const request = ++rawRequest.current
      setRawLoading(true)
      setRawError(null)
      void window.tnrdViewer.rawPage({
        fileId: overview.fileId,
        chunkId: rawChunk.id,
        page: rawPageIndex,
        pageSize: RAW_PAGE_SIZE,
        query: rawQuery,
      }).then(page => {
        if (request !== rawRequest.current) return
        setRawResult(page)
        setRawPageIndex(page.page)
      }).catch(error => {
        if (request === rawRequest.current) setRawError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (request === rawRequest.current) setRawLoading(false)
      })
    }, rawQuery ? 240 : 0)
    return () => window.clearTimeout(timer)
  }, [overview?.fileId, rawChunk?.id, rawPageIndex, rawQuery])

  useEffect(() => {
    if (!overview || !controlRegion) return
    let current = true
    setControlLoading(true)
    setControlError(null)
    void window.tnrdViewer.controlRegionPage({
      fileId: overview.fileId,
      name: controlRegion.name,
      start: controlRegion.start,
      size: controlRegion.size,
      page: controlPageIndex,
      pageSize: CONTROL_PAGE_SIZE,
    }).then(page => {
      if (!current) return
      setControlPage(page)
      setControlPageIndex(page.page)
    }).catch(error => {
      if (current) setControlError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (current) setControlLoading(false)
    })
    return () => { current = false }
  }, [overview?.fileId, controlRegion, controlPageIndex])

  const changeSort = (key: SortKey): void => {
    if (sortKey === key) setSortDirection(direction => direction === 1 ? -1 : 1)
    else { setSortKey(key); setSortDirection(1) }
    setTablePage(0)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    const path = window.tnrdViewer.pathForDroppedFile(file)
    if (path) void openRecording(window.tnrdViewer.openPath(path))
  }

  const compressedFiltered = filteredChunks.reduce((sum, chunk) => sum + chunk.compressedSize, 0)
  const selectedFields: Array<[string, string]> = selectedChunk ? [
    ['Scope', selectedChunk.lapNumber === null ? 'Multiple laps' : selectedChunk.lapNumber === 0 ? 'Session' : `Lap ${selectedChunk.lapNumber}`],
    ['Sequence', selectedChunk.sequence.toLocaleString()],
    ['Rows', selectedChunk.rowCount.toLocaleString()],
    ['Time', selectedChunk.firstTime === null ? 'Unavailable' : `${formatTime(selectedChunk.firstTime)} – ${formatTime(selectedChunk.lastTime)}${selectedChunk.timeEstimated ? ' (estimated)' : ''}`],
    ['Compressed', `${selectedChunk.kind === 'stream-block' ? '≈ ' : ''}${formatBytes(selectedChunk.compressedSize)}`],
    ['Plain', `${formatBytes(selectedChunk.uncompressedSize)} (${compressionRatio(selectedChunk)})`],
    ['Payload', formatOffset(selectedChunk.payloadOffset)],
    ['Prefix', selectedChunk.prefixValid === null ? 'Not applicable' : selectedChunk.prefixValid ? 'Valid' : 'INVALID'],
  ] : []
  if (selectedChunk && selectedChunk.branchWallClockMs !== null) {
    const date = new Date(selectedChunk.branchWallClockMs)
    selectedFields.push(['Branch wall clock', Number.isNaN(date.valueOf()) ? String(selectedChunk.branchWallClockMs) : date.toISOString()])
  }
  if (selectedChunk && selectedChunk.logicalLastTime !== null && selectedChunk.lastTime !== null && selectedChunk.logicalLastTime < selectedChunk.lastTime) selectedFields.push(['Logical cutoff', formatTime(selectedChunk.logicalLastTime)])
  if (selectedChunk?.typeCounts) selectedFields.push(['Contains', Object.entries(selectedChunk.typeCounts).map(([name, count]) => `${name} ${count}`).join(' · ')])

  const selectedRegionFields: Array<[string, string]> = selectedRegion ? [
    ['Offset', `${selectedRegion.start.toLocaleString()} · 0x${selectedRegion.start.toString(16).toUpperCase()}`],
    ['End', `${(selectedRegion.start + selectedRegion.size).toLocaleString()} · 0x${(selectedRegion.start + selectedRegion.size).toString(16).toUpperCase()}`],
    ['Size', formatBytes(selectedRegion.size)],
    ['Description', selectedRegion.detail ?? 'Control-plane region'],
  ] : []
  const selectedRegionContent = decodedRegionContent(selectedRegion, overview)

  const rawPages = Math.max(1, Math.ceil((rawResult?.filteredLines ?? 0) / (rawResult?.pageSize ?? RAW_PAGE_SIZE)))
  const controlPages = Math.max(1, Math.ceil((controlPage?.totalBytes ?? controlRegion?.size ?? 0) / (controlPage?.pageSize ?? CONTROL_PAGE_SIZE)))
  const rawChecks: string[] = []
  if (rawResult?.checksumValid !== null && rawResult?.checksumValid !== undefined) rawChecks.push(rawResult.checksumValid ? 'CRC OK' : 'CRC FAILED')
  if (rawResult?.rowCountValid !== null && rawResult?.rowCountValid !== undefined) rawChecks.push(rawResult.rowCountValid ? 'row count OK' : 'row count mismatch')
  if (rawResult) rawChecks.push(formatBytes(rawResult.totalBytes))

  return (
    <div className="app-shell" onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false) }} onDrop={onDrop}>
      <main className={dragging ? 'dragging' : ''}>
        {!overview ? (
          <section className="empty-state">
            <div className="empty-art" aria-hidden="true"><span /><span /><span /><span /><span /></div>
            <div className="eyebrow">TNRD V1—V5</div>
            <h1>See what is actually inside the recording.</h1>
            <p>Inspect physical layout, logical time, compression, branches, and the raw JSONL stored in every chunk.</p>
            <button className="primary-button" onClick={() => void openRecording(window.tnrdViewer.openDialog())}>Open a TNRD recording</button>
            <span className="drop-hint">or drop a .tnrd file anywhere</span>
          </section>
        ) : (
          <section className="workspace">
            <div className="session-strip">
              <div className="session-copy">
                <h1>{typeof overview.metadata.track_name === 'string' ? overview.metadata.track_name : 'Unknown track'} · {typeof overview.metadata.session_name === 'string' ? overview.metadata.session_name : typeof overview.metadata.session_type === 'number' ? `Session ${overview.metadata.session_type}` : 'Unknown session'}</h1>
                <p>{overview.path}</p>
              </div>
              <div className="metric"><span>FILE</span><strong>{formatBytes(overview.fileSize)}</strong></div>
              <div className="metric"><span>CHUNKS</span><strong>{overview.chunks.length.toLocaleString()}</strong></div>
              <div className="metric"><span>ROWS</span><strong>{overview.totalRows.toLocaleString()}</strong></div>
              <div className="metric"><span>COMPRESSION</span><strong>{overview.uncompressedPayloadBytes ? `${(overview.compressedPayloadBytes / overview.uncompressedPayloadBytes * 100).toFixed(1)}%` : '—'}</strong></div>
              <div className="metric"><span>FORMAT</span><strong>{overview.generation.replace('_', ' ')}</strong></div>
            </div>

            <div className="toolbar no-drag">
              <div className="segmented" aria-label="View mode">{(['physical', 'timeline', 'sequence'] as ViewMode[]).map(mode => <button key={mode} className={viewMode === mode ? 'active' : ''} onClick={() => setViewMode(mode)}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div>
              <label><AnimatedSelect<Option> aria-label="Lap" value={selectedValue(lapOptions, lapFilter)} options={lapOptions} onChange={(option: SingleValue<Option>) => { setLapFilter(option?.value ?? 'all'); setTablePage(0) }} styles={selectStyles} menuPortalTarget={document.body} isSearchable={false} /></label>
              <label className="family-select"><AnimatedSelect<Option> aria-label="Family" value={selectedValue(typeOptions, typeFilter)} options={typeOptions} onChange={(option: SingleValue<Option>) => { setTypeFilter(option?.value ?? 'all'); setTablePage(0) }} styles={selectStyles} menuPortalTarget={document.body} /></label>
              <label className="search-label"><input type="search" aria-label="Filter chunks" value={chunkSearch} onChange={event => { setChunkSearch(event.target.value); setTablePage(0) }} placeholder="Filter (index, type, sequence…)" /></label>
              <button className="secondary-button" onClick={() => setFitVersion(value => value + 1)}>Fit view</button>
              <span className="filtered-summary">{filteredChunks.length.toLocaleString()} / {overview.chunks.length.toLocaleString()} · {formatBytes(compressedFiltered)}</span>
            </div>

            <div className="visual-grid">
              <section className="map-panel">
                <div className="panel-heading map-heading"><div><span className="eyebrow">CHUNK MAP</span><h2>{viewMode === 'physical' ? ['TNRD_V1', 'TNRD_V2', 'TNRD_V3'].includes(overview.generation) ? 'Estimated compressed-stream layout' : 'Physical file layout' : viewMode === 'timeline' ? 'Logical session timeline' : 'Chunk sequence'}</h2></div><p className="map-instructions">Scroll for lanes · Ctrl + wheel to zoom · Shift + wheel or drag to pan · Double-click for raw data</p></div>
                <ChunkCanvas key={overview.fileId} overview={overview} filtered={filteredChunks} selectedId={selectedId} selectedRegion={selectedRegion} mode={viewMode} fitVersion={fitVersion} onSelect={selectChunk} onSelectRegion={selectRegion} onOpenRegion={openControlRegion} onOpenRaw={openRaw} onClearSelection={clearSelection} />
              </section>

              <aside className="inspector-panel">
                <div className="panel-heading"><div><span className="eyebrow">INSPECTOR</span><h2>Selection</h2></div></div>
                {!selectedChunk && !selectedRegion ? <div className="selection-empty">Select a chunk, directory row, or control-plane region.</div> : selectedRegion ? <div className="selection-details">
                  <div className="selection-accent"><span>{selectedRegion.name}</span><strong>CONTROL</strong></div>
                  <dl>{selectedRegionFields.map(([term, description]) => <div className="field-row" key={term}><dt>{term}</dt><dd title={description}>{description}</dd></div>)}</dl>
                  {selectedRegionContent ? <pre className="control-region-preview">{selectedRegionContent}</pre> : null}
                </div> : <div className="selection-details">
                  <div className="selection-accent"><span>{String(selectedChunk.rowType).padStart(2, '0')} · {selectedChunk.rowTypeName}</span><strong>#{selectedChunk.index}</strong></div>
                  <dl>{selectedFields.map(([term, description]) => <div className="field-row" key={term}><dt>{term}</dt><dd title={description}>{description}</dd></div>)}</dl>
                  <button className="primary-button full-width" onClick={() => openRaw(selectedChunk)}>View raw JSONL</button>
                </div>}
                <details className="json-details"><summary>Session metadata</summary><pre>{JSON.stringify(overview.metadata, null, 2)}</pre></details>
                <details className="json-details"><summary>Control summary</summary><pre>{Object.keys(overview.summary).length ? JSON.stringify(overview.summary, null, 2) : 'No separate control summary in this generation.'}</pre></details>
                <details className="json-details"><summary>Third-party licenses</summary><pre>{thirdPartyNotices}</pre></details>
              </aside>
            </div>

            <section className="table-panel">
              <div className="panel-heading table-heading"><div><span className="eyebrow">DIRECTORY</span><h2>Chunks</h2></div><Pager page={tablePage} pages={tablePages} onChange={setTablePage} /></div>
              <div className="table-scroll"><table><thead><tr>{([
                ['index', '#'], ['lapNumber', 'Lap'], ['rowType', 'Row family'], ['sequence', 'Sequence'], ['firstTime', 'Time span'], ['payloadOffset', 'Payload offset'], ['compressedSize', 'Compressed'], ['uncompressedSize', 'Plain'], ['rowCount', 'Rows'], ['prefixValid', 'Prefix'],
              ] as Array<[SortKey, string]>).map(([key, label]) => <th key={key} onClick={() => changeSort(key)}>{label}{sortKey === key ? <span className="sort-mark">{sortDirection === 1 ? ' ↑' : ' ↓'}</span> : null}</th>)}</tr></thead><tbody>{visibleRows.map(chunk => <tr key={chunk.id} className={selectedId === chunk.id ? 'selected' : ''} onClick={() => selectChunk(chunk, false)} onDoubleClick={() => openRaw(chunk)}>
                <td className="numeric">{chunk.index}</td><td className="numeric">{chunk.lapNumber === null ? 'Mixed' : chunk.lapNumber === 0 ? 'Session' : chunk.lapNumber}</td><td style={{ color: familyColors[chunk.rowType] }}>{String(chunk.rowType).padStart(2, '0')} · {chunk.rowTypeName}</td><td className="numeric">{chunk.sequence.toLocaleString()}</td><td className="numeric">{chunk.firstTime === null ? '—' : `${formatTime(chunk.firstTime)}–${formatTime(chunk.logicalLastTime ?? chunk.lastTime)}${chunk.timeEstimated ? ' ≈' : ''}`}</td><td className="numeric">{formatOffset(chunk.payloadOffset)}</td><td className="numeric">{chunk.kind === 'stream-block' ? '≈ ' : ''}{formatBytes(chunk.compressedSize)}</td><td className="numeric">{formatBytes(chunk.uncompressedSize)} · {compressionRatio(chunk)}</td><td className="numeric">{chunk.rowCount.toLocaleString()}</td><td className={chunk.prefixValid === false ? 'prefix-bad' : ''}>{chunk.prefixValid === null ? 'N/A' : chunk.prefixValid ? 'OK' : 'INVALID'}</td>
              </tr>)}</tbody></table></div>
            </section>
          </section>
        )}
      </main>

      <footer className="statusbar"><span>{status}</span>{progress !== null ? <div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} /></div> : null}</footer>

      {controlRegion && overview ? <div className="modal-backdrop" data-state="open" onMouseDown={event => { if (event.currentTarget === event.target) setControlRegion(null) }}><section className="raw-modal control-modal modal-panel" role="dialog" aria-modal="true">
        <header className="raw-header"><div><span className="eyebrow">CONTROL PLANE DATA</span><h2>{controlRegion.name}</h2><p>{overview.generation} · {formatOffset(controlRegion.start)} · {formatBytes(controlRegion.size)}</p></div><button className="icon-button large" onClick={() => setControlRegion(null)} aria-label="Close control-plane viewer">×</button></header>
        <div className="raw-toolbar"><span className="raw-integrity">RAW BYTES {controlPage ? `${formatOffset(controlRegion.start + controlPage.pageOffset)} · ${formatBytes(controlPage.totalBytes)}` : ''}</span><button className="secondary-button" disabled={!controlPage?.lines.length} onClick={() => void navigator.clipboard.writeText(controlPage?.lines.join('\n') ?? '').then(() => showToast('Current control-plane page copied'))}>Copy page</button><Pager page={controlPageIndex} pages={controlPages} onChange={setControlPageIndex} /></div>
        <div className="control-data">{decodedRegionContent(controlRegion, overview) ? <section><span className="eyebrow">DECODED</span><pre>{decodedRegionContent(controlRegion, overview)}</pre></section> : null}<section className="control-hex"><span className="eyebrow">HEX / ASCII</span>{controlLoading ? <div className="raw-loading">Reading control-plane bytes…</div> : controlError ? <div className="raw-loading">Could not read region: {controlError}</div> : <pre>{controlPage?.lines.join('\n') || 'This region is empty.'}</pre>}</section></div>
      </section></div> : null}

      {rawChunk && overview ? <div className="modal-backdrop" data-state="open" onMouseDown={event => { if (event.currentTarget === event.target) setRawChunk(null) }}><section className="raw-modal modal-panel" role="dialog" aria-modal="true">
        <header className="raw-header"><div><span className="eyebrow">DECOMPRESSED PAYLOAD</span><h2>{rawChunk.kind === 'stream-block' ? 'Stream block' : 'Chunk'} #{rawChunk.index} · {rawChunk.rowTypeName}</h2><p>{overview.generation} · {rawChunk.rowCount.toLocaleString()} rows · {formatBytes(rawChunk.uncompressedSize)} decompressed{rawChunk.visibility !== 'active' ? ` · ${rawChunk.visibility} physical payload` : ''}</p></div><button className="icon-button large" onClick={() => setRawChunk(null)} aria-label="Close raw viewer">×</button></header>
        <div className="raw-toolbar"><input type="search" value={rawQuery} onChange={event => { setRawQuery(event.target.value); setRawPageIndex(0) }} placeholder="Search this chunk…" /><button className="secondary-button" disabled={!rawResult?.lines.length} onClick={() => void navigator.clipboard.writeText(rawResult?.lines.map(line => line.text).join('\n') ?? '').then(() => showToast('Current raw page copied'))}>Copy page</button><button className="secondary-button" onClick={() => void window.tnrdViewer.exportChunk(overview.fileId, rawChunk.id).then(result => result.ok ? showToast(`Exported ${result.path}`) : result.error && showToast(result.error, true))}>Export JSONL</button><span className="raw-integrity">{rawChecks.join(' · ')}</span><Pager page={rawPageIndex} pages={rawPages} onChange={setRawPageIndex} /></div>
        <div className="raw-lines">{rawLoading ? <div className="raw-loading">{rawChunk.kind === 'container' ? 'Decompressing chunk in Node…' : 'Reading indexed stream block…'}</div> : rawError ? <div className="raw-loading">Could not read chunk: {rawError}</div> : rawResult?.lines.length ? rawResult.lines.map(line => <div className="raw-line" key={line.number}><span className="raw-line-number">{line.number.toLocaleString()}</span><code>{line.text}</code></div>) : <div className="raw-loading">{rawQuery ? 'No lines match this search.' : 'This chunk is empty.'}</div>}</div>
      </section></div> : null}

      {toast ? <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.text}</div> : null}
    </div>
  )
}
