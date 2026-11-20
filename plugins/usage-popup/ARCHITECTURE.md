# usage-popup (True-sync ledger) — Architecture & Maintenance Map

**Snapshot:** plugin `0.3.0`, DSH Desktop `0.2.2-rc.1`, 2026-11-18.
**Audience:** agents and developers changing this plugin. It records DSH client
internals that had to be reverse-engineered from the installed `app.asar`
(`dsh-client-ui-session`, `dsh-client-ui-layout`, `dsh-client-ui-sidebar`,
`dsh-client-ui-workspace`, `dsh-api-session-controller`, `dsh-client-ui-slots`)
and are not fully covered by the shipped docs.

> Line numbers are a map, not an API. After an edit, refresh them with the
> command in [§1.5](#15-refreshing-this-map) instead of trusting stale ranges.

---

## 0. Mental model

One npm package ships two halves:

| Half | Entry | Role |
| --- | --- | --- |
| Host (Node) | `dist/index.js` + `dist/host/*.js` | Append-only token/tool collector. Hooks `llm/stream` and `session/event`, wraps global `fetch`, persists JSONL under `$DSH_HOME/usage-popup/`, serves `/usage-popup/api/*`. |
| Web client | `dist/client.js` | One `plugin-launcher` tool registration + one root-level panel. Merges host records into a localStorage ledger, falls back to projection deltas, renders the ledger UI. |

The **only entry point is the unified Plugin Tools menu**: this client registers
`usage-popup.ledger` into `plugin-launcher`'s shared `window` registry, and the
panel itself is mounted at the application shell (`shell.overlay`) so it opens
from any screen. The client contributes **nothing visible** to
`conversation.composer.dock`; the DSH-native token tracker is untouched.

```
llm/stream ─┐
session/event├─► host Collector ─► UsageStore (JSONL) ─► GET /usage-popup/api/usage
fetch wrap ─┘                                             │ (10 s poll, cursor)
                                                          ▼
                                     client merge → localStorage ledger
                                                          │
        active chat (mainView retention) ─► Session dropdown + live metrics
                                                          │
                                     LedgerHud (shell.overlay, always mounted)
                                                          │
                                     plugin-launcher registry: True-sync ledger → open/toggle
```

---

## 1. File & line map

### 1.1 `src/index.tsx` (6,119 lines at 0.3.0)

| Lines | Responsibility |
| --- | --- |
| 1–58 | File header, React/Cordis imports, `name`, `inject = ['slots', 'sessions']`, start of the plugin-launcher registry bridge. |
| 58–157 | Plugin-launcher bridge (`launcherRegistry`, `registerLauncherTool`, `effectOnce`) — the byte-compatible v1 contract. |
| 159–224 | `TokenUsage`, host endpoint constants, `HostProbeState`, `resolveProjectionMode`, `hostCursorWasReset`, module-level `pluginContext`. |
| 226–263 | **`apply(ctx)`** — the complete wiring (overlay + plugin-launcher tool + null save-token cell). |
| 265–338 | Ledger open-state controller (`createLedgerController`, `useLedgerOpen`, `OPEN_KEY`). |
| 340–362 | `LedgerGlyph` (also reused as the registry tool icon) and `LedgerOverlay`. |

> The responsibility ranges below are from the pre-migration map and are shifted
> by about +17 lines after the sidebar components moved out. Refresh them with
> [§1.5](#15-refreshing-this-map) before relying on an exact range.
| 350–575 | HUD geometry, Windows titlebar inset, all persistence keys, core domain types (`LedgerEntry`, `SessionAnchor`, `BalanceMeta`, `ModelRow`, routed-usage types), formatting helpers. |
| 577–629 | RMB rate cards (`RATE_CARDS`, peak/off-peak pricing, `usageCostRmb`, `entryCostRmb`, cache savings). |
| 631–781 | Tier-router usage registry (`/tier-router/api/usage` normalization and per-route rows). |
| 783–943 | dsh-plugin-save-token dashboard normalization (the "Token saver" face). |
| 945–1034 | Local calendar helpers (day/week/month boundaries, date keys). |
| 1036–1197 | Usage math (`addUsage`, `usageDelta`, `sumUsage`, totals), `entryDedupKey`, `isRecord`, `normalizeUsage`, `cleanTitle`, model-class normalization. |
| 1199–1475 | Universal ledger storage: key discovery, legacy migration, `normalizeEntry`, `entriesFromUnknown`, `mergeLedger`, `replaceImportedEntries`, read/write. |
| 1477–1896 | Host-record ingestion (`entriesForHostRecords`, session index), anchors, balance meta/history, reconciliation planner. |
| 1898–2228 | Dashboard CSV/TSV/JSON import (`parseDashboardExport`). |
| 2230–2260 | Cross-instance notification (`storage`, BroadcastChannel, DOM event). |
| 2262–2373 | Live model detection: `modelSelection` projection → `ModelId`, DOM fallback. |
| 2375–2475 | Best-effort active-session id and title from the DOM. |
| 2477–2579 | Guarded localStorage helpers and HUD position clamp/persist. |
| 2583–2619 | Inline SVG glyphs. |
| 2621–3373 | All inline `CSSProperties` styles (theme alias tokens + literal fallbacks). |
| 3375–3653 | `SaverPanel` (token-saver face) and its styles. |
| 3655–3733 | Chat-selector data: `ChatOption`, `EMPTY_MODELS`, `buildChatOptions`. |
| 3735–3810 | `useLiveSessionUsage` — retained-session projection subscription. |
| 3812–4062 | `ChatSelect` dropdown (button, portaled menu, styles, outside-click/Escape). |
| 4081–6119 | **`LedgerHud`** — the whole panel. See §1.2. |

### 1.2 `LedgerHud` internal map (4081–6119)

| Lines (approx.) | Section |
| --- | --- |
| 4064–4090 | Signature (`PropsRuntime<'shell.overlay'> & { controller, open }`), `usePanelInfo`, `mainView` active-chat selector. |
| 4092–4102 | `useLiveSessionUsage`, `lockedChatId`, reset-to-auto when the panel opens. |
| 4104–4177 | Panel state: minimized, face (`usage`/`saver`), routed usage, position, timeframe, custom dates, runway, `nowMs`, DOM fallbacks, ledger state/ref, balance/key/sync state, host probe, refs. |
| 4179–4220 | `chatOptions` + selection priority (`locked → active → newest ledger → DOM`), `manualOverride`, `followingChat`, live `usage`/`models`, titles. |
| 4222–4297 | Timeframe boundaries, `selectedEntries`, `displayedUsage/Total`, `contextBloat`, `untrackedTokens`, cache-hit ratio. |
| 4299–4380 | Cost/savings, model tokens/rows, routed rows, worker rows, badge labels. |
| 4382–4426 | Session cost, today spend, burn telemetry, balance/runway inputs. |
| 4428–4603 | Budget, period spend, reconciliation drift, delegated summary, period window. |
| 4605–4625 | Preference persistence effects. |
| 4627–4658 | Tier-router poll (5 s, only while open + usage face + expanded). |
| 4660–4666 | One-time legacy per-session ledger migration. |
| 4668–4739 | **Host collector poll** (10 s, cursor, merge records, probe state machine). |
| 4741–4749 | Balance-history seeding. |
| 4751–4790 | Cross-instance ledger/balance/key refresh. |
| 4792–4930 | **Active-chat projection delta attribution** (anchors, high-water mark, ledger writes). |
| 4932–4981 | DOM fallback observer (model/session/title; mutation + 1.5 s tick). |
| 4983–4987 | 1 s clock tick. |
| 4989–5116 | True-balance auto-sync (`/user/balance`, 5 min + visibility/online retry, reconciliation). |
| 5118–5221 | Drag handling, clamping, persisted position. |
| 5223–5342 | Ledger export/import/reset (including re-anchoring the active chat on reset). |
| 5344–5352 | Breakdown rows and custom-range day count. |
| 5371–6119 | Render: header 5354, face tabs ≈5420, timeframe group ≈5473, chat selector 5512, token totals ≈5580, cache/breakdown ≈5593, cost column ≈5629, "Models · this session" 5708, delegated 5840, "True balance" 5848, footer 6046–6069. |

### 1.3 Host half

| File | Lines | Responsibility |
| --- | --- | --- |
| `src/host.ts` | 135 | Bundle host entry. `name`, `warn`, `registerRoutes`, `apply(ctx)`. Creates `UsageStore` + `Collector`, installs the fetch transport, subscribes `session/event` and `llm/stream` with `{ global: true }`, registers the `/usage-popup` routes, and returns a disposer. Best-effort: any failure logs and disables the host half instead of failing host load. |
| `src/host/collector.ts` | 358 | Server-tool names/fee constants, 5 s dedupe (`claimToolFee`), `canonicalServerTool`, `serverToolFee`, `SessionMeta`/`readSessionMeta`, `normalizeUsage`, `Collector` (records LLM + tool usage), `wrapLlmStream` (last-chunk-wins usage capture). |
| `src/host/route.ts` | 118 | `ROUTE_PREFIX`, `USAGE_PATH`, `HEALTH_PATH`, `MAX_LIMIT = 500`, `RouteState`, `createRouteHandler`. `GET /api/usage?since=<seq>` returns `{format, version, cursor, records[]}` (and `reset: true` after a store rotation); `GET /api/health` returns collector/transport counters. |
| `src/host/store.ts` | 209 | Record schema, `FORMAT = 'usage-popup.host-usage'`, `FORMAT_VERSION = 1`, `MAX_RECORDS = 20_000`, `ROTATE_BYTES = 32 MiB`, `resolveDataDir`/`resolveRecordsPath` (`$DSH_HOME/usage-popup/usage-records.jsonl`), `UsageStore` (load/append/seq/rotation). |
| `src/host/transport.ts` | 489 | `MAX_PARSE_BYTES`, `TRANSPORT_SYMBOL`, stats, `isIncludeUsageUrl`, `addIncludeUsage` (adds `stream_options.include_usage` to `/chat/completions`), `parseWireUsage` (server-tool + usage metadata), `installFetchTransport` (restorable global `fetch` wrapper). |
| `scripts/build.mjs` | 123 | Transpile-only build using the TypeScript compiler API. See §5.4. |

### 1.4 Tests & supporting files

| File | Lines | Suite |
| --- | --- | --- |
| `test/logic.test.mjs` | 549 | 75 checks: pure client logic (pricing, ledger merge, reconciliation, import parsing). |
| `test/host.test.mjs` | 422 | 95 checks: collector, store, tool fees, session meta. |
| `test/transport.test.mjs` | 364 | 58 checks: fetch wrapper, `include_usage` injection, wire parsing. |
| `test/integration.test.mjs` | 432 | 55 checks: host `apply()` against a fake ctx, event subscriptions, route registration. |
| `test/client.test.mjs` | 236 | 26 checks: slot wiring (no sidebar cell, one overlay, one plugin-launcher tool, no composer control) and `buildChatOptions` selection/aggregation. |
| `cordis.patch.yml` | — | Profile bundle patch: one row `usage-popup`. |
| `cordis.yml` | — | Optional local-dev patch mounting `src/index.tsx` from a checkout. |

### 1.5 Refreshing this map

```bash
# Section headers with line numbers
node -e "
const L=require('fs').readFileSync('plugins/usage-popup/src/index.tsx','utf8').split('\n');
L.forEach((l,i)=>{ if(/^\/\/ -{20,}/.test(l)) console.log(i+1, (L[i+1]||'').replace(/^\/\/ ?/,'').trim()) })
"
# Any symbol's current line
grep -n "function LedgerHud\|useLiveSessionUsage\|buildChatOptions\|function apply" plugins/usage-popup/src/index.tsx
```

---

## 2. Cordis & DSH injection contracts

### 2.1 Module-level `inject`

```ts
export const inject = ['slots', 'sessions']
```

- `slots` is the renderer service; without it `ctx.slots` throws
  `cannot get property "slots" without inject`.
- `sessions` is the client Session Controller service used by
  `ctx.sessions.retain(...)` in `useLiveSessionUsage`. It is provided by
  `@deepseek-ai/dsh-client-ui-session` and is always present in the Web UI.
- Add every other service you touch to this list; a missing declaration makes
  the plugin fiber fail and shows `usage-popup: failed` in the web-boot audit.

### 2.2 `package.json` → `dsh.client`

```jsonc
"client": {
  "platform": "web",
  "immediately": true,
  "inject": [
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-ui-session",
    "@deepseek-ai/dsh-client-ui-layout",
    "@deepseek-ai/dsh-client-ui-sidebar",
    "@deepseek-ai/dsh-client-ui-renderer"
  ]
}
```

- `conversation` is needed for the `conversation.composer.dock` **null**
  replacement.
- `session` supplies `ctx.sessions` + the `useSessions` root hook.
- `layout` supplies the `usePanelInfo` root hook.
- `sidebar` owns `sidebar.footer.action` and hosts `plugin-launcher`'s button.
- `renderer` supplies the slot service.
- `immediately: true` loads the client module at boot instead of lazily, so the
  ledger is registered in the Plugin Tools registry as soon as the shell paints.
  The Obsidian plugin uses the same setting for its tool.

Verified against the installed `app.asar` (2026-11-18): every package above
declares a `dsh.client` web module in its own manifest, so all five inject
targets resolve. `ui-layout` itself injects `ui-session`, and `ui-sidebar`
injects both `ui-layout` and `ui-session`; declaring them here is what makes the
root standard hooks (`useSessions`, `usePanelInfo`) reliably available to the
overlay.

### 2.3 Slots used

| Slot | Kind / scope | Registration | Props | Why |
| --- | --- | --- | --- | --- |
| `shell.overlay` | list / root | `{ id: 'usage-popup-ledger', order: 110 }` | Standard root props include `useSessions`, `usePanelInfo`, `useWorkspaces`, ... | Frame-wide floating layer above every column; the panel is independent of the conversation route. |
| `plugin-launcher` registry | shared `window` registry / root | `register({ id: 'usage-popup.ledger', label: 'True-sync ledger', order: 20, badge: 'LIVE', onOpen })` | none | The unified **Plugin Tools** menu. The returned disposer is run from `ctx.effect`, so the row disappears on hot-reload/plugin unload. Ordering: `obsidian-task-sync.checklist` 10, this tool 20. See [`../../plugins/plugin-launcher/OVERVIEW.md`](../../plugins/plugin-launcher/OVERVIEW.md). |
| `conversation.composer.dock` | list / session | `{ id: 'save-token-strip', order: 85, priority: -1 }` → renders `null` | Session props (unused) | **Invariant:** keep this registration. See §2.4. |

Do **not** register a `conversation.composer.dock` occupant with id
`usage-popup`; that was the removed `Usage: … HUD on` control.

### 2.4 Why the null `save-token-strip` must remain

The plugin absorbed the dsh-plugin-save-token composer strip into the panel's
"Token saver" face. The old mechanism is a **replacement registration**: the
same `id` + same `order` + lower `priority` puts this plugin in that cell. A
fresh id adds a new cell, a matching id/order replaces the shipped one.

If this null registration is removed:

- dsh-plugin-save-token's strip reappears in the chat footer, duplicating the
  panel's Token saver face and re-cluttering the composer;
- the plugin starts injecting visible UI into the chat footer — the exact thing
  the 2026-11-18 refactor removed.

The null cell is not an entry point and renders nothing.

### 2.5 Hook availability at the root overlay

`shell.overlay` standard props for this build (verified through
`cordis_inspect_query` → client `Slots.listSubTree`):

```
useRemoteAccess, useResource, useContextMenu, useWorkspaces,
usePanelInfo, useSessions, useSessionStatus, useSessionRetainInfo,
useSessionAccess, useWorkspaceAccess
```

- `usePanelInfo(selector)` selects from `{ activePanelId: MainPanelId | null }`.
  `null` means "the Conversation is displayed"; any non-null id means a global
  panel (Plugins, Automation tasks, Memory System, ...) is covering it.
- `useSessions(selector)` selects from `SessionListState`
  (`{ ids, byId, phase, projectionsBySession }`). `byId[id]` carries
  `displayTitle`, `blank`, `running`, `retainedBy`.
- There is **no** `useProjection` at root scope. That hook only exists inside a
  Session-scoped slot. Use the retained-session path in §4.3 instead.

### 2.6 Plugin Tools registration contract

The visible entry point is owned by `plugin-launcher`, a sibling client bundle.
There is no package import between them; both halves pin the same versioned
global registry. The registrant-side helper in `src/index.tsx` is deliberately
tiny and byte-compatible with the launcher:

```ts
const LAUNCHER_REGISTRY_KEY = '__DSH_PLUGIN_LAUNCHER_V1__'
// adopt an existing v1 registry, otherwise create { register, getSnapshot,
// subscribe, get, select } and pin it on window
```

- Registration payload: `{ id, label, description?, icon?, badge?, order?, onOpen }`.
- `register()` returns an unsubscribe disposer; `apply()` runs it through
  `ctx.effect(..., 'usage-popup: plugin-launcher tool')` so hot-reload/unload
  removes the row.
- Load order does not matter: the first bundle to evaluate creates the registry
  and the other adopts it.
- Changing the key or `version` requires a coordinated change in
  [`../../plugins/plugin-launcher/src/index.tsx`](../../plugins/plugin-launcher/src/index.tsx)
  and [`../../plugins/obsidian-task-sync/src/client.tsx`](../../plugins/obsidian-task-sync/src/client.tsx).

---

## 3. State & lifecycle

### 3.1 The cross-tree open controller

The Plugin Tools registry row and the overlay are separate mounts with no common
React ancestor, so open state cannot use React context. `apply()` creates one
controller (`createLedgerController`, [index.tsx:294](src/index.tsx)); the
registry tool's `onOpen` and `LedgerOverlay` both use it:

```ts
interface LedgerController {
  ctx: Context
  getOpen(): boolean
  setOpen(open: boolean): void
  toggle(): void
  subscribe(listener: () => void): () => void
}
```

- Backed by a `Set` of listeners (no React dependency).
- Persisted at `usage-popup.ledger.open.v1` (new key, default **closed**). The
  old `usage-popup.hud.visible.v1` is intentionally not reused so a previously
  "always visible" dock HUD does not auto-open over the frame.
- `useLedgerOpen(controller)` mirrors it into React state and re-subscribes.
- `toggle()` / `setOpen()` write storage before notifying, so a reload restores
  the last state.

### 3.2 Why the overlay stays mounted when closed

`LedgerOverlay` always renders `LedgerHud`; `LedgerHud` only conditionally
renders the card subtree:

```tsx
return <>{open && (<div ref={hudRef} ...> ... </div>)}</>
```

Hooks and effects are therefore alive while the panel is closed, which keeps:

- the 10 s host poll and its cursor caught up;
- the 5 s tier-router poll (it additionally checks `open`, so it idles while
  closed);
- active-chat projection subscription and anchor updates;
- the 1 s clock and 5 min balance auto-sync.

If you unmount `LedgerHud` when closed, the ledger still catches up on reopen
via `since=<cursor>` and the anchor delta, but a closed period would appear as a
single lump and balance samples would be missed.

### 3.3 Open/close lifecycle

| Event | Effect |
| --- | --- |
| Boot | `readStoredFlag(OPEN_KEY, false)` → usually closed. Overlay and the Plugin Tools row both subscribe. |
| Plugin Tools row selected | `onOpen` calls `controller.setOpen(true)`; the launcher closes its own modal. |
| Panel opens | `open` effect clears `lockedChatId` → auto-follow the active chat. |
| Panel close (header ×) | `controller.setOpen(false)`; mounts stay, subscriptions stay. |
| Overlay unmount (plugin unload) | `useLiveSessionUsage` cleanup releases the retained session; listeners unsubscribe. |

### 3.4 Ledger sync pipeline (client)

Read path:

1. Boot: `readLedgerDatabase()` reads `usage-popup.universal-ledger.v2` plus any
   legacy `usage-popup.session-ledger.v1.*` keys.
2. Host poll every 10 s: `GET /usage-popup/api/usage?since=<cursor>`.
   - 404 / wrong format → `hostProbe = 'inactive'` (projection path enabled).
   - Network error/timeout → keep previous state.
   - Valid 200 → `hostProbe = 'active'` forever (no TTL), cursor persisted,
     records mapped with `entriesForHostRecords`.
3. Cross-instance refresh: `storage` events, BroadcastChannel
   `usage-popup.ledger.v1`, and the DOM event `usage-popup:ledger-changed`.

Write path: every writer merges against a **fresh read** first
(`mergeLedger(ledgerRef.current, readLedgerDatabase())`) and then writes, so two
tabs/HUD instances cannot clobber each other. `mergeLedger` dedupes with
`entryDedupKey` (host id / import key / session + at + model + tier + token
counts).

### 3.5 Double-count gate

`resolveProjectionMode(hostProbe)` returns `project` **only** when the host half
is confirmed absent (`inactive`). While `pending` or `active`, the projection
delta effect only refreshes the anchor silently; it never writes ledger rows.
Remove that gate and the same tokens are billed twice.

---

## 4. DSH reactivity & attribution

### 4.1 Active-chat detection (the important trick)

The client has no public "current session id" service. The reliable signal is
the **retention source** used by the workspace UI:

- `@deepseek-ai/dsh-client-ui-workspace` calls
  `sessions.retain(target, { source: 'mainView' })` whenever it opens a session
  (`src/client/navigation.ts`, `replaceMain`).
- `SessionSummary.retainedBy` exposes `{ mainView?: number, ... }`.
- The workspace tree itself finds the current session with
  `(row.retainedBy.mainView ?? 0) > 0`.

`LedgerHud` uses exactly that:

```ts
const mainViewChatId = useSessions((list) => {
  for (const id of Object.keys(list.byId)) {
    const row = list.byId[id]
    if (row !== undefined && row.blank !== true && (row.retainedBy.mainView ?? 0) > 0) return id
  }
  return null
})
const activeChatId = usePanelInfo((info) => info.activePanelId) === null ? mainViewChatId : null
```

- `blank === true` is a New Session draft; it is not a chat yet.
- A non-null `activePanelId` means the conversation is covered by a global
  panel, so there is no active chat to follow.
- This selector returns a string (stable identity), so it does not re-render in
  a loop.

### 4.2 Selection state machine

```ts
autoChatId = activeChatId ?? chatOptions[0]?.sessionId ?? null
sessionKey = lockedChatId ?? autoChatId ?? domSessionId
manualOverride = lockedChatId !== null && lockedChatId !== autoChatId
followingChat = sessionKey !== null && sessionKey === activeChatId
```

- `chatOptions` = `buildChatOptions(ledgerEntries, activeChatId, activeTokens)`:
  per-`sessionId` aggregation, newest activity first, only chats with
  `entries > 0 || tokens > 0`. A blank draft therefore never enters the list.
- A new chat's first live tokens are inserted at the top immediately
  (`entries: 0`, `lastAt: Date.now()`) before the asynchronous host poll lands.
- Selecting a different historical id sets `lockedChatId`; selecting the auto
  target clears it. Opening the panel always clears it.
- When the panel is locked, the live projection is **not** shown for the
  historical chat (`usage = followingChat ? live.usage : null`); every metric
  is the pure ledger slice. The badge reads `History` instead of `Live`.

### 4.3 Live projection without a session scope

`useProjection` is Session-scoped. At the root overlay the equivalent is the
retained Session generation:

```ts
const ref = ctx.sessions.retain(activeChatId, { source: 'usagePopup' })
const session = ref.binding.session
const usageFace = session.projections.faceOf('tokenUsage')
const modelFace = session.projections.faceOf('modelSelection')
usageFace.getSnapshot()   // TokenUsageProjection | undefined
usageFace.subscribe(publish) // identity-stable per key
```

Verified contracts:

- `ctx.sessions.retain(target, { source }) → SessionReference`
  (`sessionId`, `binding`, `ready: Promise<SessionBinding>`, `release()`).
- `reference.binding.session.projections.faceOf(key)` always returns an
  `ObservableSnapshot` — absence is an `undefined` snapshot, never a missing
  face. Faces are created on demand and cached per key, so subscribing once is
  correct.
- `binding` can throw before the initial open settles; the hook retries through
  `reference.ready.then(read)` and guards with a `subscribed` flag.
- Cleanup unsubscribes both faces and calls `reference.release()`.
- The retain source `'usagePopup'` is a label only; retention counts are not
  persisted.

**Do not** use `useSessions().projectionsBySession` for live token totals. That
object is rebuilt only when the list mutates (`projectList`); tokenUsage rows can
be stale between list updates. It is fine for titles (`byId[id].displayTitle`).

### 4.4 Projection delta attribution

The delta effect ([index.tsx:4792](src/index.tsx)) always tracks the **active**
chat, never the selected historical one:

1. Read anchors from `usage-popup.session-anchors.v2`.
2. Anchor missing → store current totals, write no cost.
3. `usageTotal(next) < usageTotal(anchor)` → high-water mark; do not invent a
   refund. Refresh title/model only.
4. `usageDelta(next, anchor.lastUsage)`; a zero delta just re-anchors.
5. Non-zero delta → one `LedgerEntry` priced at the route/tier active at `at`
   (`source: 'projection'`), merged and written.
6. On a title change, existing rows for that session are retro-labelled.
7. While the host collector is active/pending (§3.5), only the anchor is
   refreshed; no row is written.

Because the effect is keyed on `activeChatId` + `live.usage`, selecting a
historical chat in the dropdown does not pause recording.

### 4.5 DOM fallbacks

No transcript text is ever read. Signals, in order:

1. `[data-active-session-id]` / `[data-current-session-id]`.
2. The sidebar tree row: `[data-row-key^="session:"][aria-selected="true"]`
   → id is the suffix after `session:`.
3. `[data-session-id]` rows with `aria-current="page"`, `aria-selected="true"`,
   `data-active="true"`, or `data-state="active"`.

A `MutationObserver` watches `data-model-id`, `data-provider-id`,
`aria-label`, `title`, `data-session-title`, `data-session-id`, `data-row-key`,
`data-active-session-id`, `aria-current`, `aria-selected`, `data-active`,
`data-state`, plus a 1.5 s interval. Elements inside `[data-usage-popup-hud]`
are ignored. DOM values are only fallbacks; the `mainView` retention path is
preferred.

---

## 5. Data schema, build & release

### 5.1 `LedgerEntry` (localStorage universal ledger)

```ts
interface LedgerEntry {
  id: string                 // generated (makeEntryId) or imported
  sessionId: string          // Session identity; '' for unattributed host records
  sessionTitle: string
  date: string               // local calendar YYYY-MM-DD
  model: 'flash' | 'pro' | 'search' | 'unattributed'
  tier: 'peak' | 'off-peak'
  usage: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens? }
  costRmb: number
  at: number                 // epoch ms
  reasoningTokens?: number
  sessionType?: 'main' | 'subagent' | 'background' | 'compaction' | 'reconcile' | 'import' | 'unknown'
  source?: 'projection' | 'host' | 'host-tool' | 'reconcile' | 'import'
  hostId?: string            // host record identity (dedupe)
  calls?: number
  costUsd?: number
  importKey?: string         // imported row identity (dedupe)
  costKnown?: boolean        // false = costRmb is authoritative recorded cost, never re-price
}
```

Dedupe: `entryDedupKey(entry)` = `hostId|importKey|sessionId|at|model|tier|uncached|cacheRead|cacheWrite|output`.

### 5.2 Local keys

| Key | Meaning |
| --- | --- |
| `usage-popup.universal-ledger.v2` | Whole ledger database (array, or `{ledger:[...]}` envelope). |
| `usage-popup.session-ledger.v1.*` | Legacy per-session ledgers, migrated on load. |
| `usage-popup.session-anchors.v2` | Per-session last cumulative usage/model for delta attribution. |
| `usage-popup.host-cursor.v1` | Host record seq already ingested. |
| `usage-popup.ledger.open.v1` | Panel open state (default `0`). |
| `usage-popup.hud.position.v1` / `minimized.v1` / `timeframe.v1` / `custom-start.v1` / `custom-end.v1` / `target-runway.v1` | Panel UI preferences. |
| `usage-popup.api-balance.v1` / `balance-history.v1` | Last true CNY balance + sample history (max 2880 points). |
| `usage-popup.deepseek-api-key.v1` | Base64-encoded API key (never exported, never logged). |

### 5.3 Host `UsageRecord` and routes

```ts
interface UsageRecord {
  id: string; seq: number; at: number
  kind: 'llm' | 'tool'
  source: 'llm-stream' | 'wire' | 'tool-event'
  sessionId: string | null
  sessionType: 'main' | 'subagent' | 'background' | 'compaction' | 'unknown'
  parentSessionId: string | null
  delegationDepth: number | null
  agentPreset: string | null
  model: string; provider: string | null; purpose: string | null
  usage: { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens } | null
  serverTool: { name, requests, status, feeUsd } | null
}
```

- `GET /usage-popup/api/usage?since=<seq>` → `{ format: 'usage-popup.host-usage', version: 1, cursor, records, reset? }` (max 500 records; `reset: true` after a store rotation).
- `GET /usage-popup/api/health` → collector/transport counters.
- Persistence: `$DSH_HOME/usage-popup/usage-records.jsonl`, rotated to `.1` at 32 MiB, 20 000 records in memory.
- Server-tool fee: `$0.00075` per request, 5 s process-wide dedupe keyed `sessionId::name`.

### 5.4 Build

`scripts/build.mjs` uses the TypeScript compiler API in **transpile-only** mode
(no type check). It resolves `typescript` from `plugins/usage-popup/node_modules`
or the workspace-root `usage-popup/node_modules`, then:

- client: `src/index.tsx` → CommonJS + `ReactJSX`, wrapped in
  `window.__ModuleLoader__.load({ id: 'usage-popup', factory: (require) => ... })`
  → `dist/client.js`;
- host: `src/host.ts` → ESM → `dist/index.js`; every `src/host/*.ts` → ESM →
  `dist/host/*.js` (host output directory is cleaned first).

Because there is no type check, always run the suites after editing; `tsc`
errors will not fail the build.

### 5.5 Test suite

```bash
cd plugins/usage-popup
node test/logic.test.mjs        # 75
node test/host.test.mjs         # 95
node test/transport.test.mjs    # 58
node test/integration.test.mjs  # 55
node test/client.test.mjs       # 23
```

Total at 0.3.0: **306 checks**. The suites are dependency-free (Node built-ins
only) and transpile the real source in memory. `integration.test.mjs` loads the
built host modules, so run `npm run build` first when host code changed.

### 5.6 Release checklist — ship to the desktop GUI

The running desktop app loads an **installed tarball** from the profile, not this
source tree. Repack and reinstall are required.

```bash
cd plugins/usage-popup

# 1. Verify
node test/logic.test.mjs && node test/host.test.mjs && \
node test/transport.test.mjs && node test/integration.test.mjs && \
node test/client.test.mjs

# 2. Bump the version (so pnpm sees a new artifact)
#    edit package.json: "version": "0.3.0" -> next version

# 3. Build
npm run build

# 4. Pack (local cache avoids sandboxed npm-cache write failures)
npm pack --cache ./.npm-cache
rm -rf .npm-cache

# 5. Point the profile at the new tarball (edit BOTH copies)
#    live:  C:/Users/Administrator/.dsh/profiles/desktop/package.json
#    repo:  profiles/desktop/package.json
#    "usage-popup": "file:C:/Users/Administrator/Documents/deepseek-harness/default-workspace/plugins/usage-popup/usage-popup-<version>.tgz"

# 6. Install into the live profile
cd "C:/Users/Administrator/.dsh/profiles/desktop"
pnpm install

# 7. Verify what is installed
node -e "console.log(require('./node_modules/usage-popup/package.json').version)"
grep -c "shell.overlay" node_modules/usage-popup/dist/client.js          # 2
grep -c "__DSH_PLUGIN_LAUNCHER_V1__" node_modules/usage-popup/dist/client.js  # 1
grep -c "usage-popup.ledger" node_modules/usage-popup/dist/client.js     # 1
grep -c "sidebar.footer.action" node_modules/usage-popup/dist/client.js  # 0
grep -c "data-composer-stat" node_modules/usage-popup/dist/client.js     # 0
```

Then **fully restart DSH** (quit from the tray, relaunch). A page refresh alone
does not reload the host half or re-read the profile composition; a client-only
change may appear on refresh, but a restart is the reliable path.

Post-restart checks:

- The sidebar shows one **Plugin Tools** button; the ledger is one row in it.
- Choosing the row from New Session / Plugins / any chat opens the panel.
- Session tab dropdown lists chats with entries/tokens/cost/age; selecting an
  older one shows the `Current chat` pill and `History`.
- Switching chats while open (no lock) follows the active chat.
- The composer shows the native token tracker only; no `Usage: … HUD on`.
- A new chat appears in the dropdown as soon as its first turn starts.

Rollback: point the same manifests back to the previous tarball, `pnpm install`,
restart.

### 5.7 Failure modes seen in practice

| Symptom | Likely cause / fix |
| --- | --- |
| Plugin absent, no Plugin Tools row | `inject` or `dsh.client.inject` names wrong, or the `__DSH_PLUGIN_LAUNCHER_V1__` contract drifted; check the web-boot audit. `sessions` must be declared for the module `inject`. |
| `usage-popup: failed` at boot | A required service was read without `inject`; a slot name/type is wrong. |
| Panel opens but totals never move | Host probe `active` but the poll is failing; check `/usage-popup/api/health`. Or the retained session was never opened (`ready` rejected). |
| Tokens double-counted | `resolveProjectionMode` gate removed, or a host record and a projection row describe the same call. |
| Dropdown empty | Ledger has no rows yet; if the host half is absent, the projection path needs an active chat with usage. |
| `Usage: … HUD on` returns | A `conversation.composer.dock` occupant with id `usage-popup` was re-added. |
| Save-token strip reappears | The null `save-token-strip` registration was removed. |
| Panel starts open unexpectedly | `usage-popup.ledger.open.v1` is `1` (or code fell back to the old `usage-popup.hud.visible.v1`). |
| HUD inert under the Windows caption | `hudTopInset()` / `-webkit-app-region: no-drag` guards were weakened; keep both. |

---

## Invariants (do not break)

1. **One entry point.** `plugin-launcher`'s registry + `shell.overlay`; never
   add a `usage-popup` cell to `sidebar.footer.action` or
   `conversation.composer.dock`.
2. **Keep the null `save-token-strip` replacement.**
3. **Do not replace the native `usage` dock control.**
4. **Never write projection rows while the host probe is `pending`/`active`.**
5. **Attribution follows `activeChatId`, not the dropdown selection.**
6. **A historical selection is a pure ledger slice** (`usage = null`).
7. **The overlay component stays mounted when closed.**
8. **`dsh.client.immediately` stays true** so the Plugin Tools row exists at boot.
9. **`name` export stays `usage-popup`** (the loader keys on it).
10. **Keep `files` in `package.json` aligned with the tarball** (`dist/index.js`,
    `dist/client.js`, `dist/host/*.js`, `cordis.patch.yml`) — `npm pack` filters
    by it.
