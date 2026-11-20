// Zero-dependency logic tests for the usage-popup client plugin.
//
// The REAL TypeScript source is transpiled in memory with the `typescript`
// package that already ships under the workspace's installed plugin tree, then
// evaluated with browser stubs. No npm install, no build output, no network.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(here, '..', '..', '..')
const tsCandidates = [
  path.join(here, '..', 'node_modules', 'typescript'), // self-contained install
  path.join(workspace, 'usage-popup', 'node_modules', 'typescript'), // source-machine fallback
]

let ts
for (const candidate of tsCandidates) {
  try {
    ts = require(candidate)
    break
  } catch {
    // try the next candidate
  }
}
if (ts === undefined) {
  console.error(`Cannot load typescript; looked in:\n${tsCandidates.map((candidate) => `  ${candidate}`).join('\n')}`)
  process.exit(1)
}

const sourcePath = path.join(here, '..', 'src', 'index.tsx')
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
  { userAgent: 'usage-popup-test' },
)

const lib = moduleRecord.exports
const required = [
  'planReconciliation',
  'parseDashboardExport',
  'apiSpendInWindow',
  'usageCostRmb',
  'entryCostRmb',
  'billedOutputTokens',
  'normalizeEntry',
  'entriesForHostRecords',
  'resolveProjectionMode',
  'hostCursorWasReset',
  'replaceImportedEntries',
]
for (const name of required) {
  if (typeof lib[name] !== 'function') {
    console.error(`FAIL: index.tsx does not export ${name}()`)
    process.exit(1)
  }
}

let checks = 0
const failures = []
function check(condition, label) {
  checks += 1
  if (!condition) failures.push(label)
}
function near(actual, expected, label, epsilon = 1e-9) {
  check(
    typeof actual === 'number' && Math.abs(actual - expected) <= epsilon,
    `${label} (expected ${expected}, got ${actual})`,
  )
}

const zero = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}
function entry(overrides = {}) {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-a',
    sessionTitle: 'Session A',
    date: '2026-01-02',
    model: 'flash',
    tier: 'off-peak',
    usage: { ...zero },
    costRmb: 0,
    at: 1_000,
    ...overrides,
  }
}

// --- apiSpendInWindow ------------------------------------------------------
const points = [
  { at: 0, balanceRmb: 100 },
  { at: 50, balanceRmb: 90 },
]
near(lib.apiSpendInWindow(points, 85, 0, 100), 15, 'apiSpendInWindow sums every drop')
near(
  lib.apiSpendInWindow(
    [
      { at: 0, balanceRmb: 100 },
      { at: 50, balanceRmb: 120 },
    ],
    110,
    0,
    100,
  ),
  10,
  'apiSpendInWindow ignores top-ups',
)
check(
  lib.apiSpendInWindow([{ at: 50, balanceRmb: 100 }], 90, 0, 100) === null,
  'apiSpendInWindow needs a baseline at/before the window start',
)
check(
  lib.apiSpendInWindow(points, null, 0, 100) === null,
  'apiSpendInWindow returns null without a current balance',
)

// --- planReconciliation ----------------------------------------------------
const ledgerAt10 = entry({ at: 10, costRmb: 10, usage: { ...zero, uncachedInputTokens: 10_000_000 } })
const balanced = lib.planReconciliation({
  prevBalance: 100,
  prevAt: 0,
  newBalance: 90,
  nowMs: 20,
  entries: [ledgerAt10],
})
check(balanced === null, 'planReconciliation returns null when apiDelta === ledgerDelta')

const gap = lib.planReconciliation({
  prevBalance: 100,
  prevAt: 0,
  newBalance: 90,
  nowMs: 20,
  entries: [entry({ at: 10, source: 'reconcile', model: 'unattributed', costRmb: 10 })],
})
check(gap !== null, 'planReconciliation returns a row for an unexplained gap')
near(gap?.costRmb ?? NaN, 10, 'planReconciliation ignores previous reconcile rows')
check(gap?.source === 'reconcile', 'planReconciliation sets source=reconcile')
check(gap?.model === 'unattributed', 'planReconciliation sets model=unattributed')
check(gap?.sessionId === 'reconcile:balance', 'planReconciliation sets the reconcile session id')
check((gap?.calls ?? -1) === 0, 'planReconciliation sets calls=0')

const smallGap = lib.planReconciliation({
  prevBalance: 100,
  prevAt: 0,
  newBalance: 90,
  nowMs: 20,
  entries: [entry({ at: 10, costRmb: 9.999, usage: { ...zero, uncachedInputTokens: 9_999_000 } })],
})
check(smallGap === null, 'planReconciliation ignores sub-half-cent noise')

// --- billedOutputTokens ----------------------------------------------------
check(
  lib.billedOutputTokens({ outputTokens: 0, reasoningTokens: 120 }) === 120,
  'billedOutputTokens uses reasoning-only output',
)
check(
  lib.billedOutputTokens({ outputTokens: 200, reasoningTokens: 80 }) === 200,
  'billedOutputTokens never adds reasoning to output',
)

// --- host probe state machine ---------------------------------------------
check(lib.resolveProjectionMode('pending') === 'skip', 'pending probe skips projection')
check(lib.resolveProjectionMode('active') === 'skip', 'active host skips projection')
check(lib.resolveProjectionMode('inactive') === 'project', 'inactive host enables projection')
check(lib.hostCursorWasReset(5, 5, undefined) === false, 'same cursor is not a reset')
check(lib.hostCursorWasReset(3, 10, undefined) === true, 'payload cursor below stored is a reset')
check(lib.hostCursorWasReset(3, 3, true) === true, 'explicit reset flag wins')

// --- dashboard CSV ---------------------------------------------------------
const csv = [
  'date,model,input_tokens,output_tokens,cache_hit_tokens,cost',
  '2026-01-02,deepseek-flash,1000,200,300,0.42',
  ',deepseek-flash,1,1,0,0.01',
].join('\n')
const csvResult = lib.parseDashboardExport(csv, 'deepseek-dashboard.csv')
check(csvResult.entries.length === 1, 'CSV import keeps exactly the valid row')
check(csvResult.skipped === 1, 'CSV import counts the row without a date as skipped')
const csvRow = csvResult.entries[0]
check(csvRow?.usage.uncachedInputTokens === 700, 'CSV subtracts cache hits from total prompt tokens')
check(csvRow?.usage.outputTokens === 200, 'CSV maps output_tokens')
check(csvRow?.usage.cacheReadTokens === 300, 'CSV maps cache_hit_tokens')
near(csvRow?.costRmb ?? NaN, 0.42, 'CSV keeps the recorded cost')
check(csvRow?.model === 'flash', 'CSV classifies the model')
check(csvRow?.date === '2026-01-02', 'CSV keeps the local date key')
check(csvRow?.source === 'import', 'CSV rows are tagged source=import')
check(csvRow?.sessionId === 'import:dashboard', 'CSV rows get an import session id')
check(typeof csvRow?.importKey === 'string' && csvRow.importKey.length > 1, 'CSV rows carry a stable import key')

const usdCsv = 'date,model,cost,currency\n2026-01-03,deepseek-v4-pro,1.00,USD\n'
const usdRow = lib.parseDashboardExport(usdCsv, 'usd.csv').entries[0]
near(usdRow?.costRmb ?? NaN, 7.2, 'USD dashboard cost is converted at 7.2')

// Total prompt + cache hit: cached input is billed once (total - cacheHit).
const splitCsv = 'date,model,input_tokens,cache_hit_tokens\n2026-01-04,deepseek-flash,1000,600\n'
const splitRow = lib.parseDashboardExport(splitCsv, 'split.csv').entries[0]
check(splitRow?.usage.uncachedInputTokens === 400, 'total 1000 + cacheHit 600 -> input 400')
check(splitRow?.usage.cacheReadTokens === 600, 'total 1000 + cacheHit 600 -> cacheRead 600')

// An explicit miss field is authoritative and must not be reduced again.
const missCsv =
  'date,model,prompt_cache_miss_tokens,cache_hit_tokens\n2026-01-04,deepseek-flash,400,600\n'
const missRow = lib.parseDashboardExport(missCsv, 'miss.csv').entries[0]
check(missRow?.usage.uncachedInputTokens === 400, 'explicit prompt_cache_miss_tokens is used')
check(missRow?.usage.cacheReadTokens === 600, 'explicit miss keeps cacheRead 600')

// Re-import: same (date, apiKey, model) replaces the previous row, latest wins.
const importCsv = (cost) =>
  `date,model,input_tokens,cache_hit_tokens,cost,api_key_name\n2026-01-02,deepseek-flash,1000,300,${cost},work-key\n`
const firstImport = lib.parseDashboardExport(importCsv('0.1'), 'first.csv').entries
const secondImport = lib.parseDashboardExport(importCsv('0.2'), 'second.csv').entries
check(
  firstImport[0]?.importKey === secondImport[0]?.importKey,
  'importKey is stable across re-imports of the same date/key/model',
)
const importedOnce = lib.replaceImportedEntries([], firstImport)
const importedTwice = lib.replaceImportedEntries(importedOnce, secondImport)
check(importedTwice.length === 1, 're-import keeps exactly one import row')
near(importedTwice[0]?.costRmb ?? NaN, 0.2, 're-import keeps the latest cost')

// --- dashboard JSON --------------------------------------------------------
const jsonResult = lib.parseDashboardExport(
  JSON.stringify({
    data: [
      {
        date: '2026-01-03',
        model: 'deepseek-v4-pro',
        input_tokens: 500,
        output_tokens: 60,
        cost: 1.5,
        api_key_name: 'work-key',
      },
    ],
  }),
  'export.json',
)
check(jsonResult.entries.length === 1, 'JSON {data:[...]} imports one row')
const jsonRow = jsonResult.entries[0]
check(jsonRow?.sessionId === 'import:work-key', 'JSON import uses the api key name')
check(jsonRow?.model === 'pro', 'JSON import classifies the model')
near(jsonRow?.costRmb ?? NaN, 1.5, 'JSON import keeps the recorded cost')

const ledgerJson = lib.parseDashboardExport(
  JSON.stringify({
    format: 'usage-popup.universal-ledger',
    entries: [
      {
        id: 'old-1',
        sessionId: 'chat-1',
        sessionTitle: 'Old chat',
        at: Date.UTC(2026, 0, 4, 12),
        date: '2026-01-04',
        model: 'flash',
        tier: 'off-peak',
        usage: { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costRmb: 0.01,
      },
    ],
  }),
  'ledger.json',
)
check(ledgerJson.entries.length === 1, 'legacy JSON ledger export still imports')
check(ledgerJson.entries[0]?.id === 'old-1', 'legacy JSON ledger row keeps its id')

// --- host ingestion --------------------------------------------------------
const hostAt = Date.UTC(2026, 0, 5, 12, 0, 0) // Monday, off-peak UTC
const llmRecord = {
  id: 'h:1',
  seq: 1,
  at: hostAt,
  kind: 'llm',
  source: 'llm-stream',
  sessionId: 's1',
  sessionType: 'subagent',
  parentSessionId: 'main-1',
  delegationDepth: 1,
  agentPreset: null,
  model: 'deepseek-flash',
  provider: 'deepseek',
  purpose: null,
  usage: {
    inputTokens: 1000,
    outputTokens: 100,
    reasoningTokens: 40,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
    totalTokens: 1300,
  },
  serverTool: null,
}
const [hostLlm] = lib.entriesForHostRecords([llmRecord], {})
check(hostLlm?.sessionType === 'subagent', 'host llm record keeps sessionType=subagent')
check(hostLlm?.source === 'host', 'host llm record is tagged source=host')
check(hostLlm?.hostId === 'h:1', 'host llm record keeps the host id')
check(hostLlm?.calls === 1, 'host llm record counts one call')
check(hostLlm?.usage.outputTokens === 100, 'host llm record bills max(output, reasoning)')
near(
  hostLlm?.costRmb ?? NaN,
  lib.usageCostRmb(hostLlm.usage, hostLlm.model, hostLlm.tier === 'peak'),
  'host DeepSeek record is priced from the rate card',
)

const subagentByIndex = {
  ...llmRecord,
  id: 'h:2',
  sessionId: 's2',
  sessionType: 'unknown',
}
const [indexed] = lib.entriesForHostRecords([subagentByIndex], {
  s2: { parentId: 'main-1', origin: null },
})
check(indexed?.sessionType === 'subagent', 'host session index resolves parented sessions')

const geminiRecord = {
  ...llmRecord,
  id: 'h:3',
  model: 'gemini-3.5-flash',
  provider: 'google',
}
const [nonDeepseek] = lib.entriesForHostRecords([geminiRecord], {})
check(nonDeepseek?.costRmb === 0, 'non-DeepSeek host record records no invented cost')
check(nonDeepseek?.costKnown === false, 'non-DeepSeek host record marks cost as unknown')
check(nonDeepseek?.model === 'unattributed', 'non-DeepSeek record maps to unattributed')
check(
  nonDeepseek?.usage.uncachedInputTokens === 1000,
  'non-DeepSeek record still records its tokens',
)

const deepseekAccount = {
  ...llmRecord,
  id: 'h:5',
  model: 'some-model',
  provider: 'deepseek-account',
}
const [accountRow] = lib.entriesForHostRecords([deepseekAccount], {})
check(accountRow?.model === 'flash', 'provider literal deepseek-account is DeepSeek-billed')
check(
  (accountRow?.costRmb ?? 0) > 0,
  'provider deepseek-account is priced from the rate card',
)

const toolRecord = {
  id: 'h:4',
  seq: 4,
  at: hostAt,
  kind: 'tool',
  source: 'tool-event',
  sessionId: 's1',
  sessionType: 'main',
  model: '',
  provider: 'deepseek',
  purpose: 'web_search',
  usage: null,
  serverTool: { name: 'web_search', requests: 2, status: 200, feeUsd: 0.00075 },
}
const [hostTool] = lib.entriesForHostRecords([toolRecord], {})
check(hostTool?.sessionId === 's1', 'host tool record keeps the session id')
check(hostTool?.model === 'search', 'host tool record maps to the server-tool model class')
check(hostTool?.sessionTitle === 'web_search', 'host tool record uses the tool name as its title')
check(hostTool?.calls === 2, 'host tool record counts server-tool requests')
near(hostTool?.costRmb ?? NaN, 0.0054, 'host tool fee 0.00075 USD becomes 0.0054 CNY', 1e-12)
near(hostTool?.costUsd ?? NaN, 0.00075, 'host tool record keeps the USD fee')
check(hostTool?.source === 'host-tool', 'host tool record is tagged source=host-tool')

// --- normalizeEntry --------------------------------------------------------
const reconcileRow = lib.normalizeEntry(
  {
    sessionId: 'reconcile:balance',
    sessionTitle: 'Unattributed / Subagent & Tool Spend',
    at: 1_000,
    date: '2026-01-01',
    model: 'unattributed',
    tier: 'peak',
    usage: { ...zero },
    costRmb: 1.23,
    source: 'reconcile',
    sessionType: 'reconcile',
  },
  null,
)
check(reconcileRow !== null, 'normalizeEntry keeps a cost-only reconcile row')
near(reconcileRow?.costRmb ?? NaN, 1.23, 'normalizeEntry keeps the reconcile cost')
check(reconcileRow?.source === 'reconcile', 'normalizeEntry preserves source')
check(reconcileRow?.sessionType === 'reconcile', 'normalizeEntry preserves sessionType')

const importRow = lib.normalizeEntry(
  {
    sessionId: 'import:work-key',
    at: 2_000,
    model: 'unattributed',
    tier: 'off-peak',
    usage: { ...zero },
    costRmb: 2.5,
    source: 'import',
    sessionType: 'import',
    importKey: 'dk123',
  },
  null,
)
check(importRow !== null, 'normalizeEntry keeps a cost-only import row')
check(importRow?.importKey === 'dk123', 'normalizeEntry preserves importKey')

const droppedRow = lib.normalizeEntry(
  {
    sessionId: 'chat-1',
    at: 3_000,
    model: 'flash',
    tier: 'off-peak',
    usage: { ...zero },
    costRmb: 0,
  },
  null,
)
check(droppedRow === null, 'normalizeEntry drops zero-cost zero-token rows')

const hostRow = lib.normalizeEntry(
  {
    sessionId: 's1',
    at: 4_000,
    model: 'deepseek-flash',
    tier: 'peak',
    usage: { ...zero, uncachedInputTokens: 5 },
    costRmb: 0.001,
    source: 'host',
    hostId: 'h:9',
    calls: 1,
    costKnown: false,
  },
  null,
)
check(hostRow?.hostId === 'h:9', 'normalizeEntry preserves hostId')
check(hostRow?.costKnown === false, 'normalizeEntry preserves costKnown=false')
near(lib.entryCostRmb(hostRow), 0.001, 'entryCostRmb honours an authoritative recorded cost')

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} check(s) failed`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log(`${checks} checks passed`)
