# DSH Plugin Monorepo

A single Git monorepo for my DeepSeek Harness (DSH) plugins, harness configurations, and
whatever I build next. Every plugin is an independent package in its own directory; the repo
root only holds shared housekeeping (this README, `.gitignore`, `.dsh/` configs).

## Contents

| Path | What it is |
| --- | --- |
| `usage-popup/` | Usage Ledger — a DSH Web UI plugin that renders a usage/ledger popup. |
| `obsidian-task-sync/` | Obsidian Task Sync — syncs task checklists between DSH and an Obsidian vault. |
| `obsidian-vault/` | Sample/mirror Obsidian vault used by the task-sync plugin. |
| `.dsh/` | DSH working configuration, including `agent_rules.md` (agent operating rules). |
| `MEMORY.md` | DSH runtime memory, mirrored into the repo so it travels with the configs. |

Each plugin directory is self-contained (`package.json`, `src/`, `scripts/`, `tests/`) and is
built/packed on its own:

```bash
cd usage-popup            # or obsidian-task-sync
npm install
npm run build             # emits dist/
npm pack                  # emits <plugin>-<version>.tgz
```

The packed `.tgz` bundles are committed on purpose — that is what gets installed into a
harness profile — so they are deliberately **not** ignored by Git.

## Adding a new plugin

1. Create `my-plugin/` with its own `package.json` and `cordis.patch.yml`.
2. Keep build output in `dist/` (ignored) and install bundles as `*.tgz` (tracked).
3. Add a row to the table above.

## Repository rules

`.gitignore` excludes `node_modules/`, `dist/`, `.env`, and `.probe/`, and contains explicit
negations (`!*.tgz`, `!.dsh/agent_rules.md`, `!MEMORY.md`) so release tarballs and harness
config/memory are always versioned.

## Credits / Acknowledgments

This repo's tooling stands on the work of the DSH optimization stack authors:

- **`dsh-code-index`** — by **lemonxiny55**
- **`dsh-plugin-save-token`** — by **vibe-any**
- **`dsh-tier-router`** — by **zhangzhangco**
- **`dsh-ops`** — by **T-Auto**
- **`dsh-mnemon`** — by **omdsh-dev**

Thanks for making the harness cheaper, faster, and considerably less tedious to operate.
