import { writeFileSync } from 'node:fs'

export const name = 'architect-tool-restrict'
// `tools` is the only hard dependency: the enforcement guard must be
// registered on the tools service itself. `agentPresets` is read lazily.
export const inject = ['tools']

// Main architect: no file/shell/inspection/workflow surface at all.
const DENY = [
  'ops_bash',
  'bash',
  'pwsh',
  'powershell',
  'shell',
  'exec',
  'read',
  'ops_read_files',
  'read_file',
  'write',
  'write_file',
  'edit',
  'multiedit',
  'apply_patch',
  'grep',
  'glob',
  'ops_grep',
  'ops_glob',
  'ops_inspect_local_file',
  'workflow',
  'tool_workflow',
  'code_map',
  'code_index',
  'code_change_context',
]

// Workers keep file/shell tools but never re-delegate or touch role tooling.
const WORKER_DENY = [
  'subagent',
  'subagent_fork',
  'delegate',
  'code_map',
  'code_index',
  'code_change_context',
  'todo_write',
  'workflow',
  'tool_workflow',
  'load_workspace_dependencies',
  'interrupt_agent',
  'list_agents',
  'send_message',
  'mnemon_document_create',
  'mnemon_document_manage',
  'mnemon_document_search',
  'mnemon_memory_body_create',
  'mnemon_memory_body_merge',
  'mnemon_memory_body_update',
  'mnemon_forget',
  'mnemon_link',
  'mnemon_remember',
  'mnemon_view_action',
  'mnemon_view_route',
]

const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'delegate'])
const PENDING_TTL_MS = 5 * 60 * 1000
const MAX_PENDING = 16
// Tool calls are never counted or capped: workers make as many sequential
// cached calls as the task needs, and the static contract keeps the session
// prefix cache warm across all of them. Only the delegation queue is bounded.
// Oversized tool results are head+tail truncated in the `tools/post-execute`
// waterfall, i.e. after execution but before they are committed to history.
// 64 KB lets a normal source file through intact; above that, 24 KB of each end
// is kept so a worker does not have to re-read the file in chunks.
const MAX_RESULT_BYTES = 65536
const RESULT_HEAD_BYTES = 24576
const RESULT_TAIL_BYTES = 24576

// Role -> reasoning effort, applied to the Agent's RECORDED model selection
// (`agent.model.select()`) before its first step. DSH resolves the effort for a
// request in `AgentLoop.preStep()` (`this.model.current()`) and then REQUIRES
// the `agent/request` waterfall to leave `reasoningEffort` untouched (it throws
// otherwise), so the selection must be corrected before step preparation.
//
// DeepSeek advertises exactly off | low | high | max; the wire API folds
// `medium` into `high`, so `low` is the only native level that actually cuts
// worker reasoning tokens while thinking stays enabled. `high` is the cap for
// the Architect: `max` is never sent.
const ARCHITECT_EFFORT = 'high'
const WORKER_EFFORT = 'low'

const ROSTER_DUMP =
  'C:/Users/Administrator/Documents/deepseek-harness/default-workspace/architect-preset/.roster.json'
const DIAG_DUMP =
  'C:/Users/Administrator/Documents/deepseek-harness/default-workspace/architect-preset/.diag.json'

const MAIN_DENY_REASON = (toolName) =>
  `ROLE VIOLATION: the Architect main agent has no file/shell/inspection tools. ` +
  `"${toolName}" is blocked. Delegate this work to a subagent with the exact paths, ` +
  'exact commands, and the required output.'

const WORKER_DENY_REASON = (toolName) =>
  `NOT PERMITTED FOR WORKERS: "${toolName}" is reserved for the Architect main agent. ` +
  'Do not delegate, plan, write documents, or call management tools. Finish the assigned ' +
  'task with file/shell tools and return a compact completion receipt.'

// Two disjoint static role contracts. Each agent receives exactly the section
// for its role, so every role's system prompt is a fixed byte string and the
// prefix cache is only invalidated by a role change, never by call counts or
// session identity.
const ARCHITECT_CONTRACT = [
  'ARCHITECT ROLE CONTRACT — the main agent has no file, shell, or repo-index tools.',
  '',
  '- Delegation is your only action: call subagent (or subagent_fork) with a complete brief.',
  '- Name the exact files/paths, exact commands, and the verification criteria; state the',
  '  required output. Do not write speculative code.',
  '- Give each worker a closed list: "Do not explore beyond this list; no broad searches,',
  '  no unrelated tests."',
  '- Prefer subagent over subagent_fork unless the full conversation history is strictly',
  '  needed: subagent gives each worker a clean, cache-friendly prefix.',
  '- For routine tasks use a single worker plus your own verification; do not spawn redundant',
  '  multi-worker review chains.',
  '- Emit zero narration before tool calls: call the tool directly.',
  '- Keep the final response concise: result, files changed, verification, remaining risks.',
].join('\n')

const WORKER_CONTRACT = [
  'WORKER ROLE CONTRACT — stay strictly inside the assigned task.',
  '',
  '- Prefer frequent, small, targeted tool calls (glob, grep, line-ranged read, edit) over',
  '  giant monolithic shell scripts.',
  '- Emit zero prose between tool calls: call the next tool directly.',
  '- Read only the files named in the task or unambiguously required; at most one discovery',
  '  call. No code_map, no code_index, no repo-wide grep/glob, no unrelated tests.',
  '- Prefer targeted edit over full-file write rewrites: every written byte costs output',
  '  tokens. No plans, todos, documents, or subagents.',
  '- No tool-call cap applies; keep each call small, sequential, and cache-friendly.',
  '- Return only a compact completion receipt: files changed, commands with exit codes, and',
  '  the verification outcome. Never paste full file contents.',
  '- If blocked or ambiguous, stop and report immediately; do not guess or explore.',
].join('\n')

const DELEGATION_BUSY =
  'DELEGATION REJECTED: too many queued workers. Wait for the current workers to finish, or ' +
  'split the work into fewer delegations.'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`architect-tool-restrict: ${message}`)
  } catch {
    // logging must never break agent creation or tool dispatch
  }
}

/** Render text-block tool content for sizing; undefined when content is not all text. */
function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
      return undefined
    }
    parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Head+tail truncation for one oversized tool result. Only the result currently
 * being committed changes: prior turns are already durable session history and
 * are never rewritten. Structured (non-text) content is left intact rather than
 * corrupted.
 */
function truncatedToolResultContent(content) {
  const text = toolResultText(content)
  if (text === undefined) return undefined
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= MAX_RESULT_BYTES) return undefined
  const head = buffer.subarray(0, RESULT_HEAD_BYTES).toString('utf8')
  const tail = buffer.subarray(buffer.length - RESULT_TAIL_BYTES).toString('utf8')
  const omitted = buffer.length - RESULT_HEAD_BYTES - RESULT_TAIL_BYTES
  const marker =
    `\n\n[... TRUNCATED ${omitted} of ${buffer.length} bytes of this tool result; ` +
    'head and tail preserved ...]\n\n'
  return [{ type: 'text', text: `${head}${marker}${tail}` }]
}

/** Keep an accepted post-execute decision but bound its eventual history content. */
function applyResultTruncation(decision, result) {
  if (!decision || decision.kind !== 'accept') return decision
  // A `value` replacement is re-materialized by the definition; leave it alone.
  if (Object.hasOwn(decision, 'value')) return decision
  try {
    const content = Object.hasOwn(decision, 'content') ? decision.content : result?.content
    const bounded = truncatedToolResultContent(content)
    return bounded === undefined ? decision : { ...decision, content: bounded }
  } catch {
    // truncation is best-effort and must never break a tool result
    return decision
  }
}

/**
 * Register the `tools/post-execute` waterfall listener for one agent. This is
 * the only point where a result can be MUTATED/REPLACED before history: the
 * accepted decision's `content` is what the batch settlement later appends as
 * the `tool/result` session event. The listener is agent-scoped, so it sees only
 * this agent's current result and never touches prior turns.
 */
function installResultTruncation(ctx, agent) {
  const host = agent?.ctx
  if (!host || typeof host.on !== 'function') return []
  const listener = (exec, result, next) => {
    const downstream = typeof next === 'function' ? next() : { kind: 'accept' }
    if (downstream && typeof downstream.then === 'function') {
      return downstream.then((decision) => applyResultTruncation(decision, result))
    }
    return applyResultTruncation(downstream, result)
  }
  try {
    const dispose = host.on('tools/post-execute', listener)
    return typeof dispose === 'function' ? [dispose] : []
  } catch (error) {
    warn(ctx, `post-execute hook failed: ${errorMessage(error)}`)
    return []
  }
}

async function dumpRoster(ctx) {
  try {
    const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    if (!presets?.list) return
    const list = await presets.list()
    const interesting = list.map((preset) => ({
      id: preset.id,
      name: preset.name,
      broken: preset.broken ?? null,
    }))
    writeFileSync(ROSTER_DUMP, JSON.stringify(interesting, null, 2))
  } catch (error) {
    warn(ctx, `roster dump failed: ${errorMessage(error)}`)
  }
}

/**
 * The committed preset identity lives in the `agentPreset` SESSION PROJECTION
 * (`agentPresets.presetForSession(session)`); the registry documents that
 * reconstruction must never read the header. Header/options reads are only a
 * fallback for agent objects created before a projection is readable.
 */
function presetOf(ctx, agent) {
  try {
    const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    const projected = presets?.presetForSession?.(agent?.session)
    if (typeof projected === 'string' && projected.length > 0) return projected
  } catch {
    // fall through to the structural fields
  }
  const candidates = [
    agent?.options?.agentPreset,
    agent?.agentPreset,
    agent?.session?.header?.agentPreset,
    agent?.session?.meta?.agentPreset,
    agent?.session?.meta?.preset,
    agent?.options?.preset,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

// A delegated child is identified by its session lineage, not by tool names:
// the immutable session header records `parentSession` and a non-zero
// `delegationDepth` for every subagent, while a top-level main session has
// neither. This keeps the file/shell DENY list structurally main-only even if
// the delegation queue is empty or out of order.
function isSubagent(agent) {
  const header = agent?.session?.header
  const meta = agent?.session?.meta
  const depth = header?.delegationDepth ?? meta?.delegationDepth
  if (typeof depth === 'number' && depth > 0) return true
  const parent = header?.parentSession ?? meta?.parentSession
  return typeof parent === 'string' && parent.length > 0
}

/**
 * The reasoning effort this role must use, or undefined when the role has no
 * opinion (any non-architect session). `other` deliberately returns undefined:
 * the preset hook must leave Standard/OPTC sessions exactly as configured.
 */
function roleEffort(role) {
  if (role === 'main') return ARCHITECT_EFFORT
  if (role === 'worker') return WORKER_EFFORT
  return undefined
}

/** Current recorded selection of an Agent (`agent.model.current()`). */
function selectionOf(agent) {
  try {
    if (typeof agent?.model?.current === 'function') {
      const current = agent.model.current()
      if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
        return current
      }
    }
  } catch {
    // fall through to the creation options
  }
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  if (typeof provider === 'string' && typeof model === 'string') {
    return { provider, model, reasoningEffort: agent?.options?.reasoningEffort }
  }
  return undefined
}

/**
 * Effort ids the route actually advertises. `llm.prepareCall()` throws
 * `UNSUPPORTED_REASONING_EFFORT` for an explicit effort the model does not
 * list, so an unknown/unsupported route is left untouched rather than broken.
 * Returns undefined when the llm service cannot be inspected (unit tests, or a
 * surface without it), in which case the caller applies the role effort.
 */
async function advertisedEfforts(ctx, selection) {
  try {
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
    if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined
    const info = await llm.resolveModelInfo(selection.provider, selection.model)
    const efforts = info?.reasoning?.efforts
    if (!Array.isArray(efforts)) return []
    return efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string')
  } catch {
    // An unregistered/unknown route must not be guessed at.
    return []
  }
}

/**
 * Force the role's effort onto the Agent's recorded selection. DSH reads
 * `agent.model.current()` once per step, and `model.select()` appends a
 * `model/selection` event that becomes the pending choice, so applying this at
 * `agent/created` (before the first turn) makes every request of that agent use
 * the role level. It is idempotent: an already-correct selection is not
 * re-appended, so the session log stays stable across reconciles.
 *
 * @returns the applied effort id, or undefined when nothing was changed.
 */
async function applyRoleEffort(ctx, agent, role) {
  const target = roleEffort(role)
  if (target === undefined) return undefined
  const model = agent?.model
  if (!model || typeof model.select !== 'function') return undefined
  const selection = selectionOf(agent)
  if (!selection) return undefined
  if (selection.reasoningEffort === target) return target
  const efforts = await advertisedEfforts(ctx, selection)
  if (Array.isArray(efforts) && !efforts.includes(target)) return undefined
  model.select({ provider: selection.provider, model: selection.model, reasoningEffort: target })
  return target
}

function normalizeId(value) {
  return typeof value === 'string' ? value.replace(/^session-/, '') : value
}

/**
 * Names `tools.restrict()` will accept for this agent scope. DSH validates a
 * restriction against `view(scope).restrictableNames` (inherited globals and
 * ancestor registrations) — NOT against every visible definition, because a
 * scope-local registration cannot be restricted. Filtering against the global
 * `definitions()` (the previous behavior) therefore produced names that made
 * `restrict()` throw, and the throw was swallowed as a silent no-op.
 */
function restrictableNames(tools, agent) {
  const known = new Set()
  for (const scope of [agent, undefined]) {
    try {
      const view = typeof tools.view === 'function' ? tools.view(scope) : undefined
      const names = view?.restrictableNames
      if (names && typeof names[Symbol.iterator] === 'function') {
        for (const entry of names) known.add(entry)
      }
    } catch {
      // try the next view
    }
  }
  if (known.size === 0) {
    try {
      const defs = typeof tools.definitions === 'function' ? tools.definitions(agent) : undefined
      for (const def of defs ?? []) if (def && typeof def.name === 'string') known.add(def.name)
    } catch {
      // no usable view; restriction is skipped rather than guessed
    }
  }
  return known
}

function restrictTools(ctx, agent, names) {
  const tools = agent?.ctx?.tools
  if (!tools || typeof tools.restrict !== 'function') return []
  const known = restrictableNames(tools, agent)
  const deny = names.filter((toolName) => known.has(toolName))
  if (deny.length === 0) return []
  try {
    const dispose = tools.restrict({ deny })
    return typeof dispose === 'function' ? [dispose] : []
  } catch (error) {
    warn(ctx, `restrict failed: ${errorMessage(error)}`)
    return []
  }
}

function addSection(ctx, agent, section) {
  const systemPrompt =
    agent?.ctx?.systemPrompt ??
    (typeof agent?.ctx?.get === 'function' ? agent.ctx.get('systemPrompt') : undefined)
  if (!systemPrompt || typeof systemPrompt.section !== 'function') return []
  try {
    const dispose = systemPrompt.section(section)
    return typeof dispose === 'function' ? [dispose] : []
  } catch (error) {
    warn(ctx, `section ${section.name} failed: ${errorMessage(error)}`)
    return []
  }
}

function toolsOf(ctx) {
  try {
    const tools =
      ctx?.tools ?? (typeof ctx?.get === 'function' ? ctx.get('tools') : undefined)
    if (tools && typeof tools.guard === 'function') return tools
  } catch {
    // fall through
  }
  return undefined
}

/**
 * Register the enforcement guard on the ROOT tools service. A guard belongs to
 * the scope of the context it is registered through; the root context is
 * unscoped, so the guard lands in the global layer and `tools.checkGuards()`
 * runs it for every agent. This is the one hook that needs neither
 * `agent/created` delivery nor an agent-scoped context, and a guard cannot be
 * re-allowed by a later policy listener.
 */
function installGlobalGuard(ctx, guard) {
  const root = ctx?.root ?? ctx
  const tools = toolsOf(root) ?? toolsOf(ctx)
  if (!tools) {
    warn(ctx, 'guard failed: tools service unavailable')
    return []
  }
  try {
    const dispose = tools.guard(guard)
    return typeof dispose === 'function' ? [dispose] : []
  } catch (error) {
    warn(ctx, `guard failed: ${errorMessage(error)}`)
    return []
  }
}

export function apply(ctx, config) {
  if (config?.dumpRoster !== false) setTimeout(() => void dumpRoster(ctx), 5000)

  const diagnostics = config?.diagnostics !== false

  const pending = []
  const states = new Map()
  const parentOf = new Map()
  const architectIds = new Set()
  const disposers = new Map()

  const diag = diagnostics
    ? {
        bootedAt: new Date().toISOString(),
        created: [],
        guard: [],
        switches: [],
        setups: [],
        efforts: [],
        disposals: 0,
      }
    : undefined

  const flushDiag = () => {
    if (!diag) return
    try {
      writeFileSync(DIAG_DUMP, JSON.stringify(diag, null, 2))
    } catch {
      // diagnostics must never affect behavior
    }
  }
  if (diag) flushDiag()

  const takePending = () => {
    const now = Date.now()
    while (pending.length > 0 && now - pending[0].at > PENDING_TTL_MS) pending.shift()
    return pending.shift()
  }

  const teardown = (key) => {
    const list = disposers.get(key)
    disposers.delete(key)
    for (let index = (list?.length ?? 0) - 1; index >= 0; index -= 1) {
      try {
        if (typeof list[index] === 'function') list[index]()
      } catch {
        // best-effort disposal
      }
    }
  }

  // A session's preset is NOT permanent: the UI selector calls
  // agentPresets.select(), which recomposes the agent in place and never
  // re-emits agent/created. Cache the derived role together with the preset it
  // was derived from, and re-derive as soon as that preset changes. (The old
  // code cached `other` forever, so an OPTC -> architect switch stayed both
  // unrestricted and unguarded.)
  const stateFor = (agent) => {
    const key = normalizeId(agent?.id ?? agent)
    const preset = presetOf(ctx, agent)
    const existing = states.get(key)
    if (existing && existing.preset === preset) return existing
    if (existing) {
      teardown(key)
      states.delete(key)
      if (diag) {
        diag.switches.push({
          id: String(key),
          from: existing.preset ?? null,
          to: preset ?? null,
          at: new Date().toISOString(),
        })
        if (diag.switches.length > 25) diag.switches.shift()
        flushDiag()
      }
    }

    const parent = normalizeId(
      agent?.session?.header?.parentSession ??
        agent?.session?.meta?.parentSession ??
        agent?.options?.parentSession,
    )
    if (parent !== undefined) parentOf.set(key, parent)

    let state
    if (isSubagent(agent)) {
      const lineage = preset === 'architect' || (parent !== undefined && architectIds.has(parent))
      if (!lineage) {
        state = { role: 'other', preset }
      } else {
        // Release the delegation slot the architect queued for this worker.
        takePending()
        state = { role: 'worker', preset }
      }
    } else if (preset === 'architect') {
      architectIds.add(key)
      state = { role: 'main', preset }
    } else {
      state = { role: 'other', preset }
    }

    states.set(key, state)
    if (diag) {
      diag.guard.push({
        id: String(key),
        role: state.role,
        preset: preset ?? null,
      })
      if (diag.guard.length > 25) diag.guard.shift()
      flushDiag()
    }
    return state
  }

  const agentsService = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    } catch {
      return undefined
    }
  }

  const findAgent = (id) => {
    try {
      return agentsService()?.get?.(id) ?? undefined
    } catch {
      return undefined
    }
  }

  // Guard registration is idempotent per execution object: the same guard can
  // live in the root layer AND in the agent's own scope (defense in depth), and
  // checkGuards() must not queue one delegation twice.
  const seen = new WeakSet()

  // Global enforcement: identical decisions to the per-agent setup below,
  // derived lazily from the calling agent on every tool call.
  const enforce = (exec) => {
    try {
      const agent = exec?.agent
      if (!agent) return undefined
      if (typeof exec === 'object' && exec !== null) {
        if (seen.has(exec)) return undefined
        seen.add(exec)
      }
      // Re-derive under the CURRENT preset and wire the realm a recompose just
      // mounted before the first decision for this call.
      setup(agent)
      const state = stateFor(agent)
      if (state.role === 'other') return undefined
      const toolName = typeof exec?.name === 'string' ? exec.name : undefined
      if (!toolName) return undefined

      if (state.role === 'main') {
        if (DELEGATION_TOOLS.has(toolName)) {
          // Untagged delegations are valid; only the outstanding queue is bounded.
          if (pending.length >= MAX_PENDING) return DELEGATION_BUSY
          pending.push({ at: Date.now() })
          return undefined
        }
        if (DENY.includes(toolName)) return MAIN_DENY_REASON(toolName)
        return undefined
      }

      if (WORKER_DENY.includes(toolName)) return WORKER_DENY_REASON(toolName)
      // No call-count cap: workers may keep making sequential cached calls.
      return undefined
    } catch (error) {
      warn(ctx, `delegation guard failed: ${errorMessage(error)}`)
      return undefined
    }
  }

  const wiring = new Set()

  // Register the SAME enforcement guard in the agent's own scope as well as the
  // root layer. A preset recompose (OPTC -> architect) swaps the realm the
  // agent dispatches through, so a root-only guard can be bypassed; the scoped
  // one always sits in the agent's chain. `seen` keeps the double registration
  // from double-counting.
  const registerScopedGuard = (agent) => {
    const tools = agent?.ctx?.tools
    if (!tools || typeof tools.guard !== 'function') return []
    try {
      const dispose = tools.guard(enforce)
      return typeof dispose === 'function' ? [dispose] : []
    } catch (error) {
      warn(ctx, `agent guard failed: ${errorMessage(error)}`)
      return []
    }
  }

  const setup = (agent) => {
    const key = normalizeId(agent?.id ?? agent)
    if (wiring.has(key)) return
    const state = stateFor(agent)
    if (state.role === 'other') {
      // Switching away from architect lifts the old restriction/guard instead
      // of silently keeping the session narrowed.
      teardown(key)
      return
    }
    if (disposers.has(key)) return
    const names = state.role === 'main' ? DENY : WORKER_DENY
    wiring.add(key)
    try {
      // Enforcement inside the agent's scope (defense in depth).
      const scopedGuards = registerScopedGuard(agent)
      // Schema-level narrowing (what the model can see). `agent.ctx.tools` is
      // the only context DSH accepts for `restrict()`.
      const restrictions = restrictTools(ctx, agent, names)
      // Exactly one static role contract goes into the deterministic section
      // position, so each role's prompt prefix is fixed and role-specific.
      const sections = addSection(ctx, agent, {
        name: 'architect:role-contract',
        order: 2690,
        text: state.role === 'main' ? ARCHITECT_CONTRACT : WORKER_CONTRACT,
      })
      // Post-execute truncation: the only pre-history mutation point. It runs on
      // this agent's current result only, never on already committed turns.
      const postExecute = installResultTruncation(ctx, agent)
      const list = [...scopedGuards, ...restrictions, ...sections, ...postExecute]
      disposers.set(key, list)
      if (diag) {
        diag.setups.push({
          id: String(key),
          role: state.role,
          preset: state.preset ?? null,
          guards: scopedGuards.length,
          restrictions: restrictions.length,
          sections: sections.length,
          at: new Date().toISOString(),
        })
        if (diag.setups.length > 25) diag.setups.shift()
        flushDiag()
      }
      warn(ctx, `${state.role} architect wired (preset=${state.preset ?? 'unknown'})`)
    } finally {
      wiring.delete(key)
    }
  }

  /**
   * Derive the role from the CURRENT preset/lineage and force its reasoning
   * effort. Awaited from `agent/created` (DSH's serial creation dispatch waits
   * for listeners), so a worker's very first step already runs at `low`.
   * Diagnostics record the transition, never the contracts.
   */
  const applyEffort = async (agent) => {
    try {
      const state = stateFor(agent)
      const before = selectionOf(agent)?.reasoningEffort
      const applied = await applyRoleEffort(ctx, agent, state.role)
      if (diag && applied !== undefined) {
        diag.efforts.push({
          id: String(normalizeId(agent?.id ?? agent)),
          role: state.role,
          from: before ?? null,
          to: applied,
          at: new Date().toISOString(),
        })
        if (diag.efforts.length > 25) diag.efforts.shift()
        flushDiag()
      }
      return applied
    } catch (error) {
      warn(ctx, `reasoning effort hook failed: ${errorMessage(error)}`)
      return undefined
    }
  }

  // Root-scoped listener: the profile context can be a sibling of agent
  // scopes, but a root listener is unscoped and receives every `scopeTarget`
  // dispatch (agent/created and agent/disposed).
  const host = typeof ctx?.root?.on === 'function' ? ctx.root : ctx
  try {
    host.on('agent/created', async payload => {
      try {
        const agent = payload?.agent
        if (diag) {
          diag.created.push({
            id: String(agent?.id ?? 'unknown'),
            preset: presetOf(ctx, agent) ?? null,
            subagent: isSubagent(agent),
            at: new Date().toISOString(),
          })
          if (diag.created.length > 25) diag.created.shift()
          flushDiag()
        }
        setup(agent)
        // Serial creation dispatch awaits this listener, so the selection is
        // recorded before the agent's first step resolves its effort.
        await applyEffort(agent)
      } catch (error) {
        warn(ctx, `agent/created failed: ${errorMessage(error)}`)
      }
    })
  } catch (error) {
    warn(ctx, `agent/created listener failed: ${errorMessage(error)}`)
  }

  // The preset selector calls agentPresets.select(), which recomposes a live
  // agent in place: no agent/created is emitted, so the cached role has to be
  // invalidated here. Hooks: the registry's semantic event, the raw session
  // event it is derived from, and tools/change (emitted by recompose).
  const onPresetSelected = (sessionId, preset) => {
    try {
      const raw = typeof sessionId === 'string' ? sessionId : sessionId?.id
      if (typeof raw !== 'string') return
      const agent = findAgent(raw) ?? findAgent(`session-${raw}`)
      if (diag) {
        diag.switches.push({
          id: String(normalizeId(raw)),
          from: null,
          to: preset ?? null,
          event: 'agent-preset/selected',
          at: new Date().toISOString(),
        })
        if (diag.switches.length > 25) diag.switches.shift()
        flushDiag()
      }
      if (!agent) return
      const key = normalizeId(raw)
      states.delete(key)
      teardown(key)
      setup(agent)
      // The switch starts the next turn after this handler returns, so the
      // new role effort is recorded before that turn's step preparation.
      void applyEffort(agent)
    } catch (error) {
      warn(ctx, `preset switch failed: ${errorMessage(error)}`)
    }
  }

  // tools/change fires on recompose (and on tool-layer mutations). Defer the
  // reconciliation so our own restrict()/teardown() effects settle first.
  let scheduled = false
  const reconcileAll = () => {
    if (scheduled) return
    scheduled = true
    const run = () => {
      scheduled = false
      let agents = []
      try {
        agents = agentsService()?.list?.() ?? []
      } catch {
        return
      }
      for (const agent of agents) {
        try {
          setup(agent)
          void applyEffort(agent)
        } catch (error) {
          warn(ctx, `reconcile failed: ${errorMessage(error)}`)
        }
      }
    }
    if (typeof queueMicrotask === 'function') queueMicrotask(run)
    else void Promise.resolve().then(run)
  }

  try {
    host.on('agent-preset/selected', onPresetSelected)
  } catch (error) {
    warn(ctx, `agent-preset/selected listener failed: ${errorMessage(error)}`)
  }
  try {
    host.on('session/event', (session, event) => {
      if (event?.type === 'agent-preset/selected') {
        onPresetSelected(session?.id ?? session, event.data?.agentPreset)
      }
    })
  } catch (error) {
    warn(ctx, `session/event listener failed: ${errorMessage(error)}`)
  }
  try {
    host.on('tools/change', reconcileAll)
  } catch (error) {
    warn(ctx, `tools/change listener failed: ${errorMessage(error)}`)
  }

  try {
    host.on('agent/disposed', payload => {
      try {
        const agent = payload?.agent
        const key = normalizeId(agent?.id ?? agent)
        if (diag) {
          diag.disposals += 1
          flushDiag()
        }
        states.delete(key)
        teardown(key)
      } catch {
        // disposal must never break agent teardown
      }
    })
  } catch (error) {
    warn(ctx, `agent/disposed listener failed: ${errorMessage(error)}`)
  }

  installGlobalGuard(ctx, enforce)
}

// Unit-test surface (ignored by the Cordis loader).
export const internal = {
  DENY,
  WORKER_DENY,
  ARCHITECT_CONTRACT,
  WORKER_CONTRACT,
  ARCHITECT_EFFORT,
  WORKER_EFFORT,
  roleEffort,
  selectionOf,
  advertisedEfforts,
  applyRoleEffort,
  MAX_RESULT_BYTES,
  RESULT_HEAD_BYTES,
  RESULT_TAIL_BYTES,
  isSubagent,
  normalizeId,
  presetOf,
  restrictableNames,
  MAX_PENDING,
  MAIN_DENY_REASON,
  WORKER_DENY_REASON,
  DELEGATION_BUSY,
  truncatedToolResultContent,
}
