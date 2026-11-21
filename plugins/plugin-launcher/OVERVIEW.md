# Plugin Launcher (`plugin-launcher`)

`plugin-launcher` is the single global-sidebar entry point for every installed plugin tool. One short **Plugin Tools** button opens a centered `shell.overlay` modal that lists each registered tool with its icon, name, description and optional status badge, and choosing a row closes the menu before launching that plugin's own surface. Other plugins register into a small versioned `window` registry, so registration works no matter which client bundle loads first.

## File Dictionary

| File | Purpose |
| --- | --- |
| [`src/index.tsx`](./src/index.tsx) | The whole web client. Exports `name = 'plugin-launcher'`, `inject = ['slots']`, and `apply(ctx)`. Wires the one `sidebar.footer.action` button (id `plugin-launcher`, order 0) and the `shell.overlay` dialog (id `plugin-launcher-modal`, order 120). Contains the tool registry (`__DSH_PLUGIN_LAUNCHER_V1__`), the open-state controller (`plugin-launcher.open.v1`), the native `<dialog>` modal with backdrop/Escape/× dismissal, the tool rows and empty state, and the scoped CSS. |
| [`src/host.js`](./src/host.js) | Inert Host half: exports `name`/`apply()` and nothing else, because the bundle row still resolves the package `main` while all behavior lives in `dsh.client`. |
| [`scripts/build.mjs`](./scripts/build.mjs) | Transpile-only build. Emits `dist/client.js` in the DSH `window.__ModuleLoader__` factory format and copies `src/host.js` to `dist/index.js`. Resolves `typescript` from the plugin, the sibling `obsidian-task-sync` install, or the workspace fallback, and fails loudly when missing. |
| [`package.json`](./package.json) | Package manifest `plugin-launcher@0.1.0`: `main`/`exports` (`./client`, `./cordis.patch.yml`), `files`, `dsh.bundle` (`cordis.patch.yml`, `listedByDefault`) and `dsh.client` (`platform: web`, `immediately`, sidebar + renderer injects), `engines.dsh ^0.2.2-rc.1`, peer deps (Cordis, React 18), and `build`/`test`/`pack`/`prepack` scripts. |
| [`cordis.patch.yml`](./cordis.patch.yml) | Bundle patch installed by the profile: inserts the `plugin-launcher` row so the client-module scan finds `dsh.client` on the manifest. |
| [`tests/registry.test.mjs`](./tests/registry.test.mjs) | 25 checks: registration/replacement/disposal, order-independent `ensure` adoption (launcher-first and registrant-first), selection callbacks, open-state persistence, and input validation. Transpiles the real TSX in memory. |
| [`tests/client.test.mjs`](./tests/client.test.mjs) | Smoke-loads the built bundle with the DSH lazy-CJS contract: exactly two slot occupants, the short sidebar label, the overlay id/order, post-load registration, and native-dialog bundle markers. |
| [`tests/modal.test.mjs`](./tests/modal.test.mjs) | 26 checks with real React: row markup (icon/name/description/badge), empty state, open/close controller behavior, close-then-launch selection, throwing tools, and the wide/rail sidebar button. |
| [`dist/index.js`](./dist/index.js) | Generated Host entry (build output). |
| [`dist/client.js`](./dist/client.js) | Generated web client bundle (build output). |
| [`plugin-launcher-0.1.0.tgz`](./plugin-launcher-0.1.0.tgz) | Packed release. `profiles/desktop/package.json` installs this file via `file:`. |
| [`OVERVIEW.md`](./OVERVIEW.md) | This feature dictionary. |

## How It Works & Wiring

- **Entrypoints:** the profile bundle installs `plugin-launcher`; `dsh.bundle.patch` inserts the `plugin-launcher` row and `dsh.client` loads `dist/client.js` immediately with the sidebar and renderer slots available. The Host row is inert.
- **Single sidebar button:** `apply(ctx)` registers one `sidebar.footer.action` cell (id `plugin-launcher`, order 0, label `Plugin Tools`) using the same 32px geometry and host alias tokens as the former per-plugin buttons. It shows an icon-only square in the collapsed rail and the short label in the wide sidebar.
- **Registration contract (v1):** a sibling client plugin ensures the global registry on `window.__DSH_PLUGIN_LAUNCHER_V1__` and calls `register({ id, label, description?, icon?, badge?, order?, onOpen })`. `register` returns an unregister disposer, and re-registering an id replaces the row. The registry exposes `register`, `getSnapshot`, `subscribe`, `get` and `select`; `version` is `1`. Both sides check the version and adopt an existing registry, so the launcher may load before or after its registrants. Keep the helper in [`../usage-popup/src/index.tsx`](../usage-popup/src/index.tsx) and [`../obsidian-task-sync/src/client.tsx`](../obsidian-task-sync/src/client.tsx) byte-compatible with this contract.
- **Modal mechanics:** opening renders a native `<dialog>` into `document.body` and calls `showModal()`, so the browser supplies the top layer, page inertness, focus containment and the `cancel` (Escape/platform close) event. No `role="dialog"`, `aria-modal` or manual focus trap is added. The backdrop is styled with `::backdrop`; a light-dismiss click is detected on the dialog element while a pointer-down guard prevents a drag that started inside from closing it. The header × and the `cancel` event route through the same controller (`plugin-launcher.open.v1`), which the sidebar button also subscribes to.
- **Selection:** clicking a row calls the registry's `select(id)` (which invokes the tool's `onOpen`) and then closes the modal. A throwing tool is logged and does not break the other rows. An empty registry renders the "No plugin tools registered yet" state with an explanation instead of a blank box.
- **Related Docs & References:** [`../../profiles/desktop/OVERVIEW.md`](../../profiles/desktop/OVERVIEW.md) documents the bundle install; [`../usage-popup/OVERVIEW.md`](../usage-popup/OVERVIEW.md) and [`../obsidian-task-sync/OVERVIEW.md`](../obsidian-task-sync/OVERVIEW.md) document the two migrated tools.

## Build, Verification & Caveats

- **Build and pack:**

  ```bash
  cd plugins/plugin-launcher
  npm install            # react/react-dom + typescript for the tests/build
  npm run build          # -> dist/index.js, dist/client.js
  npm pack               # -> plugin-launcher-0.1.0.tgz (prepack rebuilds first)
  ```

- **Run the tests** (the first suite transpiles source; the other two read `dist/client.js`):

  ```bash
  node tests/registry.test.mjs   # 25 checks
  node tests/client.test.mjs     # bundle/slot smoke
  node tests/modal.test.mjs      # 26 checks
  ```

- **Install/restore:** point `profiles/desktop/package.json` at the packed tarball, keep `plugin-launcher` in `dsh.profile.bundles`, then run `pnpm install` in the profile. **A full DSH restart is required** (quit from the tray, not a page refresh) because bundles and client modules are composed at startup.
- **Slot name caveat:** the DSH slot is `sidebar.footer.action` (declared by the `sidebar` UI package), not a literal `global-sidebar` id; the button still occupies the global sidebar foot beside Settings.
- **Ordering:** tool rows sort by `order`, then `label`. `usage-popup` uses order 20 (`LIVE`) and `obsidian-task-sync` uses order 10 (`VAULT`); new tools should pick an unused order and a namespaced id such as `plugin-name.tool`.
- **Registry key stability:** `window.__DSH_PLUGIN_LAUNCHER_V1__` is the cross-bundle ABI. Bump the `version`/key only with a coordinated update to every registering plugin; otherwise early registrations are silently dropped.
- **Committed build output:** `dist/**` and `plugin-launcher-0.1.0.tgz` are tracked so the profile can install without a build step; regenerate them with `npm run build`/`npm pack` after source changes.
- **Native `<dialog>` fallback:** `showModal()` is used when available; the build also falls back to the `open` attribute for renderers without it, and Escape/backdrop handling stays in JS.
