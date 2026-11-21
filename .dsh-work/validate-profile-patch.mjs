// Validate the intended ~/.dsh/profiles/desktop/cordis.patch.yml edit WITHOUT
// writing outside the workspace. Reads the live profile file, applies the exact
// replacement, parses the result, and writes the validated YAML to a workspace
// copy that can be published to plugin-rep.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/Administrator/.dsh/profiles/desktop/package.json')
const YAML = require('yaml')

const LIVE = 'C:/Users/Administrator/.dsh/profiles/desktop/cordis.patch.yml'
const OUT = new URL('./profile-cordis.patch.yml', import.meta.url)

const before = readFileSync(LIVE, 'utf8')
const replacement = /(^[ \t]*- id: agent-default-model\r?\n(?:^[ \t].*\r?\n)*?^[ \t]+reasoningEffort:[ \t]*)high[ \t]*$/m
const after = before.replace(replacement, '$1low')

if (after === before) {
  console.error('FAIL: agent-default-model reasoningEffort: high not found')
  process.exit(1)
}

const parsed = YAML.parse(after)
const rows = Array.isArray(parsed) ? parsed : [parsed]
const row = rows.find((entry) => entry?.id === 'agent-default-model')
if (!row) {
  console.error('FAIL: agent-default-model row missing after edit')
  process.exit(1)
}
if (row.config?.reasoningEffort !== 'low') {
  console.error(`FAIL: reasoningEffort is ${JSON.stringify(row.config?.reasoningEffort)}`)
  process.exit(1)
}
// Guard the rest of the profile: every top-level entry parses as a patch row.
if (!rows.every((entry) => entry && typeof entry === 'object')) {
  console.error('FAIL: a top-level patch entry is not an object')
  process.exit(1)
}

const changedLines = after.split('\n').filter((line, index) => line !== before.split('\n')[index])
writeFileSync(OUT, after)
console.log('PASS yaml parses; agent-default-model config =', JSON.stringify(row.config))
console.log('changed lines:', changedLines.length, changedLines.map((l) => l.trim()).join(' | '))
console.log('wrote', OUT.pathname)
