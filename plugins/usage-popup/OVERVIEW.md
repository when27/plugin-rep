# usage-popup — True-sync Token/Cost Ledger

A two-half DeepSeek Harness plugin that keeps a true-sync token and cost ledger. The host half hooks the global `llm/stream` and `session/event` feeds, wraps `fetch`, persists JSONL records under `$DSH_HOME/usage-popup/`, and serves `/usage-popup/api/*`; the web client registers one global sidebar launcher (`sidebar.footer.action`) and one root panel (`shell.overlay`), merges host records with a localStorage ledger, and shows per-chat usage, costs, balance/runway, routed-worker rows, and dashboard imports.

## File Dictionary

| File | Purpose |
| --- | --- |
| [`src/index.tsx`](./src/index.tsx) | The web client (6,102 lines at 0.3.0). Exports `name = 'usage-popup'`, `inject = ['slots', 'sessions']`, and `apply(ctx)`; wires the sidebar cell (order 2) plus the `shell.overlay` panel and a null `save-token-strip` composer cell. Contains the ledger open controller, pricing/RMB rate cards, universal ledger merge/migration, host-record reconciliation, CSV/TSV/JSON dashboard import, active-chat projection attribution, `ChatSelect`, and the `LedgerHud` panel with its `usage`/`saver` faces and Windows-titlebar drag guards. |
| [`src/host.ts`](./src/host.ts) | Host bundle entry (`name = 'usage-popup'`, `apply(ctx)`). Creates the `UsageStore` and `Collector`, installs the fetch transport, subscribes to `session/event` and `llm/stream` with `{ global: true }`, registers the `/usage-popup` routes, and returns a disposer. Failures are logged and disable the host half instead of failing host load. |
| [`src/host/collector.ts`](./src/host/collector.ts) | Collector: server-tool names and `$0.00075`/request fee, 5-second process-wide fee dedupe (`claimToolFee`), `canonicalServerTool`, `serverToolFee`, session metadata from the live Session header, `normalizeUsage`, `Collector`, and `wrapLlmStream` (last-usage-chunk-wins capture). |
| [`src/host/route.ts`](./src/host/route.ts) | The Web server handler: `ROUTE_PREFIX`, `USAGE_PATH`, `HEALTH_PATH`, `MAX_LIMIT = 500`, `RouteState`, `createRouteHandler`. `GET /api/usage?since=<seq>` returns `{format, version, cursor, records[]}` (plus `reset: true` after store rotation); `GET /api/health` returns collector/transport counters. |
| [`src/host/store.ts`](./src/host/store.ts) | Append-only JSONL store: record schema (`UsageRecord`, `NormalizedUsage`, `ServerToolUsage`), `FORMAT = 'usage-popup.host-usage'`, `FORMAT_VERSION = 1`, `MAX_RECORDS = 20_000`, `ROTATE_BYTES = 32 MiB`, `$DSH_HOME/usage-popup/usage-records.jsonl` path resolution, and `UsageStore` (load/append/seq/rotation). |
| [`src/host/transport.ts`](./src/host/transport.ts) | Global `fetch` wrapper: adds `stream_options.include_usage` to `/chat/completions`, parses wire usage and server-tool metadata, bounds parsing to 5 MiB, and exposes restorable transport stats. Some SDKs capture `fetch` before install, so this feed is best-effort. |
| [`scripts/build.mjs`](./scripts/build.mjs) | Transpile-only build via the TypeScript compiler API. Emits the CommonJS client bundle in DSH's `window.__ModuleLoader__` format (`dist/client.js`), the ESM host entry (`dist/index.js`), and ESM host modules (`dist/host/*.js`). Resolves `typescript` from the plugin or the workspace fallback and fails loudly if missing. |
| [`dist/index.js`](./dist/index.js) | Generated ESM host entry (build output; committed for packaging). |
| [`dist/client.js`](./dist/client.js) | Generated web client bundle in the DSH client-module loader format (build output; committed for packaging). |
| [`dist/host/`](./dist/host/) | Generated ESM host modules: [`collector.js`](./dist/host/collector.js), [`route.js`](./dist/host/route.js), [`store.js`](./dist/host/store.js), [`transport.js`](./dist/host/transport.js). |
| [`package.json`](./package.json) | Package manifest `usage-popup@0.3.0`: `main`/`exports`, `files`, `dsh.bundle` (`cordis.patch.yml`, `listedByDefault`) and `dsh.client` (`platform: web`, `immediately`, slot injects), `engines.dsh ^0.2.2-rc.1`, peer deps (Cordis, React 18), and the `build` script. |
| [`cordis.patch.yml`](./cordis.patch.yml) | Bundle patch installed by the profile: inserts the `usage-popup` row whose name is the package name, so the client-module scan finds `dsh.client` on the installed manifest. |
| [`cordis.yml`](./cordis.yml) | Optional local-development patch mounting `src/index.tsx` directly through an **absolute** source path (`pnpm dsh web --patch ./plugins/usage-popup/cordis.yml`). Requires a source checkout; packaged Desktop has no checkout. |
| [`PLUGIN_NOTES.md`](./PLUGIN_NOTES.md) | Author notes: the current sidebar-only/root-overlay architecture, confirmed Cordis/slot contracts, the host collector/API details, historical composer-dock notes (do not reintroduce a chat-footer trigger), pitfalls (Windows caption band, replacing the built-in usage control), and the definition of done. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Deep-dive maintenance map: mental model, exact file/line maps for the client and host halves, Cordis injection and slot contracts, state/lifecycle, active-chat reactivity and attribution, ledger schema/routes, build and release checklist, failure modes, and invariants. |
| [`test/logic.test.mjs`](./test/logic.test.mjs) | 75 checks: pure client logic — pricing, ledger merge/migration, reconciliation, dashboard import parsing, projection mode/cursor reset. Transpiles the real TSX in memory; no build output or network. |
| [`test/host.test.mjs`](./test/host.test.mjs) | 95 checks: store, collector, tool fees, session metadata, route. Transpiles host sources into `test/.build/` (scratch, rewritten per run); `dist/` is untouched. |
| [`test/transport.test.mjs`](./test/transport.test.mjs) | 58 checks: fetch wrapper, `include_usage` injection, wire parsing, stats/restore. |
| [`test/integration.test.mjs`](./test/integration.test.mjs) | 55 checks: host `apply()` against a fake ctx, event subscriptions, route registration, record → ledger flow, reconciliation. |
| [`test/client.test.mjs`](./test/client.test.mjs) | 23 checks: slot wiring (exactly one sidebar cell, one overlay, only the null save-token composer cell) and `buildChatOptions` selection/aggregation. |
| [`test/.build/`](./test/.build/) | Generated scratch host modules used by the host tests: [`host.js`](./test/.build/host.js) and [`host/`](./test/.build/host/) (`collector.js`, `route.js`, `store.js`, `transport.js`). Rewritten on every host test run. |
| [`usage-popup-0.2.0.tgz`](./usage-popup-0.2.0.tgz) | Previous packed release, kept for rollback. |
| [`usage-popup-0.3.0.tgz`](./usage-popup-0.3.0.tgz) | Current packed release. `profiles/desktop/package.json` installs this file via `file:`. |
| [`OVERVIEW.md`](./OVERVIEW.md) | This feature dictionary. |

## How It Works & Wiring

- **Entrypoints & Mounting:** the profile bundle installs `usage-popup` and its `dsh.bundle.patch` inserts the `usage-popup` row. `dsh.client` loads `dist/client.js` into the Web UI with the declared slot injects. The host row loads `dist/index.js` and serves `/usage-popup/api/usage` and `/usage-popup/api/health`.
- **Slots:** the client contributes exactly one `sidebar.footer.action` (id `usage-popup`, order 2, above the account bar) and one `shell.overlay` (id `usage-popup-ledger`). It deliberately contributes **no visible control** to `conversation.composer.dock`; a null `save-token-strip` cell remains so the composer layout is unchanged.
- **Host pipeline:** `llm/stream` and `session/event` (global) feed the collector, the fetch wrapper adds `include_usage`, and `UsageStore` appends JSONL records. The client polls the usage route every 10 s with a sequence cursor, merges records into the localStorage ledger, and reconciles the gap against true account balance (`/user/balance`, every 5 min) as an "unattributed" row. When the host is inactive, the client falls back to session projection deltas.
- **Attribution:** the panel follows the app's active chat (a `mainView` retention) and can lock onto a historical chat; subagent/compaction spend is tagged from the Session header and shown separately. The panel is always mounted but closed by default; open state is shared through `usage-popup.ledger.open.v1`.
- **Related Docs & References:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) is the line-level map and release checklist; [`PLUGIN_NOTES.md`](./PLUGIN_NOTES.md) has the confirmed contracts and pitfalls. [`../../profiles/desktop/OVERVIEW.md`](../../profiles/desktop/OVERVIEW.md) shows the `file:` install, and [`../../packages/dsh-tier-router/OVERVIEW.md`](../../packages/dsh-tier-router/OVERVIEW.md) documents the `/tier-router/api/usage` counters the client consumes.

## Build, Verification & Caveats

- **Build:**

  ```bash
  cd plugins/usage-popup
  npm run build        # node scripts/build.mjs -> dist/index.js, dist/client.js, dist/host/*.js
  ```

- **Run the tests** (no `npm install` needed if TypeScript is available in the workspace — they transpile sources in memory and only write `test/.build/`):

  ```bash
  node test/logic.test.mjs        # 75 checks
  node test/host.test.mjs         # 95 checks
  node test/transport.test.mjs    # 58 checks
  node test/integration.test.mjs  # 55 checks
  node test/client.test.mjs       # 23 checks
  ```

- **Pack a release and install it:**

  ```bash
  npm pack                       # -> usage-popup-<version>.tgz
  # bump package.json version first, then point BOTH the repo and live
  # profiles/desktop/package.json at the new tarball and run pnpm install
  ```

- **Full DSH restart is required** after installing a new build: the host half is loaded at boot, so a page refresh does not load the new collector/routes.
- **Do not reintroduce a composer-dock control.** The only entry point is the global sidebar; the chat footer keeps only the DSH-native token tracker and the null `save-token-strip` cell. Reusing the built-in `usage` id would replace the native control.
- **Windows caption band:** the desktop frame paints a 40px `-webkit-app-region: drag` strip; a panel placed inside it receives no pointer events. `hudTopInset()` clamps the top and `-webkit-app-region: no-drag` keeps the card interactive — keep both.
- **Absolute dev path:** [`cordis.yml`](./cordis.yml) contains a source-machine absolute path; update it or ignore it (it is only for `--patch` dev runs, not for the bundled profile install).
- **TypeScript resolution:** `scripts/build.mjs` looks in `plugins/usage-popup/node_modules/typescript` then a workspace fallback; the logic/client tests prefer the same local install and fall back to the workspace's installed copy. Run `npm install` in this folder for a fully self-contained setup.
- **Committed build output:** `dist/**`, `test/.build/**`, and the `.tgz` files are tracked so the profile can install without a build step; regenerate them with `npm run build`/`npm pack` after source changes.
