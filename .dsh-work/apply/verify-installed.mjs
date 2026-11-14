#!/usr/bin/env node
/** Post-install checks for the patched dsh-tier-router and profile config. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const pkg = process.argv[2]
const configPath = process.argv[3]
if (!pkg || !configPath) {
  console.error('usage: verify-installed.mjs <packageDir> <cordis.patch.yml>')
  process.exit(2)
}

const { DEFAULTS, SETTINGS_SCHEMA, tierFallbacks } = await import(
  pathToFileURL(`${pkg}/lib/schema.js`).href
)
assert.equal(typeof tierFallbacks, 'function')
assert.deepEqual(DEFAULTS.easyFallbacks, [])
assert.deepEqual(DEFAULTS.hardFallbacks, [])
assert.deepEqual(tierFallbacks({ easyFallbacks: [{ provider: 'a', model: 'b' }] }, 'easy'), [
  { provider: 'a', model: 'b' },
])

const oldConfig = SETTINGS_SCHEMA({
  hardProvider: 'deepseek-account',
  hardModel: 'deepseek-flash',
  easyProvider: 'google',
  easyModel: 'gemini-3.5-flash',
})
assert.deepEqual(oldConfig.easyFallbacks, [])
assert.deepEqual(oldConfig.hardFallbacks, [])

const newConfig = SETTINGS_SCHEMA({
  easyFallbacks: [
    { provider: 'google-vertex', model: 'gemini-3.5-flash' },
    { provider: 'zai', model: 'glm-5.3-flash' },
  ],
  hardFallbacks: [{ provider: 'deepseek-account', model: 'deepseek-flash' }],
})
assert.equal(newConfig.easyFallbacks.length, 2)
assert.equal(newConfig.hardFallbacks[0].provider, 'deepseek-account')

for (const [name, value] of Object.entries({
  string: { easyFallbacks: 'google/gemini-3.5-flash' },
  number: { easyFallbacks: [42] },
  field: { hardFallbacks: [{ provider: 7 }] },
})) {
  assert.throws(() => SETTINGS_SCHEMA(value), undefined, `malformed ${name} was accepted`)
}

const YAML = createRequire(configPath)('yaml')
const rows = YAML.parse(readFileSync(configPath, 'utf8'))
const row = rows.find((entry) => entry?.id === 'tier-router')
assert.ok(row, 'no tier-router row in cordis.patch.yml')
assert.equal(row.config.easyProvider, 'google')
assert.equal(row.config.easyModel, 'gemini-3.5-flash')
assert.deepEqual(
  row.config.easyFallbacks.map((fallback) => `${fallback.provider}/${fallback.model}`),
  ['google-vertex/gemini-3.5-flash', 'zai/glm-5.3-flash', 'zai-2/glm-5.3-flash'],
)
assert.equal(row.config.hardProvider, 'deepseek-account')
assert.equal(row.config.hardModel, 'deepseek-flash')
assert.equal(row.config.hardFallbacks, undefined, 'hardFallbacks should stay unconfigured')

console.log('SCHEMA_OK old/new/malformed cases; CONFIG_OK easyFallbacks order google-vertex,zai,zai-2; hard route unchanged')
