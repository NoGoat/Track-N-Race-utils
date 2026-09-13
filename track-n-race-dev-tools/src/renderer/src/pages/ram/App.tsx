import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { GroupBase, SingleValue } from 'react-select'
import AnimatedSelect from './AnimatedSelect'
import { RamChart } from './RamChart'
import { buildSelectStyles } from './selectStyles'
import type { MetricMode, ProcessScope } from './RamChart'
import type { CategorySummary, OpenResult, ProcessSummary, RamLogOverview, RamLogUpdate } from '../../../../shared/ramTypes'
import reactLicense from './assets/licenses/react.txt?raw'
import reactDomLicense from './assets/licenses/react-dom.txt?raw'
import reactSelectLicense from './assets/licenses/react-select.txt?raw'
import uplotLicense from './assets/licenses/uplot.txt?raw'
import cascadiaLicense from '../tnrd/assets/licenses/cascadia-code.txt?raw'
import type { Theme } from '../../types'

type SortKey = 'type' | 'pid' | 'sampleCount' | 'currentWorkingSetKb' | 'peakWorkingSetKb' | 'currentPrivateKb' | 'peakPrivateKb'
interface Option { value: ProcessScope; label: string }
const processColors: Record<string, string> = { browser: '#73bf69', tab: '#5794f2', gpu: '#ff9830', utility: '#a48ad4', renderer: '#33b5e5' }
const categoryColors = ['#56d4dd', '#fade2a', '#ff7383', '#8ab8ff', '#73bf69', '#b877d9']

const thirdPartyNotices = `React 19.2.7 — MIT\n\n${reactLicense}\n\nReact DOM 19.2.7 — MIT\n\n${reactDomLicense}\n\nreact-select 5.10.2 — MIT\n\n${reactSelectLicense}\n\nuPlot 1.6.32 — MIT\n\n${uplotLicense}\n\nCascadia Code — SIL Open Font License 1.1\n\n${cascadiaLicense}`

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = bytes
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++ }
  return unit ? `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[unit]}` : `${Math.round(bytes).toLocaleString()} B`
}

function formatKb(kb: number | null): string {
  return kb === null ? '—' : formatBytes(kb * 1024)
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds) / 1000
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`
    : `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}

function processLabel(process: Pick<ProcessSummary, 'pid' | 'type' | 'name'>): string {
  return `${process.type}${process.name ? ` · ${process.name}` : ''} · PID ${process.pid}`
}

function processColor(type: string): string {
  return processColors[type.toLocaleLowerCase()] ?? '#ff7383'
}

function categoryLabel(category: Pick<CategorySummary, 'name' | 'type'>): string {
  return `${category.name} · ${category.type}`
}

function metricValue(mode: MetricMode): string {
  return mode === 'working' ? 'Working set' : mode === 'private' ? 'Private' : 'Both metrics'
}

export default function App({ active, theme, openRequest: shellOpenRequest, onFileNameChange }: { active: boolean; theme: Theme; openRequest: number; onFileNameChange: (name: string | null) => void }) {
  const [overview, setOverview] = useState<RamLogOverview | null>(null)
  const [mode, setMode] = useState<MetricMode>('both')
  const [scope, setScope] = useState<ProcessScope>('total')
  const [fitVersion, setFitVersion] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [sortKey, setSortKey] = useState<SortKey>('peakWorkingSetKb')
  const [sortDirection, setSortDirection] = useState<1 | -1>(-1)
  const [dragging, setDragging] = useState(false)
  const [status, setStatus] = useState('Ready')
  const [liveState, setLiveState] = useState<'idle' | 'watching' | 'error'>('idle')
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  const openRequest = useRef(0)
  const handledShellOpenRequest = useRef(shellOpenRequest)
  const overviewRef = useRef<RamLogOverview | null>(null)
  const selectedIndexRef = useRef(0)
  overviewRef.current = overview
  selectedIndexRef.current = selectedIndex

  const showToast = useCallback((text: string, error = false) => setToast({ text, error }), [])
  const openLog = useCallback(async (promise: Promise<OpenResult>) => {
    const request = ++openRequest.current
    setStatus('Opening RAM usage log…')
    const result = await promise
    if (request !== openRequest.current) return
    if (!result.ok || !result.data) {
      setStatus(result.error ? `Open failed: ${result.error}` : 'Ready')
      if (result.error) showToast(result.error, true)
      return
    }
    const data = result.data
    overviewRef.current = data
    setOverview(data)
    setMode('both')
    setScope('total')
    setSelectedIndex(data.samples.length - 1)
    setFitVersion(value => value + 1)
    setLiveState('watching')
    setStatus(`Watching ${data.name} · ${data.samples.length.toLocaleString()} samples${data.invalidLines ? ` · skipped ${data.invalidLines.toLocaleString()} invalid lines` : ''}`)
    onFileNameChange(data.name)
  }, [onFileNameChange, showToast])

  useEffect(() => {
    if (!active || handledShellOpenRequest.current === shellOpenRequest) return
    handledShellOpenRequest.current = shellOpenRequest
    void openLog(window.ramViewer.openDialog())
  }, [active, openLog, shellOpenRequest])

  useEffect(() => {
    const removeOpen = window.ramViewer.onOpenPath(path => { void openLog(window.ramViewer.openPath(path)) })
    const removeLogUpdate = window.ramViewer.onLogUpdate((update: RamLogUpdate) => {
      const current = overviewRef.current
      if (update.kind === 'error') {
        if (!current || current.fileId !== update.fileId) return
        setLiveState('error')
        setStatus(`Waiting for log updates: ${update.error}`)
        return
      }
      if (update.kind === 'replace') {
        overviewRef.current = update.data
        setOverview(update.data)
        setScope('total')
        setSelectedIndex(update.data.samples.length - 1)
        setFitVersion(value => value + 1)
        setLiveState('watching')
        setStatus(`Log restarted · watching ${update.data.samples.length.toLocaleString()} samples`)
        return
      }
      if (!current || current.fileId !== update.fileId) return
      const wasFollowingLatest = selectedIndexRef.current >= current.samples.length - 1
      const next: RamLogOverview = {
        ...current,
        fileSize: update.fileSize,
        invalidLines: update.invalidLines,
        samples: [...current.samples, ...update.samples],
        processes: update.processes,
        categories: update.categories,
        lastTimestamp: update.lastTimestamp,
        durationMs: update.durationMs,
        medianIntervalMs: update.medianIntervalMs,
        peakWorkingSetKb: update.peakWorkingSetKb,
        peakPrivateKb: update.peakPrivateKb,
      }
      overviewRef.current = next
      setOverview(next)
      if (wasFollowingLatest && update.samples.length) setSelectedIndex(next.samples.length - 1)
      setLiveState('watching')
      setStatus(`Live · ${next.samples.length.toLocaleString()} samples · updated ${new Date(next.lastTimestamp).toLocaleTimeString()}`)
    })
    const keydown = (event: KeyboardEvent): void => {
      if (!active) return
      if (event.key.toLocaleLowerCase() === 'f') setFitVersion(value => value + 1)
    }
    window.addEventListener('keydown', keydown)
    return () => {
      removeOpen()
      removeLogUpdate()
      window.removeEventListener('keydown', keydown)
    }
  }, [active, openLog])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const sortedProcesses = useMemo(() => {
    const processes = [...(overview?.processes ?? [])]
    return processes.sort((left, right) => {
      const a = left[sortKey]
      const b = right[sortKey]
      if (a === b) return left.pid - right.pid
      if (a === null) return 1
      if (b === null) return -1
      return (typeof a === 'string' ? a.localeCompare(String(b)) : a - Number(b)) * sortDirection
    })
  }, [overview, sortDirection, sortKey])

  const selectedSampleIndex = overview ? Math.min(selectedIndex, overview.samples.length - 1) : 0
  const selectedSample = overview?.samples[selectedSampleIndex] ?? null
  const selectedPid = scope.startsWith('pid:') ? Number(scope.slice('pid:'.length)) : null
  const selectedComponentScope = scope.startsWith('component:') ? scope.slice('component:'.length).split(':') : null
  const selectedComponentCategoryKey = selectedComponentScope?.[0] ?? null
  const selectedComponentKey = selectedComponentScope?.[1] ?? null
  const selectedCategoryKey = scope.startsWith('category:') ? scope.slice('category:'.length) : selectedComponentCategoryKey
  const isCategoryScope = scope === 'categories' || selectedCategoryKey !== null
  const selectedProcess = selectedPid === null ? null : selectedSample?.processes.find(process => process.pid === selectedPid) ?? null
  const selectedCategory = selectedCategoryKey === null ? null : selectedSample?.categories.find(category => category.key === selectedCategoryKey) ?? null
  const selectedComponent = selectedComponentKey === null ? null : selectedCategory?.components.find(component => component.key === selectedComponentKey) ?? null
  const selectedSummary = selectedPid === null ? null : overview?.processes.find(process => process.pid === selectedPid) ?? null
  const selectedCategorySummary = selectedCategoryKey === null ? null : overview?.categories.find(category => category.key === selectedCategoryKey) ?? null
  const categoryRetainedKb = selectedComponentKey !== null
    ? selectedComponent?.retainedKb ?? null
    : selectedCategoryKey !== null
    ? selectedCategory?.retainedKb ?? null
    : scope === 'categories'
    ? selectedSample?.categories.reduce((total, category) => total + category.retainedKb, 0) ?? null
    : null
  const inspectedWorkingSetKb = isCategoryScope ? categoryRetainedKb : selectedPid === null ? selectedSample?.totalWorkingSetKb ?? null : selectedProcess?.workingSetKb ?? null
  const inspectedPrivateKb = isCategoryScope ? null : selectedPid === null ? selectedSample?.totalPrivateKb ?? null : selectedProcess?.privateKb ?? null
  const scopeOptions = useMemo<GroupBase<Option>[]>(() => {
    const componentOptions = new Map<string, Option>()
    for (const sample of overview?.samples ?? []) {
      for (const category of sample.categories) {
        for (const component of category.components) {
          const value = `component:${category.key}:${component.key}` as ProcessScope
          if (!componentOptions.has(value)) componentOptions.set(value, { value, label: `${category.name} · ${component.label}` })
        }
      }
    }
    return [
      {
        label: 'Overview',
        options: [
          { value: 'total', label: 'Application total' },
          { value: 'processes', label: 'All processes' },
        ],
      },
      {
        label: 'Processes',
        options: (overview?.processes ?? []).map(process => ({
          value: `pid:${process.pid}`,
          label: processLabel(process),
        })),
      },
      ...((overview?.categories.length ?? 0) ? [{
        label: 'Attributed data',
        options: [
          { value: 'categories' as const, label: 'All attributed categories' },
          ...(overview?.categories ?? []).map(category => ({
            value: `category:${category.key}` as ProcessScope,
            label: categoryLabel(category),
          })),
        ],
      }] : []),
      ...(componentOptions.size ? [{
        label: 'Retention detail',
        options: [...componentOptions.values()],
      }] : []),
    ]
  }, [overview])
  const selectedScopeOption = scopeOptions
    .flatMap(group => group.options)
    .find(option => option.value === scope) ?? null
  const selectStyles = useMemo(() => buildSelectStyles(theme !== 'light', {
    solidBg: true,
    controlHeight: 28,
    labelStyleGroupHeadings: true,
  }), [theme])

  const changeSort = (key: SortKey): void => {
    if (sortKey === key) setSortDirection(direction => direction === 1 ? -1 : 1)
    else { setSortKey(key); setSortDirection(key === 'type' || key === 'pid' ? 1 : -1) }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    const path = window.ramViewer.pathForDroppedFile(file)
    if (path) void openLog(window.ramViewer.openPath(path))
  }

  return (
    <div className="app-shell" onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false) }} onDrop={onDrop}>
      <main className={dragging ? 'dragging' : ''}>
        {!overview ? (
          <section className="empty-state">
            <div className="empty-art" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /></div>
            <div className="eyebrow">DIAGNOSTICS JSONL</div>
            <h1>See where the application memory goes.</h1>
            <p>Plot total and per-process working-set and private memory from a Track N Race <code>ram_usage.log</code>.</p>
            <button className="primary-button" onClick={() => void openLog(window.ramViewer.openDialog())}>Open a RAM usage log</button>
            <span className="drop-hint">or drop ram_usage.log anywhere</span>
          </section>
        ) : (
          <section className="workspace">
            <div className="session-strip">
              <div className="session-copy"><h1>RAM usage · {overview.samples.length.toLocaleString()} samples</h1><p>{overview.path}</p></div>
              <div className="metric"><span>FILE</span><strong>{formatBytes(overview.fileSize)}</strong></div>
              <div className="metric"><span>SAMPLES</span><strong>{overview.samples.length.toLocaleString()}</strong></div>
              <div className="metric"><span>DURATION</span><strong>{formatDuration(overview.durationMs)}</strong></div>
              <div className="metric"><span>PEAK WORKING</span><strong>{formatKb(overview.peakWorkingSetKb)}</strong></div>
              <div className="metric"><span>PEAK PRIVATE</span><strong>{formatKb(overview.peakPrivateKb)}</strong></div>
              {overview.categories[0] ? <div className="metric"><span>PEAK ATTRIBUTED</span><strong>{formatKb(overview.categories[0].peakRetainedKb)}</strong></div> : null}
            </div>

            <div className="toolbar no-drag">
              <div className="segmented" aria-label="Memory metric">{(['working', 'private', 'both'] as MetricMode[]).map(value => <button key={value} disabled={isCategoryScope} className={mode === value && !isCategoryScope ? 'active' : ''} onClick={() => setMode(value)}>{metricValue(value)}</button>)}</div>
              <label className="scope-label"><span className="sr-only">Process scope</span><AnimatedSelect<Option, false, GroupBase<Option>> aria-label="Process scope" value={selectedScopeOption} options={scopeOptions} onChange={(option: SingleValue<Option>) => { if (option) setScope(option.value) }} styles={selectStyles} menuPortalTarget={document.body} isSearchable /></label>
              <button className="secondary-button" onClick={() => setFitVersion(value => value + 1)}>Fit view</button>
              <span className={`live-indicator ${liveState}`}><i />{liveState === 'error' ? 'Waiting' : 'Live'}</span>
              <span className="filtered-summary">{overview.processes.length.toLocaleString()} processes · {overview.categories.length.toLocaleString()} attributed · {overview.medianIntervalMs === null ? 'unknown cadence' : `${(overview.medianIntervalMs / 1000).toFixed(2)} s cadence`}</span>
            </div>

            <div className="visual-grid">
              <section className="chart-panel">
                <div className="panel-heading chart-heading"><div><span className="eyebrow">MEMORY TIMELINE</span><h2>{selectedScopeOption?.label ?? 'Selected source'}</h2></div><div className="chart-help"><div className="chart-key">{isCategoryScope ? <span><i className="attributed" />Retained</span> : <>{mode !== 'private' ? <span><i />Working set</span> : null}{mode !== 'working' ? <span><i className="dashed" />Private</span> : null}</>}</div><p className="chart-instructions">Drag to zoom · Ctrl + wheel to zoom · Shift + wheel to pan · F to fit</p></div></div>
                <RamChart overview={overview} mode={mode} scope={scope} fitVersion={fitVersion} theme={theme} onSelectIndex={setSelectedIndex} />
              </section>

              <aside className="inspector-panel">
                <div className="panel-heading"><div><span className="eyebrow">INSPECTOR</span><h2>Cursor sample</h2></div></div>
                {selectedSample ? <div className="selection-details">
                  <div className="selection-accent"><span>{formatDuration(selectedSample.elapsedMs)}</span><strong>#{selectedIndex + 1}</strong></div>
                  <dl>
                    <div className="field-row"><dt>Timestamp</dt><dd title={selectedSample.timestamp}>{new Date(selectedSample.timestamp).toLocaleString()}</dd></div>
                    <div className="field-row"><dt>{isCategoryScope ? 'Retained' : 'Working set'}</dt><dd>{formatKb(inspectedWorkingSetKb)}</dd></div>
                    {!isCategoryScope ? <div className="field-row"><dt>Private</dt><dd>{formatKb(inspectedPrivateKb)}</dd></div> : null}
                    <div className="field-row"><dt>Sources</dt><dd>{selectedSample.categoryCount.toLocaleString()}</dd></div>
                    {selectedSummary ? <div className="field-row"><dt>Peak working</dt><dd>{formatKb(selectedSummary.peakWorkingSetKb)}</dd></div> : null}
                    {selectedSummary ? <div className="field-row"><dt>Peak private</dt><dd>{formatKb(selectedSummary.peakPrivateKb)}</dd></div> : null}
                    {selectedCategorySummary && selectedComponentKey === null ? <div className="field-row"><dt>Peak retained</dt><dd>{formatKb(selectedCategorySummary.peakRetainedKb)}</dd></div> : null}
                    {selectedCategory ? <div className="field-row"><dt>Mode</dt><dd>{selectedCategory.mode ?? 'Unknown'}</dd></div> : null}
                    {selectedCategory ? <div className="field-row"><dt>In process totals</dt><dd>{selectedCategory.alreadyIncludedInProcessTotals ? 'Yes · do not add again' : 'No'}</dd></div> : null}
                    {selectedCategory ? <div className="field-row"><dt>Renderer age</dt><dd>{selectedCategory.rendererSampleAgeMs === null ? '—' : `${selectedCategory.rendererSampleAgeMs.toLocaleString()} ms`}</dd></div> : null}
                  </dl>
                </div> : null}
                {selectedSample?.categories.length ? <div className="process-breakdown attribution-breakdown">
                  <span className="eyebrow">ATTRIBUTED DATA</span>
                  {selectedSample.categories.map((category, index) => <button key={category.key} style={{ borderLeftColor: categoryColors[index % categoryColors.length] }} className={selectedCategoryKey === category.key ? 'selected' : ''} onClick={() => setScope(`category:${category.key}`)}>
                    <span><strong>{category.name}</strong><small>{category.mode ?? category.type}{category.alreadyIncludedInProcessTotals ? ' · included in totals' : ''}</small></span><span>{formatKb(category.retainedKb)}</span>
                  </button>)}
                </div> : null}
                {selectedCategory?.components.length ? <div className="category-components">
                  <span className="eyebrow">RETENTION DETAIL</span>
                  <dl>{selectedCategory.components.map(component => <div className="field-row" key={component.key}><dt>{component.label}</dt><dd>{formatKb(component.retainedKb)}</dd></div>)}</dl>
                  {selectedCategory.counters.length ? <>
                    <span className="eyebrow detail-subheading">NATIVE HISTORY STATE</span>
                    <dl>{selectedCategory.counters.map(counter => <div className="field-row" key={counter.key}><dt>{counter.label}</dt><dd>{counter.value.toLocaleString()}</dd></div>)}</dl>
                  </> : null}
                  {selectedCategory.nativeLiveHistoryEstimateBasis ? <p>Native history estimate: {selectedCategory.nativeLiveHistoryEstimateBasis}</p> : null}
                  {selectedCategory.attributionScope ? <p>{selectedCategory.attributionScope}</p> : null}
                </div> : null}
                <div className="process-breakdown">
                  <span className="eyebrow">PROCESS BREAKDOWN</span>
                  {selectedSample?.processes.map(process => <button key={process.pid} style={{ borderLeftColor: processColor(process.type) }} className={selectedPid === process.pid ? 'selected' : ''} onClick={() => setScope(`pid:${process.pid}`)}>
                    <span><strong>{process.type}</strong><small>PID {process.pid}</small></span><span>{formatKb(process.workingSetKb)}<small>{formatKb(process.privateKb)} private</small></span>
                  </button>)}
                </div>
                <details className="json-details"><summary>Log details</summary><dl className="details-list">
                  <div className="field-row"><dt>First sample</dt><dd>{overview.firstTimestamp}</dd></div>
                  <div className="field-row"><dt>Last sample</dt><dd>{overview.lastTimestamp}</dd></div>
                  <div className="field-row"><dt>Invalid lines</dt><dd>{overview.invalidLines.toLocaleString()}</dd></div>
                </dl></details>
                <details className="json-details"><summary>Third-party licenses</summary><pre>{thirdPartyNotices}</pre></details>
              </aside>
            </div>

            <section className="table-panel">
              <div className="panel-heading table-heading"><div><span className="eyebrow">PROCESS DIRECTORY</span><h2>Observed processes</h2></div><span className="table-summary">Values at each process's last sample</span></div>
              <div className="table-scroll"><table><thead><tr>{([
                ['type', 'Process'], ['pid', 'PID'], ['sampleCount', 'Samples'], ['currentWorkingSetKb', 'Current working'], ['peakWorkingSetKb', 'Peak working'], ['currentPrivateKb', 'Current private'], ['peakPrivateKb', 'Peak private'],
              ] as Array<[SortKey, string]>).map(([key, label]) => <th key={key} onClick={() => changeSort(key)}>{label}{sortKey === key ? <span className="sort-mark">{sortDirection === 1 ? ' ↑' : ' ↓'}</span> : null}</th>)}</tr></thead><tbody>{sortedProcesses.map(process => <tr key={process.pid} className={selectedPid === process.pid ? 'selected' : ''} onClick={() => setScope(`pid:${process.pid}`)}>
                <td><span className="process-type">{process.type}</span>{process.name ? <span className="process-name"> · {process.name}</span> : null}</td>
                <td className="numeric">{process.pid}</td><td className="numeric">{process.sampleCount.toLocaleString()}</td><td className="numeric">{formatKb(process.currentWorkingSetKb)}</td><td className="numeric">{formatKb(process.peakWorkingSetKb)}</td><td className="numeric">{formatKb(process.currentPrivateKb)}</td><td className="numeric">{formatKb(process.peakPrivateKb)}</td>
              </tr>)}</tbody></table></div>
            </section>
          </section>
        )}
      </main>

      <footer className="statusbar"><span>{status}</span></footer>
      {toast ? <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.text}</div> : null}
    </div>
  )
}
