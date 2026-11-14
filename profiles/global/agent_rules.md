# Agent Operating Rules — Master/Subagent Architecture

**Status:** authoritative for this workspace. Applied via runtime memory (`MEMORY.md`), which is
re-injected into every turn. This file is the human-readable copy.

> Note: DSH does not auto-load this path. The binding copy lives in runtime memory; this file
> exists so the rules are reviewable and version-controlled.

---

## 1. Delegated Execution (`dsh-tier-router`)

- Dispatch terminal commands, directory listings, and broad file sweeps through the **`subagent`**
  tool (the installed equivalent of `tier_worker`).
- **NEVER** recursively scan subdirectories or open multiple arbitrary project files in the main
  session context.
- Keep the main context as the *coordinator*: delegate the work, receive a digest, act on the digest.

**Correction of record:** `dsh-tier-router` / `tier_worker` / a Gemini subagent are **not installed**
in this profile (verified against all 215 plugin entries). The capability maps to `subagent` /
`subagent_fork`.

---

## 2. Codebase Mapping (`dsh-code-index`)

- Use `code_map`, `code_index`, `code_search`, `code_symbols`, and `code_refs` for unfamiliar
  structure instead of speculative `grep`/`find` loops.
- AST symbol lookup before reading files: locate the definition first, then read only that range.

**Correction of record:** no plugin is named `dsh-code-index`; the tools above are present and are
the correct mechanism.

---

## 3. Context & Cache Protection (`dsh-plugin-save-token` & `dsh-ops`)

- Keep primary context clean to preserve server-side prompt-cache hit ratio (target ≥ 90%).
- When digesting worker results, ingest **only 3–5 line distilled summaries** — never raw output
  dumps or full logs.
- Prefer bounded, offset/limit reads over whole-file dumps; let `save-token` compression stand
  rather than expanding a compressed blob unless a specific detail is actually needed.

---

## 4. Focused File Access

- Operate strictly within the scope the user requested, or on specific file paths given in the prompt.
- No opportunistic exploration outside that scope. If a wider scan is genuinely required, delegate
  it and report only the distilled finding.
