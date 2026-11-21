// Rank recent sessions by output tokens and reasoning-text share.
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
const rows = []
for (const dir of readdirSync(root)) {
  const f = join(root, dir, 'session.v4.jsonl.zstd')
  try { if (!statSync(f).isFile()) continue } catch { continue }
  const evs = decodeFrames(readFileSync(f)).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const h = evs.find((e) => e.type === 'session') ?? {}
  let out = 0, inTok = 0, cache = 0, reason = 0, text = 0, msgN = 0
  for (const ev of evs) {
    if (ev.type !== 'assistant/message') continue
    const d = ev.data ?? {}
    const u = d.usage ?? {}
    out += Number(u.outputTokens ?? 0); inTok += Number(u.inputTokens ?? 0); cache += Number(u.cacheReadTokens ?? 0)
    const blocks = d.message?.content ?? d.content ?? []
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (/reasoning|thinking/.test(b.type ?? '')) reason += String(b.text ?? '').length
      if (b.type === 'text') text += String(b.text ?? '').length
    }
    msgN += 1
  }
  rows.push({ dir, h, out, inTok, cache, reason, text, msgN, mtime: statSync(f).mtime, events: evs.length })
}
// Recent architect runs only (after 2026-11-14T03:30Z)
const recent = rows.filter((r) => r.mtime > new Date('2026-11-14T03:30:00Z'))
recent.sort((a, b) => b.out - a.out)
console.log('RECENT (since 03:30Z) sessions by out:')
for (const r of recent) {
  console.log(`${r.dir.padEnd(48)} preset=${(r.h.agentPreset ?? '-').padEnd(8)} origin=${(r.h.origin ?? 'main').padEnd(8)} out=${String(r.out).padStart(6)} in=${String(r.inTok).padStart(6)} cacheRead=${String(r.cache).padStart(7)} msgs=${String(r.msgN).padStart(3)} reasoningChars=${String(r.reason).padStart(7)} textChars=${String(r.text).padStart(6)}  ~reasoningTokens=${Math.round(r.reason / 4)}`)
}
const arch = rows.filter((r) => r.h.agentPreset === 'architect' || r.dir.startsWith('mnemon-run'))
console.log('\nALL ARCHITECT sessions total out:', arch.reduce((a, r) => a + r.out, 0), 'reasoningChars:', arch.reduce((a, r) => a + r.reason, 0), 'textChars:', arch.reduce((a, r) => a + r.text, 0))
