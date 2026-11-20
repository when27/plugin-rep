// Zero-dependency client-wiring tests for the True-sync ledger refactor.
//
// The real TypeScript source is transpiled in memory (no build output) and
// evaluated with browser stubs, then `apply(ctx)` is called against a fake slot
// service. This locks in the entry-point contract: no sidebar cell of its own,
// one root overlay, one `plugin-launcher` tool registration, and only the null
// save-token composer cell.
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

const reactStub = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
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
  () => Promise.reject(new Error('no network in tests')),
  { userAgent: 'node' },
)
const plugin = moduleRecord.exports

let pass = 0
let fail = 0
const check = (ok, label) => {
  if (ok) {
    pass += 1
  } else {
    fail += 1
    console.log(`FAIL ${label}`)
  }
}

// --- slot wiring -----------------------------------------------------------
const registrations = []
const ctx = {
  slots: {
    inject(_name, callback) {
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  get() {
    return undefined
  },
  logger: { warn() {} },
}
plugin.apply(ctx)

const overlay = registrations.find((row) => row.options.name === 'shell.overlay')
check(overlay !== undefined, 'registers a shell.overlay occupant')
check(overlay?.options.id === 'usage-popup-ledger', 'overlay id is usage-popup-ledger')
check(typeof overlay?.component === 'function', 'overlay factory is a component')

const sidebar = registrations.filter((row) => row.options.name === 'sidebar.footer.action')
check(sidebar.length === 0, 'no longer mounts its own sidebar.footer.action')

const launcherRegistry = windowStub.__DSH_PLUGIN_LAUNCHER_V1__
check(launcherRegistry !== undefined, 'creates/uses the plugin-launcher tool registry')
const launcherTools = launcherRegistry?.getSnapshot() ?? []
check(launcherTools.length === 1, 'registers exactly one plugin-launcher tool')
check(launcherTools[0]?.id === 'usage-popup.ledger', 'tool id is usage-popup.ledger')
check(launcherTools[0]?.label === 'True-sync ledger', 'tool label names the ledger')
check(launcherTools[0]?.badge === 'LIVE', 'tool carries the LIVE badge')
check(typeof launcherTools[0]?.onOpen === 'function', 'tool exposes an open callback')

const dock = registrations.filter((row) => row.options.name === 'conversation.composer.dock')
check(dock.length === 1, 'only the save-token blank remains in the composer dock')
check(dock[0]?.options.id === 'save-token-strip', 'composer cell is not a usage HUD control')
check(dock[0]?.component() === null, 'save-token cell renders nothing')
check(
  registrations.every((row) => row.options.id !== 'usage-popup' || row.options.name !== 'conversation.composer.dock'),
  'no usage-popup control is injected into the chat footer',
)

// --- chat selector aggregation --------------------------------------------
const row = (sessionId, at, tokens, model = 'flash') => ({
  id: `${sessionId}-${at}`,
  sessionId,
  sessionTitle: `Title ${sessionId}`,
  date: '2026-11-18',
  model,
  tier: 'off-peak',
  usage: { uncachedInputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costRmb: 0,
  at,
  source: 'host',
  sessionType: 'main',
})
const ledger = [row('chat-a', 1000, 100), row('chat-a', 3000, 50), row('chat-b', 2000, 10), row('', 4000, 999)]

const options = plugin.buildChatOptions(ledger, null, 0)
check(options.length === 2, 'blank session ids are dropped')
check(options[0].sessionId === 'chat-a', 'chats sort by most recent activity')
check(options[0].entries === 2, 'per-chat entry count')
check(options[0].tokens === 150, 'per-chat token total')
check(options[0].lastAt === 3000, 'per-chat last activity')
check(options[1].sessionId === 'chat-b', 'second chat follows')

check(plugin.buildChatOptions(ledger, 'chat-c', 0).length === 2, 'unstarted draft is not listed')

const firstTurn = plugin.buildChatOptions(ledger, 'chat-d', 42)
check(firstTurn[0].sessionId === 'chat-d', 'first live turn registers at the top')
check(firstTurn[0].tokens === 42, 'live tokens seed the new row')
check(firstTurn[0].entries === 0, 'new row has no ledger rows yet')

const liveExisting = plugin.buildChatOptions(ledger, 'chat-b', 500)
check(
  liveExisting.find((option) => option.sessionId === 'chat-b').tokens === 500,
  'live projection raises the chat total',
)
check(plugin.buildChatOptions([], null, 0).length === 0, 'empty ledger yields no options')

console.log(`\n${pass} checks passed${fail === 0 ? '' : `, ${fail} failed`}`)
process.exit(fail === 0 ? 0 : 1)
