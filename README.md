# DeepSeek Harness Setup Export (`plugin-rep`)

This repository is a secret-scrubbed export of a working **DeepSeek Harness (DSH)**
setup: a desktop profile configuration, a custom **Architect** agent preset, two local
plugins, a locally patched `dsh-tier-router` build, the patch files that produced it,
and the **modern-web-guidance** skill. Its purpose is to let you restore and reproduce
this setup on another machine.

- **Export date:** 2026-11-13
- **Source machine:** Windows x64; DSH Desktop 0.2.2-rc.1, Node 24.21.0, pnpm 11.28.5
- **Not included:** `node_modules`, build output and caches, logs, crash dumps, `*.bak*`,
  SQLite/DB files, credential/auth/cookie files, `.env`/`.npmrc`/`.netrc`.

## What is in here

| Path | What it is |
| --- | --- |
| `profiles/` | DSH profile configuration: the desktop profile (plugin composition patch, manifest, lockfile, compatibility pin) and the global agent rules copy. |
| `presets/architect-preset/` | Source of the **Architect** agent preset: the restriction plugin, its preset definition, package manifest, and a dependency-free smoke test. |
| `plugins/usage-popup/` | Local client plugin: a global sidebar-launched token/cost ledger panel with per-chat history selection. |
| `plugins/obsidian-task-sync/` | Local plugin that bridges an Obsidian vault (tasks, headings, tree points) into the web UI. |
| `patches/` | The two local patches applied to `dsh-tier-router` 0.6.0 (tier fallbacks and worker-usage fields). |
| `packages/` | `dsh-tier-router-0.6.0.tgz`, the patched build produced from those patches; the profile installs it via `file:`. |
| `skills/modern-web-guidance/` | A DSH skill with its manifest plus a large library of modern web guidance under `guides/`. |
| `architect-preset/`, `obsidian-task-sync/`, `usage-popup/`, `router-tarball/` | Working copies / build directories of the same components (superseded in part by the `presets/`, `plugins/` and `packages/` trees). |
| `.dsh/` | Project-local DSH state, including project-level skills. |
| `.dsh-work/`, `.dsh-code-index/`, `.probe/`, `.probe-extract/` | Local tooling and scratch output; not part of the restore set. |
| `.preset-probe.cjs`, `patches-draft.patch` | Ad-hoc helper script and a draft patch left over from the patch work. |

## How it is used

1. Install a compatible DSH (DSH Desktop `0.2.2-rc.1` or a compatible newer build).
2. Copy `profiles/desktop/*` into your DSH profiles directory, then fix the
   source-machine absolute `file:`/`link:` paths in `profiles/desktop/package.json`.
3. Rebuild and pack the two plugins from `plugins/*` (build artifacts are excluded from
   this export), then run `pnpm install` in the profile directory.
4. Resolve the `dsh-ops` preset conflict described in the agent instructions, and copy
   `skills/modern-web-guidance` into a DSH skill discovery root.
5. Restart DSH fully and start a new session so the **Architect** preset applies.

The full step-by-step restore procedure, the caveats, and the design notes for the
Architect preset live in the agent-facing instructions.

## Documentation

- **[AGENTS.md](AGENTS.md)** — the detailed setup, restore procedure, caveats and design
  notes. Agent operating rules are there too.
- [`plugins/obsidian-task-sync/README.md`](plugins/obsidian-task-sync/README.md) — plugin
  documentation (install, vault configuration, widget usage).
- [`skills/modern-web-guidance/SKILL.md`](skills/modern-web-guidance/SKILL.md) — the skill
  manifest and usage instructions.

---

Agents' operating rules now live in [AGENTS.md](AGENTS.md). This file is for humans.
