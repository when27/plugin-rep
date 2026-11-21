// Smoke tests for the Architect preset restriction plugin.
// Run: node architect-preset/smoke.test.mjs
//
// These tests exercise the mechanism DSH actually honors at runtime:
//   * one GLOBAL guard registered on the ROOT tools service, which decides
//     from exec.agent (no agent/created delivery required);
//   * per-agent `agent.ctx.tools.restrict()` for schema narrowing, filtered by
//     `view(scope).restrictableNames` (DSH throws on names that are not
//     restrictable, which used to be swallowed as a silent no-op);
//   * preset identity from the `agentPreset` session projection, not the header;
//   * an agent-scoped `tools/post-execute` waterfall listener that bounds the
//     current result's content before the batch settlement appends it to the
//     `tool/result` history event (prior turns are never mutated);
//   * no tool-call count cap: workers may keep making sequential cached calls.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, internal, name as pluginName, inject } from './index.js'

const SOURCE = readFileSync(new URL('./index.js', import.meta.url), 'utf8')

let passed = 0
const failures = []

function test(title, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok ${passed} - ${title}`)
  } catch (error) {
    failures.push(title)
    console.error(`not ok - ${title}`)
    console.error(String(error?.stack ?? error).split('\n').slice(0, 4).join('\n'))
  }
}

// Awaitable variant for the asynchronous creation path. Used with top-level
// await so the summary line still runs after every async check.
async function testAsync(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok ${passed} - ${title}`)
  } catch (error) {
    failures.push(title)
    console.error(`not ok - ${title}`)
    console.error(String(error?.stack ?? error).split('\n').slice(0, 4).join('\n'))
  }
}

const KNOWN = [
  'subagent',
  'subagent_fork',
  'subagent_control',
  'todo_write',
  'code_index',
  'code_map',
  'code_change_context',
  'read',
  'write',
  'edit',
  'apply_patch',
  'grep',
  'glob',
  'pwsh',
  'bash',
  'workflow',
  'list_agents',
  'send_message',
]

function makeTools(known = KNOWN) {
  const state = { restricted: [], guards: [], views: 0 }
  const service = {
    view() {
      state.views += 1
      return { restrictableNames: new Set(known) }
    },
    definitions() {
      return known.map((toolName) => ({ name: toolName }))
    },
    restrict(filter) {
      state.restricted.push(filter)
      return () => {}
    },
    guard(fn) {
      state.guards.push(fn)
      return () => {
        const index = state.guards.indexOf(fn)
        if (index >= 0) state.guards.splice(index, 1)
      }
    },
    state,
  }
  return service
}

const DEEPSEEK_EFFORTS = ['off', 'low', 'high', 'max']

function makeHost({
  known = KNOWN,
  projections = new Map(),
  tools = makeTools(known),
  // Effort ids the fake llm reports for every route. `null` means the route
  // advertises no reasoning capability; an array restricts it to those ids.
  efforts = DEEPSEEK_EFFORTS,
} = {}) {
  const listeners = new Map()
  const warns = []
  const liveAgents = new Map()
  const resolved = []
  const host = {
    tools,
    resolved,
    get(service) {
      if (service === 'tools') return tools
      if (service === 'agents') {
        return {
          get: (id) => liveAgents.get(id),
          list: () => [...liveAgents.values()],
        }
      }
      if (service === 'agentPresets') {
        return {
          presetForSession: (session) => projections.get(session?.id) ?? session?.header?.agentPreset ?? null,
          list: async () => [],
        }
      }
      if (service === 'llm') {
        return {
          async resolveModelInfo(provider, model) {
            resolved.push({ provider, model })
            if (efforts === null) return { provider, id: model }
            return {
              provider,
              id: model,
              reasoning: {
                efforts: efforts.map((id) => ({ id })),
                defaultEffort: efforts.includes('high') ? 'high' : undefined,
              },
            }
          },
        }
      }
      return undefined
    },
    on(event, callback) {
      const list = listeners.get(event) ?? []
      list.push(callback)
      listeners.set(event, list)
      return () => {}
    },
    logger: { warn: (message) => warns.push(message) },
  }
  host.root = host
  host.listeners = listeners
  host.warns = warns
  host.liveAgents = liveAgents
  return host
}

function makeAgent({
  id,
  preset,
  depth = 0,
  parent,
  host,
  restrictThrows = false,
  headerPreset = true,
  // Recorded model selection at creation. DSH's `agent/model` surface reads the
  // projection first and falls back to the creation options, so the fake keeps
  // one mutable recorded selection and logs every select() the plugin makes.
  provider = 'deepseek-account',
  model = 'deepseek-flash',
  effort = 'max',
}) {
  const restricted = []
  const sections = []
  const agentGuards = []
  const postHooks = []
  const selections = []
  let recorded = effort === undefined
    ? { provider, model }
    : { provider, model, reasoningEffort: effort }
  const agentTools = {
    view: host.tools.view,
    definitions: host.tools.definitions,
    restrict(filter) {
      if (restrictThrows) throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
      restricted.push(filter)
      return () => {}
    },
    guard(fn) {
      agentGuards.push(fn)
      return () => {
        const index = agentGuards.indexOf(fn)
        if (index >= 0) agentGuards.splice(index, 1)
      }
    },
  }
  const header = {
    ...(headerPreset && preset !== undefined ? { agentPreset: preset } : {}),
    ...(depth > 0 ? { delegationDepth: depth } : {}),
    ...(parent !== undefined ? { parentSession: parent } : {}),
  }
  const agentModel = {
    current() {
      return { ...recorded }
    },
    select(selection) {
      recorded = { ...selection }
      selections.push({ ...selection })
    },
  }
  const agent = {
    id,
    model: agentModel,
    options: { provider, model, reasoningEffort: effort },
    session: { id, header },
    ctx: {
      tools: agentTools,
      on(event, listener) {
        if (event === 'tools/post-execute') postHooks.push(listener)
        return () => {
          const index = postHooks.indexOf(listener)
          if (index >= 0) postHooks.splice(index, 1)
        }
      },
      systemPrompt: {
        section(section) {
          sections.push(section)
          return () => {}
        },
      },
    },
  }
  return { agent, restricted, sections, agentGuards, postHooks, selections }
}

// DSH announces an agent with `await ctx.serial(carrier, 'agent/created', ...)`:
// serial listeners may be async and creation waits for them. Mirror that so the
// effort tests observe exactly what runtime ordering guarantees.
const emitCreated = async (host, agent) => {
  host.liveAgents.set(agent.id, agent)
  for (const listener of host.listeners.get('agent/created') ?? []) await listener({ agent })
}
const emitDisposed = (host, agent) => {
  host.liveAgents.delete(agent.id)
  for (const listener of host.listeners.get('agent/disposed') ?? []) listener({ agent })
}
const emitPresetSelected = (host, sessionId, preset) => {
  for (const listener of host.listeners.get('agent-preset/selected') ?? []) listener(sessionId, preset)
}

// ---------------------------------------------------------------------------
// boot wiring
// ---------------------------------------------------------------------------
{
  const host = makeHost()
  apply(host, { dumpRoster: false, diagnostics: false })
  test('plugin exports the expected identity and injects tools', () => {
    assert.equal(pluginName, 'architect-tool-restrict')
    assert.deepEqual(inject, ['tools'])
  })
  test('registers exactly one enforcement guard on the ROOT tools service', () => {
    assert.equal(host.tools.state.guards.length, 1)
  })
  test('registers agent/created and agent/disposed listeners on the root context', () => {
    assert.equal((host.listeners.get('agent/created') ?? []).length, 1)
    assert.equal((host.listeners.get('agent/disposed') ?? []).length, 1)
  })
}

// ---------------------------------------------------------------------------
// architect main: schema narrowing + prompt contract
// ---------------------------------------------------------------------------
{
  const host = makeHost()
  apply(host, { dumpRoster: false, diagnostics: false })
  const { agent, restricted, sections, postHooks } = makeAgent({ id: 'main-1', preset: 'architect', host })
  emitCreated(host, agent)

  test('main restriction is applied through agent.ctx.tools (scoped context)', () => {
    assert.equal(restricted.length, 1)
    assert.ok(restricted[0].deny.includes('code_index'))
    assert.ok(restricted[0].deny.includes('code_map'))
    assert.ok(restricted[0].deny.includes('code_change_context'))
    assert.ok(restricted[0].deny.includes('read'))
    assert.ok(restricted[0].deny.includes('bash'))
  })

  test('main deny list only contains names DSH accepts as restrictable', () => {
    assert.equal(restricted[0].deny.includes('ops_bash'), false)
    for (const toolName of restricted[0].deny) assert.ok(KNOWN.includes(toolName), toolName)
  })

  test('main gets the static ARCHITECT_CONTRACT section, mutually exclusive', () => {
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'architect:role-contract')
    assert.equal(sections[0].order, 2690)
    assert.equal(sections[0].text, internal.ARCHITECT_CONTRACT)
    assert.match(sections[0].text, /Delegation is your only action/)
    assert.match(sections[0].text, /zero narration before tool calls/)
    assert.match(sections[0].text, /prefer subagent over subagent_fork/i)
    assert.equal(sections[0].text.includes('WORKER ROLE CONTRACT'), false)
  })

  test('main registers an agent-scoped tools/post-execute listener', () => {
    assert.equal(postHooks.length, 1)
  })

  const guard = host.tools.state.guards[0]

  test('untagged subagent and subagent_fork delegations succeed unmodified', () => {
    const args = { prompt: 'fix the bug' }
    assert.equal(guard({ name: 'subagent', arguments: args, agent }), undefined)
    assert.deepEqual(args, { prompt: 'fix the bug' })
    assert.equal(guard({ name: 'subagent_fork', arguments: { description: 'x' }, agent }), undefined)
    assert.equal(guard({ name: 'delegate', arguments: { task: 'y' }, agent }), undefined)
  })

  test('no BUDGET gate or per-role budget machinery remains', () => {
    assert.doesNotMatch(SOURCE, /\bBUDGET\b/)
    assert.doesNotMatch(SOURCE, /DELEGATION_REJECT|BUDGETS|budgetTag|delegationTag/)
    assert.equal('BUDGETS' in internal, false)
    assert.equal('DELEGATION_REJECT' in internal, false)
    assert.equal('budgetTag' in internal, false)
    assert.equal('delegationTag' in internal, false)
  })

  test('main file/shell tools are blocked by the guard even if schema restriction failed', () => {
    const reason = guard({ name: 'code_index', arguments: {}, agent })
    assert.match(reason, /ROLE VIOLATION/)
    assert.match(guard({ name: 'read', arguments: { path: 'x' }, agent }), /ROLE VIOLATION/)
    assert.doesNotMatch(reason, /BUDGET/i)
  })

  test('the architect/main role is never capped', () => {
    for (let index = 0; index < 200; index += 1) {
      assert.equal(guard({ name: 'todo_write', arguments: { index }, agent }), undefined)
    }
    assert.equal(guard({ name: 'subagent_control', arguments: {}, agent }), undefined)
  })
}

// ---------------------------------------------------------------------------
// lineage workers: keep file/shell tools, lose delegation, no call-count cap
// ---------------------------------------------------------------------------
{
  const host = makeHost()
  apply(host, { dumpRoster: false, diagnostics: false })
  const { agent: main } = makeAgent({ id: 'main-2', preset: 'architect', host })
  emitCreated(host, main)
  const guard = host.tools.state.guards[0]
  assert.equal(guard({ name: 'subagent', arguments: { prompt: 'untagged work' }, agent: main }), undefined)

  const { agent: worker, sections, postHooks } = makeAgent({
    id: 'worker-1',
    preset: 'architect',
    depth: 1,
    parent: 'session-main-2',
    host,
  })

  test('a lineage worker keeps file/shell tools', () => {
    assert.equal(guard({ name: 'read', arguments: { path: 'src/a.ts' }, agent: worker }), undefined)
    assert.equal(guard({ name: 'edit', arguments: { path: 'src/a.ts' }, agent: worker }), undefined)
    assert.equal(guard({ name: 'pwsh', arguments: { command: 'node -v' }, agent: worker }), undefined)
  })

  test('a lineage worker cannot re-delegate', () => {
    assert.match(guard({ name: 'subagent', arguments: { prompt: 'untagged x' }, agent: worker }), /NOT PERMITTED FOR WORKERS/)
    assert.match(guard({ name: 'subagent_fork', arguments: {}, agent: worker }), /NOT PERMITTED FOR WORKERS/)
  })

  test('a lineage worker cannot call repo-index or role tools', () => {
    assert.match(guard({ name: 'code_index', arguments: {}, agent: worker }), /NOT PERMITTED FOR WORKERS/)
    assert.match(guard({ name: 'todo_write', arguments: {}, agent: worker }), /NOT PERMITTED FOR WORKERS/)
    assert.match(guard({ name: 'send_message', arguments: {}, agent: worker }), /NOT PERMITTED FOR WORKERS/)
  })

  test('worker has no tool-call count cap (150+ sequential calls all succeed)', () => {
    assert.equal('WORKER_CALL_CEILING' in internal, false)
    assert.equal('WORKER_CEILING_REASON' in internal, false)
    assert.doesNotMatch(SOURCE, /WORKER_CALL_CEILING|WORKER_CEILING_REASON|workerCalls/)
    assert.doesNotMatch(SOURCE, /BUDGETS|cheapBudget|heavyBudget|30\/30|60\/60/)
    let calls = 3 // the allowed read, edit, pwsh above
    for (let index = 0; index < 240; index += 1) {
      assert.equal(guard({ name: 'read', arguments: { path: `f${calls}` }, agent: worker }), undefined)
      calls += 1
    }
    assert.equal(guard({ name: 'grep', arguments: { pattern: 'x' }, agent: worker }), undefined)
    assert.equal(guard({ name: 'pwsh', arguments: { command: 'node -v' }, agent: worker }), undefined)
  })

  test('worker gets only the static WORKER_CONTRACT section, at a stable position', () => {
    emitCreated(host, worker)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'architect:role-contract')
    assert.equal(sections[0].order, 2690)
    assert.equal(sections[0].text, internal.WORKER_CONTRACT)
    assert.match(sections[0].text, /frequent, small, targeted tool calls/)
    assert.match(sections[0].text, /zero prose between tool calls/)
    assert.match(sections[0].text, /prefer targeted edit over full-file write/i)
    assert.match(sections[0].text, /No tool-call cap applies/)
    assert.equal(sections[0].text.includes('ARCHITECT ROLE CONTRACT'), false)
    assert.equal(postHooks.length, 1)
  })
}

// ---------------------------------------------------------------------------
// prompt sections carry zero dynamic state
// ---------------------------------------------------------------------------
{
  const build = ({ run, calls }) => {
    const host = makeHost()
    apply(host, { dumpRoster: false, diagnostics: false })
    const main = makeAgent({ id: `${run}-main`, preset: 'architect', host })
    emitCreated(host, main.agent)
    const guard = host.tools.state.guards[0]
    guard({ name: 'subagent', arguments: { prompt: 'untagged' }, agent: main.agent })
    for (let index = 0; index < calls; index += 1) {
      guard({ name: 'todo_write', arguments: { index }, agent: main.agent })
    }
    const worker = makeAgent({
      id: `${run}-worker`,
      preset: 'architect',
      depth: 1,
      parent: `session-${run}-main`,
      host,
    })
    emitCreated(host, worker.agent)
    for (let index = 0; index < calls; index += 1) {
      guard({ name: 'read', arguments: { path: `f${index}` }, agent: worker.agent })
    }
    return { host, main, worker }
  }

  test('the same role prompt is byte-identical under differing session/call state', () => {
    const cold = build({ run: 'cold', calls: 0 })
    const hot = build({ run: 'hot', calls: 240 })
    assert.equal(cold.main.sections.length, 1)
    assert.equal(hot.main.sections.length, 1)
    assert.equal(cold.worker.sections.length, 1)
    assert.equal(hot.worker.sections.length, 1)
    assert.equal(cold.main.sections[0].text, hot.main.sections[0].text)
    assert.equal(cold.worker.sections[0].text, hot.worker.sections[0].text)
    assert.equal(cold.main.sections[0].text, internal.ARCHITECT_CONTRACT)
    assert.equal(hot.main.sections[0].text, internal.ARCHITECT_CONTRACT)
    assert.equal(cold.worker.sections[0].text, internal.WORKER_CONTRACT)
    assert.equal(hot.worker.sections[0].text, internal.WORKER_CONTRACT)
    assert.equal(hot.worker.sections[0].text.includes('cold'), false)
    assert.equal(hot.worker.sections[0].text.includes('hot'), false)
  })
}

// ---------------------------------------------------------------------------
// lineage fallback (no agentPreset on the child header)
// ---------------------------------------------------------------------------
{
  const host = makeHost()
  apply(host, { dumpRoster: false, diagnostics: false })
  const { agent: main } = makeAgent({ id: 'main-3', preset: 'architect', host })
  emitCreated(host, main)
  const guard = host.tools.state.guards[0]
  const { agent: orphan } = makeAgent({
    id: 'worker-3',
    preset: 'architect',
    depth: 1,
    parent: 'session-main-3',
    host,
    headerPreset: false,
  })

  test('lineage alone marks a child as a worker when the header has no preset', () => {
    assert.match(guard({ name: 'subagent', arguments: {}, agent: orphan }), /NOT PERMITTED FOR WORKERS/)
    assert.equal(guard({ name: 'read', arguments: { path: 'x' }, agent: orphan }), undefined)
  })
}

// ---------------------------------------------------------------------------
// other presets are untouched
// ---------------------------------------------------------------------------
{
  const host = makeHost()
  apply(host, { dumpRoster: false, diagnostics: false })
  const guard = host.tools.state.guards[0]
  const { agent: standard, restricted, sections, postHooks } = makeAgent({ id: 'std-1', preset: 'standard', host })
  emitCreated(host, standard)

  test('a non-architect session is not restricted', () => {
    assert.equal(restricted.length, 0)
    assert.equal(sections.length, 0)
    assert.equal(postHooks.length, 0)
    assert.equal(guard({ name: 'subagent', arguments: { prompt: 'untagged is fine here' }, agent: standard }), undefined)
    assert.equal(guard({ name: 'code_index', arguments: {}, agent: standard }), undefined)
    assert.equal(guard({ name: 'read', arguments: {}, agent: standard }), undefined)
  })
}

// ---------------------------------------------------------------------------
// OPTC -> architect: the selector recomposes in place, no agent/created
// ---------------------------------------------------------------------------
{
  const projections = new Map([['session-optc-1', 'ops-ptc']])
  const host = makeHost({ projections })
  apply(host, { dumpRoster: false, diagnostics: false })
  const guard = host.tools.state.guards[0]
  const { agent, restricted, sections, agentGuards, postHooks } = makeAgent({ id: 'session-optc-1', preset: 'ops-ptc', host })
  emitCreated(host, agent)

  test('a session created under ops-ptc is left untouched (role other)', () => {
    assert.equal(restricted.length, 0)
    assert.equal(sections.length, 0)
    assert.equal(agentGuards.length, 0)
    assert.equal(postHooks.length, 0)
    assert.equal(guard({ name: 'subagent', arguments: { prompt: 'untagged' }, agent }), undefined)
    assert.equal(guard({ name: 'code_index', arguments: {}, agent }), undefined)
  })

  // The user changes the preset selector. DSH recompose()s the live agent and
  // appends agent-preset/selected; agent/created does NOT fire again.
  projections.set('session-optc-1', 'architect')
  emitPresetSelected(host, 'session-optc-1', 'architect')

  test('switching ops-ptc -> architect re-applies restrict() and ARCHITECT_CONTRACT', () => {
    assert.equal(restricted.length, 1)
    assert.ok(restricted[0].deny.includes('pwsh'))
    assert.ok(restricted[0].deny.includes('read'))
    assert.equal(sections.length, 1)
    assert.equal(sections[0].text, internal.ARCHITECT_CONTRACT)
    assert.equal(sections[0].name, 'architect:role-contract')
    assert.equal(postHooks.length, 1)
  })

  test('the switch installs an agent-scoped enforcement guard (realm-safe)', () => {
    assert.equal(agentGuards.length, 1)
    const reason = agentGuards[0]({ name: 'pwsh', arguments: { command: 'node -v' }, agent })
    assert.match(reason, /ROLE VIOLATION/)
  })

  test('after the switch the parent can no longer run file/shell/repo tools', () => {
    assert.match(guard({ name: 'code_index', arguments: {}, agent }), /ROLE VIOLATION/)
    assert.match(guard({ name: 'pwsh', arguments: { command: 'node -v' }, agent }), /ROLE VIOLATION/)
    assert.match(guard({ name: 'read', arguments: { path: 'x' }, agent }), /ROLE VIOLATION/)
  })

  test('after the switch an untagged delegation still succeeds (no BUDGET gate)', () => {
    assert.equal(guard({ name: 'subagent', arguments: { prompt: 'survey the repo' }, agent }), undefined)
  })

  test('the other cache is gone: the projection now reads architect', () => {
    assert.equal(internal.presetOf(host, agent), 'architect')
  })

  test('after the switch a lineage worker gets WORKER_CONTRACT, never ARCHITECT_CONTRACT', () => {
    const { agent: worker, sections: workerSections } = makeAgent({
      id: 'session-optc-1-worker',
      preset: 'architect',
      depth: 1,
      parent: 'session-optc-1',
      host,
    })
    emitCreated(host, worker)
    assert.equal(workerSections.length, 1)
    assert.equal(workerSections[0].name, 'architect:role-contract')
    assert.equal(workerSections[0].order, 2690)
    assert.equal(workerSections[0].text, internal.WORKER_CONTRACT)
    assert.equal(workerSections[0].text.includes('ARCHITECT ROLE CONTRACT'), false)
  })
}

// A switch whose event never reaches the plugin must still be re-derived from
// the preset projection on the next tool call (no permanent `other` cache).
{
  const projections = new Map([['session-optc-2', 'ops-ptc']])
  const host = makeHost({ projections })
  apply(host, { dumpRoster: false, diagnostics: false })
  const guard = host.tools.state.guards[0]
  const { agent, restricted, agentGuards, sections } = makeAgent({ id: 'session-optc-2', preset: 'ops-ptc', host })
  emitCreated(host, agent)
  assert.equal(guard({ name: 'code_index', arguments: {}, agent }), undefined)

  projections.set('session-optc-2', 'architect')
  test('a missed switch event is still caught lazily at the next tool call', () => {
    assert.match(guard({ name: 'code_index', arguments: {}, agent }), /ROLE VIOLATION/)
    assert.equal(restricted.length, 1)
    assert.equal(agentGuards.length, 1)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].text, internal.ARCHITECT_CONTRACT)
  })
}

// ---------------------------------------------------------------------------
// authoritative preset projection
// ---------------------------------------------------------------------------
{
  const projections = new Map([['proj-1', 'architect']])
  const host = makeHost({ projections })
  apply(host, { dumpRoster: false, diagnostics: false })
  const { agent, restricted } = makeAgent({ id: 'proj-1', preset: 'standard', host, headerPreset: false })
  emitCreated(host, agent)

  test('the agentPreset session projection wins over the header', () => {
    assert.equal(internal.presetOf(host, agent), 'architect')
    assert.equal(restricted.length, 1)
    assert.match(host.tools.state.guards[0]({ name: 'read', arguments: {}, agent }), /ROLE VIOLATION/)
  })
}

// ---------------------------------------------------------------------------
// current-result truncation before history (tools/post-execute)
// ---------------------------------------------------------------------------
{
  const host = makeHost()
  apply(host, { dumpRoster: false, diagnostics: false })
  const { agent, postHooks } = makeAgent({ id: 'grow-1', preset: 'architect', host })
  emitCreated(host, agent)
  const listener = postHooks[0]
  const exec = { name: 'read', callId: 'call-1' }
  const largeText = `HEAD${'x'.repeat(70000)}TAIL`

  test('an oversized text result is head+tail truncated by the post-execute hook', () => {
    const decision = listener(exec, { content: [{ type: 'text', text: largeText }] }, () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'accept')
    assert.equal(decision.content.length, 1)
    const text = decision.content[0].text
    assert.ok(Buffer.byteLength(text) < internal.MAX_RESULT_BYTES)
    assert.match(text, /\[\.\.\. TRUNCATED \d+ of 70008 bytes of this tool result; head and tail preserved \.\.\.\]/)
    assert.ok(text.startsWith(largeText.slice(0, 100)))
    assert.ok(text.endsWith(largeText.slice(-100)))
  })

  test('a result under 64 KB and a block decision pass through untouched', () => {
    const small = { content: [{ type: 'text', text: 'small output' }] }
    assert.deepEqual(listener(exec, small, () => ({ kind: 'accept' })), { kind: 'accept' })
    const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
    assert.equal(listener(exec, small, () => blocked), blocked)
  })

  test('64 KB passes intact; one byte over is truncated to 24 KB head + 24 KB tail', () => {
    const atLimit = { content: [{ type: 'text', text: 'a'.repeat(internal.MAX_RESULT_BYTES) }] }
    assert.deepEqual(listener(exec, atLimit, () => ({ kind: 'accept' })), { kind: 'accept' })
    const over = 'L'.repeat(internal.MAX_RESULT_BYTES) + 'R'.repeat(internal.MAX_RESULT_BYTES)
    const decision = listener(exec, { content: [{ type: 'text', text: over }] }, () => ({ kind: 'accept' }))
    const text = decision.content[0].text
    assert.ok(text.startsWith('L'.repeat(internal.RESULT_HEAD_BYTES)))
    assert.ok(text.endsWith('R'.repeat(internal.RESULT_TAIL_BYTES)))
    assert.match(text, /TRUNCATED 81920 of 131072 bytes/)
  })

  test('non-text content is left intact rather than corrupted', () => {
    const image = { content: [{ type: 'image', data: 'a'.repeat(70000) }] }
    assert.deepEqual(listener(exec, image, () => ({ kind: 'accept' })), { kind: 'accept' })
  })
}

// ---------------------------------------------------------------------------
// failure containment + disposal
// ---------------------------------------------------------------------------
{
  const host = makeHost()
  apply(host, { dumpRoster: false, diagnostics: false })
  const { agent, sections } = makeAgent({ id: 'boom-1', preset: 'architect', host, restrictThrows: true })
  emitCreated(host, agent)

  test('a throwing restrict() is contained and logged, never fatal', () => {
    assert.ok(host.warns.some((message) => message.includes('restrict failed')))
    assert.equal(sections.length, 1)
    assert.equal(sections[0].text, internal.ARCHITECT_CONTRACT)
  })

  test('agent/disposed tears down without throwing', () => {
    assert.doesNotThrow(() => emitDisposed(host, agent))
    assert.doesNotThrow(() => emitDisposed(host, agent))
  })
}

// ---------------------------------------------------------------------------
// delegation queue saturation
// ---------------------------------------------------------------------------
{
  const host = makeHost()
  apply(host, { dumpRoster: false, diagnostics: false })
  const { agent } = makeAgent({ id: 'main-4', preset: 'architect', host })
  emitCreated(host, agent)
  const guard = host.tools.state.guards[0]

  test(`delegation queue is capped at ${internal.MAX_PENDING} pending workers`, () => {
    for (let index = 0; index < internal.MAX_PENDING; index += 1) {
      assert.equal(guard({ name: 'subagent', arguments: { prompt: 'untagged x' }, agent }), undefined)
    }
    assert.equal(guard({ name: 'subagent', arguments: { prompt: 'untagged y' }, agent }), internal.DELEGATION_BUSY)
  })
}

// ---------------------------------------------------------------------------
// role-based reasoning effort: main high, workers low, others untouched
// ---------------------------------------------------------------------------
{
  let seq = 0
  const build = async ({
    preset = 'architect',
    depth = 0,
    parent,
    effort = 'max',
    efforts,
    provider,
    model,
  } = {}) => {
    seq += 1
    const host = makeHost({ efforts })
    apply(host, { dumpRoster: false, diagnostics: false })
    const made = makeAgent({
      id: `effort-${seq}`,
      preset,
      depth,
      parent,
      host,
      effort,
      provider,
      model,
    })
    await emitCreated(host, made.agent)
    return { host, ...made }
  }

  await testAsync('architect main resolves to high, downgrading max', async () => {
    const { agent, selections, host } = await build({ effort: 'max' })
    assert.equal(agent.model.current().reasoningEffort, 'high')
    assert.deepEqual(selections, [
      { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
    ])
    // Capability lookup uses the agent's exact current route.
    assert.deepEqual(host.resolved, [{ provider: 'deepseek-account', model: 'deepseek-flash' }])
  })

  await testAsync('architect main is raised to high even when the profile default is low', async () => {
    const { agent, selections } = await build({ effort: 'low' })
    assert.equal(agent.model.current().reasoningEffort, 'high')
    assert.equal(selections.at(-1).reasoningEffort, 'high')
  })

  await testAsync('architect main already at high records no duplicate selection', async () => {
    const { agent, selections } = await build({ effort: 'high' })
    assert.equal(selections.length, 0)
    assert.equal(agent.model.current().reasoningEffort, 'high')
    const again = await internal.applyRoleEffort(
      { get: () => undefined },
      agent,
      'main',
    )
    assert.equal(again, 'high')
    assert.equal(selections.length, 0)
  })

  await testAsync('depth>0 worker is forced to low (native DeepSeek level)', async () => {
    const { agent, selections } = await build({ depth: 1, parent: 'session-effort-main', effort: 'max' })
    assert.equal(agent.model.current().reasoningEffort, 'low')
    assert.deepEqual(selections, [
      { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
    ])
  })

  await testAsync('a parentSession worker at depth 0 is also forced to low', async () => {
    const { agent } = await build({ depth: 0, parent: 'session-effort-fork', effort: 'max' })
    assert.equal(agent.model.current().reasoningEffort, 'low')
  })

  await testAsync('worker already at low records no duplicate selection', async () => {
    const { agent, selections } = await build({ depth: 1, parent: 'session-x', effort: 'low' })
    assert.equal(selections.length, 0)
    assert.equal(agent.model.current().reasoningEffort, 'low')
  })

  await testAsync('a non-architect session is left completely untouched', async () => {
    const { agent, selections, restricted, sections } = await build({ preset: 'standard', effort: 'max' })
    assert.equal(selections.length, 0)
    assert.equal(agent.model.current().reasoningEffort, 'max')
    assert.equal(restricted.length, 0)
    assert.equal(sections.length, 0)
  })

  await testAsync('a child of a non-architect session is left untouched', async () => {
    const { agent, selections } = await build({
      preset: 'standard',
      depth: 1,
      parent: 'session-standard-main',
      effort: 'max',
    })
    assert.equal(selections.length, 0)
    assert.equal(agent.model.current().reasoningEffort, 'max')
  })

  await testAsync('a route without the target level is not forced into UNSUPPORTED_REASONING_EFFORT', async () => {
    const worker = await build({ depth: 1, parent: 'session-y', effort: 'max', efforts: ['off', 'high'] })
    assert.equal(worker.agent.model.current().reasoningEffort, 'max')
    assert.equal(worker.selections.length, 0)
    // Sanity: the same route still supports the Architect's high.
    const main = await build({ effort: 'max', efforts: ['off', 'high'] })
    assert.equal(main.agent.model.current().reasoningEffort, 'high')
  })

  await testAsync('a route with no reasoning capability is left untouched', async () => {
    const { agent, selections } = await build({ effort: 'max', efforts: null })
    assert.equal(selections.length, 0)
    assert.equal(agent.model.current().reasoningEffort, 'max')
  })

  await testAsync('the preset switch applies the new role effort before the next turn', async () => {
    const projections = new Map([['session-switch-effort', 'standard']])
    const host = makeHost({ projections })
    apply(host, { dumpRoster: false, diagnostics: false })
    const { agent, selections } = makeAgent({
      id: 'session-switch-effort',
      preset: 'standard',
      host,
      effort: 'max',
    })
    await emitCreated(host, agent)
    assert.equal(selections.length, 0)
    projections.set('session-switch-effort', 'architect')
    emitPresetSelected(host, 'session-switch-effort', 'architect')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(agent.model.current().reasoningEffort, 'high')
    assert.equal(selections.at(-1).reasoningEffort, 'high')
  })

  await testAsync('role effort never changes the role prompt: prefixes stay byte-identical', async () => {
    const first = await build({ effort: 'max' })
    const second = await build({ effort: 'low' })
    const workerFirst = await build({ depth: 1, parent: 'session-p1', effort: 'max' })
    const workerSecond = await build({ depth: 1, parent: 'session-p2', effort: 'high' })
    assert.equal(first.sections.length, 1)
    assert.equal(second.sections.length, 1)
    assert.equal(workerFirst.sections.length, 1)
    assert.equal(workerSecond.sections.length, 1)
    assert.equal(first.sections[0].text, internal.ARCHITECT_CONTRACT)
    assert.equal(second.sections[0].text, internal.ARCHITECT_CONTRACT)
    assert.equal(workerFirst.sections[0].text, internal.WORKER_CONTRACT)
    assert.equal(workerSecond.sections[0].text, internal.WORKER_CONTRACT)
    assert.equal(first.sections[0].text, second.sections[0].text)
    assert.equal(workerFirst.sections[0].text, workerSecond.sections[0].text)
    // The contracts remain static strings with zero interpolation, so an
    // effort change can never rotate the DeepSeek prefix cache.
    for (const contract of [internal.ARCHITECT_CONTRACT, internal.WORKER_CONTRACT]) {
      assert.equal(contract.includes('${'), false)
      assert.equal(contract.includes('reasoningEffort'), false)
    }
    assert.equal(internal.roleEffort('main'), 'high')
    assert.equal(internal.roleEffort('worker'), 'low')
    assert.equal(internal.roleEffort('other'), undefined)
    assert.equal(internal.ARCHITECT_EFFORT, 'high')
    assert.equal(internal.WORKER_EFFORT, 'low')
  })
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
test('no tool-call ceiling machinery remains in the plugin surface', () => {
  assert.equal('WORKER_CALL_CEILING' in internal, false)
  assert.equal('WORKER_CEILING_REASON' in internal, false)
  assert.equal(internal.MAX_RESULT_BYTES, 65536)
  assert.equal(internal.RESULT_HEAD_BYTES, 24576)
  assert.equal(internal.RESULT_TAIL_BYTES, 24576)
  assert.doesNotMatch(SOURCE, /TOOL CALL CEILING REACHED|ceiling is exhausted|WORKER_CALL_CEILING/)
})

test('head+tail truncation keeps the marker and both ends', () => {
  assert.equal(internal.truncatedToolResultContent([{ type: 'text', text: 'tiny' }]), undefined)
  const text = `${'h'.repeat(40000)}BODY${'t'.repeat(40000)}`
  const truncated = internal.truncatedToolResultContent([{ type: 'text', text }])
  assert.equal(truncated.length, 1)
  assert.equal(truncated[0].type, 'text')
  assert.ok(Buffer.byteLength(truncated[0].text) < internal.MAX_RESULT_BYTES)
  assert.ok(truncated[0].text.startsWith('h'.repeat(100)))
  assert.ok(truncated[0].text.endsWith('t'.repeat(100)))
  assert.match(truncated[0].text, /TRUNCATED/)
})

test('lineage detection uses depth and parentSession only', () => {
  assert.equal(internal.isSubagent({ session: { header: {} } }), false)
  assert.equal(internal.isSubagent({ session: { header: { delegationDepth: 1 } } }), true)
  assert.equal(internal.isSubagent({ session: { header: { parentSession: 'session-a' } } }), true)
  assert.equal(internal.isSubagent(undefined), false)
})

test('session ids normalize the session- prefix', () => {
  assert.equal(internal.normalizeId('session-abc'), 'abc')
  assert.equal(internal.normalizeId('abc'), 'abc')
  assert.equal(internal.normalizeId(undefined), undefined)
})

test('restrictable names never include scope-local-only tools', () => {
  const tools = {
    view: () => ({ restrictableNames: new Set(['read', 'code_index']) }),
    definitions: () => [{ name: 'read' }, { name: 'scope_local_only' }],
  }
  const known = internal.restrictableNames(tools, {})
  assert.ok(known.has('read'))
  assert.ok(known.has('code_index'))
  assert.equal(known.has('scope_local_only'), false)
})

const failed = failures.length
console.log(`\n# pass ${passed}`)
console.log(`# fail ${failed}`)
if (failed > 0) {
  console.log(`# failed tests: ${failures.join(', ')}`)
  process.exitCode = 1
}
