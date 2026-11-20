# AGENTS.md

Master repository dictionary and repo-wide operating guide for the `plugin-rep`
**DeepSeek Harness (DSH)** setup export. Humans should read [README.md](./README.md).

This file is intentionally an **index**: it holds the repository map, the export and
restore context, the global Architect/Worker rules, and the caveats that apply to the
whole repo. File-level details, build commands, and feature-specific gotchas live in
each feature's **`OVERVIEW.md`** — read only the feature you need.

Every feature folder has the same dictionary filename (`OVERVIEW.md`), at
`<feature>/OVERVIEW.md`, so an agent can find the map without guessing. Existing
`README.md`/`SKILL.md`/`ARCHITECTURE.md` files are linked from those dictionaries and
are not duplicated here.

## Export metadata

- **Export date:** 2026-11-13
- **Source machine:** Windows x64; DSH Desktop **0.2.2-rc.1**, Node **24.21.0**, pnpm **11.28.5**
- **Source paths:**
  - DSH home: `C:\Users\Administrator\.dsh`
  - Active profile: `C:\Users\Administrator\.dsh\profiles\desktop`
  - Workspace (project) root: `C:\Users\Administrator\Documents\deepseek-harness\default-workspace`
  - Project skill: `<workspace>\.dsh\skills\modern-web-guidance`
  - Global skill: `C:\Users\Administrator\.dsh\skills\modern-web-guidance`
- **Committed:** this tree is the repository's `main` branch. The committed profile files
  are the restore artifact; the source machine's live profile is outside the repo.
- **Not included:** `node_modules`, `dist`/build caches, logs, crash dumps, `*.bak*`,
  `.probe-extract`, SQLite/DB files, credential/auth/cookie files, `.env`/`.npmrc`/`.netrc`.

## Feature Directory Dictionary

| Feature | Primary entrypoint | What it is |
| --- | --- | --- |
| [`profiles/desktop/`](./profiles/desktop/OVERVIEW.md) | [`cordis.patch.yml`](./profiles/desktop/cordis.patch.yml) | Active DSH profile config, bundle manifest, and model/preset defaults. |
| [`presets/architect-preset/`](./presets/architect-preset/OVERVIEW.md) | [`index.js`](./presets/architect-preset/index.js) | Role-split Architect/Worker preset, tool restrictions, and role-based reasoning-effort hooks. |
| [`plugins/usage-popup/`](./plugins/usage-popup/OVERVIEW.md) | [`src/index.tsx`](./plugins/usage-popup/src/index.tsx) | True-sync token/cost ledger sidebar launcher and root overlay panel. |
| [`plugins/obsidian-task-sync/`](./plugins/obsidian-task-sync/OVERVIEW.md) | [`src/host.js`](./plugins/obsidian-task-sync/src/host.js) | Obsidian vault SSE bridge, daily checklist widget, and skill-tree canvas. |
| [`packages/dsh-tier-router/`](./packages/dsh-tier-router/OVERVIEW.md) | [`dsh-tier-router-0.6.0.tgz`](./packages/dsh-tier-router/dsh-tier-router-0.6.0.tgz) | Locally patched `dsh-tier-router@0.6.0` tarball and source patch files. |
| [`skills/modern-web-guidance/`](./skills/modern-web-guidance/OVERVIEW.md) | [`SKILL.md`](./skills/modern-web-guidance/SKILL.md) | Modern web development skill (`SKILL.md`) and 209 categorized guidance files. |

Supporting documents:

- [`profiles/global/agent_rules.md`](./profiles/global/agent_rules.md) — human-readable copy
  of the master/subagent operating rules (DSH does **not** auto-load this path; the binding
  copy is runtime memory). Documented in the profile dictionary.
- [`README.md`](./README.md) — human-facing setup and restore guide.
- Feature deep-dives: [`plugins/usage-popup/ARCHITECTURE.md`](./plugins/usage-popup/ARCHITECTURE.md),
  [`plugins/usage-popup/PLUGIN_NOTES.md`](./plugins/usage-popup/PLUGIN_NOTES.md),
  [`plugins/obsidian-task-sync/README.md`](./plugins/obsidian-task-sync/README.md),
  [`packages/dsh-tier-router/README.md`](./packages/dsh-tier-router/README.md),
  [`skills/modern-web-guidance/SKILL.md`](./skills/modern-web-guidance/SKILL.md).

## Global operating rules — Architect / Worker

The setup is built around one job split across two roles, enforced by the plugin in
[`presets/architect-preset/index.js`](./presets/architect-preset/index.js) rather than by
prompt text alone. These rules apply repo-wide.

**ARCHITECT (main agent — no file/shell tools; delegation is its only action):**

- Delegate with untagged `subagent` / `subagent_fork` calls: plain calls, no budget tag.
- Name exact files/paths and exact commands, and state the required output.
- Add: "Do not explore beyond this list; no broad searches, no unrelated tests."
- Never ask a worker to investigate, explore, find out, or survey the repo.
- Use the fewest workers; never re-delegate failed work; reuse results.
- Ask for a ≤20-line report: result, files changed, verification, blockers.

**WORKER (subagent — has file/shell tools; stays strictly inside the assigned task):**

- Workers have **no tool-call count cap**: make as many small, sequential tool calls as
  the task requires. The static role contract keeps DeepSeek prefix caching effective.
- Read only named files or unambiguously required ones; at most one discovery call.
- No `code_map`/`code_index`, repo-wide grep/glob, or unrelated tests.
- No plans, todos, documents, or subagents.
- Prefer small, targeted calls over one giant command; stop as soon as the task is complete.
- Return ≤20 lines: result, files changed, verification, blockers.
- If blocked or ambiguous, stop and report immediately; do not guess or explore.

The plugin blocks file/shell/inspection tools for the **main** agent and
delegation/management tools for **workers**, and caps the pending delegation queue at 16.
The role contracts, reasoning-effort split, and result truncation are implementation
details documented in [`presets/architect-preset/OVERVIEW.md`](./presets/architect-preset/OVERVIEW.md)
— read it before changing the preset.

## Restore and restart (global)

1. **Install a compatible DSH.** DSH Desktop **0.2.2-rc.1** or a compatible newer build;
   Node ≥ 20, pnpm. The profile declares `engines.dsh ^0.2.2-rc.1`, and
   `profiles/desktop/compatibility.json` pins `dsh-tier-router@0.6.0` to `0.2.2-rc.1`.
2. **Restore the profile.** Copy `profiles/desktop/*` over
   `%USERPROFILE%\.dsh\profiles\desktop\` (macOS/Linux: `~/.dsh/profiles/desktop/`).
   Keep `cordis.yml` as the empty list; all customization belongs in `cordis.patch.yml`.
3. **Adjust the local paths** in `profiles/desktop/package.json` (and the lockfile, which
   `pnpm install` regenerates). The source-machine paths do not exist on a new machine:

   ```jsonc
   "@local/dsh-architect-preset": "link:<repo>/presets/architect-preset",
   "dsh-tier-router": "file:<repo>/packages/dsh-tier-router/dsh-tier-router-0.6.0.tgz",
   "obsidian-task-sync": "file:<repo>/plugins/obsidian-task-sync/obsidian-task-sync-0.1.0.tgz",
   "usage-popup": "file:<repo>/plugins/usage-popup/usage-popup-0.3.0.tgz"
   ```

   All four artifacts are committed in this repo. Rebuild the plugins from source only if
   you change them (`npm run build && npm pack` in each plugin folder — see their
   `OVERVIEW.md`).
4. **Install the profile dependencies:**

   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm install        # regenerates node_modules + pnpm-lock.yaml
   ```

5. **Set the preset default.** `profiles/desktop/cordis.patch.yml` already sets
   `agent-preset-registry` → `default: architect`, `selectedDefault: architect`. Re-apply
   it if you merged with an existing profile. Pick **Architect** in the new-session preset
   picker once after restore; the config already pins it.
6. **Resolve the dsh-ops preset conflict** (required — see caveats):

   ```powershell
   Rename-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-ops\presets\ops-ptc.patch.yml" `
     "ops-ptc.patch.yml.disabled"
   ```

7. **Restore the skill.** Copy the directory into either discovery root:

   ```bash
   cp -r skills/modern-web-guidance ~/.dsh/skills/          # global (all projects)
   cp -r skills/modern-web-guidance <project>/.dsh/skills/  # project-level
   ```

   No profile config change is needed. DSH discovers `<root>/<name>/SKILL.md` and does
   **no recursive discovery** below the skill folder; see
   [`skills/modern-web-guidance/OVERVIEW.md`](./skills/modern-web-guidance/OVERVIEW.md).
8. **Restart DSH fully and open a new session.** Plugin composition and the registry
   config are read at startup: quit from the tray (not just a page refresh), then start a
   **new session** (a session's preset is recorded at creation, so existing sessions keep
   their old preset).
9. **Verify the preset (optional):**

   ```bash
   node presets/architect-preset/smoke.test.mjs   # exit 0, 52 pass, 0 fail
   ```

## Required caveats

- **dsh-ops preset conflict (must fix on every fresh install).** The `dsh-ops` package
  registers the same preset id (`ops-ptc`) that the Architect setup replaces. On a fresh
  install, rename or remove
  `node_modules/dsh-ops/presets/ops-ptc.patch.yml` **before starting DSH**. Registration
  then skips only the conflicting preset; all other dsh-ops tools survive.
- **A `disabled: true` preset row does NOT work.** The preset registry has no `exclude`
  key, so disabling cannot remove an existing preset row; rename/remove the patch file.
- **Absolute `file:`/`link:` paths** in `profiles/desktop/package.json`,
  `profiles/desktop/pnpm-lock.yaml`, and `plugins/usage-popup/cordis.yml` are
  source-machine paths — update them on a new machine.
- **The profile patch inserts an `@local/*` plugin row.** If you do not install
  `@local/dsh-architect-preset`, remove the `architect-tool-restrict` insert and reset the
  registry config, or the profile may fail to load.
- **Full restart, then a new session.** Config edits and host-code changes need a full DSH
  restart; existing sessions keep their recorded preset.
- **Legacy source-machine working directories.** The repository source machine also has
  `architect-preset/`, `obsidian-task-sync/`, `usage-popup/`, and `router-tarball/` at the
  root (its live profile points at some of them). They are **not** part of the restore
  set; the canonical feature trees are `profiles/`, `presets/`, `plugins/`, `packages/`,
  and `skills/`. Do not copy the legacy trees to a new machine.

## Secrets and exclusions

- The only live credentials on the source machine lived in files that were **excluded
  wholesale** from this export (`~/.dsh/.credentials.yaml`, profile auth/cookie state,
  `.env`/`.npmrc`/`.netrc`). **Every staged text file (<5 MB) was scanned** for
  `sk-`/`sk-ant-`/`sk-proj-`, `ghp_`/`github_pat_`/`gh[ous]_`, `xox[bap]-`, `AKIA…`,
  `AIza…`, `xai-…`, `glpat-`, JWTs, `-----BEGIN … PRIVATE KEY-----`, credentials embedded
  in URL userinfo, and `(api_key|secret|token|password|…)=<value>` assignments: **0
  unredacted live secrets**. The only matches were documentation/code identifiers
  (`token: SESSION_TOKEN`, `const token = __sessionToken()`, `password: true`,
  `password: cred.password`), never a credential value.
- **Re-enter credentials locally** after restore: sign in to the DeepSeek account (the
  profile expects provider `deepseek-account`) and re-create any
  `.credentials.yaml`/environment secrets you use. Nothing sensitive is in this repo.
- **Excluded contents:** `node_modules`, `.git` (other than this repo's own),
  `.probe-extract`, `.npm-cache`, `dist`/`build` output (except the committed
  `plugins/usage-popup/dist/` needed by its restore tarball), `crash-*`, `*.diag.json`,
  `.roster.json`, profile `*.bak-*`/`*.orig-*` backups, `*.log`, `*.sqlite`, `*.db`,
  auth/cookie/credential files, `.env`/`.npmrc`/`.netrc`, and `*.tgz` except the committed
  restore artifacts (`packages/dsh-tier-router/dsh-tier-router-0.6.0.tgz` and the two
  plugin tarballs).

## Verification performed for this export

- `node presets/architect-preset/smoke.test.mjs` → **exit 0, 52 pass, 0 fail**.
- `usage-popup` suites: `test/logic.test.mjs` (75), `test/host.test.mjs` (95),
  `test/transport.test.mjs` (58), `test/integration.test.mjs` (55), and
  `test/client.test.mjs` (23) — all exit 0.
- `obsidian-task-sync`: `tests/backend.test.mjs` (22 tests), `tests/bridge.test.mjs`
  (real-HTTP integration), and `tests/client-smoke.mjs` (server-render smoke) — all pass
  after `npm run build`.
- `skills/modern-web-guidance`: 209 guide files + `SKILL.md` (the original 2,018,207-byte
  skill payload); the folder is 211 files / 2,024,335 bytes including this feature's
  `OVERVIEW.md`. Both installed copies were identical before the dictionary was added.
- Restructure: the router tarball and both patch files now live together in
  `packages/dsh-tier-router/` (the root `patches/` folder is gone), each feature has an
  `OVERVIEW.md`, and every relative Markdown link in `AGENTS.md`, `README.md`, and the
  feature dictionaries resolves on disk.
