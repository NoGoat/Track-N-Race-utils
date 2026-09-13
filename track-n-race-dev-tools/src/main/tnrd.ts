import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, stat, unlink, type FileHandle } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  crc32,
  createGunzip,
  createZstdDecompress,
  zstdDecompress,
} from 'node:zlib'
import type {
  BranchInfo,
  ChunkInfo,
  ControlRegionPage,
  ControlRegionPageRequest,
  FileOverview,
  LapInfo,
  ProgressInfo,
  RawPage,
  RawPageRequest,
  RegionInfo,
  TnrdGeneration,
} from '../shared/tnrdTypes'

// This inspector deliberately has no libtnrp dependency. V1-V3 are streamed
// through Node's native decompressors into a temporary JSONL index; V4/V5 are
// opened from their fixed control planes and each Zstandard payload is decoded
// only when its raw-data view is requested.

const V4_MAGIC = Buffer.from('TNRD_V4\0', 'binary')
const V5_MAGIC = Buffer.from('TNRD_V5\0', 'binary')
const FOOTER_MARKER = Buffer.from('END4', 'ascii')
const METADATA_MAGIC = 0x3454454d
const CHUNK_MAGIC = 0x344b4843
const FOOTER_MAGIC = 0x34444e45
const MAX_CONTROL_COUNT = 1_000_000
const MONOLITHIC_BLOCK_ROWS = 4096
const MONOLITHIC_BLOCK_BYTES = 2 * 1024 * 1024
const RAW_CACHE_LIMIT = 192 * 1024 * 1024

const ROW_NAMES = new Map<number, string>([
  [0, 'Other'], [1, 'Telemetry'], [2, 'Status'], [3, 'Damage'], [4, 'Lap'],
  [5, 'Session'], [6, 'Race Event'], [7, 'Timing'], [8, 'Participants'],
  [9, 'All Status'], [10, 'Tyre Sets'], [11, 'Motion'], [12, 'Motion Ex'],
  [13, 'Positions'], [14, 'Session History'], [15, 'Mixed'],
])
const ROW_IDS = new Map<string, number>([
  ['telemetry', 1], ['status', 2], ['damage', 3], ['lap', 4], ['session', 5],
  ['race_event', 6], ['timing', 7], ['participants', 8], ['all_status', 9],
  ['tyre_sets', 10], ['motion', 11], ['motion_ex', 12], ['positions', 13],
  ['session_history_fastest', 14],
])

interface InternalChunk extends ChunkInfo {
  rawOffset?: number
  rawLength?: number
}

interface FileState {
  overview: FileOverview
  sourcePath: string
  tempPath?: string
  chunks: Map<string, InternalChunk>
}

interface RawCacheEntry {
  key: string
  buffer: Buffer
  lineStarts: number[]
  firstTime: number | null
  lastTime: number | null
  checksumValid: boolean | null
  rowCountValid: boolean | null
}

interface ValidatedFooter {
  offset: number
  summaryOffset: number
  summaryBytes: Buffer
  lapOffset: number
  lapBytes: Buffer
  chunkOffset: number
  chunkBytes: Buffer
  branchOffset?: number
  branchBytes?: Buffer
  rowIndexOffset?: number
  rowIndexBytes?: Buffer
}

type ProgressCallback = (progress: ProgressInfo) => void

function asSafeNumber(value: bigint, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds JavaScript's safe integer range`)
  return number
}

function u64(buffer: Buffer, offset: number, label = '64-bit value'): number {
  return asSafeNumber(buffer.readBigUInt64LE(offset), label)
}

function f32(buffer: Buffer, offset: number): number {
  return buffer.readFloatLE(offset)
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

function nextDownFloat32(value: number): number {
  value = Math.fround(value)
  if (value === -Infinity || Number.isNaN(value)) return value
  if (value === 0) return -1.401298464324817e-45
  const storage = new ArrayBuffer(4)
  const view = new DataView(storage)
  view.setFloat32(0, value, true)
  let bits = view.getUint32(0, true)
  bits += value > 0 ? -1 : 1
  view.setUint32(0, bits, true)
  return view.getFloat32(0, true)
}

async function readExact(handle: FileHandle, position: number, size: number): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(size) || position < 0 || size < 0) {
    throw new Error(`Invalid file range at ${position} for ${size} bytes`)
  }
  const buffer = Buffer.allocUnsafe(size)
  let filled = 0
  while (filled < size) {
    const result = await handle.read(buffer, filled, size - filled, position + filled)
    if (!result.bytesRead) throw new Error(`Recording is truncated at byte ${position + filled}`)
    filled += result.bytesRead
  }
  return buffer
}

function crcParts(parts: Array<{ bytes: Buffer; nullWhenEmpty?: boolean }>): number {
  let value = 0
  for (const part of parts) {
    value = part.nullWhenEmpty && part.bytes.length === 0 ? 0 : crc32(part.bytes, value)
  }
  return value >>> 0
}

function numericBounds(values: number[]): { minimum: number | null; maximum: number | null } {
  let minimum = Infinity
  let maximum = -Infinity
  for (const value of values) {
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  }
  return values.length ? { minimum, maximum } : { minimum: null, maximum: null }
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sessionTime(line: Buffer | string): number | null {
  const match = /"session_time"\s*:\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
    typeof line === 'string' ? line : line.toString('utf8'),
  )
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function rowType(line: Buffer | string): number {
  const match = /"type"\s*:\s*"([^"]+)"/.exec(typeof line === 'string' ? line : line.toString('utf8'))
  return match ? (ROW_IDS.get(match[1]) ?? 0) : 0
}

function rowLap(line: Buffer | string): number | null {
  const text = typeof line === 'string' ? line : line.toString('utf8')
  const match = /"(?:current_lap_num|lap_num)"\s*:\s*(\d+)/.exec(text)
  return match ? Number(match[1]) : null
}

function rowName(type: number): string {
  return ROW_NAMES.get(type) ?? `Type ${type}`
}

function decompressZstd(input: Buffer, maxOutputLength?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (maxOutputLength === undefined) {
      zstdDecompress(input, (error, result) => error ? reject(error) : resolve(result))
    } else {
      zstdDecompress(input, { maxOutputLength }, (error, result) => error ? reject(error) : resolve(result))
    }
  })
}

function estimateV4Times(chunks: InternalChunk[], laps: LapInfo[], summary: Record<string, unknown>): void {
  const lapMap = new Map(laps.map(lap => [lap.number, lap]))
  const globalStart = typeof summary.startSessionTime === 'number' ? summary.startSessionTime : (laps[0]?.startTime ?? 0)
  const globalEnd = typeof summary.totalSessionTime === 'number' ? summary.totalSessionTime : (laps.at(-1)?.endTime ?? globalStart)
  const groups = new Map<string, InternalChunk[]>()
  for (const chunk of chunks) {
    const key = `${chunk.lapNumber ?? 0}:${chunk.rowType}`
    const group = groups.get(key) ?? []
    group.push(chunk)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.sequence - b.sequence)
    const lap = group[0].lapNumber ? lapMap.get(group[0].lapNumber) : undefined
    const start = lap?.startTime ?? globalStart
    const end = Math.max(start, lap?.endTime ?? globalEnd)
    const totalWeight = group.reduce((sum, chunk) => sum + Math.max(1, chunk.rowCount), 0)
    let cursor = start
    for (const chunk of group) {
      const span = (end - start) * Math.max(1, chunk.rowCount) / totalWeight
      chunk.firstTime = cursor
      chunk.lastTime = cursor + span
      chunk.logicalLastTime = chunk.lastTime
      chunk.timeEstimated = true
      cursor += span
    }
  }
}

function buildLineIndex(buffer: Buffer): { starts: number[]; firstTime: number | null; lastTime: number | null } {
  const starts = buffer.length ? [0] : []
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a && i + 1 < buffer.length) starts.push(i + 1)
  }
  let firstTime: number | null = null
  let lastTime: number | null = null
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : buffer.length
    const time = sessionTime(buffer.subarray(starts[i], end))
    if (time === null) continue
    firstTime = firstTime === null ? time : Math.min(firstTime, time)
    lastTime = lastTime === null ? time : Math.max(lastTime, time)
  }
  return { starts, firstTime, lastTime }
}

export class TnrdStore {
  private files = new Map<string, FileState>()
  private rawCache = new Map<string, RawCacheEntry>()
  private rawCacheBytes = 0
  private openVersion = 0

  private async discardFiles(fileIds: Set<string>): Promise<void> {
    const temps: string[] = []
    for (const fileId of fileIds) {
      const file = this.files.get(fileId)
      if (file?.tempPath) temps.push(file.tempPath)
      this.files.delete(fileId)
    }
    for (const [key, entry] of this.rawCache) {
      if (!fileIds.has(key.slice(0, key.indexOf(':')))) continue
      this.rawCache.delete(key)
      this.rawCacheBytes -= entry.buffer.length
    }
    await Promise.all(temps.map(path => unlink(path).catch(() => undefined)))
  }

  async close(): Promise<void> {
    this.openVersion++
    await this.discardFiles(new Set(this.files.keys()))
  }

  async openFile(sourcePath: string, progress: ProgressCallback): Promise<FileOverview> {
    const openVersion = ++this.openVersion
    const info = await stat(sourcePath)
    if (!info.isFile()) throw new Error('The selected path is not a file')
    const handle = await open(sourcePath, 'r')
    let signature: Buffer
    try {
      signature = await readExact(handle, 0, Math.min(8, info.size))
    } finally {
      await handle.close()
    }
    progress({ phase: 'detect', fraction: 0, detail: 'Identifying TNRD generation' })
    let overview: FileOverview
    if (signature.subarray(0, 8).equals(V4_MAGIC)) overview = await this.openIndexed(sourcePath, 4, progress)
    else if (signature.subarray(0, 8).equals(V5_MAGIC)) overview = await this.openIndexed(sourcePath, 5, progress)
    else if (signature[0] === 0x1f && signature[1] === 0x8b) overview = await this.openMonolithic(sourcePath, 'gzip', info.size, progress)
    else if (signature.length >= 4 && signature.readUInt32LE(0) === 0xfd2fb528) overview = await this.openMonolithic(sourcePath, 'zstd', info.size, progress)
    else throw new Error('Unknown TNRD signature. Expected gzip, Zstandard, TNRD_V4, or TNRD_V5.')

    if (openVersion !== this.openVersion) {
      await this.discardFiles(new Set([overview.fileId]))
      throw new Error('This open request was superseded by a newer recording')
    }
    await this.discardFiles(new Set([...this.files.keys()].filter(fileId => fileId !== overview.fileId)))
    return overview
  }

  private async openMonolithic(
    sourcePath: string,
    compression: 'gzip' | 'zstd',
    fileSize: number,
    progress: ProgressCallback,
  ): Promise<FileOverview> {
    const fileId = randomUUID()
    const tempPath = join(tmpdir(), `tracknrace_tnrd_viewer_${fileId}.jsonl`)
    const chunks: InternalChunk[] = []
    let header: Record<string, unknown> | null = null
    let decompressedBytes = 0
    let carry = Buffer.alloc(0)
    let firstLine = true
    let current: {
      start: number
      end: number
      rows: number
      firstTime: number | null
      lastTime: number | null
      tailTime: number | null
      types: Map<number, number>
      laps: Set<number>
    } | null = null

    const finishBlock = (): void => {
      if (!current || current.rows === 0) return
      const sortedTypes = [...current.types.entries()].sort((a, b) => b[1] - a[1])
      const onlyType = sortedTypes.length === 1 ? sortedTypes[0][0] : 15
      const onlyLap = current.laps.size === 1 ? [...current.laps][0] : null
      const length = current.end - current.start
      const chunk: InternalChunk = {
        id: `stream:${chunks.length}`,
        index: chunks.length,
        kind: 'stream-block',
        lapNumber: onlyLap,
        rowType: onlyType,
        rowTypeName: rowName(onlyType),
        typeCounts: Object.fromEntries(sortedTypes.map(([type, count]) => [rowName(type), count])),
        sequence: chunks.length + 1,
        physicalStart: null,
        physicalSize: null,
        payloadOffset: null,
        compressedSize: 0,
        uncompressedSize: length,
        rowCount: current.rows,
        checksum: null,
        prefixValid: null,
        firstTime: current.firstTime,
        lastTime: current.lastTime,
        logicalLastTime: current.lastTime,
        timeEstimated: false,
        minDistance: null,
        maxDistance: null,
        branchWallClockMs: null,
        visibility: 'active',
        rawOffset: current.start,
        rawLength: length,
      }
      chunks.push(chunk)
      current = null
    }

    const consumeLine = (line: Buffer, start: number, end: number): void => {
      if (firstLine) {
        firstLine = false
        header = parseJsonObject(line, 'TNRD stream header')
        return
      }
      if (current && (current.rows >= MONOLITHIC_BLOCK_ROWS || end - current.start > MONOLITHIC_BLOCK_BYTES)) finishBlock()
      const type = rowType(line)
      const time = sessionTime(line)
      const lap = rowLap(line)
      if (current && time !== null && current.tailTime !== null && time < current.tailTime - 0.2) finishBlock()
      if (!current) current = { start, end, rows: 0, firstTime: null, lastTime: null, tailTime: null, types: new Map(), laps: new Set() }
      current.end = end
      current.rows++
      current.types.set(type, (current.types.get(type) ?? 0) + 1)
      if (lap !== null) current.laps.add(lap)
      if (time !== null) {
        current.firstTime = current.firstTime === null ? time : Math.min(current.firstTime, time)
        current.lastTime = current.lastTime === null ? time : Math.max(current.lastTime, time)
        current.tailTime = time
      }
    }

    const indexer = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          const combinedStart = decompressedBytes - carry.length
          const combined = carry.length ? Buffer.concat([carry, bytes]) : bytes
          decompressedBytes += bytes.length
          let lineStart = 0
          for (;;) {
            const newline = combined.indexOf(0x0a, lineStart)
            if (newline < 0) break
            const absoluteStart = combinedStart + lineStart
            consumeLine(combined.subarray(lineStart, newline), absoluteStart, combinedStart + newline + 1)
            lineStart = newline + 1
          }
          carry = Buffer.from(combined.subarray(lineStart))
          this.push(bytes)
          callback()
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)))
        }
      },
      flush(callback) {
        try {
          if (carry.length) consumeLine(carry, decompressedBytes - carry.length, decompressedBytes)
          finishBlock()
          callback()
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)))
        }
      },
    })

    const input = createReadStream(sourcePath)
    let sourceBytes = 0
    input.on('data', data => {
      sourceBytes += Buffer.byteLength(data)
      progress({
        phase: 'index',
        fraction: fileSize ? Math.min(1, sourceBytes / fileSize) : null,
        detail: `Decompressing and indexing ${compression.toUpperCase()} stream`,
      })
    })
    try {
      await pipeline(input, compression === 'gzip' ? createGunzip() : createZstdDecompress(), indexer, createWriteStream(tempPath))
    } catch (error) {
      await unlink(tempPath).catch(() => undefined)
      throw new Error(`Could not decompress ${compression.toUpperCase()} recording: ${error instanceof Error ? error.message : String(error)}`)
    }
    const parsedHeader = header as Record<string, unknown> | null
    if (!parsedHeader) {
      await unlink(tempPath).catch(() => undefined)
      throw new Error('The monolithic recording has no JSON header')
    }
    const magic = parsedHeader.magic
    const generation = magic === 'TNRD_V1' ? 'TNRD_V1' : magic === 'TNRD_V2' ? 'TNRD_V2' : magic === 'TNRD_V3' ? 'TNRD_V3' : null
    if (!generation || (compression === 'gzip' && generation !== 'TNRD_V1') || (compression === 'zstd' && generation === 'TNRD_V1')) {
      await unlink(tempPath).catch(() => undefined)
      throw new Error(`The decompressed header (${String(magic)}) does not match the ${compression} container`)
    }
    let estimatedPhysical = 0
    for (const chunk of chunks) {
      chunk.compressedSize = decompressedBytes ? Math.round(fileSize * chunk.uncompressedSize / decompressedBytes) : 0
      chunk.physicalStart = estimatedPhysical
      chunk.physicalSize = chunk.compressedSize
      estimatedPhysical += chunk.compressedSize
    }
    const totalRows = chunks.reduce((sum, chunk) => sum + chunk.rowCount, 0)
    const times = chunks.flatMap(chunk => [chunk.firstTime, chunk.lastTime]).filter((time): time is number => time !== null)
    const timeBounds = numericBounds(times)
    const overview: FileOverview = {
      fileId,
      path: sourcePath,
      name: basename(sourcePath),
      fileSize,
      generation,
      compression,
      metadata: parsedHeader,
      summary: {},
      integrity: { header: true, metadata: true, control: null, invalidPrefixes: 0, recoveredCheckpoint: false, partial: false },
      laps: [],
      branches: [],
      regions: [
        { name: `${compression.toUpperCase()} monolithic stream`, start: 0, size: fileSize, color: '#5794f2', detail: `${decompressedBytes.toLocaleString()} decompressed bytes` },
      ],
      chunks,
      totalRows,
      activeRows: totalRows,
      compressedPayloadBytes: fileSize,
      uncompressedPayloadBytes: decompressedBytes,
      startTime: timeBounds.minimum,
      endTime: timeBounds.maximum,
    }
    this.files.set(fileId, { overview, sourcePath, tempPath, chunks: new Map(chunks.map(chunk => [chunk.id, chunk])) })
    progress({ phase: 'ready', fraction: 1, detail: `Indexed ${totalRows.toLocaleString()} rows` })
    return overview
  }

  private async openIndexed(sourcePath: string, version: 4 | 5, progress: ProgressCallback): Promise<FileOverview> {
    const generation = `TNRD_V${version}` as TnrdGeneration
    const fileId = randomUUID()
    const info = await stat(sourcePath)
    const fileSize = info.size
    const handle = await open(sourcePath, 'r')
    try {
      progress({ phase: 'control', fraction: 0.1, detail: `Reading ${generation} control tables` })
      const headerSize = version === 4 ? 96 : 128
      const chunkEntrySize = version === 4 ? 48 : 96
      const footerSize = version === 4 ? 32 : 48
      const header = await readExact(handle, 0, headerSize)
      const storedHeaderCrc = header.readUInt32LE(version === 4 ? 88 : 120)
      const headerCopy = Buffer.from(header)
      headerCopy.fill(0, version === 4 ? 88 : 120, version === 4 ? 92 : 124)
      const headerCrc = crc32(headerCopy.subarray(0, version === 4 ? 88 : 120)) >>> 0
      const headerShapeValid = header.readUInt16LE(8) === version && header.readUInt16LE(10) === headerSize &&
        header.readUInt32LE(12) === (version === 4 ? 0 : 3) &&
        header.readUInt32LE(44) === 24 && header.readUInt32LE(60) === chunkEntrySize &&
        (version === 4 ? header.readUInt32LE(92) === 0 : header.readUInt32LE(116) === 16 && header.readUInt32LE(124) === 0)

      const metadataPrefix = await readExact(handle, headerSize, 16)
      if (metadataPrefix.readUInt32LE(0) !== METADATA_MAGIC) throw new Error(`Invalid ${generation} metadata prefix`)
      const metadataSize = u64(metadataPrefix, 8, 'metadata size')
      if (metadataSize > 16 * 1024 * 1024) throw new Error(`${generation} metadata exceeds the 16 MiB format limit`)
      const metadataOffset = headerSize + 16
      const metadataBytes = await readExact(handle, metadataOffset, metadataSize)
      const metadataValid = metadataPrefix.readUInt32LE(4) === (crc32(metadataBytes) >>> 0)
      const metadata = parseJsonObject(metadataBytes, `${generation} metadata`)
      if (metadata.magic !== generation || metadata.compression !== 'zstd') throw new Error(`${generation} metadata does not match its container`)

      const validateFooter = async (offset: number): Promise<ValidatedFooter | null> => {
        try {
          if (offset < metadataOffset + metadataSize || offset + footerSize > fileSize) return null
          const footer = await readExact(handle, offset, footerSize)
          if (footer.readUInt32LE(0) !== FOOTER_MAGIC || footer.readUInt16LE(4) !== version || footer.readUInt16LE(6) !== footerSize) return null
          if (version === 4) {
            const lapOffset = u64(footer, 8)
            const chunkOffset = u64(footer, 16)
            const summarySize = footer.readUInt32LE(28)
            if (chunkOffset < lapOffset || offset < chunkOffset || summarySize > lapOffset ||
                (chunkOffset - lapOffset) % 24 || (offset - chunkOffset) % 48) return null
            const lapSize = chunkOffset - lapOffset
            const chunkSize = offset - chunkOffset
            if (lapSize / 24 > MAX_CONTROL_COUNT || chunkSize / 48 > MAX_CONTROL_COUNT) return null
            const summaryOffset = lapOffset - summarySize
            if (summaryOffset < metadataOffset + metadataSize) return null
            const summaryBytes = await readExact(handle, summaryOffset, summarySize)
            const lapBytes = await readExact(handle, lapOffset, lapSize)
            const chunkBytes = await readExact(handle, chunkOffset, chunkSize)
            const parts = [{ bytes: summaryBytes }, { bytes: lapBytes, nullWhenEmpty: true }, { bytes: chunkBytes, nullWhenEmpty: true }]
            const actual = crcParts(parts)
            const portableActual = crcParts(parts.map(part => ({ bytes: part.bytes })))
            if (actual !== footer.readUInt32LE(24) && portableActual !== footer.readUInt32LE(24)) return null
            return { offset, summaryOffset, summaryBytes, lapOffset, lapBytes, chunkOffset, chunkBytes }
          }
          const branchOffset = u64(footer, 8)
          const lapOffset = u64(footer, 16)
          const chunkOffset = u64(footer, 24)
          const rowIndexOffset = u64(footer, 32)
          const summarySize = footer.readUInt32LE(44)
          if (lapOffset < branchOffset || chunkOffset < lapOffset || rowIndexOffset < chunkOffset || offset < rowIndexOffset ||
              summarySize > branchOffset || (lapOffset - branchOffset) % 16 || (chunkOffset - lapOffset) % 24 ||
              (rowIndexOffset - chunkOffset) % 96 || (offset - rowIndexOffset) % 24) return null
          const branchSize = lapOffset - branchOffset
          const lapSize = chunkOffset - lapOffset
          const chunkSize = rowIndexOffset - chunkOffset
          const rowIndexSize = offset - rowIndexOffset
          if (branchSize / 16 > MAX_CONTROL_COUNT || lapSize / 24 > MAX_CONTROL_COUNT || chunkSize / 96 > MAX_CONTROL_COUNT) return null
          const summaryOffset = branchOffset - summarySize
          if (summaryOffset < metadataOffset + metadataSize) return null
          const summaryBytes = await readExact(handle, summaryOffset, summarySize)
          const branchBytes = await readExact(handle, branchOffset, branchSize)
          const lapBytes = await readExact(handle, lapOffset, lapSize)
          const chunkBytes = await readExact(handle, chunkOffset, chunkSize)
          const rowIndexBytes = await readExact(handle, rowIndexOffset, rowIndexSize)
          const parts = [
            { bytes: summaryBytes }, { bytes: branchBytes, nullWhenEmpty: true },
            { bytes: lapBytes, nullWhenEmpty: true }, { bytes: chunkBytes, nullWhenEmpty: true },
            { bytes: rowIndexBytes, nullWhenEmpty: true },
          ]
          const actual = crcParts(parts)
          const portableActual = crcParts(parts.map(part => ({ bytes: part.bytes })))
          if (actual !== footer.readUInt32LE(40) && portableActual !== footer.readUInt32LE(40)) return null
          return { offset, summaryOffset, summaryBytes, branchOffset, branchBytes, lapOffset, lapBytes, chunkOffset, chunkBytes, rowIndexOffset, rowIndexBytes }
        } catch {
          return null
        }
      }

      const findLatestFooter = async (minimum: number): Promise<ValidatedFooter | null> => {
        const blockSize = 1024 * 1024
        let end = fileSize
        while (end > minimum) {
          const begin = Math.max(minimum, end - blockSize)
          const bytes = await readExact(handle, begin, end - begin)
          let found = bytes.lastIndexOf(FOOTER_MARKER)
          while (found >= 0) {
            const candidate = await validateFooter(begin + found)
            if (candidate) return candidate
            found = bytes.lastIndexOf(FOOTER_MARKER, found - 1)
          }
          if (begin === minimum) break
          end = begin + FOOTER_MARKER.length - 1
        }
        return null
      }

      const headerFooterOffset = u64(header, 64, 'footer offset')
      let active = headerShapeValid && storedHeaderCrc === headerCrc ? await validateFooter(headerFooterOffset) : null
      let recovered = !active
      if (active && fileSize > active.offset + footerSize) {
        const newer = await findLatestFooter(active.offset + footerSize)
        if (newer && newer.offset > active.offset) {
          active = newer
          recovered = true
        }
      }
      if (!active) active = await findLatestFooter(headerSize)
      if (!active) throw new Error(`No valid committed ${generation} checkpoint was found`)
      const headerReferencesActive = u64(header, 16) === metadataOffset && u64(header, 24) === metadataSize &&
        u64(header, 32) === active.lapOffset && header.readUInt32LE(40) === active.lapBytes.length / 24 &&
        u64(header, 48) === active.chunkOffset && header.readUInt32LE(56) === active.chunkBytes.length / chunkEntrySize &&
        u64(header, 64) === active.offset && u64(header, 72) === active.summaryOffset &&
        u64(header, 80) === active.summaryBytes.length && (version === 4 || (
          active.rowIndexOffset !== undefined && active.rowIndexBytes !== undefined &&
          active.branchOffset !== undefined && active.branchBytes !== undefined &&
          u64(header, 88) === active.rowIndexOffset && u64(header, 96) === active.rowIndexBytes.length &&
          u64(header, 104) === active.branchOffset && header.readUInt32LE(112) === active.branchBytes.length / 16
        ))
      if (!headerReferencesActive) recovered = true

      const summary = active.summaryBytes.length ? parseJsonObject(active.summaryBytes, `${generation} control summary`) : {}
      const laps: LapInfo[] = []
      for (let offset = 0; offset < active.lapBytes.length; offset += 24) {
        laps.push({
          number: active.lapBytes.readUInt32LE(offset),
          startTime: f32(active.lapBytes, offset + 4),
          endTime: f32(active.lapBytes, offset + 8),
          lapTimeMs: active.lapBytes.readUInt32LE(offset + 12),
          flags: active.lapBytes.readUInt32LE(offset + 16),
        })
      }
      const branches: BranchInfo[] = []
      if (version === 5 && active.branchBytes) {
        for (let offset = 0; offset < active.branchBytes.length; offset += 16) {
          branches.push({ wallClockMs: u64(active.branchBytes, offset), rewindSessionTime: f32(active.branchBytes, offset + 8) })
        }
      }
      const branchCutoffs = new Map<number, number>()
      if (version === 5) {
        let laterCutoff = Infinity
        for (let index = branches.length - 1; index >= 0; index--) {
          branchCutoffs.set(branches[index].wallClockMs, laterCutoff)
          laterCutoff = Math.min(laterCutoff, nextDownFloat32(branches[index].rewindSessionTime))
        }
        const initialWallClock = typeof metadata.start_time === 'number' ? metadata.start_time : 0
        branchCutoffs.set(initialWallClock, laterCutoff)
      }

      progress({ phase: 'directory', fraction: 0.45, detail: `Reading ${active.chunkBytes.length / chunkEntrySize} chunk entries` })
      const chunks: InternalChunk[] = []
      let invalidPrefixes = 0
      const entryCount = active.chunkBytes.length / chunkEntrySize
      for (let index = 0; index < entryCount; index++) {
        const offset = index * chunkEntrySize
        const lapNumber = active.chunkBytes.readUInt32LE(offset)
        const type = active.chunkBytes.readUInt16LE(offset + 4)
        const flags = active.chunkBytes.readUInt16LE(offset + 6)
        const payloadOffset = u64(active.chunkBytes, offset + 8, 'chunk payload offset')
        const compressedSize = u64(active.chunkBytes, offset + 16, 'compressed chunk size')
        const uncompressedSize = u64(active.chunkBytes, offset + 24, 'uncompressed chunk size')
        const rows = active.chunkBytes.readUInt32LE(offset + 32)
        const checksum = active.chunkBytes.readUInt32LE(offset + 36)
        const sequence = u64(active.chunkBytes, offset + 40, 'chunk sequence')
        let prefixValid = false
        if (payloadOffset >= 32 && payloadOffset + compressedSize <= fileSize) {
          const prefix = await readExact(handle, payloadOffset - 32, 32)
          prefixValid = prefix.readUInt32LE(0) === CHUNK_MAGIC && prefix.readUInt32LE(4) === lapNumber &&
            prefix.readUInt16LE(8) === type && prefix.readUInt16LE(10) === flags &&
            u64(prefix, 12) === compressedSize && u64(prefix, 20) === uncompressedSize &&
            prefix.readUInt32LE(28) === rows
        }
        if (!prefixValid) invalidPrefixes++
        let firstTime: number | null = null
        let lastTime: number | null = null
        let logicalLastTime: number | null = null
        let minDistance: number | null = null
        let maxDistance: number | null = null
        let branchWallClockMs: number | null = null
        let visibility: ChunkInfo['visibility'] = 'active'
        if (version === 5) {
          firstTime = finiteOrNull(f32(active.chunkBytes, offset + 48))
          lastTime = finiteOrNull(f32(active.chunkBytes, offset + 52))
          minDistance = finiteOrNull(f32(active.chunkBytes, offset + 60))
          maxDistance = finiteOrNull(f32(active.chunkBytes, offset + 64))
          branchWallClockMs = u64(active.chunkBytes, offset + 88, 'chunk branch timestamp')
          const cutoff = branchCutoffs.get(branchWallClockMs) ?? -Infinity
          if (firstTime !== null && cutoff < firstTime) visibility = 'superseded'
          else if (lastTime !== null && cutoff < lastTime) visibility = 'clipped'
          logicalLastTime = lastTime === null ? null : Math.min(lastTime, cutoff)
        }
        chunks.push({
          id: `chunk:${index}`,
          index,
          kind: 'container',
          lapNumber,
          rowType: type,
          rowTypeName: rowName(type),
          sequence,
          physicalStart: payloadOffset - 32,
          physicalSize: compressedSize + 32,
          payloadOffset,
          compressedSize,
          uncompressedSize,
          rowCount: rows,
          checksum,
          prefixValid,
          firstTime,
          lastTime,
          logicalLastTime,
          timeEstimated: false,
          minDistance,
          maxDistance,
          branchWallClockMs,
          visibility,
        })
        if ((index & 255) === 0) progress({ phase: 'directory', fraction: 0.45 + 0.45 * index / Math.max(1, entryCount), detail: `Validated ${index.toLocaleString()} / ${entryCount.toLocaleString()} chunk prefixes` })
      }
      if (version === 4) estimateV4Times(chunks, laps, summary)

      const regions: RegionInfo[] = [
        { name: 'Fixed header', start: 0, size: headerSize, color: '#f2495c', detail: `${generation} header and active control-table pointers` },
        { name: 'Metadata prefix', start: headerSize, size: 16, color: '#ff9830', detail: 'Metadata marker, encoded length, and checksum' },
        { name: 'Session metadata', start: metadataOffset, size: metadataSize, color: '#e5ac0e', detail: `${Object.keys(metadata).length.toLocaleString()} decoded metadata fields` },
        { name: 'Control summary', start: active.summaryOffset, size: active.summaryBytes.length, color: '#a48ad4', detail: `${Object.keys(summary).length.toLocaleString()} decoded summary fields` },
      ]
      if (version === 5 && active.branchOffset !== undefined && active.branchBytes) regions.push({ name: 'Branch table', start: active.branchOffset, size: active.branchBytes.length, color: '#ff7383', detail: `${branches.length.toLocaleString()} branch entries` })
      regions.push(
        { name: 'Lap table', start: active.lapOffset, size: active.lapBytes.length, color: '#b877d9', detail: `${laps.length.toLocaleString()} lap entries` },
        { name: 'Chunk directory', start: active.chunkOffset, size: active.chunkBytes.length, color: '#8ab8ff', detail: `${entryCount.toLocaleString()} chunk entries` },
      )
      if (version === 5 && active.rowIndexOffset !== undefined && active.rowIndexBytes) regions.push({ name: 'Row index', start: active.rowIndexOffset, size: active.rowIndexBytes.length, color: '#56d4dd', detail: `${(active.rowIndexBytes.length / 24).toLocaleString()} row-index entries` })
      regions.push({ name: 'Commit footer', start: active.offset, size: footerSize, color: '#f2495c', detail: recovered ? 'Recovered committed checkpoint' : 'Active committed control snapshot' })

      const availableTimes = chunks.flatMap(chunk => [chunk.firstTime, chunk.logicalLastTime]).filter((time): time is number => time !== null && Number.isFinite(time))
      const totalRows = chunks.reduce((sum, chunk) => sum + chunk.rowCount, 0)
      const activeRows = chunks.filter(chunk => chunk.visibility !== 'superseded').reduce((sum, chunk) => sum + chunk.rowCount, 0)
      const timeBounds = numericBounds(availableTimes)
      const overview: FileOverview = {
        fileId,
        path: sourcePath,
        name: basename(sourcePath),
        fileSize,
        generation,
        compression: 'zstd',
        metadata,
        summary,
        integrity: {
          header: headerShapeValid && storedHeaderCrc === headerCrc && headerReferencesActive,
          metadata: metadataValid,
          control: true,
          invalidPrefixes,
          recoveredCheckpoint: recovered,
          partial: active.offset + footerSize < fileSize,
        },
        laps,
        branches,
        regions: regions.filter(region => region.size > 0),
        chunks,
        totalRows,
        activeRows,
        compressedPayloadBytes: chunks.reduce((sum, chunk) => sum + chunk.compressedSize, 0),
        uncompressedPayloadBytes: chunks.reduce((sum, chunk) => sum + chunk.uncompressedSize, 0),
        startTime: timeBounds.minimum ?? (laps[0]?.startTime ?? null),
        endTime: timeBounds.maximum ?? (laps.at(-1)?.endTime ?? null),
      }
      this.files.set(fileId, { overview, sourcePath, chunks: new Map(chunks.map(chunk => [chunk.id, chunk])) })
      progress({ phase: 'ready', fraction: 1, detail: `Loaded ${chunks.length.toLocaleString()} chunks` })
      return overview
    } finally {
      await handle.close()
    }
  }

  private async rawEntry(fileId: string, chunkId: string): Promise<RawCacheEntry> {
    const key = `${fileId}:${chunkId}`
    const cached = this.rawCache.get(key)
    if (cached) {
      this.rawCache.delete(key)
      this.rawCache.set(key, cached)
      return cached
    }
    const file = this.files.get(fileId)
    const chunk = file?.chunks.get(chunkId)
    if (!file || !chunk) throw new Error('That recording or chunk is no longer open')
    let buffer: Buffer
    let checksumValid: boolean | null = null
    if (chunk.kind === 'stream-block') {
      if (!file.tempPath || chunk.rawOffset === undefined || chunk.rawLength === undefined) throw new Error('Monolithic stream cache is unavailable')
      const handle = await open(file.tempPath, 'r')
      try { buffer = await readExact(handle, chunk.rawOffset, chunk.rawLength) } finally { await handle.close() }
    } else {
      if (chunk.payloadOffset === null) throw new Error('Chunk has no payload offset')
      const handle = await open(file.sourcePath, 'r')
      try {
        const compressed = await readExact(handle, chunk.payloadOffset, chunk.compressedSize)
        buffer = await decompressZstd(compressed, chunk.uncompressedSize)
      } finally {
        await handle.close()
      }
      checksumValid = buffer.length === chunk.uncompressedSize && chunk.checksum !== null && (crc32(buffer) >>> 0) === chunk.checksum
    }
    const indexed = buildLineIndex(buffer)
    const entry: RawCacheEntry = {
      key,
      buffer,
      lineStarts: indexed.starts,
      firstTime: indexed.firstTime,
      lastTime: indexed.lastTime,
      checksumValid,
      rowCountValid: indexed.starts.length === chunk.rowCount,
    }
    while (this.rawCacheBytes + buffer.length > RAW_CACHE_LIMIT && this.rawCache.size) {
      const oldest = this.rawCache.entries().next().value as [string, RawCacheEntry] | undefined
      if (!oldest) break
      this.rawCache.delete(oldest[0])
      this.rawCacheBytes -= oldest[1].buffer.length
    }
    this.rawCache.set(key, entry)
    this.rawCacheBytes += buffer.length
    return entry
  }

  async rawPage(request: RawPageRequest): Promise<RawPage> {
    const entry = await this.rawEntry(request.fileId, request.chunkId)
    const pageSize = Math.max(1, Math.min(1000, Math.floor(request.pageSize)))
    const query = (request.query ?? '').trim().toLocaleLowerCase().slice(0, 256)
    let indices: number[] | null = null
    if (query) {
      indices = []
      for (let index = 0; index < entry.lineStarts.length; index++) {
        const start = entry.lineStarts[index]
        let end = index + 1 < entry.lineStarts.length ? entry.lineStarts[index + 1] - 1 : entry.buffer.length
        if (end > start && entry.buffer[end - 1] === 0x0d) end--
        if (entry.buffer.toString('utf8', start, end).toLocaleLowerCase().includes(query)) indices.push(index)
      }
    }
    const filteredLines = indices?.length ?? entry.lineStarts.length
    const pages = Math.max(1, Math.ceil(filteredLines / pageSize))
    const page = Math.max(0, Math.min(pages - 1, Math.floor(request.page)))
    const pageStart = page * pageSize
    const pageEnd = Math.min(filteredLines, (page + 1) * pageSize)
    const selected = indices?.slice(pageStart, pageEnd) ?? Array.from(
      { length: pageEnd - pageStart },
      (_, index) => pageStart + index,
    )
    const lines = selected.map(index => {
      const start = entry.lineStarts[index]
      let end = index + 1 < entry.lineStarts.length ? entry.lineStarts[index + 1] - 1 : entry.buffer.length
      if (end > start && entry.buffer[end - 1] === 0x0d) end--
      return { number: index + 1, text: entry.buffer.toString('utf8', start, end) }
    })
    return {
      chunkId: request.chunkId,
      page,
      pageSize,
      totalLines: entry.lineStarts.length,
      filteredLines,
      totalBytes: entry.buffer.length,
      lines,
      checksumValid: entry.checksumValid,
      rowCountValid: entry.rowCountValid,
      firstTime: entry.firstTime,
      lastTime: entry.lastTime,
    }
  }

  async rawBuffer(fileId: string, chunkId: string): Promise<Buffer> {
    return (await this.rawEntry(fileId, chunkId)).buffer
  }

  async controlRegionPage(request: ControlRegionPageRequest): Promise<ControlRegionPage> {
    const file = this.files.get(request.fileId)
    if (!file) throw new Error('That recording is no longer open')
    const region = file.overview.regions.find(candidate =>
      candidate.name === request.name && candidate.start === request.start && candidate.size === request.size)
    if (!region) throw new Error('That control-plane region is not part of the open recording')

    const pageSize = Math.max(256, Math.min(16 * 1024, Math.floor(request.pageSize)))
    const pages = Math.max(1, Math.ceil(region.size / pageSize))
    const page = Math.max(0, Math.min(pages - 1, Math.floor(request.page)))
    const relativeOffset = page * pageSize
    const length = Math.max(0, Math.min(pageSize, region.size - relativeOffset))
    const handle = await open(file.sourcePath, 'r')
    let bytes: Buffer
    try {
      bytes = await readExact(handle, region.start + relativeOffset, length)
    } finally {
      await handle.close()
    }

    const lines: string[] = []
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const line = bytes.subarray(offset, Math.min(bytes.length, offset + 16))
      const hex = [...line].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ').padEnd(47, ' ')
      const ascii = [...line].map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('')
      const absolute = region.start + relativeOffset + offset
      lines.push(`${absolute.toString(16).padStart(12, '0').toUpperCase()}  ${hex}  |${ascii}|`)
    }
    return { name: region.name, page, pageSize, totalBytes: region.size, pageOffset: relativeOffset, lines }
  }
}
