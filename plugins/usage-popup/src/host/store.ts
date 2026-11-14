// Append-only JSONL store for the host usage collector.
//
// One line per UsageRecord. The sequence number lives inside the record so it is
// stable across restarts: at boot we replay the log, keep the last
// MAX_RECORDS valid rows, and continue from maxSeq + 1. Corrupt or truncated
// lines (a crash mid-append) are skipped rather than fatal.

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const FORMAT = 'usage-popup.host-usage'
export const FORMAT_VERSION = 1
export const MAX_RECORDS = 20_000
export const ROTATE_BYTES = 32 * 1024 * 1024

export type RecordKind = 'llm' | 'tool'
export type RecordSource = 'llm-stream' | 'wire' | 'tool-event'
export type SessionType = 'main' | 'subagent' | 'background' | 'compaction' | 'unknown'

export interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number | null
}

export interface ServerToolUsage {
  name: string
  requests: number
  status: number | null
  feeUsd: number
}

export interface UsageRecord {
  id: string
  seq: number
  at: number
  kind: RecordKind
  source: RecordSource
  sessionId: string | null
  sessionType: SessionType
  parentSessionId: string | null
  delegationDepth: number | null
  agentPreset: string | null
  model: string
  provider: string | null
  purpose: string | null
  usage: NormalizedUsage | null
  serverTool: ServerToolUsage | null
}

export type UsageRecordInput = Omit<UsageRecord, 'id' | 'seq'>

/** `$DSH_HOME` (or `~/.dsh`) + `usage-popup`. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'usage-popup')
}

export function resolveRecordsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataDir(env), 'usage-records.jsonl')
}

function isRecord(value: unknown): value is UsageRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Partial<UsageRecord>
  return (
    typeof record.id === 'string'
    && typeof record.seq === 'number'
    && Number.isSafeInteger(record.seq)
    && record.seq > 0
    && (record.kind === 'llm' || record.kind === 'tool')
    && typeof record.at === 'number'
  )
}

export class UsageStore {
  readonly file: string
  readonly records: UsageRecord[] = []
  maxSeq = 0
  loadErrors = 0
  writeErrors = 0
  private nextSeq = 1
  private queue: Promise<void> = Promise.resolve()
  private appends = 0

  constructor(options: { file?: string } = {}) {
    this.file = options.file ?? resolveRecordsPath()
  }

  /** Read the log synchronously at boot; truncate the in-memory window. */
  load(): void {
    this.records.length = 0
    this.nextSeq = 1
    this.maxSeq = 0
    try {
      if (!existsSync(this.file)) return
      try {
        if (statSync(this.file).size >= ROTATE_BYTES) {
          this.rotateSync()
          return
        }
      } catch {
        /* size unavailable: keep appending */
      }
      const text = readFileSync(this.file, 'utf8')
      const lines = text.split('\n')
      const parsed: UsageRecord[] = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const value = JSON.parse(trimmed) as unknown
          if (!isRecord(value)) {
            this.loadErrors += 1
            continue
          }
          parsed.push(value)
        } catch {
          // A truncated final line is expected after a hard kill.
          this.loadErrors += 1
        }
      }
      parsed.sort((a, b) => a.seq - b.seq)
      const start = Math.max(0, parsed.length - MAX_RECORDS)
      for (let index = start; index < parsed.length; index += 1) {
        const record = parsed[index]!
        this.records.push(record)
        if (record.seq > this.maxSeq) this.maxSeq = record.seq
      }
      // Duplicate/backwards seqs are tolerated: stay strictly after the max.
      this.nextSeq = this.maxSeq + 1
    } catch {
      this.loadErrors += 1
    }
  }

  /** Append one record, assign its persistent seq, and queue the disk write. */
  append(input: UsageRecordInput): UsageRecord {
    const seq = this.nextSeq
    this.nextSeq += 1
    const record: UsageRecord = { id: `h:${seq}`, seq, ...input }
    this.maxSeq = seq
    this.records.push(record)
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS)
    this.enqueue(record)
    return record
  }

  /** Ascending records with `seq > since`, capped at `limit`. */
  since(since: number, limit = 500): UsageRecord[] {
    const out: UsageRecord[] = []
    if (!(limit > 0)) return out
    for (const record of this.records) {
      if (record.seq <= since) continue
      out.push(record)
      if (out.length >= limit) break
    }
    return out
  }

  get cursor(): number {
    return this.maxSeq
  }

  get count(): number {
    return this.records.length
  }

  /** Await all queued writes (tests / shutdown). */
  async flush(): Promise<void> {
    await this.queue
  }

  private enqueue(record: UsageRecord): void {
    this.queue = this.queue
      .then(() => this.write(record))
      .catch(() => {
        this.writeErrors += 1
      })
  }

  private async write(record: UsageRecord): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    this.appends += 1
    if (this.appends % 256 === 0) {
      try {
        const info = await stat(this.file)
        if (info.size >= ROTATE_BYTES) await rename(this.file, `${this.file}.1`)
      } catch {
        /* missing file is fine */
      }
    }
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8')
  }

  private rotateSync(): void {
    try {
      renameSync(this.file, `${this.file}.1`)
      writeFileSync(this.file, '', 'utf8')
    } catch {
      /* rotation is best effort */
    }
  }
}
