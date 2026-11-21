import { TierRouterAdapter, createStats } from './lib/router.js'
import { DEFAULTS } from './lib/schema.js'
const cfg = { ...DEFAULTS, contextGuard: false, easyProvider: 'google', easyModel: 'gemini-3.5-flash', easyFallbacks: [{ provider: 'zai', model: 'glm-5.3-flash' }], normalProvider: 'deepseek-account', normalModel: 'deepseek-flash', fallbackProvider: 'deepseek-account', fallbackModel: 'deepseek-flash' }
const stats = createStats()
const router = new TierRouterAdapter({ llm: {}, logger: { info() {} } }, () => cfg, { stats })
console.log('models:', (await router.listModels('tier-router')).map(m => m.id).join(','))
console.log('worker name:', (await router.resolveModel('tier-router', 'worker')).name)
const chain = await router.resolveChain({ model: 'worker', sessionId: '2bd229f1-f937-410a-b076-d686ebb1f054', messages: [{ role: 'user', content: [{ type: 'text', text: 'do it' }] }] })
console.log('worker chain:', chain.level, chain.classifier, chain.chain.map(c => c.provider + '/' + c.model).join(' > '))
stats.recordUsage('2bd229f1-f937-410a-b076-d686ebb1f054', 'google', 'gemini-3.5-flash', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 })
console.log('usage workers:', JSON.stringify(stats.snapshot().usage.workers))
