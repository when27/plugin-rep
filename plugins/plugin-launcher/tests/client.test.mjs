// Smoke-load the built browser bundle with the same lazy-CJS contract the
// Harness module loader uses. This catches module-evaluation and slot-wiring
// faults without a browser and locks the entry-point contract: exactly one
// global-sidebar cell plus one shell.overlay modal, and nothing else.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
let exports

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

globalThis.window = {
  console: { error() {} },
  localStorage: {
    getItem() {
      return null
    },
    setItem() {},
  },
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, 'plugin-launcher')
      exports = factory((specifier) => {
        if (specifier === 'react') return reactStub
        if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
        if (specifier === 'react-dom') return reactDomStub
        throw new Error(`unexpected require("${specifier}")`)
      })
    },
  },
}

await import('../dist/client.js')
assert.ok(exports, 'client bundle registered an empty export')
assert.equal(exports.name, 'plugin-launcher')
assert.deepEqual(exports.inject, ['slots'])

const disposers = []
const registered = []
const ctx = {
  slots: {
    inject(name, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
}

exports.apply(ctx)

const sidebar = registered.filter((entry) => entry.options.name === 'sidebar.footer.action')
const overlay = registered.filter((entry) => entry.options.name === 'shell.overlay')
assert.equal(registered.length, 2, 'the launcher owns exactly two slot occupants')
assert.equal(sidebar.length, 1, 'exactly one sidebar.footer.action is registered')
assert.equal(overlay.length, 1, 'exactly one shell.overlay is registered')
assert.equal(sidebar[0].options.id, 'plugin-launcher')
assert.equal(sidebar[0].options.order, 0)
assert.equal(typeof sidebar[0].options.label, 'function')
assert.equal(sidebar[0].options.label(), 'Plugin Tools')
assert.equal(overlay[0].options.id, 'plugin-launcher-modal')
assert.equal(overlay[0].options.order, 120)
assert.equal(typeof sidebar[0].component, 'function')
assert.equal(typeof overlay[0].component, 'function')

// A tool registered after plugin-launcher loaded lands in the same registry.
const registry = window.__DSH_PLUGIN_LAUNCHER_V1__
assert.ok(registry, 'apply() created the global tool registry')
let opened = 0
const dispose = registry.register({
  id: 'usage-popup.ledger',
  label: 'True-sync ledger',
  description: 'Token and cost ledger',
  badge: 'LIVE',
  order: 20,
  onOpen: () => {
    opened += 1
  },
})
assert.equal(registry.getSnapshot().length, 1)
assert.equal(registry.getSnapshot()[0].label, 'True-sync ledger')
registry.select('usage-popup.ledger')
assert.equal(opened, 1)
dispose()
assert.equal(registry.getSnapshot().length, 0)

// The built bundle must use the native modal contract, not a hand-rolled
// div overlay: showModal(), a styled ::backdrop and scroll containment.
const bundle = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
assert.match(bundle, /showModal/)
assert.match(bundle, /::backdrop/)
assert.match(bundle, /overscroll-behavior: contain/)
assert.match(bundle, /aria-labelledby/)
assert.match(bundle, /onCancel|oncancel/i)
assert.doesNotMatch(bundle, /aria-modal=/)
assert.doesNotMatch(bundle, /window\.open\s*\(/)

console.log('\nclient wiring checks passed')
