# dsh-tier-router (patched 0.6.0 build)

The locally patched `dsh-tier-router@0.6.0` package: a prepacked npm tarball plus the two source patches that produced it. The desktop profile installs the tarball with a `file:` dependency, so it overrides the registry build. The patches add per-tier fallback arrays (`easyFallbacks`/`hardFallbacks`) and a virtual `worker` model with local per-model/per-session token counters served from `/tier-router/api/usage`.

## File Dictionary

| File | Purpose |
| --- | --- |
| [`dsh-tier-router-0.6.0.tgz`](./dsh-tier-router-0.6.0.tgz) | The patched package build (121,540 bytes). Packed from a router source checkout with both patches applied; also contains the package's `cordis.patch.yml`, client bundle, `lib/`, types, and `.orig-*` backup copies from the patch run. The profile installs this exact file via `file:`. |
| [`dsh-tier-router-0.6.0-tier-fallbacks.patch`](./dsh-tier-router-0.6.0-tier-fallbacks.patch) | Fallback-routing patch. Adds `easyFallbacks`/`hardFallbacks` arrays to the settings schema and types, extends chain resolution in `lib/router.js` so a tier walks its own fallbacks before the next-nearest tier, and updates the example `cordis.patch.yml` with the google → google-vertex → zai → zai-2 easy chain. |
| [`dsh-tier-router-0.6.0-worker-usage.patch`](./dsh-tier-router-0.6.0-worker-usage.patch) | Worker/usage patch. Adds the virtual `WORKER = 'worker'` model (skips classification and always uses the easy chain), the fallback-array defaults and schema fields, local provider-independent token accounting in `lib/router.js` (totals, per-model, per-session, per-worker), and a `GET /tier-router/api/usage` route in `lib/models-api.js`. |
| [`README.md`](./README.md) | Original patch write-up: what each patch adds, the staged apply procedure, the pnpm-store hardlink warning, restart requirement, upgrade caveat, risk analysis, verification performed, and SHA-256 hashes. It predates the folder move, so treat the path examples in it as historical and prefer this `OVERVIEW.md` for the current layout. |
| [`OVERVIEW.md`](./OVERVIEW.md) | This feature dictionary. |

## How It Works & Wiring

- **Entrypoints & Mounting:** `profiles/desktop/package.json` depends on `"dsh-tier-router": "file:.../packages/dsh-tier-router/dsh-tier-router-0.6.0.tgz"` and lists `dsh-tier-router` in `dsh.profile.bundles`. The package contributes its own `cordis.patch.yml` (a `tier-router` row) and registers the virtual provider `tier-router` with the `smart` (classifier-driven) and `worker` (always-easy) models. `profiles/desktop/compatibility.json` pins `dsh-tier-router@0.6.0` to DSH `0.2.2-rc.1`.
- **Key Mechanics:**
  - **Classification:** `smart` classifies each request as hard/normal/easy (and detects vision need), then routes to the configured provider for that tier.
  - **Fallback chains:** `easyFallbacks` and `hardFallbacks` are optional `[{ provider, model }]` arrays. Chain order is the requested tier → its fallbacks → the next-nearest tier → its fallbacks → … → the default model, de-duplicated by the existing `pushIfRoutable` logic.
  - **Worker model:** `tier-router/worker` bypasses classification and always uses the easy chain (`easyProvider` → `easyFallbacks`); delegated subagents select it when they must stay on the cheap Google/Z.ai keys.
  - **Usage counters:** `lib/router.js` records billed usage per model, per session, and for plain-UUID worker sessions. `GET /tier-router/api/usage` returns only these local counters (no provider balance/billing API), which the `usage-popup` client reads for its routed-model rows.
  - **Health/fallback:** quota/auth errors and repeated failures bench a route for `routeCooldownMs`; when all routes are benched the guard fails open and attempts the unguarded chain. Exhausting every route emits a single `ROUTE_FAILED` error chunk listing the tried routes.
- **Related Docs & References:** [`README.md`](./README.md) is the deep patch record (apply steps, hashes, risks, pnpm-store warning). [`../../profiles/desktop/OVERVIEW.md`](../../profiles/desktop/OVERVIEW.md) shows the `file:` install and compatibility pin. [`../../plugins/usage-popup/OVERVIEW.md`](../../plugins/usage-popup/OVERVIEW.md) consumes `/tier-router/api/usage` for its routed/worker rows.

## Build, Verification & Caveats

- **Inspect the packed tarball** (no install required):

  ```bash
  tar tzf packages/dsh-tier-router/dsh-tier-router-0.6.0.tgz
  tar xOzf packages/dsh-tier-router/dsh-tier-router-0.6.0.tgz package/package.json
  ```

- **Re-apply / rebuild** from a router source checkout (the tarball is already built and committed):

  ```bash
  # In a dsh-tier-router 0.6.0 source checkout:
  git apply /path/to/packages/dsh-tier-router/dsh-tier-router-0.6.0-tier-fallbacks.patch
  git apply /path/to/packages/dsh-tier-router/dsh-tier-router-0.6.0-worker-usage.patch
  npm pack   # produces dsh-tier-router-0.6.0.tgz
  ```

  The fallback patch is written against a profile root (`a/cordis.patch.yml`, `a/node_modules/dsh-tier-router/...`), so from a profile root use `patch -p1`; the worker patch is written against the package root (`a/lib/...`).
- **Verify a repacked build** after any change: `node --check` every changed `lib/*.js`, parse the settings schema with old single-route, new array, and malformed configs, and confirm the easy chain order.
- **pnpm-store hardlink warning (critical):** `dsh-tier-router` is installed into the hoisted pnpm store, where `patch` writes through hardlinks and can corrupt the shared store. The original apply procedure therefore copied the package to a physical directory first (`apply.sh`) and only then patched. Do not run the raw patch against the hoisted install.
- **Upgrades revert the patch:** any `npm`/`pnpm` install or upgrade of `dsh-tier-router` replaces the package with fresh store-hardlinked files. Re-apply/rebuild after a reinstall; re-check the hunks if the version changes. The `cordis.patch.yml` `easyFallbacks` key survives an upgrade but stock 0.6.0 ignores it, silently returning to single-route behavior.
- **Restart requirement:** host plugin code and the settings section are loaded at boot. The patched `lib/*.js` and the YAML change do not take effect until a full DSH backend restart.
- **Source-machine paths:** the profile's `file:` path is absolute (`C:/Users/Administrator/...`); update it on a new machine. The in-repo `README.md` still contains older `node_modules/...` and `.dsh-work/...` examples from before this consolidation.
