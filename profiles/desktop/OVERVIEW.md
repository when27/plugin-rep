# Desktop DSH Profile

The active DeepSeek Harness profile for the Web/Desktop GUI. It composes the UI and plugin tree from the ordered `dsh.profile.bundles` list, then applies the `cordis.patch.yml` patch layer (UI overrides, model defaults, the Architect preset registry, and the profile-level `@local` tool-restriction row). It is the profile half of the setup; the feature-specific configuration lives in the linked plugin and preset folders.

## File Dictionary

| File | Purpose |
| --- | --- |
| [`cordis.yml`](./cordis.yml) | Profile root entry list. Deliberately the empty array `[]`: the tree is composed from the profile bundles, then `cordis.patch.yml`, then any `--patch` overlays. Edit the patch file, not this one. |
| [`cordis.patch.yml`](./cordis.patch.yml) | The profile patch layer. Sets the UI rows (`ui-settings-account` done, chat `transcriptView: verbose` / `performanceUsage: detailed`, settings UI disabled, dark theme), `agent-default-model` (`deepseek-account` / `deepseek-flash` / `reasoningEffort: low`), `agent-preset-registry` (`default: architect`, `selectedDefault: architect`), and inserts the `architect-tool-restrict` row (`@local/dsh-architect-preset`). |
| [`package.json`](./package.json) | Profile manifest: the ordered `dsh.profile.bundles` list and the dependencies. The `@local` preset and the router/plugin tarballs (`dsh-tier-router`, `obsidian-task-sync`, `usage-popup`, `plugin-launcher`) are `link:`/`file:` references into this repository that must be adjusted after restore. |
| [`pnpm-lock.yaml`](./pnpm-lock.yaml) | Lockfile for the profile dependencies, including the `link:`/`file:` resolutions. Regenerate with `pnpm install` after changing any local path. |
| [`pnpm-workspace.yaml`](./pnpm-workspace.yaml) | pnpm settings: a single-package workspace (`.`), `nodeLinker: hoisted`, `autoInstallPeers: false`. |
| [`compatibility.json`](./compatibility.json) | Extra DSH compatibility pin: `{"dsh-tier-router@0.6.0": ["0.2.2-rc.1"]}`. |
| [`../global/agent_rules.md`](../global/agent_rules.md) | Human-readable copy of the master/subagent operating rules that are applied through runtime memory. DSH does **not** auto-load this path; it exists so the rules are reviewable and versioned. |

## How It Works & Wiring

- **Entrypoints & Mounting:** DSH loads the profile directory (`~/.dsh/profiles/desktop` by default). `cordis.yml` is the root row list, but it is empty on purpose; the effective tree is `package.json` → `dsh.profile.bundles` (in order), then `cordis.patch.yml`, then any `--patch` overlay passed to `dsh web`/the desktop app.
- **Bundle order matters:** `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` come first, then the feature packages (`dsh-code-index`, `dsh-mnemon`, `obsidian-task-sync`, `dsh-ops`, `dsh-plugin-save-token`, `dsh-tier-router`, `usage-popup`, `plugin-launcher`), then `@local/dsh-architect-preset` last so its preset row is registered after the base UI. The sidebar now shows a single **Plugin Tools** button from `plugin-launcher`; `usage-popup` and `obsidian-task-sync` register their tools into it instead of mounting their own sidebar cells.
- **Profile-level restriction row:** the `architect-tool-restrict` insert is in the profile patch, not in the preset, because a preset realm resolves its rows against the install base and cannot mount a `@local/*` package. The row filters tools per agent/preset inside the running profile.
- **Defaults:** `agent-default-model` selects the DeepSeek account provider, `deepseek-flash`, and `reasoningEffort: low` as the routine default. The Architect preset hook raises the main agent to `high` and forces lineage workers to `low`; see [`../../presets/architect-preset/OVERVIEW.md`](../../presets/architect-preset/OVERVIEW.md).
- **Related Docs & References:** [`../../AGENTS.md`](../../AGENTS.md) has the global restore/restart procedure and caveats; [`../../README.md`](../../README.md) is the human-facing setup guide; [`../../presets/architect-preset/OVERVIEW.md`](../../presets/architect-preset/OVERVIEW.md), [`../../plugins/plugin-launcher/OVERVIEW.md`](../../plugins/plugin-launcher/OVERVIEW.md), [`../../plugins/usage-popup/OVERVIEW.md`](../../plugins/usage-popup/OVERVIEW.md), [`../../plugins/obsidian-task-sync/OVERVIEW.md`](../../plugins/obsidian-task-sync/OVERVIEW.md), [`../../packages/dsh-tier-router/OVERVIEW.md`](../../packages/dsh-tier-router/OVERVIEW.md), and [`../../skills/modern-web-guidance/OVERVIEW.md`](../../skills/modern-web-guidance/OVERVIEW.md) document the features this profile mounts.

## Build, Verification & Caveats

- **Install the profile dependencies** from this directory after restoring it and fixing the local paths:

  ```bash
  cd profiles/desktop
  pnpm install
  ```

  This regenerates `node_modules` and `pnpm-lock.yaml`. The profile expects DSH `^0.2.2-rc.1`, Node ≥ 20, and pnpm 11.x.
- **Validate the manifests** without starting DSH:

  ```bash
  node -e "JSON.parse(require('fs').readFileSync('profiles/desktop/package.json','utf8')); JSON.parse(require('fs').readFileSync('profiles/desktop/compatibility.json','utf8')); console.log('ok')"
  node -e "require('node:fs').readFileSync('profiles/desktop/cordis.patch.yml','utf8')" # then review the YAML rows
  ```

- **Absolute source-machine paths:** `package.json` and `pnpm-lock.yaml` contain `C:/Users/Administrator/...` `link:`/`file:` references (`presets/architect-preset`, `packages/dsh-tier-router/dsh-tier-router-0.6.0.tgz`, `plugins/obsidian-task-sync/obsidian-task-sync-0.1.0.tgz`, `plugins/usage-popup/usage-popup-0.3.0.tgz`, `plugins/plugin-launcher/plugin-launcher-0.1.0.tgz`). Replace them with the target machine's checkout paths and re-run `pnpm install`.
- **Do not put customization in `cordis.yml`.** It must stay `[]`; every override belongs in `cordis.patch.yml`.
- **Restart requirement:** plugin composition and the preset registry are read at startup. Changes need a **full DSH restart** (quit from the tray, not a page refresh), and an existing session keeps its old preset — start a **new session** to pick up the Architect preset.
- **dsh-ops preset conflict:** on a fresh install, rename or remove `node_modules/dsh-ops/presets/ops-ptc.patch.yml` before starting DSH. A `disabled: true` row cannot remove an existing preset; only removing the patch file works. See [`../../AGENTS.md`](../../AGENTS.md) for the exact command.
- **Missing `@local` package:** if `@local/dsh-architect-preset` is not installed/resolvable, remove the `architect-tool-restrict` insert and reset the registry config, or the profile may fail to load.
