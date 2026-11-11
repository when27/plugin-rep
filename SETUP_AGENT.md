# Autonomous DSH Workspace Restoration Guide

**Target Audience:** AI Agent / DeepSeek Harness
**Objective:** Reconstruct the Master/Subagent optimization stack for this repository on a new host machine.

### 1. Version Exemption
Before installing plugins, you must force compatibility for the tier router. 
Write the following to `~/.dsh/profiles/desktop/compatibility.json`:
`{ "dsh-tier-router@0.6.0": ["0.2.2-rc.1"] }`

### 2. Plugin Installation
Install the following core operational plugins via your package manager:
* `dsh-tier-router@0.6.0` (Traffic routing & Master/Subagent delegation)
* `dsh-plugin-save-token@2.4.1` (Context compression)
* `dsh-ops@0.5.2` (Terminal/Git execution via niugit)
* `dsh-mnemon@0.5.43` (Vector memory checkpointing)
* `dsh-code-index@0.12.0` (`code_map` / `code_index` AST symbol mapping)

### 3. Provider & Router Configuration
Mount the tier router in the active profile and configure the fallback chain. The router registers as provider `tier-router`; the default agent model is wired through a `@deepseek-ai/dsh-agent-default-model` override in `cordis.patch.yml`.
Register the API keys under distinct provider names (`google-1`, `google-2`, `zhipu-1`, `zhipu-2`, `deepseek-account`).
Set the routing logic:
* `hard`: `deepseek-account`
* `easy`: `google-1` -> `google-2` -> `zhipu-1` -> `zhipu-2`
* Default Agent Model: `tier-router / smart` (reasoningEffort `high`)

### 4. Memory Restoration
The `agent_rules.md` file located in `.dsh/` must be respected. To restore persistent memory, copy the rules from `.dsh/agent_rules.md` and append them to the host's active `MEMORY.md` located in the DSH profile directory (outside this repository). 

**Execution Directive:** Do not use speculative file sweeping. Rely on `code_map` for architecture discovery and dispatch all terminal operations through the configured `subagent` tiers.
