// Offline host->client contract test for usage-popup 0.2.0.
//
// Drives the REAL built host half (dist/index.js apply wiring, dist/host/*)
// with a fake Cordis context, reads the usage route payload, then feeds that
// payload through the REAL client source transpiled in memory (same harness as
// test/logic.test.mjs). No npm install, no network, no running host.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

let checks = 0
const failures = []
function check(condition, label) {
  checks += 1
  if (!condition) failures.push(label)
}
function eq(actual, expected, label) {
  check(
    Object.is(actual, expected),
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  )
}
function near(actual, expected, label, epsilon = 1e-9) {
  check(
    typeof actual === 'number' && Math.abs(actual - expected) <= epsilon,
    `${label} (expected ${expected}, got ${actual})`,
  )
}

// ---------------------------------------------------------------------------
// a. Load the built host modules and run apply() against a fake ctx.
// ---------------------------------------------------------------------------
const { FORMAT, FORMAT_VERSION, UsageStore, resolveRecordsPath } = await import(
  pathToFileURL(path.join(pluginRoot, 'dist', 'host', 'store.js')).href
)
const { FEE_PER_SERVER_TOOL_REQUEST_USD } = await import(
  pathToFileURL(path.join(pluginRoot, 'dist', 'host', 'collector.js')).href
)
const { USAGE_PATH } = await import(
  pathToFileURL(path.join(pluginRoot, 'dist', 'host', 'route.js')).href
)
const host = await import(pathToFileURL(path.join(pluginRoot, 'dist', 'index.js')).href)

eq(host.name, 'usage-popup', 'host module name')
check(typeof host.apply === 'function', 'host module exports apply()')

const scratch = await mkdtemp(path.join(tmpdir(), 'usage-popup-integration-'))
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = scratch
eq(resolveRecordsPath(), path.join(scratch, 'usage-popup', 'usage-records.jsonl'), 'records path follows DSH_HOME')

const handlers = {}
let routeHandler = null
let disposed = null
const fakeCtx = {
  on(name, fn) {
    handlers[name] = fn
    return () => {}
  },
  inject(_deps, callback) {
    callback({
      webServer: {
        register(route) {
          routeHandler = route.handler
          return () => {}
        },
      },
    })
  },
  logger: { warn() {} },
  effect(fn) {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
}

disposed = host.apply(fakeCtx)
check(typeof disposed === 'function', 'apply() returns a disposer')
check(typeof handlers['session/event'] === 'function', 'apply() subscribes to session/event')
check(typeof handlers['llm/stream'] === 'function', 'apply() subscribes to llm/stream')
check(typeof routeHandler === 'function', 'apply() registers the webServer route')
check(FEE_PER_SERVER_TOOL_REQUEST_USD === 0.00075, 'host fee constant is 0.00075 USD/request')
eq(FORMAT, 'usage-popup.host-usage', 'store format contract')
eq(FORMAT_VERSION, 1, 'store format version contract')
eq(USAGE_PATH, '/usage-popup/api/usage', 'route path contract')

// ---------------------------------------------------------------------------
// b. Subagent session event first, then a recorded llm/stream.
// ---------------------------------------------------------------------------
handlers['session/event'](
  {
    id: 'ses_child',
    origin: 'subagent',
    parentSession: 'ses_main',
    delegationDepth: 1,
    agentPreset: 'standard',
  },
  { type: 'x', data: {} },
)

const textChunk = { type: 'text', text: 'x' }
const usageChunk = {
  type: 'usage',
  usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 },
}
let nextCalls = 0
const wrapped = handlers['llm/stream'](
  { model: 'deepseek-chat', provider: 'deepseek', sessionId: 'ses_child', purpose: null },
  async function* () {
    nextCalls += 1
    yield textChunk
    yield usageChunk
  },
)
const seen = []
for await (const chunk of wrapped) seen.push(chunk)
eq(nextCalls, 1, 'downstream llm/stream called exactly once')
eq(seen.length, 2, 'both chunks delivered to the consumer')
check(seen[0] === textChunk && seen[1] === usageChunk, 'chunks re-yielded unchanged')

// ---------------------------------------------------------------------------
// c. Read the route payload.
// ---------------------------------------------------------------------------
function makeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(text) {
      this.body = text
    },
  }
}

const usageRes = makeResponse()
await routeHandler({ url: '/usage-popup/api/usage?since=0', method: 'GET' }, usageRes)
eq(usageRes.statusCode, 200, 'usage route status 200')
check(
  String(usageRes.headers?.['content-type'] ?? '').startsWith('application/json'),
  'usage route content-type is JSON',
)
let payload
try {
  payload = JSON.parse(usageRes.body)
} catch (error) {
  payload = null
  check(false, `usage route body is valid JSON (${error.message})`)
}
check(payload !== null, 'usage payload parsed')
eq(payload?.format, FORMAT, 'payload format')
eq(payload?.version, FORMAT_VERSION, 'payload version')
check(typeof payload?.cursor === 'number' && payload.cursor >= 1, 'payload cursor >= 1')
eq(Array.isArray(payload?.records) ? payload.records.length : -1, 1, 'exactly one host record')
const record = payload?.records?.[0] ?? {}
eq(record.kind, 'llm', 'record kind llm')
eq(record.source, 'llm-stream', 'record source llm-stream')
eq(record.sessionId, 'ses_child', 'record sessionId ses_child')
eq(record.sessionType, 'subagent', 'record sessionType subagent')
eq(record.parentSessionId, 'ses_main', 'record parentSessionId ses_main')
eq(record.delegationDepth, 1, 'record delegationDepth 1')
eq(record.agentPreset, 'standard', 'record agentPreset standard')
eq(record.usage?.reasoningTokens, 20, 'record usage.reasoningTokens 20')
eq(record.id, `h:${record.seq}`, 'record id contract h:<seq>')

// ---------------------------------------------------------------------------
// d. Client half: transpile the REAL src/index.tsx (same harness as logic.test).
// ---------------------------------------------------------------------------
const workspace = path.resolve(here, '..', '..', '..')
const tsEntry = path.join(workspace, 'usage-popup', 'node_modules', 'typescript')
let ts
try {
  ts = require(tsEntry)
} catch (error) {
  console.error(`Cannot load typescript from ${tsEntry}: ${error.message}`)
  process.exit(1)
}

const sourcePath = path.join(pluginRoot, 'src', 'index.tsx')
const source = fs.readFileSync(sourcePath, 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: {
    target: 'ES2022',
    module: 'CommonJS',
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText

const store = new Map()
const localStorageStub = {
  get length() {
    return store.size
  },
  key(index) {
    return Array.from(store.keys())[index] ?? null
  },
  getItem(key) {
    return store.has(key) ? store.get(key) : null
  },
  setItem(key, value) {
    store.set(key, String(value))
  },
  removeItem(key) {
    store.delete(key)
  },
  clear() {
    store.clear()
  },
}

const windowStub = {
  localStorage: localStorageStub,
  btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
  atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame() {},
  innerWidth: 1280,
  innerHeight: 800,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  confirm: () => false,
}

const documentStub = {
  body: {},
  documentElement: { hasAttribute: () => false },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  visibilityState: 'visible',
}

class BroadcastChannelStub {
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const fetchStub = () => Promise.reject(new Error('no network in tests'))

const reactStub = {
  Fragment: Symbol('Fragment'),
  createElement: () => ({}),
  useEffect() {},
  useLayoutEffect() {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
}
const jsxRuntimeStub = {
  Fragment: Symbol('Fragment'),
  jsx: () => ({}),
  jsxs: () => ({}),
  jsxDEV: () => ({}),
}
const reactDomStub = { createPortal: () => ({}) }

const stubRequire = (id) => {
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return jsxRuntimeStub
  if (id === 'react-dom') return reactDomStub
  throw new Error(`unexpected require("${id}")`)
}

const moduleRecord = { exports: {} }
const evaluate = new Function(
  'require',
  'module',
  'exports',
  'window',
  'document',
  'localStorage',
  'BroadcastChannel',
  'fetch',
  'navigator',
  js,
)
evaluate(
  stubRequire,
  moduleRecord,
  moduleRecord.exports,
  windowStub,
  documentStub,
  localStorageStub,
  BroadcastChannelStub,
  fetchStub,
  { userAgent: 'usage-popup-integration-test' },
)

const lib = moduleRecord.exports
for (const name of ['entriesForHostRecords', 'entryCostRmb', 'usageCostRmb', 'apiSpendInWindow', 'planReconciliation']) {
  check(typeof lib[name] === 'function', `client exports ${name}()`)
}

const routeRecords = payload.records.slice()
routeRecords.push({
  id: 'h:99',
  seq: 99,
  at: payload.records[0].at + 1,
  kind: 'tool',
  source: 'wire',
  sessionId: 'ses_child',
  sessionType: 'subagent',
  parentSessionId: 'ses_main',
  delegationDepth: null,
  agentPreset: null,
  model: 'server-tool',
  provider: null,
  purpose: null,
  usage: null,
  serverTool: { name: 'web_search', requests: 1, status: 200, feeUsd: 0.00075 },
})

const entries = lib.entriesForHostRecords(routeRecords)
eq(entries.length, 2, 'entriesForHostRecords maps llm + tool records')
const llmEntry = entries.find((entry) => entry.source === 'host')
const toolEntry = entries.find((entry) => entry.source === 'host-tool')
check(llmEntry !== undefined, 'subagent llm becomes a host ledger entry')
check(toolEntry !== undefined, 'tool record becomes a host-tool ledger entry')
eq(llmEntry?.sessionId, 'ses_child', 'llm entry sessionId')
eq(llmEntry?.sessionType, 'subagent', 'llm entry sessionType subagent')
eq(llmEntry?.model, 'flash', 'deepseek-chat prices as flash')
const card =
  llmEntry?.tier === 'peak'
    ? { uncachedInput: 2.0, cacheRead: 0.04, output: 8.0 }
    : { uncachedInput: 1.0, cacheRead: 0.02, output: 4.0 }
const expectedLlmCost = (100 * card.uncachedInput + 40 * card.cacheRead + 50 * card.output) / 1_000_000
near(lib.entryCostRmb(llmEntry), expectedLlmCost, 'subagent cost from DeepSeek flash rates', 1e-12)
eq(toolEntry?.model, 'search', 'tool entry model is the server-tool-search class')
eq(toolEntry?.sessionTitle, 'web_search', 'tool entry title keeps the tool name')
near(lib.entryCostRmb(toolEntry), 0.0054, 'server-tool-search fee = 0.00075 USD * 7.2', 1e-9)

// ---------------------------------------------------------------------------
// e. Reconciliation math against a balance history.
// ---------------------------------------------------------------------------
const ledger = entries.slice()
const ledgerSum = ledger.reduce((sum, entry) => sum + lib.entryCostRmb(entry), 0)
check(ledgerSum < 0.21, 'ledger starts below the measured API spend')

const minAt = Math.min(...ledger.map((entry) => entry.at))
const T0 = minAt - 60_000
const T1 = T0 + 10 * 60_000
const history = [
  { at: T0, balanceRmb: 10.0 },
  { at: T1, balanceRmb: 9.79 },
]
const apiSpend = lib.apiSpendInWindow(history, 9.79, T0, T1)
near(apiSpend, 0.21, 'apiSpendInWindow measures the 0.210 RMB drop', 1e-9)

const plan = lib.planReconciliation({
  prevBalance: 10.0,
  prevAt: T0,
  newBalance: 9.79,
  nowMs: T1,
  entries: ledger,
})
check(plan !== null, 'planReconciliation emits the unexplained gap')
near(plan?.costRmb ?? NaN, 0.21 - ledgerSum, 'reconcile cost = api delta - ledger sum', 1e-3)
eq(plan?.source, 'reconcile', 'reconcile row source')
eq(plan?.model, 'unattributed', 'reconcile row model')
eq(plan?.sessionId, 'reconcile:balance', 'reconcile row session id')

const merged = plan === null ? ledger : [...ledger, plan]
const mergedSum = merged.reduce((sum, entry) => sum + lib.entryCostRmb(entry), 0)
near(mergedSum, 0.21, 'merged ledger sums to the measured API delta', 0.005)

// The planner is pure: replaying the same bracketed window re-plans the same
// gap, and the existing reconcile row must never be counted as spend again.
const second = lib.planReconciliation({
  prevBalance: 10.0,
  prevAt: T0,
  newBalance: 9.79,
  nowMs: T1,
  entries: merged,
})
if (second === null) {
  check(true, 'already-added reconcile row is excluded (no double counting)')
} else {
  near(
    second.costRmb,
    plan?.costRmb ?? NaN,
    'existing reconcile row is excluded from ledgerDelta (no double counting)',
    1e-3,
  )
}
// The real caller advances the baseline to the new sample, so the next sync
// for the same window sees apiDelta 0 and emits nothing.
check(
  lib.planReconciliation({
    prevBalance: 9.79,
    prevAt: T1,
    newBalance: 9.79,
    nowMs: T1,
    entries: merged,
  }) === null,
  'next sync over the settled window emits no further reconcile row',
)

// ---------------------------------------------------------------------------
// Cleanup and report.
// ---------------------------------------------------------------------------
if (typeof disposed === 'function') disposed()
await new Promise((resolve) => setTimeout(resolve, 50))
if (previousDshHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousDshHome
await rm(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`FAIL: ${failure}`)
  process.exit(1)
}
console.log(`${checks} checks passed`)
