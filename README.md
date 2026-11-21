# DeepSeek Harness Setup Export (`plugin-rep`)

This repository is a secret-scrubbed export of a working **DeepSeek Harness (DSH)**
setup: a desktop profile configuration, a custom **Architect** agent preset, three local
plugins, a locally patched `dsh-tier-router` build, the patch files that produced it,
and the **modern-web-guidance** skill. Its purpose is to let you restore and reproduce
this setup on another machine.

Every feature folder carries its own **`OVERVIEW.md`** dictionary (files, wiring,
build/test commands, and caveats). This README is the human-facing setup guide;
[AGENTS.md](AGENTS.md) is the agent-facing master index and operating guide.

- **Export date:** 2026-11-13
- **Source machine:** Windows x64; DSH Desktop 0.2.2-rc.1, Node 24.21.0, pnpm 11.28.5
- **Not included:** `node_modules`, build caches, logs, crash dumps, `*.bak*`,
  SQLite/DB files, credential/auth/cookie files, `.env`/`.npmrc`/`.netrc`.

## What is in here

| Feature | Dictionary | What it is |
| --- | --- | --- |
| `profiles/desktop/` | [OVERVIEW.md](profiles/desktop/OVERVIEW.md) | The active DSH profile: plugin composition patch, manifest, lockfile, compatibility pin, and model/preset defaults. |
| `profiles/global/` | [agent_rules.md](profiles/global/agent_rules.md) | Human-readable copy of the master/subagent operating rules (not auto-loaded; documented in the profile dictionary). |
| `presets/architect-preset/` | [OVERVIEW.md](presets/architect-preset/OVERVIEW.md) | Source of the **Architect** agent preset: restriction plugin, preset definition, manifest, and dependency-free smoke test. |
| `plugins/usage-popup/` | [OVERVIEW.md](plugins/usage-popup/OVERVIEW.md) | True-sync token/cost ledger: host collector + `/usage-popup/api/*`, root overlay panel, registered as a Plugin Tools row. |
| `plugins/plugin-launcher/` | [OVERVIEW.md](plugins/plugin-launcher/OVERVIEW.md) | Unified **Plugin Tools** sidebar button + `shell.overlay` selection modal and the order-independent tool registry the other plugins register into. |
| `plugins/obsidian-task-sync/` | [OVERVIEW.md](plugins/obsidian-task-sync/OVERVIEW.md) | Obsidian vault SSE bridge, daily checklist widget, and skill-tree canvas, registered as a Plugin Tools row. |
| `packages/dsh-tier-router/` | [OVERVIEW.md](packages/dsh-tier-router/OVERVIEW.md) | The patched `dsh-tier-router@0.6.0` tarball plus the two source patches that produced it. |
| `skills/modern-web-guidance/` | [OVERVIEW.md](skills/modern-web-guidance/OVERVIEW.md) | A DSH skill manifest plus 209 categorized modern-web guidance files under `guides/`. |

The source machine also keeps the original working directories (`architect-preset/`,
`obsidian-task-sync/`, `usage-popup/`, `router-tarball/`) for its live profile. They are
**not part of the restore set**; the feature trees above are the canonical copies.

## Restore

1. Install a compatible DSH (DSH Desktop `0.2.2-rc.1` or a compatible newer build;
   Node ≥ 20, pnpm 11.x).
2. Copy `profiles/desktop/*` into your DSH profiles directory
   (`%USERPROFILE%\.dsh\profiles\desktop\` on Windows, `~/.dsh/profiles/desktop/` on
   macOS/Linux). Keep `cordis.yml` as the empty list; all customization belongs in
   `cordis.patch.yml`.
3. Fix the source-machine paths in `profiles/desktop/package.json`:

   ```jsonc
   "@local/dsh-architect-preset": "link:<repo>/presets/architect-preset",
   "dsh-tier-router": "file:<repo>/packages/dsh-tier-router/dsh-tier-router-0.6.0.tgz",
   "obsidian-task-sync": "file:<repo>/plugins/obsidian-task-sync/obsidian-task-sync-0.1.0.tgz",
   "plugin-launcher": "file:<repo>/plugins/plugin-launcher/plugin-launcher-0.1.0.tgz",
   "usage-popup": "file:<repo>/plugins/usage-popup/usage-popup-0.3.0.tgz"
   ```

   The three plugin tarballs are committed. If you change plugin source, rebuild and
   repack it before installing: `npm run build && npm pack` in
   `plugins/plugin-launcher`, `plugins/usage-popup`, or `plugins/obsidian-task-sync`
   (each `OVERVIEW.md` lists its exact commands and tests).

4. Install the profile dependencies:

   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm install
   ```

5. Resolve the `dsh-ops` preset conflict (rename
   `node_modules/dsh-ops/presets/ops-ptc.patch.yml` before starting DSH) — see the
   caveat in [AGENTS.md](AGENTS.md).
6. Copy `skills/modern-web-guidance` into a DSH skill discovery root
   (`~/.dsh/skills/` globally and/or `<project>/.dsh/skills/`). No profile config change
   is needed.
7. Restart DSH fully (quit from the tray, not a page refresh) and start a **new**
   session so the Architect preset applies.

The full step-by-step procedure, caveats, and verification results live in
[AGENTS.md](AGENTS.md). Plugin build/pack and test commands live in each feature's
`OVERVIEW.md`.

## DSH folders this setup lives in

The restore touches these locations. `%USERPROFILE%` is `~` on macOS/Linux; `$DSH_HOME`
defaults to `%USERPROFILE%\.dsh`.

| Folder | Path | What goes there |
| --- | --- | --- |
| DSH home | `%USERPROFILE%\.dsh` | Profiles, sessions, storages, attachments, credentials. |
| Active profile | `%USERPROFILE%\.dsh\profiles\desktop` | `package.json` (bundle list + `link:`/`file:` deps), `cordis.patch.yml`, `cordis.yml`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `compatibility.json`, `node_modules/`. |
| Profile backup | `%USERPROFILE%\.dsh\profiles\desktop\.restore-backup-<timestamp>` | Pre-restore copies of the profile config files (created by a restore). |
| Session store | `%USERPROFILE%\.dsh\sessions` | Session history; a session keeps the preset it was created with. |
| Project skill root | `<project>\.dsh\skills` | Discovery priority 100 — wins over every other root. |
| Project agent skill root | `<project>\.agents\skills` | Discovery priority 200. |
| Global skill root | `%USERPROFILE%\.dsh\skills` | Discovery priority 400 — applies to all projects. |
| Skill layout | `<any skill root>\<kebab-name>\SKILL.md` | No recursive discovery: `SKILL.md` must sit at exactly this depth, with `guides/**` below it. |
| Profile instruction overlay | `<project>\AGENTS.md`, `<project>\AGENTS.local.md` | DSH loads the base candidates (`AGENTS.md`, `CLAUDE.md`) then the local overlays (`AGENTS.local.md`, `CLAUDE.local.md`); the overlay wins. |

Two consequences worth remembering:

- **`<repo>` in `package.json` is not `<workspace>`.** If you clone this repo inside a
  workspace folder (for example `<workspace>\plugin-rep`), every `link:`/`file:` dependency
  needs that extra segment. A machine-specific copy of the values is kept in
  [`AGENTS.local.md`](./AGENTS.local.md).
- **`pnpm install` must run in the profile directory**, never in the repo, so the plugin
  tarballs land in `%USERPROFILE%\.dsh\profiles\desktop\node_modules`.

## Documentation

- [AGENTS.md](AGENTS.md) — master repository dictionary, global operating rules,
  restore/restart procedure, caveats, and secret/exclusion notes.
- [profiles/desktop/OVERVIEW.md](profiles/desktop/OVERVIEW.md) — profile dictionary.
- [presets/architect-preset/OVERVIEW.md](presets/architect-preset/OVERVIEW.md) — preset dictionary.
- [plugins/plugin-launcher/OVERVIEW.md](plugins/plugin-launcher/OVERVIEW.md) — unified Plugin Tools launcher dictionary.
- [plugins/usage-popup/OVERVIEW.md](plugins/usage-popup/OVERVIEW.md) — usage-ledger dictionary.
- [plugins/obsidian-task-sync/OVERVIEW.md](plugins/obsidian-task-sync/OVERVIEW.md) — Obsidian plugin dictionary.
- [packages/dsh-tier-router/OVERVIEW.md](packages/dsh-tier-router/OVERVIEW.md) — router tarball/patch dictionary.
- [skills/modern-web-guidance/OVERVIEW.md](skills/modern-web-guidance/OVERVIEW.md) — skill dictionary.
- [plugins/obsidian-task-sync/README.md](plugins/obsidian-task-sync/README.md) — user-facing plugin documentation.
- [plugins/usage-popup/ARCHITECTURE.md](plugins/usage-popup/ARCHITECTURE.md) — deep architecture map.
- [skills/modern-web-guidance/SKILL.md](skills/modern-web-guidance/SKILL.md) — the skill manifest and usage instructions.

---

Agents' operating rules live in [AGENTS.md](AGENTS.md). This file is for humans.
