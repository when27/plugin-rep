// Smoke tests for the Architect preset restriction plugin.
// Run: node architect-preset/smoke.test.mjs
//
// These tests exercise the mechanism DSH actually honors at runtime:
//   * one GLOBAL guard registered on the ROOT tools service, which decides
//     from exec.agent (no agent/created delivery required);
//   * per-agent `agent.ctx.tools.restrict()` for schema narrowing, filtered by
//     `view(scope).restrictableNames` (DSH throws on names that are not
//     restrictable, which used to be swallowed as a silent no-op);
//   * preset identity from the `agentPreset` session projection, not the header.
import assert from 'node:assert/strict'
import { apply, internal, name as pluginName, inject } from './index.js'

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

function makeHost({ known = KNOWN, projections = new Map(), tools = makeTools(known) } = {}) {
  const listeners = new Map()
  const warns = []
  const liveAgents = new Map()
  const host = {
    tools,
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

function makeAgent({ id, preset, depth = 0, parent, host, restrictThrows = false, headerPreset = true }) {
  const restricted = []
  const sections = []
  const agentGuards = []
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
  const agent = {
    id,
    session: { id, header },
    ctx: {
      tools: agentTools,
      systemPrompt: {
        section(section) {
          sections.push(section)
          return () => {}
        },
      },
    },
  }
  return { agent, restricted, sections, agentGuards }
}

const emitCreated = (host, agent) => {
  host.liveAgents.set(agent.id, agent)
  for (const listener of host.listeners.get('agent/created') ?? []) listener({ agent })
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
  const { agent, restricted, sections } = makeAgent({ id: 'main-1', preset: 'architect', host })
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

  test('main gets the role contract system-prompt section', () => {
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'architect:role-contract')
    assert.match(sections[0].text, /ROLE CONTRACT/)
    assert.match(sections[0].text, /BUDGET=cheap/)
  })

  const guard = host.tools.state.guards[0]

  test('untagged delegation from the architect main is rejected', () => {
    assert.equal(guard({ name: 'subagent', arguments: { prompt: 'fix the bug' }, agent }), internal.DELEGATION_REJECT)
    assert.equal(guard({ name: 'subagent_fork', arguments: { description: 'x' }, agent }), internal.DELEGATION_REJECT)
  })

  test('tagged delegation is allowed and queues a worker budget', () => {
    assert.equal(guard({ name: 'subagent', arguments: { prompt: 'BUDGET=heavy\nfix src/a.ts' }, agent }), undefined)
    assert.equal(guard({ name: 'subagent', arguments: { budget: 'cheap', prompt: 'list files' }, agent }), undefined)
  })

  test('main file/shell tools are blocked by the guard even if schema restriction failed', () => {
    const reason = guard({ name: 'code_index', arguments: {}, agent })
    assert.match(reason, /ROLE VIOLATION/)
    assert.match(guard({ name: 'read', arguments: { path: 'x' }, agent }), /ROLE VIOLATION/)
  })

  test('non-delegation architect calls are not otherwise blocked', () => {
    assert.equal(guard({ name: 'todo_write', arguments: {}, agent }), undefined)
    assert.equal(guard({ name: 'subagent_control', arguments: {}, agent }), undefined)
  })
}

// ---------------------------------------------------------------------------
// lineage workers: keep file/shell tools, lose delegation, budget enforced
// ---------------------------------------------------------------------------
{
  const host = makeHost()
  apply(host, { dumpRoster: false, diagnostics: false, cheapBudget: 30, heavyBudget: 60 })
  const { agent: main } = makeAgent({ id: 'main-2', preset: 'architect', host })
  emitCreated(host, main)
  const guard = host.tools.state.guards[0]
  assert.equal(guard({ name: 'subagent', arguments: { prompt: 'BUDGET=cheap\nwork' }, agent: main }), undefined)

  const { agent: worker, sections } = makeAgent({
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
    assert.match(guard({ name: 'subagent', arguments: { prompt: 'BUDGET=cheap\nx' }, agent: worker }), /NOT PERMITTED FOR WORKERS/)
    assert.match(guard({ name: 'subagent_fork', arguments: {}, agent: worker }), /NOT PERMITTED FOR WORKERS/)
  })

  test('a lineage worker cannot call repo-index or role tools', () => {
    assert.match(guard({ name: 'code_index', arguments: {}, agent: worker }), /NOT PERMITTED FOR WORKERS/)
    assert.match(guard({ name: 'todo_write', arguments: {}, agent: worker }), /NOT PERMITTED FOR WORKERS/)
    assert.match(guard({ name: 'send_message', arguments: {}, agent: worker }), /NOT PERMITTED FOR WORKERS/)
  })

  test('worker budget counts down and hard-stops at the cheap cap (30)', () => {
    let allowed = 3 // read, edit, pwsh above
    while (allowed < 30) {
      assert.equal(guard({ name: 'read', arguments: { path: `f${allowed}` }, agent: worker }), undefined)
      allowed += 1
    }
    const reason = guard({ name: 'read', arguments: { path: 'over' }, agent: worker })
    assert.match(reason, /TOOL BUDGET EXHAUSTED \(30\/30\)/)
  })

  test('worker role contract section is installed on agent/created', () => {
    emitCreated(host, worker)
    assert.equal(sections.length, 1)
    assert.match(sections[0].text, /WORKER \(has file\/shell tools\)/)
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
  const { agent: standard, restricted } = makeAgent({ id: 'std-1', preset: 'standard', host })
  emitCreated(host, standard)

  test('a non-architect session is not restricted', () => {
    assert.equal(restricted.length, 0)
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
  const { agent, restricted, sections, agentGuards } = makeAgent({ id: 'session-optc-1', preset: 'ops-ptc', host })
  emitCreated(host, agent)

  test('a session created under ops-ptc is left untouched (role other)', () => {
    assert.equal(restricted.length, 0)
    assert.equal(sections.length, 0)
    assert.equal(agentGuards.length, 0)
    assert.equal(guard({ name: 'subagent', arguments: { prompt: 'untagged' }, agent }), undefined)
    assert.equal(guard({ name: 'code_index', arguments: {}, agent }), undefined)
  })

  // The user changes the preset selector. DSH recompose()s the live agent and
  // appends agent-preset/selected; agent/created does NOT fire again.
  projections.set('session-optc-1', 'architect')
  emitPresetSelected(host, 'session-optc-1', 'architect')

  test('switching ops-ptc -> architect re-applies restrict() and the role contract', () => {
    assert.equal(restricted.length, 1)
    assert.ok(restricted[0].deny.includes('pwsh'))
    assert.ok(restricted[0].deny.includes('read'))
    assert.equal(sections.length, 1)
    assert.match(sections[0].text, /BUDGET=cheap/)
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

  test('after the switch an untagged delegation is rejected', () => {
    assert.equal(guard({ name: 'subagent', arguments: { prompt: 'survey the repo' }, agent }), internal.DELEGATION_REJECT)
  })

  test('the other cache is gone: the projection now reads architect', () => {
    assert.equal(internal.presetOf(host, agent), 'architect')
  })
}

// A switch whose event never reaches the plugin must still be re-derived from
// the preset projection on the next tool call (no permanent `other` cache).
{
  const projections = new Map([['session-optc-2', 'ops-ptc']])
  const host = makeHost({ projections })
  apply(host, { dumpRoster: false, diagnostics: false })
  const guard = host.tools.state.guards[0]
  const { agent, restricted, agentGuards } = makeAgent({ id: 'session-optc-2', preset: 'ops-ptc', host })
  emitCreated(host, agent)
  assert.equal(guard({ name: 'code_index', arguments: {}, agent }), undefined)

  projections.set('session-optc-2', 'architect')
  test('a missed switch event is still caught lazily at the next tool call', () => {
    assert.match(guard({ name: 'code_index', arguments: {}, agent }), /ROLE VIOLATION/)
    assert.equal(restricted.length, 1)
    assert.equal(agentGuards.length, 1)
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
  })

  test('agent/disposed tears down without throwing', () => {
    assert.doesNotThrow(() => emitDisposed(host, agent))
    assert.doesNotThrow(() => emitDisposed(host, agent))
  })
}

// ---------------------------------------------------------------------------
// budget queue saturation
// ---------------------------------------------------------------------------
{
  const host = makeHost()
  apply(host, { dumpRoster: false, diagnostics: false })
  const { agent } = makeAgent({ id: 'main-4', preset: 'architect', host })
  emitCreated(host, agent)
  const guard = host.tools.state.guards[0]

  test(`delegation queue is capped at ${internal.MAX_PENDING} pending workers`, () => {
    for (let index = 0; index < internal.MAX_PENDING; index += 1) {
      assert.equal(guard({ name: 'subagent', arguments: { prompt: 'BUDGET=cheap\nx' }, agent }), undefined)
    }
    assert.equal(guard({ name: 'subagent', arguments: { prompt: 'BUDGET=cheap\ny' }, agent }), internal.DELEGATION_BUSY)
  })
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
test('budget tags parse from prompts, brackets and argument fields', () => {
  assert.equal(internal.budgetTag('BUDGET=cheap\nfix'), 'cheap')
  assert.equal(internal.budgetTag('budget : HEAVY probe'), 'heavy')
  assert.equal(internal.budgetTag('please run [cheap] now'), 'cheap')
  assert.equal(internal.budgetTag('heavy: refactor'), 'heavy')
  assert.equal(internal.budgetTag('no tag here'), undefined)
  assert.equal(internal.delegationTag({ budget: 'HEAVY' }), 'heavy')
  assert.equal(internal.delegationTag({ prompt: 'BUDGET=cheap\nx' }), 'cheap')
  assert.equal(internal.delegationTag({ prompt: 'plain' }), undefined)
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
