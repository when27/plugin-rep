// Transport middleware tests: include_usage injection, wire parsing, fee math,
// and fetch-wrapper transparency.
// Run with: node test/transport.test.mjs

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
  check(Object.is(actual, expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
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
const {
  addIncludeUsage,
  parseWireUsage,
  serverToolFee,
  installFetchTransport,
  createTransportStats,
} = await import(moduleUrl('host/transport.js'))

// ---------------------------------------------------------------------------
// addIncludeUsage
// ---------------------------------------------------------------------------
const streamingChat = JSON.stringify({ model: 'm', stream: true, messages: [] })
const added = JSON.parse(addIncludeUsage(streamingChat))
eq(added.stream_options.include_usage, true, 'adds include_usage to streaming chat')
eq(added.model, 'm', 'preserves other body keys')
eq(added.messages.length, 0, 'preserves nested arrays')

const merged = JSON.parse(addIncludeUsage(JSON.stringify({
  stream: true,
  stream_options: { foo: 'bar', include_usage: false },
})))
eq(merged.stream_options.include_usage, true, 'overrides include_usage false')
eq(merged.stream_options.foo, 'bar', 'keeps other stream_options keys')

const nonStreaming = JSON.stringify({ model: 'm', stream: false, messages: [] })
eq(addIncludeUsage(nonStreaming), nonStreaming, 'leaves non-streaming body untouched')
const alreadyRequested = JSON.stringify({ stream: true, stream_options: { include_usage: true } })
eq(addIncludeUsage(alreadyRequested), alreadyRequested, 'idempotent for include_usage true')
eq(addIncludeUsage('not json'), 'not json', 'invalid JSON passed through')

// ---------------------------------------------------------------------------
// parseWireUsage: OpenAI chat JSON
// ---------------------------------------------------------------------------
const openaiChat = parseWireUsage(JSON.stringify({
  id: 'chatcmpl-1',
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_cache_hit_tokens: 40,
    prompt_cache_miss_tokens: 60,
    total_tokens: 120,
    completion_tokens_details: { reasoning_tokens: 5 },
  },
}))
eq(openaiChat.usage.inputTokens, 60, 'chat input = cache miss')
eq(openaiChat.usage.outputTokens, 20, 'chat output')
eq(openaiChat.usage.reasoningTokens, 5, 'chat reasoning')
eq(openaiChat.usage.cacheReadTokens, 40, 'chat cache read')
eq(openaiChat.usage.cacheWriteTokens, 0, 'chat cache write defaults to 0')
eq(openaiChat.usage.totalTokens, 120, 'chat total tokens')
eq(openaiChat.tools.length, 0, 'chat has no server tools')

// ---------------------------------------------------------------------------
// parseWireUsage: OpenAI SSE final usage chunk
// ---------------------------------------------------------------------------
const openaiSse = parseWireUsage([
  'data: {"id":"chatcmpl-2","choices":[{"delta":{"content":"hi"}}]}',
  '',
  'data: {"id":"chatcmpl-2","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
  '',
  'data: [DONE]',
  '',
].join('\n'))
eq(openaiSse.usage.inputTokens, 7, 'SSE input tokens')
eq(openaiSse.usage.outputTokens, 3, 'SSE output tokens')
eq(openaiSse.usage.totalTokens, null, 'SSE missing total stays null')

// ---------------------------------------------------------------------------
// parseWireUsage: OpenAI responses JSON with server tools
// ---------------------------------------------------------------------------
const openaiResponses = parseWireUsage(JSON.stringify({
  object: 'response',
  usage: {
    input_tokens: 50,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens_details: { reasoning_tokens: 4 },
    server_tool_use: { web_search_requests: 1, tool_search_requests: 2 },
  },
}))
eq(openaiResponses.usage.inputTokens, 50, 'responses input tokens')
eq(openaiResponses.usage.cacheReadTokens, 20, 'responses cached tokens')
eq(openaiResponses.usage.reasoningTokens, 4, 'responses reasoning tokens')
const responsesTools = Object.fromEntries(openaiResponses.tools.map((tool) => [tool.name, tool.requests]))
eq(responsesTools.web_search, 1, 'responses web_search count')
eq(responsesTools.tool_search, 2, 'responses tool_search count')

// ---------------------------------------------------------------------------
// parseWireUsage: Anthropic messages JSON (cache + server_tool_use)
// ---------------------------------------------------------------------------
const anthropic = parseWireUsage(JSON.stringify({
  type: 'message',
  role: 'assistant',
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
    server_tool_use: { web_search_requests: 2 },
  },
  content: [
    { type: 'server_tool_use', id: 'srv-1', name: 'web_search', input: { query: 'x' } },
    { type: 'web_search_tool_result', tool_use_id: 'srv-1', content: [] },
  ],
}))
eq(anthropic.usage.inputTokens, 10, 'anthropic input tokens')
eq(anthropic.usage.outputTokens, 5, 'anthropic output tokens')
eq(anthropic.usage.cacheReadTokens, 3, 'anthropic cache read')
eq(anthropic.usage.cacheWriteTokens, 2, 'anthropic cache write')
eq(anthropic.tools.length, 1, 'anthropic one tool row')
eq(anthropic.tools[0].name, 'web_search', 'anthropic tool name')
eq(anthropic.tools[0].requests, 2, 'usage counters win over content blocks (no double count)')

// ---------------------------------------------------------------------------
// Fee math
// ---------------------------------------------------------------------------
eq(serverToolFee(1000), 0.75, '1000 requests = 0.75 USD')
eq(serverToolFee(1), 0.00075, '1 request = 0.00075 USD')
eq(serverToolFee(2), 0.0015, '2 requests = 0.0015 USD')
eq(serverToolFee(0), 0, 'no requests = no fee')

// ---------------------------------------------------------------------------
// Fetch wrapper transparency + wire tool records
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch

// Dedicated transparency block: install exactly one wrapper over a recording
// fake and assert untouched/mutated requests and observable responses.
{
  const calls = []
  const fakeFetch = async (input, init) => {
    calls.push({ input, init })
    return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const previous = globalThis.fetch
  globalThis.fetch = fakeFetch
  const stats = createTransportStats()
  const tools = []
  const dispose = installFetchTransport({
    stats,
    onTools: (tool, sessionId) => tools.push({ ...tool, sessionId }),
  })
  try {
    // Non-matching URL: same init object, same Response.
    const untouchedInit = { method: 'POST', body: 'raw-body-not-json' }
    const untouchedResponse = await globalThis.fetch('https://example.com/other', untouchedInit)
    eq(calls[0].init, untouchedInit, 'non-matching init object untouched')
    eq(calls[0].input, 'https://example.com/other', 'non-matching input untouched')
    check(untouchedResponse.ok, 'non-matching response passes through')

    // Matching streaming chat: body gains include_usage before the original fetch.
    const streamingBody = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    await globalThis.fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      body: streamingBody,
      headers: { 'content-type': 'application/json', 'x-deepseek-harness-session-id': 'sess-1' },
    })
    const sent = JSON.parse(calls[1].init.body)
    eq(sent.stream_options.include_usage, true, 'wrapper mutates streaming body')
    eq(sent.messages.length, 1, 'wrapper preserves other body keys')
    eq(calls[1].init.headers['content-type'], 'application/json', 'wrapper preserves headers')

    // Matching non-streaming chat: body untouched.
    const nonStreamingBody = JSON.stringify({ model: 'm', messages: [] })
    await globalThis.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: nonStreamingBody })
    eq(calls[2].init.body, nonStreamingBody, 'non-streaming body untouched')

    // `/responses` is observed read-only: a streaming body must be byte-identical.
    const responsesBody = JSON.stringify({ model: 'm', stream: true, input: [] })
    await globalThis.fetch('https://api.deepseek.com/v1/responses', {
      method: 'POST',
      body: responsesBody,
    })
    eq(calls[3].init.body, responsesBody, '/responses streaming body is byte-identical')

    // Caller can still read the response body.
    const response = await globalThis.fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
    })
    const text = await response.text()
    check(text.includes('"prompt_tokens":1'), 'caller response body readable')
    check(stats.intercepted >= 3, 'model endpoints counted as intercepted')

    // Give the background observer a moment to settle the JSON usage.
    for (let attempt = 0; attempt < 50 && stats.usageParsed === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    eq(stats.usageParsed >= 1, true, 'JSON usage observed from clone')
    eq(tools.length, 0, 'no tool records for token-only responses')
  } finally {
    dispose()
    globalThis.fetch = previous
  }
}

// Server-tool wire record from an SSE response.
{
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":3,"server_tool_use":{"web_search_requests":2}}}}',
    '',
    'data: {"type":"message_delta","usage":{"output_tokens":20}}',
    '',
    '',
  ].join('\n')
  const fakeFetch = async (input, init) => new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'r1' },
  })
  const previous = globalThis.fetch
  globalThis.fetch = fakeFetch
  const stats = createTransportStats()
  const tools = []
  const dispose = installFetchTransport({
    stats,
    onTools: (tool, sessionId) => tools.push({ ...tool, sessionId }),
  })
  try {
    const response = await globalThis.fetch('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-deepseek-harness-session-id': 'sess-9' },
      body: JSON.stringify({ stream: true }),
    })
    eq(await response.text(), sse, 'SSE body still readable by caller')
    for (let attempt = 0; attempt < 100 && tools.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    eq(tools.length, 1, 'one wire tool record')
    eq(tools[0].name, 'web_search', 'wire tool canonical name')
    eq(tools[0].requests, 2, 'wire tool request count')
    eq(tools[0].sessionId, 'sess-9', 'wire tool session header')
    eq(stats.serverToolFees, 1, 'serverToolFees stat')
    eq(stats.usageParsed, 1, 'usageParsed stat')
  } finally {
    dispose()
    globalThis.fetch = previous
  }
}

// Second install is a no-op; the owning installer keeps the real disposer.
{
  const calls = []
  const fakeFetch = async (input) => {
    calls.push(input)
    return new Response('ok', { status: 200 })
  }
  const previous = globalThis.fetch
  globalThis.fetch = fakeFetch
  const first = installFetchTransport({ stats: createTransportStats() })
  const second = installFetchTransport({ stats: createTransportStats() })
  try {
    check(typeof second === 'function', 'second install returns a disposer function')
    second()
    await globalThis.fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    eq(calls.length, 1, 'first wrapper still active after second install + dispose')
    check(globalThis.fetch !== fakeFetch, 'second install never removed the active wrapper')
  } finally {
    first()
    eq(globalThis.fetch, fakeFetch, 'first disposer still restores the original fetch')
    globalThis.fetch = previous
  }
}

// Error propagation: a rejected fetch stays rejected.
{
  const failure = new Error('network down')
  const previous = globalThis.fetch
  globalThis.fetch = async () => {
    throw failure
  }
  const stats = createTransportStats()
  const dispose = installFetchTransport({ stats })
  try {
    let caught = null
    try {
      await globalThis.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: '{}' })
    } catch (error) {
      caught = error
    }
    eq(caught, failure, 'fetch rejection propagates unchanged')
  } finally {
    dispose()
    globalThis.fetch = previous
  }
}

globalThis.fetch = realFetch

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log(`${checks} checks passed`)
