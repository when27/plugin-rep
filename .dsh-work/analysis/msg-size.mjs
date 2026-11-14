// Summarize assistant messages: text/reasoning sizes and tool call counts.
// Usage: node .dsh-work/analysis/msg-size.mjs <dirPrefix>
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
const dir = readdirSync(root).find((d) => d.includes(target))
const evs = decodeFrames(readFileSync(join(root, dir, 'session.v4.jsonl.zstd'))).split('\n').filter(Boolean).map((l) => JSON.parse(l))
let i = 0
for (const ev of evs) {
  if (ev.type !== 'assistant/message') continue
  i += 1
  const d = ev.data ?? {}
  const msg = d.message ?? d
  const content = msg.content ?? d.content ?? []
  const blocks = Array.isArray(content) ? content : []
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const reasoning = blocks.filter((b) => /reasoning|thinking/.test(b.type ?? '')).map((b) => b.text ?? b.reasoning ?? '').join('')
  const calls = blocks.filter((b) => b.type === 'tool-call' || b.type === 'tool_use')
  const u = d.usage ?? ev.usage ?? {}
  console.log(`msg ${i}: out=${u.outputTokens} in=${u.inputTokens} cacheRead=${u.cacheReadTokens} blocks=${blocks.map((b) => b.type).join('+')} textChars=${text.length} reasoningChars=${reasoning.length} toolCalls=${calls.length} topKeys=${Object.keys(d).join(',')}`)
  if (text.length > 2000) console.log('  text head:', JSON.stringify(text.slice(0, 300)))
  if (reasoning.length) console.log('  reasoning head:', JSON.stringify(reasoning.slice(0, 300)))
  if (calls.length) console.log('  calls:', calls.map((c) => c.name + '(' + String(JSON.stringify(c.arguments ?? c.input ?? {})).length + ' json chars)').join(' '))
}
