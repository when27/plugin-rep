// Registry contract tests for plugin-launcher.
//
// The real TSX source is transpiled in memory and evaluated with browser
// stubs, so the tests exercise the exact registration/ensure code that ships in
// the client bundle — not a re-implementation.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = path.join(here, '..', 'src', 'index.tsx')

let typescript
for (const candidate of [
  'typescript',
  path.join(here, '..', 'node_modules', 'typescript'),
  path.join(here, '..', '..', 'obsidian-task-sync', 'node_modules', 'typescript'),
]) {
  try {
    typescript = require(candidate)
    break
  } catch {
    /* try the next candidate */
  }
}
if (typescript === undefined) {
  console.error('Cannot load typescript; run `npm install` in plugins/plugin-launcher.')
  process.exit(1)
}

const source = readFileSync(sourcePath, 'utf8')
const js = typescript.transpileModule(source, {
  compilerOptions: {
    target: 'ES2022',
    module: 'CommonJS',
    jsx: typescript.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useId: () => 'dpl-title',
  useLayoutEffect() {},
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const jsxRuntimeStub = {
  Fragment: Symbol('Fragment'),
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
}
const reactDomStub = { createPortal: (node) => node }

const moduleRecord = { exports: {} }
new Function('require', 'module', 'exports', js)(
  (specifier) => {
    if (specifier === 'react') return reactStub
    if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
    if (specifier === 'react-dom') return reactDomStub
    throw new Error(`unexpected require("${specifier}")`)
  },
  moduleRecord,
  moduleRecord.exports,
)
const plugin = moduleRecord.exports
const { createLauncherRegistry, ensureLauncherRegistry, createLauncherController } = plugin.__test

let pass = 0
let fail = 0
const check = (ok, label) => {
  if (ok) pass += 1
  else {
    fail += 1
    console.log(`FAIL ${label}`)
  }
}

// --- registration ----------------------------------------------------------
const host = {}
const registry = ensureLauncherRegistry(host)
check(registry.version === 1, 'registry advertises contract version 1')
check(host[plugin.__test.TOOL_REGISTRY_KEY] === registry, 'registry pins the documented window key')
check(ensureLauncherRegistry(host) === registry, 'ensure is idempotent')

let alphaOpened = 0
registry.register({ id: 'alpha', label: 'Alpha', description: 'first', order: 2, onOpen: () => { alphaOpened += 1 } })
registry.register({ id: 'beta', label: 'Beta', order: 1, onOpen: () => {} })
registry.register({ id: 'gamma', label: 'Gamma', order: 1, onOpen: () => {} })
check(
  registry.getSnapshot().map((tool) => tool.id).join(',') === 'beta,gamma,alpha',
  'snapshot sorts by order then label',
)
check(registry.getSnapshot().length === 3, 'all registered tools are listed')
check(registry.get('beta')?.label === 'Beta', 'get() resolves a tool by id')
check(registry.get('missing') === null, 'get() returns null for unknown ids')

const disposeAlpha = registry.register({ id: 'alpha', label: 'Alpha v2', order: 0, onOpen: () => {} })
check(registry.get('alpha')?.label === 'Alpha v2', 'same id replaces the previous entry')
disposeAlpha()
check(registry.get('alpha') === null, 'the returned disposer removes the entry')
check(registry.getSnapshot().length === 2, 'disposal updates the snapshot')

const staleDisposer = registry.register({ id: 'beta', label: 'Beta v2', order: 1, onOpen: () => {} })
// A second registration under the same id makes the first disposer stale.
registry.register({ id: 'beta', label: 'Beta v3', order: 1, onOpen: () => {} })
staleDisposer()
check(registry.get('beta')?.label === 'Beta v3', 'stale disposer cannot delete a newer entry')

// --- selection callback ----------------------------------------------------
const invoked = []
const disposeSelect = registry.register({ id: 'select-me', label: 'Select', order: 9, onOpen: () => invoked.push('opened') })
const controller = createLauncherController(fakeStorage())
controller.setOpen(true)
check(plugin.__test.runTool(registry, controller, 'select-me') === true, 'runTool selects a known tool')
check(invoked.join(',') === 'opened', 'selection invokes the registered onOpen callback')
check(controller.getOpen() === false, 'selection closes the modal first')
controller.setOpen(true)
check(plugin.__test.runTool(registry, controller, 'nope') === false, 'unknown id is ignored')
check(controller.getOpen() === true, 'unknown id leaves the modal open')
disposeSelect()

// --- load-order independence ----------------------------------------------
const earlyHost = {}
const earlyRegistry = createLauncherRegistry(earlyHost)
earlyRegistry.register({ id: 'early', label: 'Early tool', onOpen: () => {} })
earlyHost[plugin.__test.TOOL_REGISTRY_KEY] = earlyRegistry
const adopted = ensureLauncherRegistry(earlyHost)
check(adopted === earlyRegistry, 'launcher adopts a registry created by an earlier plugin')
check(adopted.getSnapshot()[0]?.id === 'early', 'earlier registrations survive adoption')

const lateHost = {}
const lateRegistry = ensureLauncherRegistry(lateHost)
lateRegistry.register({ id: 'late', label: 'Late tool', onOpen: () => {} })
check(lateHost[plugin.__test.TOOL_REGISTRY_KEY].getSnapshot()[0]?.id === 'late', 'tools registered after the launcher still land')

// --- open-state controller -------------------------------------------------
function fakeStorage() {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
}

const storage = fakeStorage()
const first = createLauncherController(storage)
let notifications = 0
const unsubscribe = first.subscribe(() => {
  notifications += 1
})
check(first.getOpen() === false, 'controller starts closed')
first.toggle()
check(first.getOpen() === true, 'toggle opens')
first.toggle()
check(first.getOpen() === false, 'toggle closes')
first.setOpen(true)
const second = createLauncherController(storage)
check(second.getOpen() === true, 'open state persists through storage')
check(notifications === 3, 'subscribers are notified for every real transition')
first.setOpen(true)
check(notifications === 3, 'setting the same value does not notify')
unsubscribe()

// --- validation ------------------------------------------------------------
assert.throws(() => registry.register({ id: '', label: 'x', onOpen() {} }), /tool\.id/)
assert.throws(() => registry.register({ id: 'x', label: 'x' }), /onOpen/)
assert.throws(() => registry.register(null), /must be an object/)

console.log(`\n${pass} checks passed${fail === 0 ? '' : `, ${fail} failed`}`)
process.exit(fail === 0 ? 0 : 1)
