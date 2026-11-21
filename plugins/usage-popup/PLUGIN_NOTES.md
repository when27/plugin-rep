# usage-popup — True-sync ledger notes

> **Current architecture (2026-11-19).** The sole entry point is `plugin-launcher`'s
> unified **Plugin Tools** button in the global sidebar; this plugin registers
> `usage-popup.ledger` (label `True-sync ledger`, order 20) into its shared
> `window.__DSH_PLUGIN_LAUNCHER_V1__` registry and the panel itself is mounted at
> the root in `shell.overlay`. The plugin contributes **nothing** to
> `sidebar.footer.action` or `conversation.composer.dock`, so the sidebar keeps
> one short button and the chat footer keeps only the DSH-native token tracker.
> The Session tab has a chat selector built from the ledger:
> it follows the app's active chat automatically (the Session retained with
> source `mainView`, and only while no global panel is open), falls back to
> the most recently active ledger chat on non-chat screens, and lets the user
> lock onto a historical chat with a one-click "Current chat" snap-back pill.
> The composer-dock notes below describe the 0.1–0.2 history and are kept for
> context; do not re-introduce a chat-footer trigger.
>
> The open state lives in `createLedgerController` (`usage-popup.ledger.open.v1`,
> closed by default) because the registry tool callback and the overlay are
> separate mounts. Live metrics for the root-scoped panel come from
> `ctx.sessions.retain(activeChatId, { source: 'usagePopup' })` and the
> generation's `projections.faceOf('tokenUsage' | 'modelSelection')`; historical
> chats are pure ledger slices.
>
> For the full line map, Cordis/slot contracts, lifecycle, schema and release
> checklist, read [`ARCHITECTURE.md`](ARCHITECTURE.md).

## What is already confirmed (do not re-derive)

These were verified against the installed client packages (`dsh 0.2.2-rc.1`),
not guessed:

- A plugin is a TypeScript/TSX module exporting `apply(ctx)` and a `name`.
- **Declare every service you touch.** The client half reads `ctx.slots`, and
  `slots` is provided by the renderer from a sibling fiber, so the module must
  also export `inject = ['slots']`. Without that declaration Cordis throws
  `cannot get property "slots" without inject`, the fiber ends `FAILED`, and
  web boot reports `usage-popup: failed` (this was the 0.1.0 reload crash).
- Slots are registered with
  `ctx.slots.inject(slotName, () => ctx.slots.register(entry, Component))`.
- `conversation.composer.dock` is a **list** slot. Built-in entries:
  - `activity` — order 0
  - `usage` — order 1 (token total + cache hit, already has its own dialog)
  A **new `id`** adds a new control; the same `id` + same `order` replaces one.
  The dock orders rows by `order`, and a lower `priority` picks a replacement.
- The usage projection is keyed `tokenUsage`, typed
  `TokenUsageProjection`, with exactly these numeric fields:
  `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`.
- Slot components receive session-scoped selector hooks as props; the one to
  use is `useProjection('tokenUsage')`. It returns the projection or
  `undefined` (no session bound yet / not yet loaded).
- Component props are typed with `PropsRuntime<'conversation.composer.dock'>`
  from `@deepseek-ai/dsh-client-ui-slots`.
- Runtime externals available to client plugins include: `react`,
  `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`, `zod`,
  `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-ui-dockkit`.

## Remaining work (the TODO)

### 1. The popup itself
`UsagePopControl` currently returns a bare button. Make clicking it toggle a
small popover showing, at minimum:

- total tokens = uncachedInput + output + cacheRead + cacheWrite
- the four fields broken out
- cache-hit ratio = cacheRead / (uncachedInput + cacheRead), shown when nonzero

Suggested approach (lowest risk):

- `import { useState } from 'react'` and `import { createPortal } from 'react-dom'`.
- Keep the button as the trigger. On click, set `open`.
- Render the popover with `createPortal(..., document.body)`.

**Why the portal is mandatory:** the composer is a containing block for
fixed-position descendants. A `position: fixed` popover inside the dock will
anchor to the composer, not the viewport. Portal to `document.body`, or use a
`Menu`/`Tooltip` primitive that already portals.

- Close on Escape and on outside pointerdown. Mirror the built-in stats
  dialog behavior: "closes on Escape or on a pointerdown or click outside it."
- Handle the `undefined` state (no session / no data) with a neutral "—" or a
  "no session" line. Do not crash on a null projection.

### 2. Styling
The dock controls follow a shared "statistics-control radius" convention; you
don't need it to look native on day one, but:

- add a class or `data-composer-stat="usage-popup"` (already set) so CSS can
  target it,
- do **not** append to `document.body` or write DOM outside your component —
  the renderer owns the tree. The portal'd popover is the one sanctioned
  exception.

### 3. Verify the type accessor if the build complains
The skeleton destructures `useProjection` straight off the props. If the
compiler/loader reports it isn't a prop, check the installed `.d.ts` under
`node_modules/@deepseek-ai/dsh-client-ui-slots` for the exact `ScopeStandardProps`
shape — it may be `props.hooks.useProjection` or a named import from the
renderer package. `useProjection: UseProjection` is what the bundled types
declare; adjust only if the toolchain rejects it, and note what you changed.

## How to run it (pick one)

### A. Dev loop (recommended; needs a checkout)
The packaged Desktop app has no source checkout on disk, so clone the repo first:

1. Clone `deepseek-ai/deepseek-harness` and follow the run-from-source path.
2. From the repo root:
   `pnpm dsh web --patch <absolute>/usage-popup/cordis.yml`
3. Open the printed URL and confirm `[usage-popup]` loads (add a `console.log`
   in `apply` if you want proof).
4. The dock control appears in the composer, after the built-in `usage` stat.

### B. Bundle install (packaged app, no checkout)
Package the plugin and install it through the Web sidebar **Plugins** page (or
the `plugin_manager` tool). Before doing this, copy the exact DSH peer/engines
declaration from an existing official plugin's `package.json` — the skeleton's
`package.json` is deliberately minimal and may not satisfy the loader's version
gate. Confirm the `exports`/`main` points at built JS if the loader does not
transpile `node_modules` TSX.

## Pitfalls to keep in mind

- **Never float the HUD inside the Windows caption band.** The desktop frame
  paints a full-width `-webkit-app-region: drag` strip (`40px`, from
  `--dsh-windows-titlebar-height`) across the top of the window. Chromium hands
  that strip to the OS window-drag hit test, so a `document.body` portal sitting
  inside it receives no pointer events at all: no clicks, no hover, no drag.
  The HUD once persisted `y: 8` (the old clamp minimum), landed there, and
  became completely inert — only the composer toggle (outside the strip) still
  worked. Guards now in place: `hudTopInset()` clamps `top` to
  `titlebar + 8`, and `hudStyle` sets `-webkit-app-region: no-drag` so the card
  stays interactive even if it overlaps the strip. Do not lower that minimum or
  remove the `no-drag`.
- **Don't replace the built-in `usage` control by accident.** A new `id`
  (`usage-popup`, order 2) adds; only reuse id `usage` + order 1 if you intend
  to replace it.
- **Don't touch `name`.** The loader keys on the module `name` export.
- **Scope.** `conversation.composer.dock` is session-scoped; the projection is
  per-session. There is no usage data before a session is bound, so the
  `undefined` branch is reachable and must render something.
- **`shell.overlay` is for whole-frame overlays.** The docs say to prefer a slot
  with allocated space and use `shell.overlay` only when you need a full-frame
  overlay with known placement. For a small popup anchored to a dock control,
  the dock slot + portal is the right call. Only escalate to `shell.overlay`
  (register `{ name: 'shell.overlay', ... }`) if the popup must float
  independently of the composer.

## Definition of done

- [ ] Button shows a live total that updates as the session runs.
- [ ] Click opens a portal'd popover; Escape / outside-click closes it.
- [ ] Four-field breakdown + cache-hit ratio render correctly.
- [ ] No-session state renders without crashing.
- [ ] Plugin loads and unloads cleanly (no leaked DOM, no body-level junk).

## Host collector (0.2.0)

The host half collects token usage from the global `llm/stream` waterfall,
server-tool fees from `session/event` + a transparent `fetch` observer, and
serves it to the client:

- `GET /usage-popup/api/usage?since=<seq>` -> `{format:"usage-popup.host-usage", version:1, cursor, records}` (ascending seq, max 500). If `since > cursor` (a store restart/rotation reset seq to 1 while the browser cursor persisted) the route replays from 0 and adds the optional `reset: true` boolean.
- `GET /usage-popup/api/health` -> collector + transport counters.

Subagent tagging reads the live Session's `header` (`origin`, `parentSession`,
`delegationDepth`, `agentPreset`); the flat session shape is still accepted for
compatibility. Token records are emitted once per stream from the latest `usage`
chunk (DSH last-chunk-wins). Server-tool fees are deduped process-wide with a
5-second claim window keyed `sessionId::name`, because the wire parser and the
`session/event` path can both observe the same request. Some provider SDKs
(e.g. pi-ai) capture the global `fetch` before this plugin installs its wrapper,
so the wire observer can miss their requests; the `llm/stream` and
`session/event` feeds remain authoritative.

Records persist to `$DSH_HOME/usage-popup/usage-records.jsonl` (`~/.dsh` when
`DSH_HOME` is unset), rotating to `.1` at 32 MB. Rebuild with
`node scripts/build.mjs` from this directory (writes `dist/index.js`,
`dist/client.js`, `dist/host/*.js`); install the profile bundle the same way as
before.

