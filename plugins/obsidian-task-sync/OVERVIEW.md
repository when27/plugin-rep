# obsidian-task-sync — Vault Bridge, Daily Checklist & Skill Tree

A DeepSeek Harness plugin that bridges an Obsidian vault folder into the Web UI. The host half (`src/host.js`) runs a same-origin, token-authenticated filesystem API with an SSE watcher over checklist and skill-tree Markdown files; the web client (`src/client.tsx`) adds a sidebar launcher and a draggable, non-modal floating widget with a daily checklist, focus timer, rollover, and a game-style skill-tree canvas.

## File Dictionary

| File | Purpose |
| --- | --- |
| [`src/host.js`](./src/host.js) | Host half (1,514 lines). Exports `name = 'obsidian-task-sync'`, `inject = ['webServer']`, `apply(ctx)`, and parser/write helpers. Provides the `/obsidian-task-sync` routes (list/read/create/write/rollover/tree/toggle), the per-process session token and boot payload, same-origin checks, the debounced `fs.watch` + SSE stream, strict filename validation, exact-line Markdown parsing/writing (CRLF-preserving), revision-checked writes, atomic temp+rename, and size limits. |
| [`src/client.tsx`](./src/client.tsx) | Web client (5,568 lines). Exports `name`, `inject = ['slots', 'locale']`, and `apply(ctx)`. Registers the `sidebar.footer.action` launcher and the `shell.overlay` widget; contains the bridge client (token header, bootstrap retry), vault/position/minimized/focus localStorage state, locale context, checklist view (progress ring, tags, composer, drag reorder), skill-tree canvas (lanes, SVG links, ranks/points), focus timer parsing, and the Windows titlebar drag clamp. |
| [`scripts/build.mjs`](./scripts/build.mjs) | Build script: transpiles `src/client.tsx` with `typescript` into the DSH `window.__ModuleLoader__` client bundle (`dist/client.js`) and copies `src/host.js` to `dist/index.js`. Uses `transpileModule` only (no Harness client packages beyond React/ReactDOM). |
| [`package.json`](./package.json) | Package manifest `obsidian-task-sync@0.1.0`: `main`/`exports` (including `./client`, `./cordis.patch.yml`, `./locale/*.json`, `./icon`), `files`, `dsh.bundle`/`dsh.client` (web, immediate, sidebar + renderer injects), `scripts` (`build`, `test`, `test:backend`, `test:bridge`, `test:client`, `pack`, `prepack`), `engines` (DSH `^0.2.2-rc.1`, Node ≥ 20), and peer/dev deps. |
| [`package-lock.json`](./package-lock.json) | npm lockfile from the source build. |
| [`cordis.patch.yml`](./cordis.patch.yml) | Bundle patch installed by the profile: inserts the `obsidian-task-sync` row (host bridge + SSE watcher). |
| [`locale/en.json`](./locale/en.json) | English bundle metadata strings (title/description) used by the Web UI locale registry. |
| [`locale/zh.json`](./locale/zh.json) | Chinese bundle metadata strings. |
| [`icon.svg`](./icon.svg) | Bundle icon (64×64 SVG) shown by the plugin manager/sidebar. |
| [`README.md`](./README.md) | Plugin documentation: features, the in-app-widget rationale, install/pack, first-run vault setup, daily workflow, Markdown task/skill-tree formats, security model, and development notes. |
| [`tests/backend.test.mjs`](./tests/backend.test.mjs) | 22 Node tests for the host parser and exact-line writers: task parsing/nesting, fenced-code handling, checkbox toggle/uncheck, stale-line refusal, append/rollover/dedupe, CRLF preservation, reorder/delete, filename validation, checklist listing/read, bundled tree parsing, points, and tree toggles. |
| [`tests/bridge.test.mjs`](./tests/bridge.test.mjs) | Real-HTTP integration test for the bridge: server setup, token/origin enforcement, read/write/toggle/rollover, stale-revision 409, append-to-existing-tomorrow, and cleanup. |
| [`tests/client-smoke.mjs`](./tests/client-smoke.mjs) | Server-renders the skill-tree canvas and focus timer from the real bundled tree, and exercises the focus-duration parser, tag pill renderer, and built client bundle markers — no browser required. |
| [`obsidian-task-sync-0.1.0.tgz`](./obsidian-task-sync-0.1.0.tgz) | Packed release (`npm pack` output). `profiles/desktop/package.json` installs this file via `file:`. |
| [`OVERVIEW.md`](./OVERVIEW.md) | This feature dictionary. |

## How It Works & Wiring

- **Entrypoints & Mounting:** the profile bundle installs `obsidian-task-sync`; its `dsh.bundle.patch` inserts the `obsidian-task-sync` host row, and `dsh.client` loads `dist/client.js` into the Web UI. The host mounts on the Harness Web server and owns the `/obsidian-task-sync/*` API plus the SSE stream.
- **Token/authentication:** a per-process random token is exposed through the `webserver/index-inject` boot row (`__OBSIDIAN_TASK_SYNC__`); every JSON call and SSE stream requires it. A page that loaded before install can fetch the same token from `GET /obsidian-task-sync/bootstrap`, which the Harness Connection service admits against the signed browser session. Cross-origin `Origin` and `Sec-Fetch-Site: cross-site` requests are refused, and the raw HTTP handler is used because Web `resource` routes only accept GET/HEAD (POST needs this handler).
- **File conventions:** checklists are `YYYY-MM-DD-Checklist-<Title>.md`; skill trees are `SkillTrees-<Name>.md`. APIs accept only a vault root plus a basename matching those patterns, rejecting traversal. Writes are atomic (temp file + rename) and bounded (2 MiB file, 1 MiB body, 2,000 tree nodes).
- **Exact-line updates:** toggling a task/node rewrites only its `[ ]`/`[x]` marker, preserving frontmatter, headings, nesting, CRLF, trailing notes, and unrelated formatting. Reordering/deleting touches only task lines. Every mutation carries the document revision; a stale click gets a 409 with the fresh document.
- **Live sync:** a debounced `fs.watch` pushes external edits over SSE; a 6-second poll is the fallback when SSE is unavailable. The widget waits for the bridge token (loading state, 12 s cap, backoff retries) before any read.
- **Widget:** one `sidebar.footer.action` launcher toggles the `shell.overlay` panel. The card is draggable only by its title bar, clamped below the Windows 40px caption band, remembers position/minimized state, and widens to 940px for the tree canvas. The left rail switches checklist/tree without unmounting.
- **Related Docs & References:** [`README.md`](./README.md) is the full user/install/format documentation; [`../../AGENTS.md`](../../AGENTS.md) links the restore procedure. The `cordis.patch.yml` here is the bundle wiring; the client/README sections explain the security model and why the widget is in-app rather than a pop-out window.

## Build, Verification & Caveats

- **Build and test** from this directory:

  ```bash
  npm install
  npm test              # build + backend + bridge + client-smoke
  npm run build         # dist/index.js + dist/client.js
  npm pack              # -> obsidian-task-sync-0.1.0.tgz
  ```

  Individual suites: `node tests/backend.test.mjs` (22 tests), `node tests/bridge.test.mjs` (real HTTP integration), `node tests/client-smoke.mjs` (server-render smoke). `npm test` runs the build first because the client-smoke test reads the generated bundle.
- **Install/restore:** install the packed `.tgz` as a profile bundle (Plugin Manager) or point `profiles/desktop/package.json` at it, then run `pnpm install` in the profile. Requires DSH `^0.2.2-rc.1`, React 18, Node 20+.
- **Vault folder must already exist** — the plugin never creates the Obsidian vault itself. First run asks for the absolute checklist folder and validates it on the host.
- **Restart requirement:** host code loads at boot, so changes to `src/host.js`/routes need a full DSH restart. Client-only changes still need the rebuilt bundle installed (a page refresh alone picks up a rebuilt bundle only when the profile's installed copy changes).
- **Windows caption band:** the registry/drag behavior uses a 40px fallback inset and `-webkit-app-region: no-drag`; keep both or the widget can become inert behind the caption strip.
- **`fs.watch` availability:** on filesystems without watch support the UI labels itself "Polling" and falls back to the 6-second poll; do not remove the fallback.
- **No pop-out window:** the desktop renderer denies renderer-initiated windows (`setWindowOpenHandler` returns `deny`), and the plugin manifest has no window permission. The widget intentionally renders in the existing page via `shell.overlay`; do not add `window.open`.
- **Build output is not committed:** `dist/**` is generated by `npm run build` (unlike `usage-popup`'s tracked `dist/`), and `prepack` builds automatically before `npm pack`.
