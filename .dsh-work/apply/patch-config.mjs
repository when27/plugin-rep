#!/usr/bin/env node
/**
 * Replace only the `tier-router` block in a DSH profile's cordis.patch.yml.
 *
 * The block is located by its two stable anchors, not by line number, so other
 * rows added by another agent are preserved. Run with no arguments to patch
 * the default desktop profile; pass a path to patch a copy for testing.
 *
 *   node patch-config.mjs [path/to/cordis.patch.yml]
 *
 * Exits 0 when patched or already patched; exits 1 (leaving the file untouched)
 * when the expected anchors or values are missing.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

const file = process.argv[2] ?? '/c/Users/Administrator/.dsh/profiles/desktop/cordis.patch.yml'
const START = '# dsh-tier-router: virtual provider'
const END = '    routeFailureThreshold: 2\n'

const NEW_BLOCK = `# dsh-tier-router: virtual provider "tier-router" / model "smart".
# Hard and fallback tiers start on the DeepSeek account route. Easy turns
# start on Gemini and then follow the explicit easy fallback chain:
# google → google-vertex → zai → zai-2 → deepseek-account.
# dsh-tier-router 0.6.0 is patched in place with per-tier fallback arrays
# (easyFallbacks / hardFallbacks), matching the existing visionFallbacks.
# \`hard\` keeps its existing route; only easyFallbacks is configured here.
- id: tier-router
  name: dsh-tier-router
  config:
    enabled: true
    classifier: heuristic

    hardProvider: deepseek-account
    hardModel: deepseek-flash
    hardEffort: max

    normalProvider: deepseek-account
    normalModel: deepseek-flash
    normalEffort: max

    easyProvider: google
    easyModel: gemini-3.5-flash
    easyEffort: ''
    easyFallbacks:
      - provider: google-vertex
        model: gemini-3.5-flash
      - provider: zai
        model: glm-5.3-flash
      - provider: zai-2
        model: glm-5.3-flash

    visionProvider: google
    visionModel: gemini-3.5-flash
    visionMode: replace
    visionFallbacks:
      - provider: google-vertex
        model: gemini-3.5-flash
      - provider: zai
        model: glm-5.3-flash
      - provider: zai-2
        model: glm-5.3-flash
      - provider: deepseek-account
        model: deepseek-flash

    fallbackProvider: deepseek-account
    fallbackModel: deepseek-flash
    contextGuard: true
    routeCooldownMs: 300000
    routeFailureThreshold: 2
`

const text = readFileSync(file, 'utf8')
if (text.includes('easyFallbacks:')) {
  console.log('already patched: easyFallbacks present')
  process.exit(0)
}
const start = text.indexOf(START)
if (start < 0 || text.indexOf(START, start + 1) !== -1) {
  console.error('ABORT: tier-router start anchor not found exactly once')
  process.exit(1)
}
const end = text.indexOf(END, start)
if (end < 0) {
  console.error('ABORT: tier-router end anchor not found after start')
  process.exit(1)
}
const block = text.slice(start, end + END.length)
for (const expected of [
  'easyProvider: google',
  'easyModel: gemini-3.5-flash',
  'hardProvider: deepseek-account',
  'hardModel: deepseek-flash',
]) {
  if (!block.includes(expected)) {
    console.error(`ABORT: tier-router block does not contain ${expected}; re-read the profile first`)
    process.exit(1)
  }
}
const next = text.slice(0, start) + NEW_BLOCK + text.slice(end + END.length)
const tmp = `${file}.tmp-${process.pid}`
writeFileSync(tmp, next, 'utf8')
renameSync(tmp, file)
console.log(`patched tier-router block in ${file}`)
