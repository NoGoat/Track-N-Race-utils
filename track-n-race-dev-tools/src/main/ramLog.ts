import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, resolve } from 'node:path'
import type { CategorySummary, ProcessSummary, RamCategoryComponent, RamCategoryCounter, RamCategorySample, RamLogOverview, RamProcessSample, RamSample } from '../shared/ramTypes'

interface RawProcess {
  pid?: unknown
  type?: unknown
  name?: unknown
  working_set_kb?: unknown
  private_kb?: unknown
}

interface RawSample {
  timestamp?: unknown
  elapsed_ms?: unknown
  total_working_set_kb?: unknown
  total_private_kb?: unknown
  process_count?: unknown
  processes?: unknown
  category_count?: unknown
  categories?: unknown
  telemetry_data?: unknown
}

type MutableProcessSummary = ProcessSummary

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function numberAt(value: unknown, path: string[]): number | null {
  let current: unknown = value
  for (const key of path) {
    const object = record(current)
    if (!object) return null
    current = object[key]
  }
  return finiteNumber(current)
}

const componentPaths: Array<[string, string, string[]]> = [
  ['main', 'Main retained', ['main', 'retained_bytes']],
  ['renderer', 'Renderer retained', ['renderer', 'estimated_retained_bytes']],
  ['native_transit', 'Native transit', ['main', 'native_transit', 'retained_bytes']],
  ['native_live_history', 'Native live history', ['main', 'native_live_history', 'retained_bytes']],
  ['hidden_resume', 'Hidden resume buffers', ['main', 'hidden_resume', 'retained_bytes']],
  ['seek_forward', 'Seek forwarding', ['main', 'seek_forward', 'retained_bytes']],
  ['working_sources', 'Working source payloads', ['renderer', 'working_source_buffers', 'estimated_serialized_bytes']],
  ['published_views', 'Published view references', ['renderer', 'published_window_views', 'estimated_reference_bytes']],
  ['playback_cache', 'Playback lap cache', ['renderer', 'playback_lap_cache', 'estimated_serialized_bytes']],
  ['live_snapshots', 'Live lap snapshots', ['renderer', 'live_lap_snapshots', 'estimated_reference_bytes']],
  ['playback_blocks', 'Playback lap blocks', ['renderer', 'playback_lap_blocks', 'estimated_serialized_bytes']],
  ['race_events', 'Race events', ['renderer', 'race_events', 'estimated_serialized_bytes']],
  ['lap_boundaries', 'Lap boundaries', ['renderer', 'lap_boundaries', 'estimated_serialized_bytes']],
  ['current_state', 'Current state', ['renderer', 'current_state', 'estimated_serialized_bytes']],
  ['chart_cpu', 'Chart buffers · CPU', ['renderer', 'chart_buffers', 'cpu_bytes']],
  ['chart_gpu', 'Chart buffers · GPU', ['renderer', 'chart_buffers', 'gpu_texture_bytes']],
  ['history_packed_used', 'History packed · used', ['main', 'native_live_history', 'packed_bytes']],
  ['history_packed_capacity', 'History packed · capacity', ['main', 'native_live_history', 'packed_capacity_bytes']],
  ['history_json_payload_used', 'History JSON payload · used', ['main', 'native_live_history', 'json_payload_bytes']],
  ['history_json_payload_capacity', 'History JSON payload · capacity', ['main', 'native_live_history', 'json_payload_capacity_bytes']],
  ['history_json_container_capacity', 'History JSON containers · capacity', ['main', 'native_live_history', 'json_container_capacity_bytes']],
  ['history_sequence_capacity', 'History sequence · capacity', ['main', 'native_live_history', 'sequence_capacity_bytes']],
  ['history_compressed_plain', 'Compressed laps · original size', ['main', 'native_live_history', 'compressed_plain_bytes']],
  ['history_compressed_payload', 'Compressed laps · payload', ['main', 'native_live_history', 'compressed_payload_bytes']],
  ['history_compressed_capacity', 'Compressed laps · capacity', ['main', 'native_live_history', 'compressed_capacity_bytes']],
]

const counterPaths: Array<[string, string, string[]]> = [
  ['history_laps', 'History laps', ['main', 'native_live_history', 'laps']],
  ['history_pinned_laps', 'Pinned laps', ['main', 'native_live_history', 'pinned_laps']],
  ['history_compressed_laps', 'Compressed laps', ['main', 'native_live_history', 'compressed_laps']],
  ['history_busy_laps', 'Busy laps', ['main', 'native_live_history', 'busy_laps']],
  ['history_json_rows', 'JSON rows', ['main', 'native_live_history', 'json_rows']],
  ['history_sequence_entries', 'Sequence entries', ['main', 'native_live_history', 'sequence_entries']],
  ['history_queued_jobs', 'Queued compression jobs', ['main', 'native_live_history', 'queued_jobs']],
]

function parseCategory(value: unknown): RamCategorySample | null {
  const raw = record(value)
  if (!raw || raw.category === 'process') return null
  const key = typeof raw.category === 'string' ? raw.category : null
  const retainedKb = finiteNumber(raw.estimated_retained_kb)
    ?? (() => { const bytes = finiteNumber(raw.estimated_retained_bytes); return bytes === null ? null : bytes / 1024 })()
  if (!key || retainedKb === null) return null
  const components: RamCategoryComponent[] = componentPaths.flatMap(([componentKey, label, path]) => {
    const bytes = numberAt(raw, path)
    return bytes === null ? [] : [{ key: componentKey, label, retainedKb: bytes / 1024 }]
  })
  const counters: RamCategoryCounter[] = counterPaths.flatMap(([counterKey, label, path]) => {
    const value = numberAt(raw, path)
    return value === null ? [] : [{ key: counterKey, label, value }]
  })
  const nativeLiveHistory = record(record(raw.main)?.native_live_history)
  return {
    key,
    type: typeof raw.type === 'string' ? raw.type : key,
    name: typeof raw.name === 'string' ? raw.name : key,
    mode: typeof raw.mode === 'string' ? raw.mode : null,
    retainedKb,
    alreadyIncludedInProcessTotals: raw.already_included_in_process_totals === true,
    attributionScope: typeof raw.attribution_scope === 'string' ? raw.attribution_scope : null,
    rendererSampleAgeMs: raw.renderer_sample_age_ms === null ? null : finiteNumber(raw.renderer_sample_age_ms),
    components,
    counters,
    nativeLiveHistoryEstimateBasis: typeof nativeLiveHistory?.estimate_basis === 'string' ? nativeLiveHistory.estimate_basis : null,
  }
}

function parseProcess(value: unknown): RamProcessSample | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as RawProcess
  const pid = finiteNumber(raw.pid)
  const workingSetKb = finiteNumber(raw.working_set_kb)
  if (pid === null || workingSetKb === null || typeof raw.type !== 'string') return null
  const privateKb = raw.private_kb === null ? null : finiteNumber(raw.private_kb)
  return {
    pid: Math.trunc(pid),
    type: raw.type,
    name: typeof raw.name === 'string' ? raw.name : null,
    workingSetKb,
    privateKb,
  }
}

export function parseRamLogLine(line: string): RamSample | null {
  let raw: RawSample
  try {
    raw = JSON.parse(line) as RawSample
  } catch {
    return null
  }

  const timestampMs = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN
  const elapsedMs = finiteNumber(raw.elapsed_ms)
  const totalWorkingSetKb = finiteNumber(raw.total_working_set_kb)
  if (!Number.isFinite(timestampMs) || elapsedMs === null || totalWorkingSetKb === null || !Array.isArray(raw.processes)) return null

  const processes = raw.processes.map(parseProcess).filter((process): process is RamProcessSample => process !== null)
  if (processes.length !== raw.processes.length) return null
  const totalPrivateKb = raw.total_private_kb === null ? null : finiteNumber(raw.total_private_kb)
  const processCount = finiteNumber(raw.process_count)
  const rawCategories = Array.isArray(raw.categories) ? raw.categories : raw.telemetry_data ? [{ category: 'telemetry_data', ...record(raw.telemetry_data) }] : []
  const categories = rawCategories.map(parseCategory).filter((category): category is RamCategorySample => category !== null)
  const categoryCount = finiteNumber(raw.category_count)
  return {
    timestamp: new Date(timestampMs).toISOString(),
    elapsedMs,
    totalWorkingSetKb,
    totalPrivateKb,
    processCount: processCount === null ? processes.length : Math.trunc(processCount),
    processes,
    categoryCount: categoryCount === null ? processes.length + categories.length : Math.trunc(categoryCount),
    categories,
  }
}

function medianInterval(samples: RamSample[]): number | null {
  const intervals: number[] = []
  for (let index = 1; index < samples.length; index++) {
    const interval = samples[index].elapsedMs - samples[index - 1].elapsedMs
    if (interval > 0) intervals.push(interval)
  }
  if (!intervals.length) return null
  intervals.sort((left, right) => left - right)
  const middle = Math.floor(intervals.length / 2)
  return intervals.length % 2 ? intervals[middle] : (intervals[middle - 1] + intervals[middle]) / 2
}

function summarizeProcesses(samples: RamSample[]): ProcessSummary[] {
  const summaries = new Map<number, MutableProcessSummary>()
  for (const sample of samples) {
    for (const process of sample.processes) {
      const existing = summaries.get(process.pid)
      if (!existing) {
        summaries.set(process.pid, {
          pid: process.pid,
          type: process.type,
          name: process.name,
          sampleCount: 1,
          firstWorkingSetKb: process.workingSetKb,
          currentWorkingSetKb: process.workingSetKb,
          peakWorkingSetKb: process.workingSetKb,
          firstPrivateKb: process.privateKb,
          currentPrivateKb: process.privateKb,
          peakPrivateKb: process.privateKb,
        })
        continue
      }
      existing.sampleCount++
      existing.type = process.type
      existing.name = process.name
      existing.currentWorkingSetKb = process.workingSetKb
      existing.peakWorkingSetKb = Math.max(existing.peakWorkingSetKb, process.workingSetKb)
      existing.currentPrivateKb = process.privateKb
      if (process.privateKb !== null) existing.peakPrivateKb = Math.max(existing.peakPrivateKb ?? process.privateKb, process.privateKb)
    }
  }
  return [...summaries.values()]
    .sort((left, right) => right.peakWorkingSetKb - left.peakWorkingSetKb)
}

function summarizeCategories(samples: RamSample[]): CategorySummary[] {
  const summaries = new Map<string, CategorySummary>()
  for (const sample of samples) {
    for (const category of sample.categories) {
      const existing = summaries.get(category.key)
      if (!existing) {
        summaries.set(category.key, {
          key: category.key,
          type: category.type,
          name: category.name,
          sampleCount: 1,
          currentRetainedKb: category.retainedKb,
          peakRetainedKb: category.retainedKb,
          alreadyIncludedInProcessTotals: category.alreadyIncludedInProcessTotals,
        })
        continue
      }
      existing.sampleCount++
      existing.type = category.type
      existing.name = category.name
      existing.currentRetainedKb = category.retainedKb
      existing.peakRetainedKb = Math.max(existing.peakRetainedKb, category.retainedKb)
      existing.alreadyIncludedInProcessTotals = category.alreadyIncludedInProcessTotals
    }
  }
  return [...summaries.values()].sort((left, right) => right.peakRetainedKb - left.peakRetainedKb)
}

export function appendRamLogOverview(overview: RamLogOverview, appendedSamples: RamSample[], invalidLines: number, fileSize: number): RamLogOverview {
  if (!appendedSamples.length) return { ...overview, fileSize, invalidLines: overview.invalidLines + invalidLines }

  const processes = new Map(overview.processes.map(process => [process.pid, { ...process }]))
  const categories = new Map(overview.categories.map(category => [category.key, { ...category }]))
  let peakWorkingSetKb = overview.peakWorkingSetKb
  let peakPrivateKb = overview.peakPrivateKb
  for (const sample of appendedSamples) {
    peakWorkingSetKb = Math.max(peakWorkingSetKb, sample.totalWorkingSetKb)
    if (sample.totalPrivateKb !== null) peakPrivateKb = Math.max(peakPrivateKb ?? sample.totalPrivateKb, sample.totalPrivateKb)
    for (const process of sample.processes) {
      const existing = processes.get(process.pid)
      if (!existing) {
        processes.set(process.pid, {
          pid: process.pid,
          type: process.type,
          name: process.name,
          sampleCount: 1,
          firstWorkingSetKb: process.workingSetKb,
          currentWorkingSetKb: process.workingSetKb,
          peakWorkingSetKb: process.workingSetKb,
          firstPrivateKb: process.privateKb,
          currentPrivateKb: process.privateKb,
          peakPrivateKb: process.privateKb,
        })
        continue
      }
      existing.sampleCount++
      existing.type = process.type
      existing.name = process.name
      existing.currentWorkingSetKb = process.workingSetKb
      existing.peakWorkingSetKb = Math.max(existing.peakWorkingSetKb, process.workingSetKb)
      existing.currentPrivateKb = process.privateKb
      if (process.privateKb !== null) existing.peakPrivateKb = Math.max(existing.peakPrivateKb ?? process.privateKb, process.privateKb)
    }
    for (const category of sample.categories) {
      const existing = categories.get(category.key)
      if (!existing) {
        categories.set(category.key, {
          key: category.key,
          type: category.type,
          name: category.name,
          sampleCount: 1,
          currentRetainedKb: category.retainedKb,
          peakRetainedKb: category.retainedKb,
          alreadyIncludedInProcessTotals: category.alreadyIncludedInProcessTotals,
        })
        continue
      }
      existing.sampleCount++
      existing.type = category.type
      existing.name = category.name
      existing.currentRetainedKb = category.retainedKb
      existing.peakRetainedKb = Math.max(existing.peakRetainedKb, category.retainedKb)
      existing.alreadyIncludedInProcessTotals = category.alreadyIncludedInProcessTotals
    }
  }

  const samples = [...overview.samples, ...appendedSamples]
  const last = samples[samples.length - 1]
  return {
    ...overview,
    fileSize,
    invalidLines: overview.invalidLines + invalidLines,
    samples,
    processes: [...processes.values()].sort((left, right) => right.peakWorkingSetKb - left.peakWorkingSetKb),
    categories: [...categories.values()].sort((left, right) => right.peakRetainedKb - left.peakRetainedKb),
    lastTimestamp: last.timestamp,
    durationMs: Math.max(0, last.elapsedMs - samples[0].elapsedMs),
    medianIntervalMs: medianInterval(samples.slice(-121)),
    peakWorkingSetKb,
    peakPrivateKb,
  }
}

export async function parseRamLog(filePath: string): Promise<RamLogOverview> {
  const absolutePath = resolve(filePath)
  const file = await stat(absolutePath)
  if (!file.isFile()) throw new Error('The selected path is not a file.')

  const samples: RamSample[] = []
  let invalidLines = 0
  const lines = createInterface({ input: createReadStream(absolutePath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    const sample = parseRamLogLine(line)
    if (sample) samples.push(sample)
    else invalidLines++
  }
  if (!samples.length) throw new Error('No valid RAM usage samples were found in this file.')

  samples.sort((left, right) => left.elapsedMs - right.elapsedMs)
  const first = samples[0]
  const last = samples[samples.length - 1]
  let peakWorkingSetKb = 0
  let peakPrivateKb: number | null = null
  for (const sample of samples) {
    peakWorkingSetKb = Math.max(peakWorkingSetKb, sample.totalWorkingSetKb)
    if (sample.totalPrivateKb !== null) peakPrivateKb = Math.max(peakPrivateKb ?? sample.totalPrivateKb, sample.totalPrivateKb)
  }
  return {
    fileId: `${absolutePath}:${file.dev}:${file.ino}`,
    path: absolutePath,
    name: basename(absolutePath),
    fileSize: file.size,
    invalidLines,
    samples,
    processes: summarizeProcesses(samples),
    categories: summarizeCategories(samples),
    firstTimestamp: first.timestamp,
    lastTimestamp: last.timestamp,
    durationMs: Math.max(0, last.elapsedMs - first.elapsedMs),
    medianIntervalMs: medianInterval(samples),
    peakWorkingSetKb,
    peakPrivateKb,
  }
}
