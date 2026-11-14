// Minimal text probe for packages inside app.asar (run under Electron's node).
// usage: <exe> .preset-probe.cjs <dir> <regex>
const fs = require('fs')
const path = require('path')
const [dir, re] = process.argv.slice(2)
if (!dir || !re) {
  console.error('usage: probe.cjs <dir> <regex>')
  process.exit(2)
}
const rx = new RegExp(re, 'i')
let hits = 0
const files = fs.readdirSync(dir, { recursive: true })
for (const rel of files) {
  const file = path.join(dir, rel)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    continue
  }
  if (!stat.isFile() || !/\.(js|mjs|cjs|json|ts)$/.test(file)) continue
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (!rx.test(lines[i])) continue
    console.log(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 500)}`)
    hits += 1
    if (hits >= 80) {
      console.log('--- hit cap reached ---')
      process.exit(0)
    }
  }
}
console.log(`--- ${hits} hit(s) ---`)
