# DeepSeek Harness Setup Export (`plugin-rep`)

A secret-scrubbed export of a working **DeepSeek Harness (DSH)** setup: the active
profile configuration, the custom **Architect** agent preset, two local plugins, the
locally patched `dsh-tier-router` build, the patch files that produced it, and the
**modern-web-guidance** skill. Restore it on another machine to reproduce the setup.

- **Export date:** 2026-11-13
- **Source machine:** Windows x64; DSH Desktop **0.2.2-rc.1**, Node **24.21.0**, pnpm **11.28.5**
- **Source paths:**
  - DSH home: `C:\Users\Administrator\.dsh`
  - Active profile: `C:\Users\Administrator\.dsh\profiles\desktop`
  - Workspace (project) root: `C:\Users\Administrator\Documents\deepseek-harness\default-workspace`
  - Project skill: `<workspace>\.dsh\skills\modern-web-guidance`
  - Global skill: `C:\Users\Administrator\.dsh\skills\modern-web-guidance`
- **Not included:** `node_modules`, `dist`/build caches, logs, crash dumps, `*.bak*`,
  `.probe-extract`, SQLite/DB files, credential/auth/cookie files, `.env`/`.npmrc`/`.netrc`.
- **Committed:** this tree is the repository's `main` branch; the preset source below is
  the version this README documents.

## Directory layout

| Path | What it is |
| --- | --- |
| `profiles/desktop/cordis.yml` | Profile root entry list. Deliberately `[]`: the plugin tree is composed from the profile bundles, then `cordis.patch.yml`, then any `--patch` overlays. Edit the patch file, not this one. |
| `profiles/desktop/cordis.patch.yml` | The profile patch layer: UI config (account step done, chat `transcriptView: verbose`/`performanceUsage: detailed`, settings UI disabled, dark theme), `agent-default-model` (`deepseek-account` / `deepseek-flash` / `reasoningEffort: max`), `agent-preset-registry` with `default: architect` + `selectedDefault: architect`, and the inserted `architect-tool-restrict` row (`@local/dsh-architect-preset`). |
| `profiles/desktop/package.json` | Profile manifest: `dsh.profile.bundles` order and dependencies. Contains **source-machine absolute paths** (`link:` / `file:`) that must be adjusted after restore. |
| `profiles/desktop/pnpm-lock.yaml` | Lockfile for the profile dependencies (re-run `pnpm install` after changing `file:` paths). |
| `profiles/desktop/pnpm-workspace.yaml` | pnpm settings: single package (`.`), `nodeLinker: hoisted`, `autoInstallPeers: false`. |
| `profiles/desktop/compatibility.json` | Extra compatibility pin: `{"dsh-tier-router@0.6.0": ["0.2.2-rc.1"]}`. |
| `profiles/desktop/settings/` | **Absent on the source machine** — there were no separate text settings files; all text config lived directly in the profile root and is captured above. |
| `profiles/global/agent_rules.md` | Master/subagent operating rules (human-readable copy of the runtime `MEMORY.md` rules). DSH does **not** auto-load this path; it exists so the rules are reviewable/versioned. |
| `presets/architect-preset/index.js` | The `architect-tool-restrict` Cordis plugin: deny lists, static `ARCHITECT_CONTRACT`/`WORKER_CONTRACT` injection, uncapped worker tool calls (no call-count ceiling), and agent-scoped `tools/post-execute` result truncation (64 KB threshold, 24 KB head + 24 KB tail). Tracks absolute `ROSTER_DUMP`/`DIAG_DUMP` paths used only for diagnostics — adjust or ignore them. |
| `presets/architect-preset/cordis.patch.yml` | Defines the preset itself: `preset-architect` row (`@deepseek-ai/dsh-agent-preset`, config `id: architect`, `order: 20`) and its plugin rows. |
| `presets/architect-preset/package.json` | Package `@local/dsh-architect-preset` (private, ESM) with `dsh.bundle.patch: ./cordis.patch.yml`. |
| `presets/architect-preset/smoke.test.mjs` | 40-check smoke suite for the restriction plugin; Node built-ins only, no dependencies. |
| `plugins/usage-popup/src/index.tsx` | Client half of the token-usage popup: composer HUD with per-session token usage, model/balance ledger, draggable HUD position. |
| `plugins/usage-popup/scripts/build.mjs` | Tranpiles `src/index.tsx` with the TypeScript compiler API into `dist/index.js` + `dist/client.js` (`npm run build`). |
| `plugins/usage-popup/cordis.patch.yml` | Bundle patch: inserts row `usage-popup` (name `usage-popup`). |
| `plugins/usage-popup/cordis.yml` | Optional local-dev patch: mounts the plugin from an absolute source path in a repository checkout (`pnpm dsh web --patch ./plugins/usage-popup/cordis.yml`). |
| `plugins/usage-popup/package.json` | Package manifest (`usage-popup@0.1.2`), `dsh.bundle` + `dsh.client` declarations, `engines.dsh ^0.2.2-rc.1`. |
| `plugins/usage-popup/PLUGIN_NOTES.md` | Author notes on the composer HUD, build and manual verification. |
| `plugins/obsidian-task-sync/src/host.js` | Host half: same-origin filesystem bridge + live SSE watcher over an Obsidian vault (read/append tasks, headings, tree points). |
| `plugins/obsidian-task-sync/src/client.tsx` | Web client: sidebar launcher, detached daily-checklist widget and the skill-tree canvas. |
| `plugins/obsidian-task-sync/scripts/build.mjs` | Build script: `dist/index.js` from `host.js`, `dist/client.js` from `client.tsx`. |
| `plugins/obsidian-task-sync/cordis.patch.yml` | Bundle patch: inserts row `obsidian-task-sync`. |
| `plugins/obsidian-task-sync/package.json` | Package manifest (`obsidian-task-sync@0.1.0`), `dsh.bundle`/`dsh.client`, locale/icon exports. |
| `plugins/obsidian-task-sync/package-lock.json` | npm lockfile from the source build. |
| `plugins/obsidian-task-sync/README.md` | Plugin documentation (install, vault config, widget usage). |
| `plugins/obsidian-task-sync/locale/{en,zh}.json` | Plugin strings. |
| `plugins/obsidian-task-sync/icon.svg` | Bundle icon. |
| `plugins/obsidian-task-sync/tests/*.mjs` | Backend, bridge and client-smoke tests. |
| `patches/dsh-tier-router-0.6.0-tier-fallbacks.patch` | Local patch against `dsh-tier-router` 0.6.0 (`cordis.patch.yml` tier/fallback routing). |
| `patches/dsh-tier-router-0.6.0-worker-usage.patch` | Local patch against `dsh-tier-router` 0.6.0 (`lib/schema.js` worker-usage fields). |
| `packages/dsh-tier-router-0.6.0.tgz` | The patched local build of `dsh-tier-router` 0.6.0 (121,540 bytes, 0.12 MB). Produced from a router source checkout with both patches applied; the profile installs it via `file:`. |
| `skills/modern-web-guidance/SKILL.md` | Skill manifest/instructions: search → retrieve → apply modern web guidance. |
| `skills/modern-web-guidance/guides/**` | 209 guide files in 17 categories: `ui-behaviors` (40), `performance` (26), `ui-components` (22), `visual-design` (22), `forms` (19), `css` (18), `security` (17), `ui-atoms` (13), `html` (8), `js` (5), `built-in-ai` (5), `accessibility` (4), `user-experience` (3), `webmcp` (3), `pwa` (2), `privacy` (1), `wasm` (1). |

## The Architect preset

### Role contract

The preset splits one job across two roles, enforced by the restriction plugin
(`presets/architect-preset/index.js`) rather than by prompt text alone.

**ARCHITECT (main agent — no file/shell tools; delegation is its only action):**

- Delegate with untagged `subagent` / `subagent_fork` calls: plain calls, no budget tag.
  The old cheap/heavy budget tiers were removed, so delegation is never tagged.
- Name exact files/paths and exact commands, and state the required output.
- Add: "Do not explore beyond this list; no broad searches, no unrelated tests."
- Never ask a worker to investigate, explore, find out, or survey the repo.
- Use the fewest workers; never re-delegate failed work; reuse results.
- Ask for a ≤20-line report: result, files changed, verification, blockers.

**WORKER (subagent — has file/shell tools; stays strictly inside the assigned task):**

- Workers have **no tool-call count cap**: make as many small, sequential tool calls as
  the task requires. The static role contract keeps DeepSeek prefix caching effective, so
  repeated cached turns are cheap; a call ceiling is not needed as a runaway-loop backstop.
- Read only named files or unambiguously required ones; at most one discovery call.
- No `code_map`/`code_index`, repo-wide grep/glob, or unrelated tests.
- No plans, todos, documents, or subagents.
- Prefer small, targeted calls over one giant command; stop as soon as the task is complete.
- Return ≤20 lines: result, files changed, verification, blockers.
- If blocked or ambiguous, stop and report immediately; do not guess or explore.

The plugin blocks file/shell/inspection tools for the **main** agent (`read`, `write`,
`edit`, `apply_patch`, `grep`, `glob`, `bash`/`pwsh`, `code_map`, `workflow`, ...) and
blocks delegation/management tools for **workers** (`subagent`, `subagent_fork`,
`todo_write`, `list_agents`, `send_message`, memory-document/management tools, ...).
It also caps the pending delegation queue at 16; there is no per-worker call-count cap.

### Cache-optimized preset architecture

Each role gets one fixed, byte-stable prompt prefix: the plugin injects a static
`ARCHITECT_CONTRACT` or `WORKER_CONTRACT` section per role (section
`architect:role-contract`, order 2690) instead of per-run text. A worker's prefix changes
only if its role changes, which keeps DeepSeek prefix caching effective.

- **Untagged delegation.** `subagent` / `subagent_fork` are plain calls with no budget
  tag and no cheap/heavy tier selection; the former budget-tier rules are gone.
- **Uncapped worker tool calls.** No `WORKER_CALL_CEILING` and no call-count map exist;
  workers make as many sequential calls as a task needs, relying on DeepSeek prefix
  caching instead of a hard cap to keep long runs cheap.
- **Static contract split.** `ARCHITECT_CONTRACT` / `WORKER_CONTRACT` are injected per
  role with no per-run interpolation, keeping the prompt prefix stable and cache-friendly.
- **Agent-scoped `tools/post-execute` truncation.** Text tool results larger than
  `65536` bytes (64 KB) are reduced to a 24 KB head + 24 KB tail (24576 + 24576) plus a
  truncation marker before they enter history. A normal source file (`index.js`,
  `smoke.test.mjs`, `README.md`) passes through intact, so workers don't re-read files in
  chunks. Only the current result is changed, never prior turns, and structured non-text
  content is left intact.

### How it is mounted and configured

1. **Preset definition** — `presets/architect-preset/cordis.patch.yml` inserts one row:

   ```yaml
   - insert:
       - id: preset-architect
         name: '@deepseek-ai/dsh-agent-preset'
         config:
           id: architect
           name: Architect
           order: 20
           description: "Delegates to workers; the main agent has no file/shell tools."
           plugins: [...]
   ```

   The `plugins` list mounts `dsh-tool-bash` (disabled on win32), `dsh-tool-pwsh`
   (disabled elsewhere), `dsh-tool-fs` (`applyPatch: false`), `dsh-tool-fs-search`
   (`sampleOverCapGlobResults: false`), `dsh-tool-jobs`, `dsh-tool-subagent-control`,
   `dsh-tool-subagent` (`provider: spawn`, tool `subagent`), `dsh-tool-subagent`
   (`provider: fork`, tool `subagent_fork`) and `dsh-tool-todo`
   (`allowParallelInProgress: true`).

   File/shell tools are mounted **in the preset on purpose**: a delegated child inherits
   the parent's preset, so a preset without them would give workers an empty tool surface.

2. **Main-agent restriction** — the profile patch (`profiles/desktop/cordis.patch.yml`)
   inserts row `architect-tool-restrict` with `name: "@local/dsh-architect-preset"`.
   A preset realm resolves its rows against the install base, so the `@local/*`
   restriction plugin cannot mount inside the preset; the profile-level row filters tool
   names by the session's preset id and lineage instead (main agent vs. worker).

3. **Profile bundle** — `profiles/desktop/package.json` lists
   `@local/dsh-architect-preset` in `dsh.profile.bundles` and depends on it via
   `"link:C:/Users/Administrator/Documents/deepseek-harness/default-workspace/architect-preset"`.

### Selecting it and making it the durable default

- The registry row is `agent-preset-registry` (`@deepseek-ai/dsh-agent-preset-registry`).
  It is configured in `profiles/desktop/cordis.patch.yml` with:

  ```yaml
  - id: agent-preset-registry
    name: "@deepseek-ai/dsh-agent-preset-registry"
    config:
      default: architect
      selectedDefault: architect
  ```

  `selectedDefault` is the persisted pick made in the preset picker; `default` is the
  fallback when nothing is selected. Set **both** to `architect` so the durable default
  holds even if the persisted selection is reset.

- Pick **Architect** in the new-session preset picker once after restore (this writes
  `selectedDefault`). The config above already pins it.

- **Full restart + new-session caveat:** plugin composition and the registry config are
  read at startup, so a config change requires a **full DSH restart** (quit from the
  tray, not just a page refresh). A session's preset is recorded at creation in the
  `agentPreset` session projection, so **existing sessions keep their old preset** —
  start a **new session** to get the Architect contract. (The restriction plugin does
  re-compose a session that was created under another preset, e.g. `ops-ptc` →
  `architect`, when you switch it, but a new session is the clean path.)

- The plugin's `ROSTER_DUMP`/`DIAG_DUMP` constants still point at the source workspace
  (`...\default-workspace\architect-preset\.roster.json` / `.diag.json`). They are
  diagnostic dumps only; adjust them or leave them.

## The `modern-web-guidance` skill

- **Installed at:** `<workspace>\.dsh\skills\modern-web-guidance` (project-level, 100-tier)
  and `C:\Users\Administrator\.dsh\skills\modern-web-guidance` (global, 400-tier).
  Both copies are identical: **210 files, 2,018,207 bytes (~1.92 MB)**.
- **Verified DSH discovery roots** (first match wins, higher priority = lower number):
  1. `<projectRoot>/.dsh/skills` — 100
  2. `<projectRoot>/.agents/skills` — 200
  3. `customSkillDirs` — 300
  4. `~/.dsh/skills` — 400
  5. `agentsHome/skills` — 500
  6. bundled skills — 600

  Layout is `<root>/<name>/SKILL.md`, kebab-case directory names, **no recursive**
  discovery below the skill directory. The active profile already mounts
  `skill` / `skill-filesystem` / `tool-skill` through `@deepseek-ai/dsh-base`, so
  **no profile config change is needed** — copying the directory is enough.
- **CLI usage** (verified on the source machine: exit 0, 10 JSON hits):

  ```bash
  npx -y modern-web-guidance@latest search "dialog modal"
  ```

  Canonical form used by the skill itself (pins the bundled guide version):

  ```bash
  npx -y modern-web-guidance@latest search "<query>" --skill-version 2026_11_09-5bcc021b
  ```

  Related commands: `npx -y modern-web-guidance@latest retrieve "<id>"`,
  `npx -y modern-web-guidance@latest legacy-scan <path> --json`. Use 2–5
  action-oriented words per query; on Windows use `npx.cmd`, prefer `pnpx` when pnpm
  is available, allowlist `npx -y modern-web-guidance@latest *` (never bare `npx *`),
  and add `--offline` if the command hangs while offline.

## Restore step by step

1. **Install a compatible DSH** on the target machine (DSH Desktop **0.2.2-rc.1** or a
   compatible newer build; Node ≥ 20, pnpm). The profile declares
   `engines.dsh ^0.2.2-rc.1` and `compatibility.json` pins `dsh-tier-router@0.6.0`
   to `0.2.2-rc.1`.
2. **Restore the profile.** Copy `profiles/desktop/*` over
   `%USERPROFILE%\.dsh\profiles\desktop\` (macOS/Linux: `~/.dsh/profiles/desktop/`).
   Keep `cordis.yml` as the empty list; all customization belongs in
   `cordis.patch.yml`.
3. **Adjust the local paths** in `profiles/desktop/package.json` — the source-machine
   paths do not exist on a new machine:

   ```jsonc
   "@local/dsh-architect-preset": "link:<repo>/presets/architect-preset",
   "dsh-tier-router": "file:<repo>/packages/dsh-tier-router-0.6.0.tgz",
   "obsidian-task-sync": "file:<build>/obsidian-task-sync-0.1.0.tgz",
   "usage-popup": "file:<build>/usage-popup-0.1.2.tgz"
   ```

   The two plugin tarballs are **not** in this export (build artifacts are excluded).
   Rebuild them from source first:

   ```bash
   cd plugins/usage-popup && npm install && npm run build && npm pack
   cd ../obsidian-task-sync && npm install && npm run build && npm pack
   ```

   (Both builds need only the `typescript` devDependency. `dist/` is generated; do not
   commit it.)
4. **Restore/install presets and plugins, then the profile deps.** The architect preset
   must be resolvable — the profile patch inserts `architect-tool-restrict` with
   `name: "@local/dsh-architect-preset"`. Then run the install from the profile
   directory:

   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm install        # regenerates node_modules + pnpm-lock.yaml
   ```

5. **Set the preset default.** `profiles/desktop/cordis.patch.yml` already sets
   `agent-preset-registry` → `default: architect`, `selectedDefault: architect`.
   Re-apply it if you merged with an existing profile.
6. **Resolve the dsh-ops preset conflict** (required — see caveats below):

   ```powershell
   Rename-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-ops\presets\ops-ptc.patch.yml" `
     "ops-ptc.patch.yml.disabled"
   ```

7. **Restore the skills.** Copy the directory into either discovery root:

   ```bash
   # global (all projects)
   cp -r skills/modern-web-guidance ~/.dsh/skills/
   # and/or project-level
   cp -r skills/modern-web-guidance <project>/.dsh/skills/
   ```

   No profile config change is needed.
8. **Restart DSH fully and open a new session.** Verify the session reports the
   Architect preset and that the main agent has no file/shell tools; delegated prompts
   are plain untagged `subagent`/`subagent_fork` calls (the former budget tiers were
   removed).
9. **Optionally verify the preset plugin:**

   ```bash
   node presets/architect-preset/smoke.test.mjs   # exit 0, 40 pass, 0 fail
   ```

## Required caveats

- **dsh-ops preset conflict (must fix on every fresh install).** The `dsh-ops` package
  registers the same preset id (`ops-ptc`) that the Architect setup replaces. On a
  fresh install, rename or remove
  `node_modules/dsh-ops/presets/ops-ptc.patch.yml` **before starting DSH** (the source
  machine already has it as `ops-ptc.patch.yml.bak-opsptc-20261113-203831`). With the
  file removed, registration skips only the conflicting preset — **all other dsh-ops
  tools survive**.
- **A `disabled: true` preset row does NOT work.** The preset registry has no
  `exclude` key, so disabling cannot remove an existing preset row; the `ops-ptc`
  patch file must be renamed/removed as above.
- **Absolute `file:`/`link:` paths** in `profiles/desktop/package.json` and the
  `usage-popup/cordis.yml` dev patch are source-machine paths — update them.
- **The profile patch inserts an `@local/*` plugin row.** If you do not install
  `@local/dsh-architect-preset`, remove the `architect-tool-restrict` insert and reset
  the registry config, or the profile may fail to load.

## Secrets and exclusions

- The only live credentials on the source machine lived in files that were **excluded
  wholesale** from this export (`~/.dsh/.credentials.yaml`, profile auth/cookie state,
  `.env`/`.npmrc`/`.netrc`). **Every staged text file (<5 MB) was scanned** for
  `sk-`/`sk-ant-`/`sk-proj-`, `ghp_`/`github_pat_`/`gh[ous]_`, `xox[bap]-`,
  `AKIA…`, `AIza…`, `xai-…`, `glpat-`, JWTs, `-----BEGIN … PRIVATE KEY-----`,
  credentials embedded in URL userinfo, and `(api_key|secret|token|password|…)=<value>`
  assignments: **0 unredacted live secrets**. The only matches were documentation/code
  identifiers (`token: SESSION_TOKEN`, `const token = __sessionToken()`, `password: true`,
  `password: cred.password`), never a credential value. No `<REDACTED_*>` placeholders
  were needed.
- **Re-enter credentials locally** after restore: sign in to the DeepSeek account
  (the profile expects provider `deepseek-account`) and re-create any
  `.credentials.yaml`/environment secrets you use. Nothing sensitive is in this repo.
- **Excluded contents:** `node_modules`, `.git` (other than this repo's own),
  `.probe-extract`, `.npm-cache`, `dist`/`build` output, `crash-*`, `*.diag.json`,
  `.roster.json`, profile `*.bak-*`/`*.orig-*` backups, `*.log`, `*.sqlite`, `*.db`,
  auth/cookie/credential files, `.env`/`.npmrc`/`.netrc`, and `*.tgz` except
  `packages/dsh-tier-router-0.6.0.tgz`.

## Verification performed for this export

- `node presets/architect-preset/smoke.test.mjs` → **exit 0, 40 pass, 0 fail**
  (same result in the original workspace at `architect-preset/smoke.test.mjs`).
- Staged working tree: **244 files, 2,711,164 bytes**; `skills/modern-web-guidance/SKILL.md`
  and this `README.md` present; no `node_modules`, `.git`, logs, crash dumps, `*.diag.json`,
  `.roster.json`, `*.bak*`, SQLite/DB, or auth/cookie files.
