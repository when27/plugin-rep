// Dump selected event payloads from one DSH session log.
// Usage: node .dsh-work/analysis/dump-events.mjs <dirPrefix> <typeRegex> [maxPerType]
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeFrames(buf) {
  const starts = []
  let at = 0
  while (at < buf.length - 3) { const i = buf.indexOf(MAGIC, at); if (i < 0) break; starts.push(i); at = i + 4 }
  const parts = []
  for (let k = 0; k < starts.length; k++) { try { parts.push(zstdDecompressSync(buf.subarray(starts[k], starts[k + 1] ?? buf.length))) } catch {} }
  return Buffer.concat(parts).toString('utf8')
}
const root = 'C:/Users/Administrator/.dsh/sessions/--C-Users-Administrator-Documents-deepseek-harness-default-workspace--'
const target = process.argv[2]
const re = new RegExp(process.argv[3] ?? '.')
const max = Number(process.argv[4] ?? 3)
const dir = readdirSync(root).find((d) => d.includes(target))
const evs = decodeFrames(readFileSync(join(root, dir, 'session.v4.jsonl.zstd'))).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const counts = new Map()
for (const ev of evs) {
  if (!re.test(ev.type)) continue
  const n = counts.get(ev.type) ?? 0
  counts.set(ev.type, n + 1)
  if (n >= max) continue
  console.log(`\n### ${ev.type} seq=${ev.seq} ts=${ev.timestamp ?? ev.at ?? ''}`)
  console.log(JSON.stringify(ev).slice(0, 12000))
}
console.log('\ncounts:', Object.fromEntries(counts))
