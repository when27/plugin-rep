// Smoke-load the built browser bundle with the same lazy-CJS contract the
// Harness module loader uses. This catches module-evaluation and registration
// faults without a browser, and guards the in-app overlay contract: no popup
// APIs, a sidebar toggle, and a shell.overlay widget layer.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaultTreeMarkdown, parseSkillTree } from '../src/host.js'

const nodeRequire = createRequire(import.meta.url)
let exports

const windowListeners = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, 'obsidian-task-sync')
      exports = factory((specifier) => nodeRequire(specifier))
    },
  },
  addEventListener(name, listener) {
    windowListeners.set(name, listener)
  },
  removeEventListener(name) {
    windowListeners.delete(name)
  },
  localStorage: {
    getItem() {
      return null
    },
    setItem() {},
  },
}

await import('../dist/client.js')
assert.ok(exports, 'client bundle registered an empty export')
assert.equal(exports.name, 'obsidian-task-sync')
assert.deepEqual(exports.inject, ['slots', 'locale'])

const disposers = []
const registered = []
let dictionaries = null
const ctx = {
  effect(callback) {
    const cleanup = callback()
    disposers.push(cleanup)
    return () => cleanup?.()
  },
  locale: {
    register(namespace, value) {
      assert.equal(namespace, 'obsidian-task-sync')
      assert.ok(value.en && value.zh)
      assert.equal(value.en.popupBlocked, undefined, 'the popup-blocked string is gone')
      dictionaries = value
      return () => {}
    },
    bind() {
      return (key) => dictionaries?.en?.[key] ?? key
    },
  },
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

const sidebar = registered.find((entry) => entry.options.name === 'sidebar.footer.action')
const overlay = registered.find((entry) => entry.options.name === 'shell.overlay')
assert.ok(sidebar, 'sidebar.footer.action was not registered')
assert.ok(overlay, 'shell.overlay was not registered')
assert.equal(sidebar.options.id, 'obsidian-task-sync')
assert.equal(overlay.options.id, 'obsidian-task-sync-widget')
assert.equal(typeof sidebar.component, 'function')
assert.equal(typeof overlay.component, 'function')

const markup = renderToStaticMarkup(React.createElement(sidebar.component, { wide: true }))
assert.match(markup, /<button/)
assert.match(markup, /aria-pressed="false"/)
assert.match(markup, /Open Obsidian checklist/)
assert.doesNotMatch(markup, /undefined/)

// The widget layer is mounted globally but renders nothing until the sidebar
// button opens it. Server rendering exercises the closed branch.
assert.equal(renderToStaticMarkup(React.createElement(overlay.component)), '')

// The built bundle must not reach for popup or cross-window primitives.
const bundle = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
assert.doesNotMatch(bundle, /window\.open\s*\(/)
assert.doesNotMatch(bundle, /window\.alert\s*\(/)
assert.doesNotMatch(bundle, /BroadcastChannel/)
assert.doesNotMatch(bundle, /obsidianTaskSync/)
assert.doesNotMatch(bundle, /obsidian-task-sync-popout/)

// Interaction guards: the card opts out of the Windows caption drag region,
// the titlebar-aware clamp is present, and dragging listens on window only
// after a pointerdown on the chrome.
assert.match(bundle, /-webkit-app-region:\s*no-drag/)
assert.match(bundle, /pointer-events:\s*auto/)
assert.match(bundle, /--ots-top-inset/)
assert.match(bundle, /data-windows-titlebar/)
assert.match(bundle, /data-ots-drag-handle/)
assert.match(bundle, /addEventListener\(["']pointermove["']/)
assert.doesNotMatch(bundle, /onPointerMove/)

// Drag-release flicker regression: the entrance animation must be a one-shot
// class, never a rule re-enabled when `is-dragging` is removed.
assert.match(bundle, /ots-widget\.is-entering\s*\{\s*animation:\s*ots-widget-in/)
assert.doesNotMatch(bundle, /is-dragging\s*\{\s*animation/)
assert.match(bundle, /entering \? ' is-entering'/)

// Native select popups are OS-drawn; the widget must use its own listbox.
assert.doesNotMatch(bundle, /createElement\)\('select'/)
assert.match(bundle, /ots-dd-menu/)
assert.match(bundle, /role: 'listbox'/)

// Skill tree surface: rail navigation, canvas, and bridge operations.
assert.match(bundle, /ots-rail-button/)
assert.match(bundle, /ots-canvas-scroll/)
assert.match(bundle, /ots-node/)
assert.match(bundle, /ots-rank-badge/)
assert.match(bundle, /tree\/toggle/)
assert.match(bundle, /SkillTrees-/)

// Daily workflow update: rollover, focus timer, tag pills, minimized pill.
assert.match(bundle, /task\/rollover/)
assert.match(bundle, /ots-rollover/)
assert.match(bundle, /ots-focus/)
assert.match(bundle, /ots-widget-minimize/)
assert.match(bundle, /is-minimized/)
assert.match(bundle, /ots-tag/)
assert.match(bundle, /MINIMIZED_KEY/)
assert.match(bundle, /FOCUS_KEY/)

assert.equal(typeof exports.__rankFor, 'function')
assert.equal(typeof exports.__layoutSkillTree, 'function')
assert.equal(typeof exports.__renderSkillTreeCanvas, 'function')
assert.deepEqual(
  [0, 10, 25, 40, 50, 60].map((points) => exports.__rankFor(points).rank.key),
  [
    'rankNovice',
    'rankProficient',
    'rankMaster',
    'rankSoftware',
    'rankSenior',
    'rankPrincipal',
  ],
)
assert.equal(exports.__rankFor(24).toNext, 1)
assert.equal(exports.__rankFor(59).toNext, 1)
assert.equal(exports.__rankFor(65).next, null)
assert.equal(exports.__rankFor(65).progress, 1)

// Focus timer: clock input means H:MM[:SS], a flat number means minutes.
assert.equal(typeof exports.__parseFocusDuration, 'function')
assert.equal(exports.__parseFocusDuration('1:30'), 5_400)
assert.equal(exports.__parseFocusDuration('90'), 5_400)
assert.equal(exports.__parseFocusDuration('01:00:00'), 3_600)
assert.equal(exports.__parseFocusDuration('1:30:15'), 5_415)
assert.equal(exports.__parseFocusDuration(' 45 '), 2_700)
assert.equal(exports.__parseFocusDuration('1:90'), null)
assert.equal(exports.__parseFocusDuration('0'), null)
assert.equal(exports.__parseFocusDuration('soon'), null)
assert.equal(exports.__formatFocusDuration(3_600), '01:00:00')
assert.equal(exports.__formatFocusDuration(5_400), '01:30:00')
const timerMarkup = renderToStaticMarkup(exports.__renderFocusTimer())
assert.match(timerMarkup, /class="ots-focus"/)
assert.match(timerMarkup, /01:00:00/)
assert.match(timerMarkup, /aria-label="focusStart"/)
assert.match(timerMarkup, /aria-label="focusPause"/)
assert.match(timerMarkup, /aria-label="focusReset"/)
assert.doesNotMatch(timerMarkup, /undefined/)

// Obsidian tags render as pills, while `C#` and URL fragments stay text.
assert.equal(typeof exports.__renderInline, 'function')
const tagged = renderToStaticMarkup(
  exports.__renderInline('Fix #urgent and #project/alpha today'),
)
assert.match(tagged, /class="ots-tag"/)
assert.match(tagged, /data-tone="[0-3]"/)
assert.match(tagged, />#urgent</)
assert.match(tagged, />#project\/alpha</)
const notTags = renderToStaticMarkup(exports.__renderInline('C# and https://x.test/#frag'))
assert.doesNotMatch(notTags, /class="ots-tag"/)

const parsedTree = parseSkillTree(defaultTreeMarkdown())
const layout = exports.__layoutSkillTree(parsedTree)
assert.equal(layout.nodes.length, 17)
assert.equal(layout.edges.length, 17)
assert.equal(layout.lanes.length, 4)
assert.ok(layout.width > 1600, `tree canvas should scroll horizontally, got ${layout.width}`)
assert.equal(layout.nodes[0].x, 278)
assert.equal(layout.nodes[0].y, layout.nodes[5].y)
assert.ok(layout.edges.every((edge) => edge.path.startsWith('M ')))
assert.equal(layout.nodes[0].locked, false)
assert.equal(layout.nodes[1].locked, true)
assert.equal(layout.nodes[1].parentId, layout.nodes[0].id)

const treeMarkup = renderToStaticMarkup(exports.__renderSkillTreeCanvas(parsedTree))
assert.match(treeMarkup, /class="ots-canvas"/)
assert.match(treeMarkup, /class="ots-node"/)
assert.match(treeMarkup, /C\+\+17 \/ C\+\+20 \/ C\+\+23/)
assert.match(treeMarkup, /<path/)
assert.match(treeMarkup, /class="ots-root"/)
assert.doesNotMatch(treeMarkup, /undefined/)

// Token lifecycle: the runtime fallback for a page that loaded before the
// plugin installed must be the authenticated bootstrap route.
assert.match(bundle, /BOOTSTRAP_PATH = `\$\{ROUTE\}\/bootstrap`/)
assert.match(bundle, /bridgePreparing/)

for (const cleanup of disposers.reverse()) {
  if (typeof cleanup === 'function') cleanup()
}
await new Promise((resolve) => setTimeout(resolve, 20))
console.log('client smoke test passed:', markup.slice(0, 120), '…')
