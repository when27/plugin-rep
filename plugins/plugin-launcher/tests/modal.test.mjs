// Modal behavior tests: rendered row/empty markup, open-state transitions and
// the close-then-launch selection contract. Uses the real React runtime and the
// built client bundle, so the component code under test is exactly what ships.

import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let exports
globalThis.window = {
  console: { error() {} },
  localStorage: (() => {
    const store = new Map()
    return {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    }
  })(),
  __ModuleLoader__: {
    load({ factory }) {
      exports = factory((specifier) => {
        if (specifier === 'react') return React
        if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
        if (specifier === 'react-dom') return require('react-dom')
        throw new Error(`unexpected require("${specifier}")`)
      })
    },
  },
}
globalThis.localStorage = window.localStorage

const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)

await import('../dist/client.js')

const { ToolList, EmptyState, createLauncherRegistry, createLauncherController, runTool } = {
  ToolList: exports.ToolList,
  EmptyState: exports.EmptyState,
  createLauncherRegistry: exports.__test.createLauncherRegistry,
  createLauncherController: exports.__test.createLauncherController,
  runTool: exports.__test.runTool,
}

let pass = 0
let fail = 0
const check = (ok, label) => {
  if (ok) pass += 1
  else {
    fail += 1
    console.log(`FAIL ${label}`)
  }
}

// --- rendered list ---------------------------------------------------------
const tool = {
  id: 'demo.tool',
  label: 'Demo tool',
  description: 'A short description of the demo surface',
  badge: 'BETA',
  order: 1,
  icon: React.createElement('span', { className: 'demo-icon' }, '◆'),
  onOpen() {},
}
const markup = renderToStaticMarkup(React.createElement(ToolList, { tools: [tool], onSelect() {} }))
check(markup.includes('Demo tool'), 'row renders the tool label')
check(markup.includes('A short description of the demo surface'), 'row renders the description')
check(markup.includes('BETA'), 'row renders the optional badge')
check(markup.includes('demo-icon'), 'row renders the registered icon node')
check(markup.includes('data-tool-id="demo.tool"'), 'row carries its id for selection')
check(markup.includes('<button'), 'rows are real buttons')
check(!markup.includes('undefined'), 'no undefined leaks into the markup')

const textIcon = renderToStaticMarkup(
  React.createElement(ToolList, { tools: [{ ...tool, icon: 'T' }], onSelect() {} }),
)
check(textIcon.includes('dpl-glyph-text'), 'a string icon falls back to a text tile')

const noDescription = renderToStaticMarkup(
  React.createElement(ToolList, { tools: [{ ...tool, description: undefined }], onSelect() {} }),
)
check(!noDescription.includes('dpl-desc'), 'a missing description renders no empty row')

const empty = renderToStaticMarkup(React.createElement(EmptyState))
check(empty.includes('No plugin tools registered yet'), 'empty state names the condition')
check(empty.includes('dpl-empty-body'), 'empty state explains how tools appear')

// --- open/close controller -------------------------------------------------
const storage = (() => {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  }
})()
const controller = createLauncherController(storage)
check(controller.getOpen() === false, 'modal starts closed')
controller.toggle()
check(controller.getOpen() === true, 'sidebar toggle opens the modal')
controller.setOpen(false)
check(controller.getOpen() === false, 'close button/backdrop/Escape path closes it')
const reopened = createLauncherController(storage)
check(reopened.getOpen() === false, 'closed state is persisted')
reopened.setOpen(true)
check(createLauncherController(storage).getOpen() === true, 'open state is persisted')

// --- selection -------------------------------------------------------------
const registry = createLauncherRegistry()
let opened = 0
registry.register({ id: 'a', label: 'A', onOpen: () => { opened += 1 } })
const openController = createLauncherController(null)
openController.setOpen(true)
check(runTool(registry, openController, 'a') === true, 'runTool launches a known tool')
check(opened === 1, 'runTool invokes the tool callback')
check(openController.getOpen() === false, 'runTool closes the modal before/with launch')
openController.setOpen(true)
check(runTool(registry, openController, 'absent') === false, 'runTool ignores an absent tool')
check(openController.getOpen() === true, 'an absent tool does not close the modal')

const errorController = createLauncherController(null)
errorController.setOpen(true)
const errorRegistry = createLauncherRegistry()
errorRegistry.register({
  id: 'broken',
  label: 'Broken',
  onOpen() {
    throw new Error('boom')
  },
})
check(runTool(errorRegistry, errorController, 'broken') === true, 'a throwing tool still reports a launch attempt')
check(errorController.getOpen() === false, 'a throwing tool still closes the modal')

// --- sidebar button --------------------------------------------------------
const button = renderToStaticMarkup(
  React.createElement(exports.LauncherButton, { wide: true, controller: createLauncherController(null) }),
)
check(button.includes('>Plugin Tools<'), 'wide sidebar button shows the short label')
check(button.includes('aria-haspopup="dialog"'), 'button advertises the popup dialog')
const rail = renderToStaticMarkup(
  React.createElement(exports.LauncherButton, { wide: false, controller: createLauncherController(null) }),
)
check(!rail.includes('>Plugin Tools<'), 'rail button collapses to the icon square')

console.log(`\n${pass} checks passed${fail === 0 ? '' : `, ${fail} failed`}`)
process.exit(fail === 0 ? 0 : 1)
