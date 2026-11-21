import { DEFAULTS, SETTINGS_SCHEMA } from './dsh-tier-router/lib/schema.js'
import { TierRouterAdapter } from './dsh-tier-router/lib/router.js'

const base = {
  ...DEFAULTS,
  enabled: true,
  classifier: 'heuristic',
  contextGuard: false,
  fallbackProvider: 'deepseek-account',
  fallbackModel: 'deepseek-flash',
  hardProvider: 'deepseek-account',
  hardModel: 'deepseek-flash',
  normalProvider: 'deepseek-account',
  normalModel: 'deepseek-flash',
  easyProvider: 'google',
  easyModel: 'gemini-3.5-flash',
}
const easyFallbacks = [
  { provider: 'google-vertex', model: 'gemini-3.5-flash' },
  { provider: 'zai', model: 'glm-5.3-flash' },
  { provider: 'zai-2', model: 'glm-5.3-flash' },
]
const oldCfg = { ...base }
const newCfg = { ...base, easyFallbacks }

async function resolve(settings, text) {
  const adapter = new TierRouterAdapter({ logger: { info() {} } }, () => settings)
  const result = await adapter.resolveChain({
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  })
  return {
    level: result.level,
    kind: result.kind,
    chain: result.chain.map((r) => `${r.provider}/${r.model}`),
    reasons: result.chain.map((r) => r.reason),
  }
}

for (const [name, settings] of [['old', oldCfg], ['new', newCfg]]) {
  for (const [label, text] of [
    ['easy', 'hi'],
    ['hard', 'Design a distributed migration architecture with concurrency and deadlock handling'],
  ]) {
    console.log(name, label, JSON.stringify(await resolve(settings, text)))
  }
}

const schemaCases = {
  oldSingleRoute: { hardProvider: 'deepseek-account', hardModel: 'deepseek-flash', easyProvider: 'google', easyModel: 'gemini-3.5-flash' },
  newArrays: { easyFallbacks, hardFallbacks: [{ provider: 'deepseek-account', model: 'deepseek-flash' }] },
  malformedString: { easyFallbacks: 'google/gemini-3.5-flash' },
  malformedNumber: { easyFallbacks: [42] },
  malformedField: { hardFallbacks: [{ provider: 7 }] },
}
for (const [name, value] of Object.entries(schemaCases)) {
  try {
    const parsed = SETTINGS_SCHEMA(value)
    console.log('schema', name, 'OK', JSON.stringify({
      easyFallbacks: parsed.easyFallbacks,
      hardFallbacks: parsed.hardFallbacks,
    }))
  } catch (error) {
    console.log('schema', name, 'ERR', String(error?.message ?? error).split('\n')[0])
  }
}
