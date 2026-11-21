// Host-half tests: store, llm/stream recorder, session tagging, route.
// Run with: node test/host.test.mjs
//
// Sources are transpiled into test/.build/ (scratch, rewritten per run); the
// built dist/ directory is never touched by tests.

import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))

let checks = 0
let failures = 0
function check(condition, label) {
  checks += 1
  if (!condition) {
    failures += 1
    console.error(`FAIL: ${label}`)
    throw new Error(label)
  }
}
function eq(actual, expected, label) {
  const ok = Object.is(actual, expected)
  check(ok, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}

async function buildSources() {
  const candidates = [
    join(pluginRoot, 'node_modules', 'typescript'),
    join(pluginRoot, '..', '..', 'usage-popup', 'node_modules', 'typescript'),
  ]
  let ts = null
  for (const candidate of candidates) {
    const entry = join(candidate, 'lib', 'typescript.js')
    if (!existsSync(entry)) continue
    const module = await import(pathToFileURL(entry).href)
    ts = module.default ?? module
    break
  }
  if (ts === null) throw new Error('typescript not found for test transpile')

  const buildDir = join(pluginRoot, 'test', '.build')
  await rm(buildDir, { recursive: true, force: true })
  await mkdir(join(buildDir, 'host'), { recursive: true })
  const compile = async (sourcePath, outPath) => {
    const source = await readFile(sourcePath, 'utf8')
    const compiled = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        sourceMap: false,
      },
    })
    await writeFile(outPath, compiled.outputText, 'utf8')
  }
  await compile(join(pluginRoot, 'src', 'host.ts'), join(buildDir, 'host.js'))
  for (const name of await readdir(join(pluginRoot, 'src', 'host'))) {
    if (!name.endsWith('.ts')) continue
    await compile(join(pluginRoot, 'src', 'host', name), join(buildDir, 'host', name.replace(/\.ts$/, '.js')))
  }
  return buildDir
}

const buildDir = await buildSources()
const moduleUrl = (relative) => pathToFileURL(join(buildDir, relative)).href

const { UsageStore, FORMAT, FORMAT_VERSION } = await import(moduleUrl('host/store.js'))
const { Collector, wrapLlmStream, claimToolFee, TOOL_FEE_DEDUPE_WINDOW_MS } = await import(moduleUrl('host/collector.js'))
const { createRouteHandler } = await import(moduleUrl('host/route.js'))

function baseInput(overrides = {}) {
  return {
    at: 1,
    kind: 'llm',
    source: 'llm-stream',
    sessionId: null,
    sessionType: 'unknown',
    parentSessionId: null,
    delegationDepth: null,
    agentPreset: null,
    model: 'model-x',
    provider: null,
    purpose: null,
    usage: null,
    serverTool: null,
    ...overrides,
  }
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'usage-popup-host-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Store: append/load JSONL round-trip, monotonic seq, since filter, corruption.
// ---------------------------------------------------------------------------
await withTempDir(async (dir) => {
  const file = join(dir, 'usage-records.jsonl')
  const store = new UsageStore({ file })
  store.load()
  const first = store.append(baseInput({ at: 10 }))
  const second = store.append(baseInput({ at: 20, kind: 'tool', source: 'wire' }))
  eq(first.id, 'h:1', 'first id')
  eq(first.seq, 1, 'first seq')
  eq(second.seq, 2, 'second seq monotonic')
  eq(store.cursor, 2, 'cursor after append')
  await store.flush()

  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  eq(lines.length, 2, 'two JSONL lines persisted')

  const reloaded = new UsageStore({ file })
  reloaded.load()
  eq(reloaded.count, 2, 'reload count')
  eq(reloaded.cursor, 2, 'reload cursor')
  const third = reloaded.append(baseInput({ at: 30 }))
  eq(third.seq, 3, 'seq continues after reload')
  eq(reloaded.since(1).length, 2, 'since filters lower seqs')
  eq(reloaded.since(2).length, 1, 'since returns only newer rows')
  eq(reloaded.since(0, 1).length, 1, 'since respects limit')
  await reloaded.flush()

  await appendFile(file, '{"id":"h:4","seq":4,"at":', 'utf8')
  const tolerant = new UsageStore({ file })
  tolerant.load()
  eq(tolerant.count, 3, 'corrupt trailing line skipped')
  check(tolerant.loadErrors >= 1, 'corrupt line counted as load error')
  eq(tolerant.maxSeq, 3, 'corrupt line does not advance seq')
})

// ---------------------------------------------------------------------------
// Recorder: chunks re-yielded unchanged, exactly one record, failures isolated.
// ---------------------------------------------------------------------------
await withTempDir(async (dir) => {
  const store = new UsageStore({ file: join(dir, 'usage-records.jsonl') })
  store.load()
  const collector = new Collector(store)
  const main = { id: 's1' }
  collector.observeSession(main, { type: 'turn/start' })

  const chunks = [
    { type: 'text', text: 'hello' },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 } },
  ]
  let nextCalls = 0
  const wrapped = wrapLlmStream(
    collector,
    { sessionId: 's1', provider: 'deepseek', model: 'deepseek-chat', purpose: 'chat' },
    () => {
      nextCalls += 1
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  )
  const seen = []
  for await (const chunk of wrapped) seen.push(chunk)
  eq(nextCalls, 1, 'next called exactly once')
  eq(seen.length, 2, 'all chunks re-yielded')
  check(seen[0] === chunks[0] && seen[1] === chunks[1], 'chunks are the same objects')
  eq(store.count, 1, 'exactly one usage record')
  const record = store.records[0]
  eq(record.kind, 'llm', 'record kind')
  eq(record.source, 'llm-stream', 'record source')
  eq(record.sessionId, 's1', 'record sessionId')
  eq(record.sessionType, 'main', 'record sessionType')
  eq(record.provider, 'deepseek', 'record provider')
  eq(record.model, 'deepseek-chat', 'record model')
  eq(record.purpose, 'chat', 'record purpose')
  eq(record.usage.inputTokens, 5, 'usage inputTokens')
  eq(record.usage.outputTokens, 7, 'usage outputTokens')
  eq(record.usage.cacheReadTokens, 2, 'usage cacheReadTokens')
  eq(record.usage.cacheWriteTokens, 1, 'usage cacheWriteTokens')
  eq(record.usage.reasoningTokens, 3, 'usage reasoningTokens')
  eq(record.usage.totalTokens, null, 'missing totalTokens stays null')

  // A throwing store must not disturb the stream.
  const brokenStore = { append() { throw new Error('boom') } }
  const broken = new Collector(brokenStore)
  const stream = wrapLlmStream(broken, {}, () => (async function* () {
    yield { type: 'text', text: 'a' }
    yield { type: 'usage', usage: { inputTokens: 1 } }
  })())
  const brokenSeen = []
  for await (const chunk of stream) brokenSeen.push(chunk)
  eq(brokenSeen.length, 2, 'throwing store keeps chunks flowing')
})

// ---------------------------------------------------------------------------
// Recorder: last-chunk-wins (one record, latest usage) and early consumer break.
// ---------------------------------------------------------------------------
await withTempDir(async (dir) => {
  const store = new UsageStore({ file: join(dir, 'last-wins.jsonl') })
  store.load()
  const collector = new Collector(store)
  const wrapped = wrapLlmStream(collector, { sessionId: 's1', model: 'm' }, () =>
    (async function* () {
      yield { type: 'text', text: 'a' }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }
      yield { type: 'text', text: 'b' }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
    })(),
  )
  const seen = []
  for await (const chunk of wrapped) seen.push(chunk)
  eq(seen.length, 4, 'both usage chunks and text re-yielded')
  eq(store.count, 1, 'two usage chunks emit exactly one record')
  eq(store.records[0].usage.inputTokens, 3, 'record keeps the LAST input tokens')
  eq(store.records[0].usage.outputTokens, 4, 'record keeps the LAST output tokens')

  // Consumer breaks after the usage chunk: the buffered record still flushes.
  const breakStore = new UsageStore({ file: join(dir, 'break.jsonl') })
  breakStore.load()
  const breakCollector = new Collector(breakStore)
  const breaking = wrapLlmStream(breakCollector, { model: 'm' }, () =>
    (async function* () {
      yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 8 } }
      yield { type: 'text', text: 'never' }
    })(),
  )
  for await (const chunk of breaking) {
    eq(chunk.type, 'usage', 'first chunk is usage')
    break
  }
  eq(breakStore.count, 1, 'early break still emits the buffered usage record')
  eq(breakStore.records[0].usage.inputTokens, 9, 'early-break record has the usage')
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Session tagging: subagent metadata, compaction purpose, tool-event fees.
// ---------------------------------------------------------------------------
await withTempDir(async (dir) => {
  const store = new UsageStore({ file: join(dir, 'usage-records.jsonl') })
  store.load()
  const collector = new Collector(store)
  const main = { id: 's1' }
  const subagent = { id: 's2', parentSession: { id: 's1' }, delegationDepth: 1, agentPreset: 'worker', origin: 'subagent' }

  collector.observeSession(subagent, { type: 'turn/start' })
  const subRecord = collector.recordLlm({ sessionId: 's2', model: 'm' }, { inputTokens: 1 })
  eq(subRecord.sessionType, 'subagent', 'subagent session type')
  eq(subRecord.parentSessionId, 's1', 'subagent parent')
  eq(subRecord.delegationDepth, 1, 'subagent depth')
  eq(subRecord.agentPreset, 'worker', 'subagent preset')

  const compacted = collector.recordLlm(
    { sessionId: 'unknown-session', model: 'm', purpose: 'conversation-compaction' },
    {},
  )
  eq(compacted.sessionType, 'compaction', 'compaction purpose tag')

  collector.observeSession(main, { type: 'tool/call', data: { callId: 'c1', name: 'deepseek_web_search' } })
  const toolRecord = collector.observeSession(main, {
    type: 'tool/result',
    data: { message: { source: { callId: 'c1' }, isError: false } },
  })
  check(toolRecord !== null, 'tool result emits a record')
  eq(toolRecord.kind, 'tool', 'tool record kind')
  eq(toolRecord.source, 'tool-event', 'tool record source')
  eq(toolRecord.serverTool.name, 'web_search', 'tool record canonical name')
  eq(toolRecord.serverTool.requests, 1, 'tool record requests')
  eq(toolRecord.serverTool.status, 200, 'tool record success status')
  eq(toolRecord.serverTool.feeUsd, 0.00075, 'tool record fee')
  const duplicate = collector.observeSession(main, {
    type: 'tool/result',
    data: { message: { source: { callId: 'c1' }, isError: false } },
  })
  eq(duplicate, null, 'tool result deduped')

  // Live Session shape: lineage fields live under `header`.
  const headerChild = {
    id: 'ses_child',
    header: {
      id: 'ses_child',
      origin: 'subagent',
      parentSession: 'ses_main',
      delegationDepth: 1,
    },
  }
  collector.observeSession(headerChild, { type: 'turn/start' })
  const headerRecord = collector.recordLlm(
    { sessionId: 'ses_child', model: 'm' },
    { inputTokens: 2 },
  )
  eq(headerRecord.sessionType, 'subagent', 'header origin tags subagent')
  eq(headerRecord.parentSessionId, 'ses_main', 'header parentSession tags parent')
  eq(headerRecord.delegationDepth, 1, 'header delegationDepth tags depth')

  // A failed tool result is not billed.
  const failing = { id: 's3' }
  collector.observeSession(failing, {
    type: 'tool/call',
    data: { callId: 'c-fail', name: 'deepseek_read_url' },
  })
  const failedTool = collector.observeSession(failing, {
    type: 'tool/result',
    data: { message: { source: { callId: 'c-fail' }, isError: true } },
  })
  eq(failedTool, null, 'failed tool result emits no fee')
  eq(store.count, 4, 'only expected records emitted')
})

// ---------------------------------------------------------------------------
// Server-tool fee claims are process-level with a 5s window per session::name.
// ---------------------------------------------------------------------------
{
  const t0 = 1_000_000
  eq(TOOL_FEE_DEDUPE_WINDOW_MS, 5_000, 'fee dedupe window is 5s')
  eq(claimToolFee('sA', 'web_search', t0), true, 'first claim wins')
  eq(claimToolFee('sA', 'web_search', t0 + 4_999), false, 'second claim within 5s is duplicate')
  eq(claimToolFee('sA', 'web_search', t0 + 6_000), true, 'claim after 6s wins again')
  eq(claimToolFee('sB', 'web_search', t0 + 6_000), true, 'different session is independent')
  eq(claimToolFee('sA', 'read_url', t0 + 6_000), true, 'different name is independent')
}

// ---------------------------------------------------------------------------
// Route: payload shape, since filter, health, 404, 405, invalid since.
// ---------------------------------------------------------------------------
function makeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(text) {
      this.body = text
    },
  }
}

await withTempDir(async (dir) => {
  const store = new UsageStore({ file: join(dir, 'usage-records.jsonl') })
  store.load()
  store.append(baseInput({ at: 1 }))
  store.append(baseInput({ at: 2 }))
  const transport = { installed: true, intercepted: 3, usageParsed: 2, serverToolFees: 1, errors: 0 }
  const handler = createRouteHandler(() => ({ store, startedAt: 1234, transport }))

  const usageRes = makeResponse()
  await handler({ url: '/usage-popup/api/usage?since=0', method: 'GET' }, usageRes)
  eq(usageRes.statusCode, 200, 'usage status 200')
  const usageBody = JSON.parse(usageRes.body)
  eq(usageBody.format, FORMAT, 'usage format')
  eq(usageBody.version, FORMAT_VERSION, 'usage version')
  eq(usageBody.cursor, 2, 'usage cursor')
  eq(usageBody.records.length, 2, 'usage records length')
  eq(usageBody.records[0].seq, 1, 'usage ascending first')
  eq(usageBody.records[1].seq, 2, 'usage ascending second')

  const filteredRes = makeResponse()
  await handler({ url: '/usage-popup/api/usage?since=1', method: 'GET' }, filteredRes)
  const filteredBody = JSON.parse(filteredRes.body)
  eq(filteredBody.records.length, 1, 'since filter')
  eq(filteredBody.records[0].seq, 2, 'since filter row')
  eq(usageBody.reset, undefined, 'no reset flag on a normal payload')

  const resetRes = makeResponse()
  await handler({ url: '/usage-popup/api/usage?since=99', method: 'GET' }, resetRes)
  const resetBody = JSON.parse(resetRes.body)
  eq(resetBody.reset, true, 'since > cursor reports reset')
  eq(resetBody.cursor, 2, 'reset payload cursor is the store max')
  eq(resetBody.records.length, 2, 'reset replays records from seq 0')

  const healthRes = makeResponse()
  await handler({ url: '/usage-popup/api/health', method: 'GET' }, healthRes)
  eq(healthRes.statusCode, 200, 'health status 200')
  const healthBody = JSON.parse(healthRes.body)
  eq(healthBody.ok, true, 'health ok')
  eq(healthBody.format, FORMAT, 'health format')
  eq(healthBody.version, FORMAT_VERSION, 'health version')
  eq(healthBody.cursor, 2, 'health cursor')
  eq(healthBody.startedAt, 1234, 'health startedAt')
  eq(healthBody.records, 2, 'health record count')
  eq(healthBody.transport.installed, true, 'health transport installed')
  eq(healthBody.transport.intercepted, 3, 'health intercepted')
  eq(healthBody.transport.usageParsed, 2, 'health usageParsed')
  eq(healthBody.transport.serverToolFees, 1, 'health serverToolFees')
  eq(healthBody.transport.errors, 0, 'health errors')

  const missingRes = makeResponse()
  await handler({ url: '/usage-popup/api/nope', method: 'GET' }, missingRes)
  eq(missingRes.statusCode, 404, 'unknown path 404')
  eq(JSON.parse(missingRes.body).error, 'not found', '404 body')

  const methodRes = makeResponse()
  await handler({ url: '/usage-popup/api/usage', method: 'POST' }, methodRes)
  eq(methodRes.statusCode, 405, 'wrong method 405')

  const invalidSinceRes = makeResponse()
  await handler({ url: '/usage-popup/api/usage?since=abc', method: 'GET' }, invalidSinceRes)
  eq(invalidSinceRes.statusCode, 400, 'invalid since 400')

  const negativeSinceRes = makeResponse()
  await handler({ url: '/usage-popup/api/usage?since=-1', method: 'GET' }, negativeSinceRes)
  eq(negativeSinceRes.statusCode, 400, 'negative since 400')
})

// ---------------------------------------------------------------------------
// Host module exports (loader contract).
// ---------------------------------------------------------------------------
const hostModule = await import(moduleUrl('host.js'))
eq(hostModule.name, 'usage-popup', 'host module name export')
check(typeof hostModule.apply === 'function', 'host module apply export')

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log(`${checks} checks passed`)
