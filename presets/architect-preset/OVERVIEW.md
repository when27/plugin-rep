# Architect Preset

A cache-optimized, role-split DeepSeek Harness agent preset. It defines the `architect` preset row (the main agent gets no file/shell/inspection tools and delegates everything) and ships the `architect-tool-restrict` Cordis plugin that enforces the role split, injects a static per-role contract, pins role-based `reasoningEffort`, and head+tail truncates oversized tool results before they enter history.

## File Dictionary

| File | Purpose |
| --- | --- |
| [`index.js`](./index.js) | The `architect-tool-restrict` Cordis plugin. Exports `name`, `inject = ['tools']`, `apply(ctx, config)`, and `internal` (for tests). Contains the main-agent `DENY` / worker `WORKER_DENY` lists, the static `ARCHITECT_CONTRACT` / `WORKER_CONTRACT` sections (order 2690), the role→effort map (`high` main, `low` workers), the 64 KiB `tools/post-execute` head+tail truncation (24 KiB + 24 KiB), the global tool guard, and the pending-delegation queue cap of 16. `ROSTER_DUMP`/`DIAG_DUMP` are diagnostic-only absolute paths. |
| [`cordis.patch.yml`](./cordis.patch.yml) | Defines the preset itself: inserts the `preset-architect` row (`@deepseek-ai/dsh-agent-preset`, config `id: architect`, `name: Architect`, `order: 20`) and its plugin rows: `dsh-tool-bash` (disabled on win32), `dsh-tool-pwsh` (disabled elsewhere), `dsh-tool-fs` (`applyPatch: false`), `dsh-tool-fs-search`, `dsh-tool-jobs`, `dsh-tool-subagent-control`, two `dsh-tool-subagent` rows (`provider: spawn` → `subagent`, `provider: fork` → `subagent_fork`), and `dsh-tool-todo` (`allowParallelInProgress: true`). File/shell tools are mounted here so delegated children inherit a working tool surface. |
| [`package.json`](./package.json) | Package `@local/dsh-architect-preset` (private, ESM, `main`/`exports` → `./index.js`) with `dsh.bundle.patch: ./cordis.patch.yml`, which is how the profile bundle activates the preset. |
| [`smoke.test.mjs`](./smoke.test.mjs) | Dependency-free Node smoke suite for the restriction and reasoning-effort hooks. It asserts the deny lists, static contracts, global guard, per-agent restriction, effort selection, truncation behavior, lineage detection, and the absence of any call-count ceiling. Run with `node presets/architect-preset/smoke.test.mjs`. |
| [`OVERVIEW.md`](./OVERVIEW.md) | This feature dictionary. |

## How It Works & Wiring

- **Entrypoints & Mounting:** the package is linked into the desktop profile (`@local/dsh-architect-preset` → `presets/architect-preset`) and listed in `dsh.profile.bundles`. Its `dsh.bundle.patch` inserts the `preset-architect` row. The profile's `cordis.patch.yml` separately inserts the `architect-tool-restrict` row (`name: "@local/dsh-architect-preset"`) because a preset realm resolves rows against the install base and cannot mount an `@local/*` package.
- **Key Mechanics:**
  - **Main agent (Architect):** file, shell, inspection, workflow, and repo-index tools are denied; delegation with plain untagged `subagent`/`subagent_fork` calls is its only action.
  - **Workers (depth > 0 / `parentSession`):** keep file/shell tools but are denied delegation and management tools. There is no tool-call ceiling; workers may make unlimited sequential cached calls.
  - **Static contracts:** one fixed, byte-stable `ARCHITECT_CONTRACT` or `WORKER_CONTRACT` section is injected per role at order 2690, with no per-run interpolation, so DeepSeek prefix caching stays effective.
  - **Reasoning effort by role:** the plugin calls `agent.model.select({ provider, model, reasoningEffort })` from the awaited `agent/created` listener (and on preset switch) before the first step fixes the request. Main is forced to `high` (`max` is downgraded), lineage workers to `low`, other presets are untouched. The route's advertised efforts are checked first (`llm.resolveModelInfo`), so unsupported levels are skipped instead of failing.
  - **Result truncation:** an agent-scoped `tools/post-execute` waterfall listener reduces text results larger than 65,536 bytes to a 24,576-byte head + 24,576-byte tail plus a marker, before the batch settlement appends the result to history. Prior turns and structured content are untouched.
  - **Delegation queue:** pending delegations are capped at 16 with a 5-minute TTL; there is no per-worker call-count cap.
- **Related Docs & References:** [`../../profiles/desktop/OVERVIEW.md`](../../profiles/desktop/OVERVIEW.md) documents the profile patch and bundle wiring; [`../../AGENTS.md`](../../AGENTS.md) keeps the repo-wide Architect/Worker operating rules and the restore/restart steps. The preset's mount/config details are in [`cordis.patch.yml`](./cordis.patch.yml), and the implementation is [`index.js`](./index.js).

## Build, Verification & Caveats

- **Run the smoke suite** (no dependencies, Node built-ins only):

  ```bash
  node presets/architect-preset/smoke.test.mjs
  ```

  Expected: exit 0 with the full 52-check pass summary and 0 failures.
- **Full restart + new session are required.** Preset composition and registry config are read at startup, and a session's preset is recorded at creation. Quit DSH from the tray (a page refresh is not enough) and start a new session; existing sessions keep their old preset.
- **Preset rows are schema-validated.** `dsh-tool-subagent` requires `provider` (`spawn`|`fork`) and `dsh-tool-todo` requires `allowParallelInProgress` (boolean). A missing required value makes the whole preset show "Failed to load". Only install-resolvable `@deepseek-ai/*` specifiers belong in the preset's `plugins` list.
- **Keep the preset and profile copies separate.** The restriction row lives in the profile patch; moving it into the preset makes the preset fail to load because `@local/*` does not resolve in a preset realm.
- **Diagnostic dumps:** `ROSTER_DUMP`/`DIAG_DUMP` in `index.js` point at `presets/architect-preset/.roster.json` and `.diag.json` on the source machine. They are diagnostics only; adjust or ignore them. The files are generated at boot and are not part of the restore set.
- **Model-effort interaction:** `agent-default-model` in the profile is deliberately `reasoningEffort: low`; the preset raises the main agent to `high` and forces workers to `low`. Do not also install a plugin that force-overrides the model on `agent/request` — DSH throws if that waterfall changes `reasoningEffort`.
