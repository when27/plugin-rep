import { TierRouterAdapter, createStats } from './lib/router.js'
import { DEFAULTS } from './lib/schema.js'
const cfg = {
  ...DEFAULTS, enabled: true, classifier: 'heuristic', contextGuard: false,
  easyProvider: 'google', easyModel: 'gemini-3.5-flash',
  easyFallbacks: [{ provider: 'google-vertex', model: 'gemini-3.5-flash' }, { provider: 'zai', model: 'glm-5.3-flash' }],
  normalProvider: 'deepseek-account', normalModel: 'deepseek-flash',
  hardProvider: 'deepseek-account', hardModel: 'deepseek-flash',
  visionProvider: 'google', visionModel: 'gemini-3.5-flash',
  fallbackProvider: 'deepseek-account', fallbackModel: 'deepseek-flash',
}
const stats = createStats()
const ctx = { llm: {}, logger: { info() {} } }
const router = new TierRouterAdapter(ctx, () => cfg, { stats })
const worker = await router.resolveChain({ model: 'worker', sessionId: '2bd229f1-f937-410a-b076-d686ebb1f054', messages: [{ role: 'user', content: [{ type: 'text', text: 'read file x and summarize' }] }] })
const smart = await router.resolveChain({ model: 'smart', sessionId: 'session-e92f779c-afe1-49c3-9924-5d2ef9b01a7c', messages: [{ role: 'user', content: [{ type: 'text', text: 'read file x and summarize' }] }] })
console.log('worker:', worker.level, worker.classifier, worker.chain.map(c => c.provider + '/' + c.model).join(' > '))
console.log('smart :', smart.level, smart.classifier, smart.chain.map(c => c.provider + '/' + c.model).join(' > '))
stats.recordUsage('2bd229f1-f937-410a-b076-d686ebb1f054', 'google', 'gemini-3.5-flash', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 })
stats.recordUsage('session-e92f779c-afe1-49c3-9924-5d2ef9b01a7c', 'deepseek-account', 'deepseek-flash', { inputTokens: 40, outputTokens: 10, cacheReadTokens: 1 })
const u = stats.snapshot().usage
console.log('totals:', JSON.stringify(u.totals))
console.log('workers:', JSON.stringify(u.workers))
console.log('sessions:', Object.keys(u.sessions).length)
