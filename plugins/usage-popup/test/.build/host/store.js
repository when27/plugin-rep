// Append-only JSONL store for the host usage collector.
//
// One line per UsageRecord. The sequence number lives inside the record so it is
// stable across restarts: at boot we replay the log, keep the last
// MAX_RECORDS valid rows, and continue from maxSeq + 1. Corrupt or truncated
// lines (a crash mid-append) are skipped rather than fatal.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export const FORMAT = 'usage-popup.host-usage';
export const FORMAT_VERSION = 1;
export const MAX_RECORDS = 20_000;
export const ROTATE_BYTES = 32 * 1024 * 1024;
/** `$DSH_HOME` (or `~/.dsh`) + `usage-popup`. */
export function resolveDataDir(env = process.env) {
    const home = env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
    return join(home, 'usage-popup');
}
export function resolveRecordsPath(env = process.env) {
    return join(resolveDataDir(env), 'usage-records.jsonl');
}
function isRecord(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const record = value;
    return (typeof record.id === 'string'
        && typeof record.seq === 'number'
        && Number.isSafeInteger(record.seq)
        && record.seq > 0
        && (record.kind === 'llm' || record.kind === 'tool')
        && typeof record.at === 'number');
}
export class UsageStore {
    file;
    records = [];
    maxSeq = 0;
    loadErrors = 0;
    writeErrors = 0;
    nextSeq = 1;
    queue = Promise.resolve();
    appends = 0;
    constructor(options = {}) {
        this.file = options.file ?? resolveRecordsPath();
    }
    /** Read the log synchronously at boot; truncate the in-memory window. */
    load() {
        this.records.length = 0;
        this.nextSeq = 1;
        this.maxSeq = 0;
        try {
            if (!existsSync(this.file))
                return;
            try {
                if (statSync(this.file).size >= ROTATE_BYTES) {
                    this.rotateSync();
                    return;
                }
            }
            catch {
                /* size unavailable: keep appending */
            }
            const text = readFileSync(this.file, 'utf8');
            const lines = text.split('\n');
            const parsed = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === '')
                    continue;
                try {
                    const value = JSON.parse(trimmed);
                    if (!isRecord(value)) {
                        this.loadErrors += 1;
                        continue;
                    }
                    parsed.push(value);
                }
                catch {
                    // A truncated final line is expected after a hard kill.
                    this.loadErrors += 1;
                }
            }
            parsed.sort((a, b) => a.seq - b.seq);
            const start = Math.max(0, parsed.length - MAX_RECORDS);
            for (let index = start; index < parsed.length; index += 1) {
                const record = parsed[index];
                this.records.push(record);
                if (record.seq > this.maxSeq)
                    this.maxSeq = record.seq;
            }
            // Duplicate/backwards seqs are tolerated: stay strictly after the max.
            this.nextSeq = this.maxSeq + 1;
        }
        catch {
            this.loadErrors += 1;
        }
    }
    /** Append one record, assign its persistent seq, and queue the disk write. */
    append(input) {
        const seq = this.nextSeq;
        this.nextSeq += 1;
        const record = { id: `h:${seq}`, seq, ...input };
        this.maxSeq = seq;
        this.records.push(record);
        if (this.records.length > MAX_RECORDS)
            this.records.splice(0, this.records.length - MAX_RECORDS);
        this.enqueue(record);
        return record;
    }
    /** Ascending records with `seq > since`, capped at `limit`. */
    since(since, limit = 500) {
        const out = [];
        if (!(limit > 0))
            return out;
        for (const record of this.records) {
            if (record.seq <= since)
                continue;
            out.push(record);
            if (out.length >= limit)
                break;
        }
        return out;
    }
    get cursor() {
        return this.maxSeq;
    }
    get count() {
        return this.records.length;
    }
    /** Await all queued writes (tests / shutdown). */
    async flush() {
        await this.queue;
    }
    enqueue(record) {
        this.queue = this.queue
            .then(() => this.write(record))
            .catch(() => {
            this.writeErrors += 1;
        });
    }
    async write(record) {
        await mkdir(dirname(this.file), { recursive: true });
        this.appends += 1;
        if (this.appends % 256 === 0) {
            try {
                const info = await stat(this.file);
                if (info.size >= ROTATE_BYTES)
                    await rename(this.file, `${this.file}.1`);
            }
            catch {
                /* missing file is fine */
            }
        }
        await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    }
    rotateSync() {
        try {
            renameSync(this.file, `${this.file}.1`);
            writeFileSync(this.file, '', 'utf8');
        }
        catch {
            /* rotation is best effort */
        }
    }
}
