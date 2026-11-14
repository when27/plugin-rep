import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { DEFAULTS } from './dsh-tier-router/lib/schema.js'
import { TierRouterAdapter } from './dsh-tier-router/lib/router.js'

const requireFromProfile = createRequire('C:/Users/Administrator/.dsh/profiles/desktop/package.json')
const YAML = requireFromProfile('yaml')
const rows = YAML.parse(readFileSync(process.argv[2], 'utf8'))
const row = rows.find((entry) => entry?.id === 'tier-router')
if (!row) throw new Error('tier-router row missing')
// contextGuard is disabled only so this probe does not need a live llm service;
// the chain order is unaffected by the guard itself.
const settings = { ...DEFAULTS, ...row.config, contextGuard: false }
console.log('config keys:', Object.keys(row.config).join(', '))

async function resolve(text) {
  const adapter = new TierRouterAdapter({ logger: { info() {} } }, () => settings)
  const result = await adapter.resolveChain({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
  return `${result.level}: ` + result.chain.map((r) => `${r.provider}/${r.model} (${r.reason})`).join(' -> ')
}
console.log('easy:', await resolve('hi'))
console.log('hard:', await resolve('Design a distributed migration architecture with concurrency and deadlock handling'))
