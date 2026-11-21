// Decode concatenated zstd frames produced by the DSH session store, then scan
// for billed usage samples. Run: node .dsh-work/analysis/scan-usage.mjs [root]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeFrames(buf) {
  const starts = []
  let at = 0
  while (at < buf.length - 3) {
    const i = buf.indexOf(MAGIC, at)
    if (i < 0) break
    starts.push(i)
    at = i + 4
  }
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const slice = buf.subarray(starts[k], starts[k + 1] ?? buf.length)
    try { parts.push(zstdDecompressSync(slice)) } catch (e) { /* not a frame boundary */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

const root = process.argv[2] ?? 'C:/Users/Administrator/.dsh/sessions/--C-Users-Administrator-Documents-deepseek-harness-default-workspace--'
const dirs = readdirSync(root).filter((d) => {
  try { return statSync(join(root, d)).isDirectory() && statSync(join(root, d, 'session.v4.jsonl.zstd')).isFile() } catch { return false }
})

const rows = []
for (const dir of dirs) {
  const file = join(root, dir, 'session.v4.jsonl.zstd')
  let events
  try {
    const text = decodeFrames(readFileSync(file))
    events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch (e) { console.error('skip', dir, e.message); continue }
  const header = events.find((e) => e.type === 'session') ?? {}
  const types = new Map()
  const samples = []
  for (const ev of events) {
    const t = ev.type ?? '?'
    types.set(t, (types.get(t) ?? 0) + 1)
    const u = ev.usage ?? ev.data?.usage
    if (u && typeof u === 'object' && (u.output !== undefined || u.outputTokens !== undefined || u.completion_tokens !== undefined || u.reasoning !== undefined)) {
      samples.push({ t, model: ev.model ?? ev.data?.model ?? ev.data?.modelId, u })
    }
  }
  let out = 0, reason = 0, input = 0, cacheHit = 0
  for (const s of samples) {
    const u = s.u
    out += Number(u.output ?? u.outputTokens ?? u.completion_tokens ?? 0) || 0
    reason += Number(u.reasoning ?? u.reasoningTokens ?? u.reasoning_tokens ?? u.reasoning_content_tokens ?? 0) || 0
    input += Number(u.input ?? u.inputTokens ?? u.prompt_tokens ?? 0) || 0
    cacheHit += Number(u.cacheHit ?? u.cachedInput ?? u.cacheRead ?? u.cached_input_tokens ?? 0) || 0
  }
  const stat = statSync(file)
  rows.push({ dir, mtime: stat.mtime, bytes: stat.size, header, events: events.length, samples, out, reason, input, cacheHit, types: [...types.entries()].sort((a, b) => b[1] - a[1]) })
}

rows.sort((a, b) => b.out - a.out)
for (const r of rows.slice(0, 12)) {
  console.log(`=== ${r.dir} out=${r.out} reason=${r.reason} in=${r.input} cacheHit=${r.cacheHit} samples=${r.samples.length} events=${r.events} mtime=${r.mtime.toISOString()} ===`)
  console.log(' header:', JSON.stringify({ parent: r.header.parentSession, depth: r.header.delegationDepth, preset: r.header.agentPreset, origin: r.header.origin }))
  console.log(' types:', r.types.map(([t, n]) => `${t}:${n}`).join(' '))
  for (const s of r.samples.slice(0, 4)) console.log('  sample:', s.t, JSON.stringify(s.u).slice(0, 500))
}
const withSamples = rows.filter((r) => r.samples.length)
console.log(`\nscanned=${rows.length} withUsage=${withSamples.length} sumOut=${rows.reduce((a, r) => a + r.out, 0)} sumReason=${rows.reduce((a, r) => a + r.reason, 0)}`)
