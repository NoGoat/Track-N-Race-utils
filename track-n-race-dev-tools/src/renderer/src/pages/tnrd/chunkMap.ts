import type { ChunkInfo, FileOverview, RegionInfo, ViewMode } from '../../../../shared/tnrdTypes'

const COLORS: Record<number, string> = {
  0: '#8b90a7', 1: '#5794f2', 2: '#73bf69', 3: '#f2495c', 4: '#fade2a',
  5: '#b877d9', 6: '#ff9830', 7: '#33b5e5', 8: '#c0c6d4', 9: '#8ab8ff',
  10: '#e5ac0e', 11: '#56d4dd', 12: '#a48ad4', 13: '#ff7383', 14: '#96d98d',
  15: '#d4d7e5',
}

interface HitRect {
  chunk: ChunkInfo
  x: number
  y: number
  width: number
  height: number
}

interface RegionHitRect {
  region: RegionInfo
  x: number
  y: number
  width: number
  height: number
}

function regionKey(region: RegionInfo): string {
  return `${region.name}:${region.start}:${region.size}`
}

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++ }
  return unit ? `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[unit]}` : `${value} B`
}

function formatTime(value: number): string {
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const seconds = value % 60
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}` : `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`
}

export class ChunkMap {
  private overview: FileOverview | null = null
  private chunks: ChunkInfo[] = []
  private filteredIds = new Set<string>()
  private selectedId: string | null = null
  private selectedRegionKey: string | null = null
  private mode: ViewMode = 'physical'
  private fullMin = 0
  private fullMax = 1
  private viewMin = 0
  private viewMax = 1
  private hitRects: HitRect[] = []
  private regionHitRects: RegionHitRect[] = []
  private resizeObserver: ResizeObserver
  private scrollContainer: HTMLElement | null
  private drag: { x: number; min: number; max: number; moved: boolean } | null = null
  private readonly hideTooltip = (): void => { this.tooltip.hidden = true }

  constructor(
    private canvas: HTMLCanvasElement,
    private tooltip: HTMLElement,
    private onSelect: (chunk: ChunkInfo) => void,
    private onSelectRegion: (region: RegionInfo) => void,
    private onOpenRegion: (region: RegionInfo) => void,
    private onOpenRaw: (chunk: ChunkInfo) => void,
    private onClearSelection: () => void,
  ) {
    this.resizeObserver = new ResizeObserver(() => this.render())
    this.resizeObserver.observe(canvas)
    this.scrollContainer = canvas.closest('.canvas-viewport')
    this.scrollContainer?.addEventListener('scroll', this.hideTooltip, { passive: true })
    window.addEventListener('resize', this.hideTooltip)
    canvas.addEventListener('wheel', event => this.wheel(event), { passive: false })
    canvas.addEventListener('pointerdown', event => this.pointerDown(event))
    canvas.addEventListener('pointermove', event => this.pointerMove(event))
    canvas.addEventListener('pointerup', event => this.pointerUp(event))
    canvas.addEventListener('pointerleave', () => {
      this.tooltip.hidden = true
      this.drag = null
    })
    canvas.addEventListener('dblclick', event => {
      const region = this.regionHitAt(event.offsetX, event.offsetY)
      if (region) {
        this.onSelectRegion(region.region)
        this.onOpenRegion(region.region)
        return
      }
      const hit = this.hitAt(event.offsetX, event.offsetY)
      if (hit) this.onOpenRaw(hit.chunk)
    })
  }

  destroy(): void {
    this.resizeObserver.disconnect()
    this.scrollContainer?.removeEventListener('scroll', this.hideTooltip)
    window.removeEventListener('resize', this.hideTooltip)
    this.tooltip.hidden = true
  }

  setData(overview: FileOverview): void {
    this.overview = overview
    this.chunks = overview.chunks
    this.filteredIds = new Set(this.chunks.map(chunk => chunk.id))
    this.selectedId = null
    this.selectedRegionKey = null
    this.fit()
  }

  setMode(mode: ViewMode): void {
    this.mode = mode
    this.fit()
  }

  setFiltered(chunks: ChunkInfo[]): void {
    this.filteredIds = new Set(chunks.map(chunk => chunk.id))
    this.render()
  }

  select(chunkId: string | null, region: RegionInfo | null): void {
    this.selectedId = chunkId
    this.selectedRegionKey = region ? regionKey(region) : null
    this.render()
  }

  fit(): void {
    if (!this.overview) return
    const ranges = this.chunks.map(chunk => this.range(chunk)).filter((range): range is [number, number] => Boolean(range))
    if (!ranges.length) {
      this.fullMin = 0
      this.fullMax = 1
    } else {
      this.fullMin = Infinity
      this.fullMax = -Infinity
      for (const [minimum, maximum] of ranges) {
        if (minimum < this.fullMin) this.fullMin = minimum
        if (maximum > this.fullMax) this.fullMax = maximum
      }
      if (this.mode === 'physical') {
        this.fullMin = 0
        this.fullMax = Math.max(1, this.overview.fileSize)
      }
      if (this.fullMax <= this.fullMin) this.fullMax = this.fullMin + 1
    }
    this.viewMin = this.fullMin
    this.viewMax = this.fullMax
    this.render()
  }

  private range(chunk: ChunkInfo): [number, number] | null {
    if (this.mode === 'physical') {
      if (chunk.physicalStart === null || chunk.physicalSize === null) return null
      return [chunk.physicalStart, chunk.physicalStart + Math.max(1, chunk.physicalSize)]
    }
    if (this.mode === 'timeline') {
      if (chunk.firstTime === null || chunk.lastTime === null) return null
      return [chunk.firstTime, Math.max(chunk.firstTime + 0.0001, chunk.lastTime)]
    }
    return [chunk.sequence, chunk.sequence + 1]
  }

  private wheel(event: WheelEvent): void {
    if (!this.overview) return
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return
    event.preventDefault()
    const span = this.viewMax - this.viewMin
    if (event.shiftKey) {
      const shift = span * event.deltaY * 0.001
      this.setViewport(this.viewMin + shift, this.viewMax + shift)
      return
    }
    const rect = this.canvas.getBoundingClientRect()
    const labelWidth = 142
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - labelWidth) / Math.max(1, rect.width - labelWidth - 16)))
    const anchor = this.viewMin + span * fraction
    const factor = Math.exp(event.deltaY * 0.0015)
    const minimumSpan = Math.max((this.fullMax - this.fullMin) / 100_000, Number.EPSILON)
    const nextSpan = Math.max(minimumSpan, Math.min(this.fullMax - this.fullMin, span * factor))
    this.setViewport(anchor - nextSpan * fraction, anchor + nextSpan * (1 - fraction))
  }

  private setViewport(minimum: number, maximum: number): void {
    const fullSpan = this.fullMax - this.fullMin
    const span = Math.min(fullSpan, maximum - minimum)
    let min = minimum
    if (min < this.fullMin) min = this.fullMin
    if (min + span > this.fullMax) min = this.fullMax - span
    this.viewMin = min
    this.viewMax = min + span
    this.render()
  }

  private pointerDown(event: PointerEvent): void {
    this.drag = { x: event.clientX, min: this.viewMin, max: this.viewMax, moved: false }
    this.canvas.setPointerCapture(event.pointerId)
  }

  private pointerMove(event: PointerEvent): void {
    if (this.drag) {
      const delta = event.clientX - this.drag.x
      if (Math.abs(delta) > 3) this.drag.moved = true
      const rect = this.canvas.getBoundingClientRect()
      const shift = -delta / Math.max(1, rect.width - 158) * (this.drag.max - this.drag.min)
      this.setViewport(this.drag.min + shift, this.drag.max + shift)
      return
    }
    const regionHit = this.regionHitAt(event.offsetX, event.offsetY)
    if (regionHit) {
      this.canvas.style.cursor = 'pointer'
      const region = regionHit.region
      this.showTooltip(event, [
        region.name,
        `${formatBytes(region.start)} – ${formatBytes(region.start + region.size)}`,
        `${formatBytes(region.size)} control data`,
        region.detail ?? 'Click to inspect this region',
      ])
      return
    }
    const hit = this.hitAt(event.offsetX, event.offsetY)
    if (!hit) {
      this.tooltip.hidden = true
      this.canvas.style.cursor = 'grab'
      return
    }
    this.canvas.style.cursor = 'pointer'
    const chunk = hit.chunk
    const time = chunk.firstTime === null || chunk.lastTime === null
      ? 'No time bounds'
      : `${formatTime(chunk.firstTime)} – ${formatTime(chunk.lastTime)}${chunk.timeEstimated ? ' · estimated' : ''}`
    this.showTooltip(event, [
      `#${chunk.index} · ${chunk.rowTypeName}`,
      `Lap ${chunk.lapNumber || 'Session'} · sequence ${chunk.sequence.toLocaleString()}`,
      `${chunk.rowCount.toLocaleString()} rows · ${chunk.kind === 'stream-block' ? '≈ ' : ''}${formatBytes(chunk.compressedSize)} → ${formatBytes(chunk.uncompressedSize)}`,
      time,
      'Double-click to inspect raw JSONL',
    ])
  }

  private showTooltip(event: PointerEvent, lines: string[]): void {
    const gap = 14
    const viewportPadding = 8
    this.tooltip.textContent = lines.join('\n')
    this.tooltip.hidden = false

    const bounds = this.tooltip.getBoundingClientRect()
    let left = event.clientX + gap
    let top = event.clientY + gap
    if (left + bounds.width > window.innerWidth - viewportPadding) left = event.clientX - bounds.width - gap
    if (top + bounds.height > window.innerHeight - viewportPadding) top = event.clientY - bounds.height - gap

    this.tooltip.style.left = `${Math.max(viewportPadding, left)}px`
    this.tooltip.style.top = `${Math.max(viewportPadding, top)}px`
  }

  private pointerUp(event: PointerEvent): void {
    if (!this.drag) return
    const moved = this.drag.moved
    this.drag = null
    this.canvas.releasePointerCapture(event.pointerId)
    if (!moved) {
      const region = this.regionHitAt(event.offsetX, event.offsetY)
      if (region) {
        this.onSelectRegion(region.region)
        return
      }
      const hit = this.hitAt(event.offsetX, event.offsetY)
      if (hit) this.onSelect(hit.chunk)
      else this.onClearSelection()
    }
  }

  private hitAt(x: number, y: number): HitRect | null {
    for (let index = this.hitRects.length - 1; index >= 0; index--) {
      const hit = this.hitRects[index]
      if (!this.filteredIds.has(hit.chunk.id)) continue
      if (x >= hit.x && x <= hit.x + hit.width && y >= hit.y && y <= hit.y + hit.height) return hit
    }
    return null
  }

  private regionHitAt(x: number, y: number): RegionHitRect | null {
    for (let index = this.regionHitRects.length - 1; index >= 0; index--) {
      const hit = this.regionHitRects[index]
      if (x >= hit.x && x <= hit.x + hit.width && y >= hit.y && y <= hit.y + hit.height) return hit
    }
    return null
  }

  render(): void {
    const rect = this.canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const ratio = window.devicePixelRatio || 1
    const width = Math.round(rect.width * ratio)
    const height = Math.round(rect.height * ratio)
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    const context = this.canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, rect.width, rect.height)
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-base') || '#0c0e14'
    context.fillRect(0, 0, rect.width, rect.height)
    this.hitRects = []
    this.regionHitRects = []
    if (!this.overview || !this.chunks.length) return

    const labelWidth = 142
    const right = rect.width - 16
    const plotWidth = Math.max(1, right - labelWidth)
    const top = this.mode === 'physical' ? 52 : 16
    const types = [...new Set(this.chunks.map(chunk => chunk.rowType))].sort((a, b) => a - b)
    const laneHeight = Math.max(22, Math.min(38, (rect.height - top - 24) / Math.max(1, types.length)))
    const laneFor = new Map(types.map((type, index) => [type, index]))
    const span = this.viewMax - this.viewMin
    const xFor = (value: number): number => labelWidth + (value - this.viewMin) / span * plotWidth
    const selectionColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#dde0ec'

    context.font = '10px "Cascadia Code", Consolas, monospace'
    context.textBaseline = 'middle'
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary') || '#7c8098'
    for (let index = 0; index < types.length; index++) {
      const y = top + index * laneHeight
      context.save()
      context.beginPath()
      context.rect(0, y, labelWidth - 8, laneHeight)
      context.clip()
      context.fillText(`${String(types[index]).padStart(2, '0')}  ${this.chunks.find(chunk => chunk.rowType === types[index])?.rowTypeName ?? 'Unknown'}`, 10, y + laneHeight / 2)
      context.restore()
      context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-subtle') || '#161828'
      context.beginPath()
      context.moveTo(labelWidth, y + laneHeight)
      context.lineTo(right, y + laneHeight)
      context.stroke()
    }

    if (this.mode === 'physical') {
      for (const region of this.overview.regions) {
        const start = xFor(region.start)
        const end = xFor(region.start + region.size)
        if (end < labelWidth || start > right) continue
        const x = Math.max(labelWidth, start)
        const regionWidth = Math.max(2, Math.min(right, end) - x)
        const selected = regionKey(region) === this.selectedRegionKey
        context.globalAlpha = selected ? 1 : 0.8
        context.fillStyle = selected ? selectionColor : region.color
        context.fillRect(x, 12, regionWidth, 19)
        this.regionHitRects.push({ region, x, y: 8, width: Math.max(6, regionWidth), height: 27 })
      }
      context.globalAlpha = 1
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary') || '#7c8098'
      context.fillText('CONTROL PLANE', 10, 21)
    }

    for (const chunk of this.chunks) {
      const range = this.range(chunk)
      const lane = laneFor.get(chunk.rowType)
      if (!range || lane === undefined || range[1] < this.viewMin || range[0] > this.viewMax) continue
      const start = Math.max(labelWidth, xFor(range[0]))
      const end = Math.min(right, xFor(range[1]))
      const x = Math.min(right - 1, start)
      const chunkWidth = Math.max(2, end - start)
      const y = top + lane * laneHeight + 4
      const chunkHeight = laneHeight - 8
      const matches = this.filteredIds.has(chunk.id)
      const selected = chunk.id === this.selectedId
      context.globalAlpha = selected ? 1 : matches ? 0.82 : 0.045
      context.fillStyle = selected ? selectionColor : COLORS[chunk.rowType] ?? COLORS[0]
      context.fillRect(x, y, chunkWidth, chunkHeight)
      if (matches) this.hitRects.push({ chunk, x, y, width: chunkWidth, height: chunkHeight })
    }
    context.globalAlpha = 1

    const ticks = 6
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-muted') || '#484c62'
    for (let index = 0; index <= ticks; index++) {
      const value = this.viewMin + span * index / ticks
      const x = labelWidth + plotWidth * index / ticks
      const label = this.mode === 'physical' ? formatBytes(value) : this.mode === 'timeline' ? formatTime(value) : Math.round(value).toLocaleString()
      context.textAlign = index === 0 ? 'left' : index === ticks ? 'right' : 'center'
      context.fillText(label, x, rect.height - 9)
    }
    context.textAlign = 'left'
  }
}
