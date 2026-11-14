// Find post-execute truncation markers in session tool results.
import { readFileSync, readdirSync, statSync } from 'node:fs'
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
for (const dir of readdirSync(root)) {
  const f = join(root, dir, 'session.v4.jsonl.zstd')
  try { if (!statSync(f).isFile()) continue } catch { continue }
  const evs = decodeFrames(readFileSync(f)).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const hits = evs.filter((ev) => ev.type === 'tool/result' && JSON.stringify(ev.data ?? ev).includes('TRUNCATED'))
  if (!hits.length) continue
  console.log(`\n=== ${dir} truncation_markers=${hits.length} ===`)
  for (const ev of hits.slice(0, 6)) {
    const text = JSON.stringify(ev.data)
    const match = text.match(/TRUNCATED (\d+) of (\d+) bytes/)
    console.log(' ', match ? `omitted=${match[1]} total=${match[2]}` : text.slice(0, 160))
  }
}
