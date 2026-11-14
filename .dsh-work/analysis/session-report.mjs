// Report recent DSH sessions and assistant/message usage detail.
// Usage: node .dsh-work/analysis/session-report.mjs [sessionIdOrDir] [root]
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
    starts.push(i); at = i + 4
  }
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    try { parts.push(zstdDecompressSync(buf.subarray(starts[k], starts[k + 1] ?? buf.length))) } catch {}
  }
  return Buffer.concat(parts).toString('utf8')
}
const root = 'C:/Users/Administrator/.dsh/sessions/--C-Users-Administrator-Documents-deepseek-harness-default-workspace--'
const target = process.argv[2]

function statsOf(dir) {
  const file = join(root, dir, 'session.v4.jsonl.zstd')
  const evs = decodeFrames(readFileSync(file)).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const header = evs.find((e) => e.type === 'session') ?? {}
  let out = 0, inp = 0, n = 0, toolCalls = 0, thinking = 0
  for (const ev of evs) {
    if (ev.type === 'tool/call') toolCalls += 1
    if (ev.type === 'assistant/message') {
      const u = ev.data?.usage ?? ev.usage ?? {}
      out += Number(u.outputTokens ?? u.output ?? 0)
      inp += Number(u.inputTokens ?? 0)
      n += 1
    }
    if (/thinking|reasoning/i.test(ev.type ?? '')) thinking += 1
  }
  return { dir, header, out, inp, n, toolCalls, thinking, mtime: statSync(file).mtime, events: evs.length }
}

if (process.argv[3] === 'recent' || !target) {
  const all = readdirSync(root).filter((d) => { try { return statSync(join(root, d, 'session.v4.jsonl.zstd')).isFile() } catch { return false } }).map(statsOf)
  all.sort((a, b) => b.mtime - a.mtime)
  for (const s of all.slice(0, 30)) {
    console.log(`${s.mtime.toISOString()} out=${String(s.out).padStart(7)} in=${String(s.inp).padStart(7)} msgs=${String(s.n).padStart(3)} tools=${String(s.toolCalls).padStart(3)} preset=${s.header.agentPreset ?? '-'} origin=${s.header.origin ?? 'main'} parent=${(s.header.parentSession ?? '').slice(0, 20)} id=${s.dir}`)
  }
  process.exit(0)
}

const dirs = readdirSync(root).filter((d) => d.startsWith(target) || d.includes(target))
for (const dir of dirs) {
  const file = join(root, dir, 'session.v4.jsonl.zstd')
  const evs = decodeFrames(readFileSync(file)).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const header = evs.find((e) => e.type === 'session')
  console.log(`\n===== ${dir} =====`)
  console.log('header:', JSON.stringify(header))
  console.log('mtime:', statSync(file).mtime.toISOString(), 'events:', evs.length)
  let totalOut = 0, totalIn = 0, steps = 0, turn = 0
  for (const ev of evs) {
    if (ev.type === 'turn/start') { turn += 1; console.log(`\n--- turn ${turn} @ ${new Date(ev.timestamp ?? Date.now()).toISOString()} ---`) }
    if (ev.type === 'model/selection') console.log('model/selection:', JSON.stringify(ev.data ?? ev).slice(0, 300))
    if (ev.type === 'step/end' || ev.type === 'step/start') continue
    if (ev.type === 'assistant/message') {
      const d = ev.data ?? {}
      const u = d.usage ?? ev.usage ?? {}
      const out = Number(u.outputTokens ?? u.output ?? 0)
      const inp = Number(u.inputTokens ?? 0)
      const cache = Number(u.cacheReadTokens ?? 0)
      totalOut += out; totalIn += inp; steps += 1
      const keys = Object.keys(u).join(',')
      const thinking = d.thinking ?? d.reasoning ?? d.reasoningContent ?? d.thinkingContent
      console.log(`step ${steps}: model=${d.model ?? d.modelId ?? ev.model ?? '?'} in=${inp} cacheRead=${cache} out=${out} usageKeys=[${keys}] thinking=${thinking ? String(thinking).length : 0}`)
      if (thinking) console.log('  thinking preview:', String(thinking).slice(0, 200).replace(/\n/g, ' '))
    }
    if (ev.type === 'assistant/thinking' || ev.type === 'assistant/reasoning') {
      const text = ev.data?.text ?? ev.data?.content ?? ev.data?.reasoning
      console.log(`THINKING EVENT ${ev.type}: ${String(text).length} chars`)
    }
    if (ev.type === 'user/message') console.log('USER:', JSON.stringify(ev.data).slice(0, 160))
    if (ev.type === 'tool/call') console.log('TOOL CALL:', ev.data?.name ?? '?', String(ev.data?.arguments?.description ?? ev.data?.arguments?.command ?? '').slice(0, 80))
  }
  console.log(`\nTOTALS out=${totalOut} in=${totalIn} assistantMessages=${steps}`)
}
