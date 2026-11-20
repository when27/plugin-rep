# modern-web-guidance Skill

A searchable modern-web best-practice skill for DeepSeek Harness: `SKILL.md` tells an agent to search, retrieve, and apply guidance before writing HTML/CSS/client-side JS, and `guides/` ships 209 categorized guidance files. DSH discovers it as `<skills-root>/modern-web-guidance/SKILL.md` and loads the manifest only; the guides are retrieved on demand through the `modern-web-guidance` CLI.

## File Dictionary

| File | Purpose |
| --- | --- |
| [`SKILL.md`](./SKILL.md) | The skill manifest and instructions: YAML frontmatter (`name`, trigger-heavy `description`), the search → retrieve → apply → disclose workflow, query-writing rules, `npx`/`pnpx` usage, fallbacks/browser-support policy, and the `legacy-scan` modernization flow. DSH skill discovery requires this exact filename at this depth. |
| [`guides/`](./guides/) | 209 guide files in 17 category folders. Each guide is a Markdown document with frontmatter; the CLI searches their metadata and `retrieve` returns the full text. The category folders and representative files are listed below. |
| [`OVERVIEW.md`](./OVERVIEW.md) | This feature dictionary. |

### `guides/` categories

| Category | Files | Representative file |
| --- | --- | --- |
| [`guides/accessibility/`](./guides/accessibility/) | 4 | [`accessibility.md`](./guides/accessibility/accessibility.md) |
| [`guides/built-in-ai/`](./guides/built-in-ai/) | 5 | [`language-detection.md`](./guides/built-in-ai/language-detection.md) |
| [`guides/css/`](./guides/css/) | 18 | [`animate-to-intrinsic-sizes.md`](./guides/css/animate-to-intrinsic-sizes.md) |
| [`guides/forms/`](./guides/forms/) | 19 | [`animated-select-picker.md`](./guides/forms/animated-select-picker.md) |
| [`guides/html/`](./guides/html/) | 8 | [`accessible-web-components.md`](./guides/html/accessible-web-components.md) |
| [`guides/js/`](./guides/js/) | 5 | [`calculate-event-differentials.md`](./guides/js/calculate-event-differentials.md) |
| [`guides/performance/`](./guides/performance/) | 26 | [`batch-analytics-events.md`](./guides/performance/batch-analytics-events.md) |
| [`guides/privacy/`](./guides/privacy/) | 1 | [`privacy.md`](./guides/privacy/privacy.md) |
| [`guides/pwa/`](./guides/pwa/) | 2 | [`install-web-app.md`](./guides/pwa/install-web-app.md) |
| [`guides/security/`](./guides/security/) | 17 | [`client-side-encryption.md`](./guides/security/client-side-encryption.md) |
| [`guides/ui-atoms/`](./guides/ui-atoms/) | 13 | [`carousel-slide-effects.md`](./guides/ui-atoms/carousel-slide-effects.md) |
| [`guides/ui-behaviors/`](./guides/ui-behaviors/) | 40 | [`2d-panning.md`](./guides/ui-behaviors/2d-panning.md) |
| [`guides/ui-components/`](./guides/ui-components/) | 22 | [`accordion.md`](./guides/ui-components/accordion.md) |
| [`guides/user-experience/`](./guides/user-experience/) | 3 | [`content-first-noise-reduction.md`](./guides/user-experience/content-first-noise-reduction.md) |
| [`guides/visual-design/`](./guides/visual-design/) | 22 | [`adapt-scrollbar-to-contrast-preferences.md`](./guides/visual-design/adapt-scrollbar-to-contrast-preferences.md) |
| [`guides/wasm/`](./guides/wasm/) | 1 | [`cpp-on-the-web.md`](./guides/wasm/cpp-on-the-web.md) |
| [`guides/webmcp/`](./guides/webmcp/) | 3 | [`agentic-forms.md`](./guides/webmcp/agentic-forms.md) |

Total: 209 guides + `SKILL.md` = 210 runtime files. Adding this `OVERVIEW.md` makes 211 files in the folder (2,024,335 bytes); the skill payload itself is 2,018,207 bytes, as measured on the source machine.

## How It Works & Wiring

- **Entrypoints & Discovery:** DSH scans these roots in priority order (lower number wins): 1. `<projectRoot>/.dsh/skills` (100), 2. `<projectRoot>/.agents/skills` (200), 3. `customSkillDirs` (300), 4. `~/.dsh/skills` (400), 5. `agentsHome/skills` (500), 6. bundled skills (600). The layout is `<root>/<name>/SKILL.md` with a kebab-case directory; DSH performs **no recursive discovery** below the skill folder, so `SKILL.md` and `guides/**` must stay at exactly this nesting depth.
- **No profile change needed:** the active profile mounts `skill` / `skill-filesystem` / `tool-skill` through `@deepseek-ai/dsh-base`; copying the directory into a discovery root is enough.
- **Key Mechanics:** the agent runs `npx -y modern-web-guidance@latest search "<query>" --skill-version 2026_11_09-5bcc021b` (2–5 action-oriented words per query), then `retrieve "<id>"` for the matching guide(s), and must apply the guide's Baseline/fallback rules. `legacy-scan <path> --json` is reserved for broad open-ended modernization, not for adding/fixing a named feature. On Windows use `npx.cmd`; prefer `pnpx` when pnpm is available; allowlist only `npx -y modern-web-guidance@latest *` (never bare `npx *`); use `--offline` if the command hangs offline.
- **Related Docs & References:** [`SKILL.md`](./SKILL.md) is the authoritative instruction file and covers query phrasing, retrieve behavior, disclosure requirements, browser-support policy, and `legacy-scan` in full. [`../../AGENTS.md`](../../AGENTS.md) keeps the restore steps for copying the skill into a discovery root.

## Build, Verification & Caveats

- **Verify the installed copy** (from the skill directory):

  ```bash
  # 209 guides + SKILL.md = 210 files, 2,018,207 bytes on the source machine
  find skills/modern-web-guidance -type f | wc -l
  ```

- **Smoke-test the CLI** (needs network/approval; exit 0 with JSON hits):

  ```bash
  npx -y modern-web-guidance@latest search "dialog modal"
  ```

- **Restore** by copying the whole folder into a discovery root; no profile config change:

  ```bash
  cp -r skills/modern-web-guidance ~/.dsh/skills/          # global
  cp -r skills/modern-web-guidance <project>/.dsh/skills/  # project-level
  ```

- **Do not flatten or nest the skill:** renaming `SKILL.md`, adding another directory level, or moving `guides/` breaks DSH discovery (`no recursive discovery`).
- **Do not rename the folder** away from kebab-case; the folder name is the skill name. `OVERVIEW.md` is documentation and is not part of the skill runtime.
- **CLI version pin:** the `--skill-version 2026_11_09-5bcc021b` value ties the CLI output to this guide snapshot; update it only if the bundled guides are regenerated.
