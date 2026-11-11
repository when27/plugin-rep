# Autonomous DSH Workspace Restoration Guide

**Target Audience:** AI Agent / DeepSeek Harness
**Objective:** Reconstruct the Master/Subagent optimization stack for this repository on a new host machine.

### 1. Version Exemption
Before installing plugins, you must force compatibility for the tier router. 
Write the following to `~/.dsh/profiles/desktop/compatibility.json`:
`{ "dsh-tier-router@0.6.0": ["0.2.2-rc.1"] }`

### 2. Plugin Installation
Install the following core operational plugins via your package manager:
* `dsh-tier-router` (Traffic routing & Master/Subagent delegation)
* `dsh-plugin-save-token` (Context compression)
* `dsh-ops` (Terminal/Git execution via niugit)
* `dsh-mnemon` (Vector memory checkpointing)
* `dsh-code-index` / `code_map` (AST symbol mapping)

### 3. Provider & Router Configuration
Mount the tier router in the active profile and configure the fallback chain. 
Register the API keys under distinct provider names (`google-1`, `google-2`, `zhipu-1`, `zhipu-2`, `deepseek-account`).
Set the routing logic:
* `hard`: `deepseek-account`
* `easy`: `google-1` -> `google-2` -> `zhipu-1` -> `zhipu-2`
* Default Agent Model: `tier-router / smart`

### 4. Memory Restoration
The `agent_rules.md` file located in `.dsh/` must be respected. To restore persistent memory, copy the rules from `.dsh/agent_rules.md` and append them to the host's active `MEMORY.md` located in the DSH profile directory (outside this repository). 

**Execution Directive:** Do not use speculative file sweeping. Rely on `code_map` for architecture discovery and dispatch all terminal operations through the configured `subagent` tiers.
