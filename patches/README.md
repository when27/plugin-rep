# dsh-tier-router 0.6.0 — per-tier fallback arrays

Patch date: 2026-11-11
Package: `dsh-tier-router@0.6.0` (profile-installed, latest npm at patch time)
Package directory (resolved via `Config.listConfigs`): `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-tier-router`

## Status

**Verified, staged, NOT yet applied to the profile.** The session sandbox is
`workspace-write`; every write under `C:\Users\Administrator\.dsh\profiles\desktop`
is denied even though `.dsh-work/mode-install.done` exists. The complete apply
bundle is in `.dsh-work/apply/` and `apply.sh` was tested end-to-end against a
simulated profile. A privileged agent/user must run the apply step.

## What the patch adds

Two optional, backward-compatible settings arrays, matching the existing
`visionFallbacks` shape:

```yaml
easy:          { provider, model }
easyFallbacks: [ { provider, model }, ... ]
hard:          { provider, model }
hardFallbacks: [ { provider, model }, ... ]
```

- Old single-route configs still parse exactly as before (`easyFallbacks` and
  `hardFallbacks` default to `[]`, and `tierFallbacks()` returns `[]` when the
  key is absent).
- Chain order becomes: requested tier → that tier's fallbacks → next nearest
  tier → that tier's fallbacks → … → default model. Duplicate provider/model
  routes are still de-duplicated by the existing `pushIfRoutable` logic.
- `visionFallbacks` is unchanged (same schema helper, same routing order).
- Malformed arrays are rejected by the schemastery schema instead of being
  ignored: a string, a number, or a non-string `provider` throws at parse time.
  Entries with an empty provider/model are treated as unconfigured by the
  existing `routeConfigured()` check.
- `hardFallbacks` is supported but intentionally left unconfigured here. The
  known hard → normal → easy degradation of 0.6.0 is unchanged (see Risks).

## Files touched

| File | Change |
| --- | --- |
| `node_modules/dsh-tier-router/lib/schema.js` | `DEFAULTS` + `SETTINGS_SCHEMA` fields, shared `fallbackField()`, new `tierFallbacks()` helper |
| `node_modules/dsh-tier-router/lib/router.js` | import helper; insert per-tier fallbacks into the text delegation chain |
| `node_modules/dsh-tier-router/lib/models-api.js` | whitelist `easyFallbacks` / `hardFallbacks` for the settings API |
| `node_modules/dsh-tier-router/lib/types/index.d.ts` | `TierFallback` interface, settings fields, `tierFallbacks()` declaration |
| `cordis.patch.yml` | only the `tier-router` block: comment + `easyFallbacks` (targeted replacement) |

The package entry is `index.js` (there is no `lib/index.js` in this package),
so `index.js` itself is unchanged. `pkg.types` points at
`lib/types/index.d.ts`, which is updated.

## Config shape example

```yaml
- id: tier-router
  name: dsh-tier-router
  config:
    easyProvider: google
    easyModel: gemini-3.5-flash
    easyFallbacks:
      - provider: google-vertex
        model: gemini-3.5-flash
      - provider: zai
        model: glm-5.3-flash
      - provider: zai-2
        model: glm-5.3-flash
    hardProvider: deepseek-account
    hardModel: deepseek-flash
```

## Effective routes after applying

Verified by running the patched `TierRouterAdapter.resolveChain()` against the
staged profile config (read-only, `contextGuard` disabled only so the probe
needs no live llm service):

```
easy: google/gemini-3.5-flash
   -> google-vertex/gemini-3.5-flash   (easy tier fallback)
   -> zai/glm-5.3-flash                (easy tier fallback)
   -> zai-2/glm-5.3-flash              (easy tier fallback)
   -> deepseek-account/deepseek-flash  (normal tier fallback)

hard: deepseek-account/deepseek-flash  (hard tier)
   -> google/gemini-3.5-flash           (easy tier fallback; hardFallbacks empty)
   -> google-vertex/gemini-3.5-flash
   -> zai/glm-5.3-flash
   -> zai-2/glm-5.3-flash
```

Before the patch the same config produced `easy: google → deepseek-account` and
`hard: deepseek-account → google`; only `visionFallbacks` was a real chain.

### Model id provenance (no invented ids)

- `google/gemini-3.5-flash`: explicitly declared first model in the `llm-pi-ai`
  `google` provider block.
- `google-vertex/gemini-3.5-flash`: `google-vertex` declares **no** `models`
  list in the profile, so this reuses the declared Google model id that the
  existing `visionFallbacks` already uses for `google-vertex`.
- `zai/glm-5.3-flash` and `zai-2/glm-5.3-flash`: `zai` declares no `models`
  list; `zai-2` declares `glm-5.3-flash` first. The same ids are already in the
  existing `visionFallbacks` for both providers.
- `deepseek-account/deepseek-flash`: existing hard/normal/fallback route.

## Applying

Preferred (handles the pnpm hardlink problem and backs everything up):

```bash
bash /c/Users/Administrator/Documents/deepseek-harness/default-workspace/.dsh-work/apply/apply.sh \
  --profile /c/Users/Administrator/.dsh/profiles/desktop
```

`apply.sh`:

1. Backs up `cordis.patch.yml` as `cordis.patch.yml.orig-<timestamp>`.
2. Copies the staged patched package into
   `node_modules/.dsh-tier-router.new-<timestamp>` (physical files, `nlink=1`),
   and copies each edited original to `<name>.orig-<timestamp>` inside it.
3. Swaps the package directory, keeping the old one for rollback.
4. Replaces only the `tier-router` block with `patch-config.mjs` (aborts if the
   anchors/values changed, so another agent's edits are preserved).
5. Runs `node --check`, the schema old/new/malformed checks, and the YAML
   `easyFallbacks` order check; rolls back on any failure.

Manual equivalent: use the bundle copy at `.dsh-work/apply/dsh-tier-router/`,
do the directory swap yourself, then apply
`.dsh-work/apply/cordis.patch.yml.tier-router.patch` with
`patch -p1` from the profile root.

### Why not just `patch -p1` the installed tree?

The profile uses pnpm `nodeLinker: hoisted`. All 18 package files had
`nlink=2`: they are hardlinked into
`C:\Users\Administrator\AppData\Local\pnpm\store\v11\files\...`. `patch` writes
through a hardlink in place (verified: the other link's content and inode both
changed), which would corrupt the shared pnpm store. `apply.sh` replaces the
whole package directory with a physical copy first. **Do not run the raw patch
against the hoisted install.**

The combined patch at `patches/dsh-tier-router-0.6.0-tier-fallbacks.patch` is
still reapplyable from the profile root on an already-physical copy:

```bash
cd /c/Users/Administrator/.dsh/profiles/desktop
patch -p1 --dry-run < /c/.../patches/dsh-tier-router-0.6.0-tier-fallbacks.patch
patch -p1         < /c/.../patches/dsh-tier-router-0.6.0-tier-fallbacks.patch
```

(A `--dry-run` against the real, still-unpatched profile succeeds; it was run
with no writes.)

## Restart requirement

Host plugin code is loaded at boot. The patched `lib/*.js` does **not** take
effect until the DSH backend for this profile is restarted (`dsh web` / the
desktop app). No restart was performed by this task. The YAML change alone also
needs the same restart because the settings section is constructed at apply time.

## Upgrade / reinstall caveat

`npm`/`pnpm` install or upgrade of `dsh-tier-router` replaces the package with
fresh store-hardlinked files and **reverts this patch**. Re-run the apply bundle
after any reinstall; if the version changes, re-check the hunks first. The
`cordis.patch.yml` `easyFallbacks` key survives an upgrade but is ignored by
stock 0.6.0 (its schema passes unknown keys through), so routing silently
returns to the old single-route behavior.

## Risks when all fallbacks are exhausted

- Every chain entry, then the default route, is tried. If all fail, the router
  emits one `finish` chunk with `kind: 'error'`, code `ROUTE_FAILED`, and the
  list of tried routes — fail-open, never a silent drop.
- Per-route health benches a route after quota/auth errors or
  `routeFailureThreshold` consecutive failures for `routeCooldownMs`; while all
  routes are benched, the guard fail-open returns the unguarded chain so the
  request is still attempted.
- `hard` still degrades through `easy` (and now through `easyFallbacks`) because
  `hardFallbacks` is empty and `hard`'s nearest fallback order is
  normal → easy. Configure `hardFallbacks` if that is not desired.

## Verification performed (staged copies)

- `node --check` on all four changed JS/TS files: OK.
- `SETTINGS_SCHEMA` parse:
  - old single-route config → `easyFallbacks: []`, `hardFallbacks: []` OK
  - new array config → both arrays preserved in order OK
  - malformed string / number / non-string provider → rejected with
    `expected array` / `expected object` / `expected string` OK
- `resolveChain()` with the staged config (above) produced the expected
  `easy` and `hard` chains.
- Patched package copied to the simulated profile with `cp -a`:
  all 22 files `nlink=1`; backups present; `apply.sh` reported `applied : yes`.
- `cordis.patch.yml` parsed with the profile's `yaml` package; `easyFallbacks`
  order is google-vertex, zai, zai-2.
- Combined patch `patch -p1 --dry-run` against the real profile: all 5 files
  check clean, no writes (config sha256 unchanged).
- Real profile was **not** modified: config sha256 remains
  `10ee44ab18aa97588bf08e400de13af0db4335988145571ad898964e77a23dc1`.

## Hashes (sha256)

See `.dsh-work/apply/sha256.txt`. Staged files:

```
7c4838ce72f49ff13a1380328e9f2ee44ec4d4e603d873e5ee03a3aa1284a47b  .dsh-work/apply/dsh-tier-router/lib/schema.js
1a97219392d91ee34769afa5463d27fbe22d6eeeb4181ee1e245a763bacde8c4  .dsh-work/apply/dsh-tier-router/lib/router.js
899d9af6ae2ee9b6a364dd0e642875902340a7977d48b5d58b3db4b6e8b67e09  .dsh-work/apply/dsh-tier-router/lib/models-api.js
ed84732e6c168d1e140b3337b1f20e653f7b46778e38a1f483ffe71d60210c8b  .dsh-work/apply/dsh-tier-router/lib/types/index.d.ts
d1b950dc333edaa268d3c4fdbef55c88340cc94b8c8882ad1bccbf4d655bcf4a  .dsh-work/apply/cordis.patch.yml
3cc222a8616c178dba0ffb0376513203b808af5c2fadc298d392ecf57ebd8500  patches/dsh-tier-router-0.6.0-tier-fallbacks.patch
```
