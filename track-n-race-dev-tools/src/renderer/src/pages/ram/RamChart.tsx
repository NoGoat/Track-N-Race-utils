import { useEffect, useMemo, useRef } from 'react'
import uPlot from 'uplot'
import type { RamLogOverview } from '../../../../shared/ramTypes'

export type MetricMode = 'working' | 'private' | 'both'
export type ProcessScope = 'total' | 'processes' | 'categories' | `pid:${number}` | `category:${string}` | `component:${string}:${string}`

interface ChartLine {
  label: string
  color: string
  dash?: number[]
  values: Array<number | null>
}

interface ChartDefinition {
  data: uPlot.AlignedData
  lines: ChartLine[]
  maxGiB: number
}

const processColors: Record<string, string> = {
  browser: '#73bf69',
  tab: '#5794f2',
  gpu: '#ff9830',
  utility: '#a48ad4',
  renderer: '#33b5e5',
}
const fallbackColors = ['#ff7383', '#56d4dd', '#fade2a', '#b877d9', '#8ab8ff', '#9bd58f']
const categoryColors = ['#56d4dd', '#fade2a', '#ff7383', '#8ab8ff', '#73bf69', '#b877d9']

function processColor(type: string, index: number): string {
  return processColors[type.toLocaleLowerCase()] ?? fallbackColors[index % fallbackColors.length]
}

function gib(kb: number | null): number | null {
  return kb === null ? null : kb / (1024 * 1024)
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainder = total % 60
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(Math.floor(remainder)).padStart(2, '0')}`
  return `${minutes}:${String(Math.floor(remainder)).padStart(2, '0')}`
}

function formatMemoryTick(valueGiB: number, unit: 'MiB' | 'GiB'): string {
  if (unit === 'MiB') {
    const valueMiB = valueGiB * 1024
    return `${valueMiB.toFixed(valueMiB < 10 ? 1 : 0)} MiB`
  }
  return `${valueGiB.toFixed(valueGiB < 0.1 ? 3 : valueGiB < 1 ? 2 : 1)} GiB`
}

function buildDefinition(overview: RamLogOverview, mode: MetricMode, scope: ProcessScope): ChartDefinition {
  const elapsed = overview.samples.map(sample => sample.elapsedMs / 1000)
  const lines: ChartLine[] = []

  if (scope.startsWith('component:')) {
    const [categoryKey, componentKey] = scope.slice('component:'.length).split(':')
    const component = overview.samples
      .flatMap(sample => sample.categories
        .filter(category => category.key === categoryKey)
        .flatMap(category => category.components))
      .find(candidate => candidate.key === componentKey)
    if (component) {
      lines.push({
        label: component.label,
        color: categoryColors[0],
        values: overview.samples.map(sample => gib(
          sample.categories
            .find(category => category.key === categoryKey)
            ?.components.find(candidate => candidate.key === componentKey)
            ?.retainedKb ?? null,
        )),
      })
    }
  } else if (scope === 'categories' || scope.startsWith('category:')) {
    const selectedKeys = scope === 'categories'
      ? overview.categories.map(category => category.key)
      : [scope.slice('category:'.length)]
    selectedKeys.forEach((key, index) => {
      const summary = overview.categories.find(category => category.key === key)
      if (!summary) return
      lines.push({
        label: `${summary.name} · retained`,
        color: categoryColors[index % categoryColors.length],
        values: overview.samples.map(sample => gib(sample.categories.find(category => category.key === key)?.retainedKb ?? null)),
      })
    })
  } else if (scope === 'total') {
    if (mode !== 'private') lines.push({ label: 'Total working set', color: '#5794f2', values: overview.samples.map(sample => gib(sample.totalWorkingSetKb)) })
    if (mode !== 'working') lines.push({ label: 'Total private', color: '#b877d9', dash: mode === 'both' ? [8, 5] : undefined, values: overview.samples.map(sample => gib(sample.totalPrivateKb)) })
  } else {
    const selectedPids = scope === 'processes'
      ? overview.processes.map(process => process.pid)
      : [Number(scope.slice('pid:'.length))]
    selectedPids.forEach((pid, processIndex) => {
      const summary = overview.processes.find(process => process.pid === pid)
      if (!summary) return
      const baseColor = processColor(summary.type, processIndex)
      if (mode !== 'private') lines.push({
        label: `${summary.type} ${pid} · working set`,
        color: baseColor,
        values: overview.samples.map(sample => gib(sample.processes.find(process => process.pid === pid)?.workingSetKb ?? null)),
      })
      if (mode !== 'working') lines.push({
        label: `${summary.type} ${pid} · private`,
        color: baseColor,
        dash: [8, 5],
        values: overview.samples.map(sample => gib(sample.processes.find(process => process.pid === pid)?.privateKb ?? null)),
      })
    })
  }

  let maxGiB = 0
  for (const line of lines) {
    for (const value of line.values) {
      if (value !== null && value > maxGiB) maxGiB = value
    }
  }

  return { data: [elapsed, ...lines.map(line => line.values)], lines, maxGiB }
}

function interactionPlugin(domainRef: { current: [number, number] }): uPlot.Plugin {
  let wheelHandler: ((event: WheelEvent) => void) | null = null
  return {
    hooks: {
      ready: [chart => {
        wheelHandler = event => {
          if (!event.ctrlKey && !event.shiftKey) return
          event.preventDefault()
          const min = chart.scales.x.min
          const max = chart.scales.x.max
          if (min === undefined || max === undefined) return
          const domain = domainRef.current
          const span = max - min
          if (event.shiftKey && !event.ctrlKey) {
            const shift = span * event.deltaY * 0.001
            const bounded = Math.max(domain[0] - min, Math.min(domain[1] - max, shift))
            chart.setScale('x', { min: min + bounded, max: max + bounded })
            return
          }
          const rect = chart.over.getBoundingClientRect()
          const focus = chart.posToVal(event.clientX - rect.left, 'x')
          const factor = Math.exp(event.deltaY * 0.0015)
          let nextMin = focus - (focus - min) * factor
          let nextMax = focus + (max - focus) * factor
          if (nextMax - nextMin >= domain[1] - domain[0]) {
            nextMin = domain[0]
            nextMax = domain[1]
          } else {
            if (nextMin < domain[0]) { nextMax += domain[0] - nextMin; nextMin = domain[0] }
            if (nextMax > domain[1]) { nextMin -= nextMax - domain[1]; nextMax = domain[1] }
          }
          chart.setScale('x', { min: nextMin, max: nextMax })
        }
        chart.over.addEventListener('wheel', wheelHandler, { passive: false })
      }],
      destroy: [chart => {
        if (wheelHandler) chart.over.removeEventListener('wheel', wheelHandler)
      }],
    },
  }
}

export function RamChart({ overview, mode, scope, fitVersion, theme, onSelectIndex }: {
  overview: RamLogOverview
  mode: MetricMode
  scope: ProcessScope
  fitVersion: number
  theme: string
  onSelectIndex: (index: number) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<uPlot | null>(null)
  const selectRef = useRef(onSelectIndex)
  const definitionRef = useRef<ChartDefinition | null>(null)
  const domainRef = useRef<[number, number]>([0, 1])
  const yUnitRef = useRef<'MiB' | 'GiB'>('GiB')
  const previousDomainRef = useRef<[number, number] | null>(null)
  selectRef.current = onSelectIndex
  const definition = useMemo(() => buildDefinition(overview, mode, scope), [mode, overview, scope])
  const seriesKey = useMemo(() => definition.lines.map(line => `${line.label}:${line.color}:${line.dash?.join(',') ?? ''}`).join('|'), [definition.lines])
  const xValues = definition.data[0]
  const domain: [number, number] = [Number(xValues[0] ?? 0), Number(xValues[xValues.length - 1] ?? 1)]
  if (domain[0] === domain[1]) domain[1] = domain[0] + 1
  definitionRef.current = definition
  domainRef.current = domain
  yUnitRef.current = definition.maxGiB < 1 ? 'MiB' : 'GiB'

  useEffect(() => {
    const host = hostRef.current
    if (!host || !definition.lines.length) return
    const computed = getComputedStyle(document.documentElement)
    const text = computed.getPropertyValue('--text-secondary').trim()
    const grid = computed.getPropertyValue('--border-subtle').trim()
    const background = computed.getPropertyValue('--bg-base').trim()
    const initialDefinition = definitionRef.current
    if (!initialDefinition) return
    const initialDomain = domainRef.current

    const options: uPlot.Options = {
      width: Math.max(320, host.clientWidth),
      height: Math.max(220, host.clientHeight),
      padding: [14, 12, 4, 0],
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false, setScale: true },
        points: { size: 6, width: 1 },
      },
      scales: {
        x: { time: false, auto: false, min: initialDomain[0], max: initialDomain[1] },
        y: { auto: true, range: (_chart, _min, max) => {
          return [0, max > 0 ? max * 1.12 : 1]
        } },
      },
      axes: [
        {
          stroke: text,
          grid: { show: true, stroke: grid, width: 1 },
          ticks: { show: true, stroke: grid, width: 1, size: 5 },
          size: 32,
          gap: 8,
          values: (_chart, values) => values.map(value => formatDuration(value)),
        },
        {
          stroke: text,
          grid: { show: true, stroke: grid, width: 1 },
          ticks: { show: true, stroke: grid, width: 1, size: 5 },
          size: 62,
          gap: 8,
          values: (_chart, values) => values.map(value => formatMemoryTick(value, yUnitRef.current)),
        },
      ],
      series: [
        { label: 'Elapsed time' },
        ...initialDefinition.lines.map(line => ({
          label: line.label,
          scale: 'y',
          stroke: line.color,
          width: 1.5,
          dash: line.dash,
          spanGaps: false,
          points: { show: false },
          value: (_chart: uPlot, rawValue: number | null) => rawValue === null ? '—' : `${rawValue.toFixed(3)} GiB`,
        })),
      ],
      hooks: {
        setCursor: [chart => {
          if (chart.cursor.idx !== null && chart.cursor.idx !== undefined) selectRef.current(chart.cursor.idx)
        }],
      },
      plugins: [interactionPlugin(domainRef)],
    }

    host.replaceChildren()
    host.style.background = background
    const chart = new uPlot(options, initialDefinition.data, host)
    chartRef.current = chart
    previousDomainRef.current = initialDomain
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (!box || box.width < 1 || box.height < 1) return
      chart.setSize({ width: Math.round(box.width), height: Math.round(box.height) })
    })
    observer.observe(host)
    return () => {
      observer.disconnect()
      chart.destroy()
      if (chartRef.current === chart) chartRef.current = null
    }
  }, [overview.fileId, seriesKey, theme])

  useEffect(() => {
    const chart = chartRef.current
    const previousDomain = previousDomainRef.current
    if (!chart || !previousDomain) return
    const visibleMin = chart.scales.x.min ?? previousDomain[0]
    const visibleMax = chart.scales.x.max ?? previousDomain[1]
    const edgeTolerance = Math.max(0.05, (previousDomain[1] - previousDomain[0]) * 0.002)
    const wasFollowing = visibleMax >= previousDomain[1] - edgeTolerance

    chart.setData(definition.data, true)
    if (wasFollowing) {
      chart.setScale('x', { min: domain[0], max: domain[1] })
    } else {
      const boundedMin = Math.max(domain[0], Math.min(domain[1], visibleMin))
      const boundedMax = Math.max(boundedMin + 0.001, Math.min(domain[1], visibleMax))
      chart.setScale('x', { min: boundedMin, max: boundedMax })
    }
    previousDomainRef.current = domain
  }, [definition])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !fitVersion) return
    chart.setScale('x', { min: domainRef.current[0], max: domainRef.current[1] })
  }, [fitVersion])

  return <div className="chart-host" ref={hostRef} onPointerLeave={() => selectRef.current(overview.samples.length - 1)} />
}
