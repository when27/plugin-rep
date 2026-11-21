// Transparent global `fetch` middleware for server-tool fee accounting.
//
// Two jobs, both best effort:
//   1. For OpenAI-style streaming `/chat/completions` POSTs, add
//      `stream_options: { include_usage: true }` so the wire carries a final
//      usage chunk. `/responses` is observed but never mutated (its streaming
//      payload does not accept `stream_options`). Every other request is passed
//      through byte-identically.
//   2. For *successful* model-endpoint responses, read a clone in the
//      background (max 5 MB) and emit `kind:'tool'` records for server-tool
//      requests. Token usage records are NOT emitted here: the `llm/stream`
//      recorder is the single token source, which avoids double counting.
//
// The wrapper never consumes the caller's body or delays its response.

import type { NormalizedUsage } from './store.js'
import { canonicalServerTool, serverToolFee } from './collector.js'

export const MAX_PARSE_BYTES = 5 * 1024 * 1024
export const TRANSPORT_SYMBOL = Symbol.for('usage-popup.fetch-transport')

export interface TransportStats {
  installed: boolean
  intercepted: number
  usageParsed: number
  serverToolFees: number
  errors: number
}

export interface WireToolUse {
  name: string
  requests: number
}

export interface ParsedWireUsage {
  usage: NormalizedUsage | null
  tools: WireToolUse[]
  /** True when at least one body/frame could not be parsed. */
  malformed?: boolean
}

export function createTransportStats(): TransportStats {
  return {
    installed: false,
    intercepted: 0,
    usageParsed: 0,
    serverToolFees: 0,
    errors: 0,
  }
}

/** Endpoints whose streaming body accepts `stream_options.include_usage`. */
export function isIncludeUsageUrl(url: string): boolean {
  return /\/chat\/completions(?:[/?#]|$)/.test(url)
}

/** Endpoints we are willing to observe: OpenAI chat/responses and Anthropic messages. */
export function isModelEndpoint(url: string): boolean {
  return isIncludeUsageUrl(url)
    || /\/responses(?:[/?#]|$)/.test(url)
    || /\/messages(?:[/?#]|$)/.test(url)
}

/**
 * Ensure a streaming chat/responses body asks for a final usage chunk.
 * Returns the input unchanged for anything that is not a stream request.
 */
export function addIncludeUsage(bodyText: string): string {
  if (typeof bodyText !== 'string' || bodyText.trim() === '') return bodyText
  let body: any
  try {
    body = JSON.parse(bodyText)
  } catch {
    return bodyText
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bodyText
  if (!body.stream) return bodyText
  const current = body.stream_options
  if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
    if (current.include_usage === true) return bodyText
    body.stream_options = { ...current, include_usage: true }
  } else {
    body.stream_options = { include_usage: true }
  }
  return JSON.stringify(body)
}

function toInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

interface Accumulator {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number | null
  /** Counts declared by provider usage payloads. */
  tools: Map<string, number>
  /** Counts inferred from response content blocks. */
  blocks: Map<string, number>
}

function newAccumulator(): Accumulator {
  return { tools: new Map(), blocks: new Map() }
}

function addTool(target: Map<string, number>, name: string | null, requests: number): void {
  if (name === null || !(requests > 0)) return
  target.set(name, (target.get(name) ?? 0) + requests)
}

/** Map a provider `*_requests` counter key to a canonical tool name. */
function counterKeyToTool(key: string): string | null {
  const stripped = key.replace(/(_requests|_request|Requests)$/i, '')
  return canonicalServerTool(stripped)
}

function extractServerTools(acc: Accumulator, container: unknown): void {
  if (container === null || typeof container !== 'object') return
  if (Array.isArray(container)) {
    for (const entry of container) extractServerTools(acc, entry)
    return
  }
  for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
    const requests = toInt(value)
    if (requests === undefined || requests <= 0) continue
    const name = counterKeyToTool(key)
    if (name !== null) addTool(acc.tools, name, requests)
  }
}

/** Merge a provider usage payload into the accumulator. Later chunks win. */
function extractUsage(acc: Accumulator, usage: unknown): void {
  if (usage === null || typeof usage !== 'object') return
  const value = usage as Record<string, any>
  const prompt = toInt(value.prompt_tokens)
  const miss = toInt(value.prompt_cache_miss_tokens)
  const hit = toInt(value.prompt_cache_hit_tokens)
  const cachedPrompt = toInt(value.prompt_tokens_details?.cached_tokens)
    ?? toInt(value.input_tokens_details?.cached_tokens)
  const completion = toInt(value.completion_tokens)
  const reasoning =
    toInt(value.completion_tokens_details?.reasoning_tokens)
    ?? toInt(value.output_tokens_details?.reasoning_tokens)
  const cacheReadInput = toInt(value.cache_read_input_tokens)
  const cacheCreationInput = toInt(value.cache_creation_input_tokens)
  const input = toInt(value.input_tokens)
  const output = toInt(value.output_tokens)
  const total = value.total_tokens

  // OpenAI chat style.
  if (miss !== undefined) acc.inputTokens = miss
  else if (prompt !== undefined) acc.inputTokens = prompt
  else if (input !== undefined && acc.inputTokens === undefined) acc.inputTokens = input
  if (hit !== undefined) acc.cacheReadTokens = hit
  else if (cachedPrompt !== undefined) acc.cacheReadTokens = cachedPrompt
  else if (cacheReadInput !== undefined) acc.cacheReadTokens = cacheReadInput
  if (cacheCreationInput !== undefined) acc.cacheWriteTokens = cacheCreationInput
  if (completion !== undefined) acc.outputTokens = completion
  else if (output !== undefined) acc.outputTokens = output
  if (reasoning !== undefined) acc.reasoningTokens = reasoning
  if (typeof total === 'number' && Number.isFinite(total)) acc.totalTokens = Math.trunc(total)

  extractServerTools(acc, value.server_tool_use)
  extractServerTools(acc, value.serverToolUse)
}

function extractContentBlocks(acc: Accumulator, content: unknown): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, any>
    if (record.type === 'server_tool_use') {
      addTool(acc.blocks, canonicalServerTool(record.name), 1)
    } else if (record.type === 'web_search_tool_result') {
      if (!acc.blocks.has('web_search')) addTool(acc.blocks, 'web_search', 1)
    }
  }
}

function finalize(acc: Accumulator, malformed = false): ParsedWireUsage {
  const hasUsage =
    acc.inputTokens !== undefined
    || acc.outputTokens !== undefined
    || acc.reasoningTokens !== undefined
    || acc.cacheReadTokens !== undefined
    || acc.cacheWriteTokens !== undefined
    || acc.totalTokens !== undefined
  const usage: NormalizedUsage | null = hasUsage
    ? {
      inputTokens: acc.inputTokens ?? 0,
      outputTokens: acc.outputTokens ?? 0,
      reasoningTokens: acc.reasoningTokens ?? 0,
      cacheReadTokens: acc.cacheReadTokens ?? 0,
      cacheWriteTokens: acc.cacheWriteTokens ?? 0,
      totalTokens: typeof acc.totalTokens === 'number' ? acc.totalTokens : null,
    }
    : null
  const names = new Set([...acc.tools.keys(), ...acc.blocks.keys()])
  const tools: WireToolUse[] = [...names].map((name) => ({
    name,
    // Provider counters and content blocks describe the same requests; take the
    // larger count instead of summing them (SSE chunks arrive in either order).
    requests: Math.max(acc.tools.get(name) ?? 0, acc.blocks.get(name) ?? 0),
  }))
  return malformed ? { usage, tools, malformed } : { usage, tools }
}

function applyJsonBody(acc: Accumulator, body: any): void {
  if (body === null || typeof body !== 'object') return
  if (body.response && typeof body.response === 'object') {
    applyJsonBody(acc, body.response)
    return
  }
  if (body.usage !== undefined) extractUsage(acc, body.usage)
  if (body.type === 'message') {
    extractContentBlocks(acc, body.content)
  } else if (Array.isArray(body.content)) {
    extractContentBlocks(acc, body.content)
  }
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (item === null || typeof item !== 'object') continue
      if (item.type === 'web_search_call') addTool(acc.blocks, 'web_search', 1)
      else if (item.type === 'tool_search_call') addTool(acc.blocks, 'tool_search', 1)
      if (Array.isArray(item.content)) extractContentBlocks(acc, item.content)
    }
  }
}

function applySseEvent(acc: Accumulator, event: any): void {
  if (event === null || typeof event !== 'object') return
  if (event.type === 'response.completed' && event.response) {
    applyJsonBody(acc, event.response)
    return
  }
  if (event.type === 'message_start' && event.message) {
    extractUsage(acc, event.message.usage)
    extractContentBlocks(acc, event.message.content)
    return
  }
  if (event.type === 'message_delta') {
    extractUsage(acc, event.usage)
    return
  }
  if (event.type === 'content_block_start' && event.content_block) {
    extractContentBlocks(acc, [event.content_block])
    return
  }
  if (event.usage !== undefined) extractUsage(acc, event.usage)
  if (event.message?.usage !== undefined) extractUsage(acc, event.message.usage)
  if (event.response?.usage !== undefined) extractUsage(acc, event.response.usage)
}

function looksLikeSse(text: string): boolean {
  return /(^|\n)data:/.test(text)
}

/** Parse a JSON body or SSE stream into normalized usage + server-tool counts. */
export function parseWireUsage(text: string): ParsedWireUsage {
  const acc = newAccumulator()
  const body = typeof text === 'string' ? text : ''
  if (body.trim() === '') return finalize(acc)
  if (!looksLikeSse(body)) {
    try {
      applyJsonBody(acc, JSON.parse(body))
    } catch {
      return finalize(acc, true)
    }
    return finalize(acc)
  }
  let malformed = false
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      applySseEvent(acc, JSON.parse(payload))
    } catch {
      // One broken SSE frame must not lose the rest.
      malformed = true
    }
  }
  return finalize(acc, malformed)
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input
  if (input !== null && typeof input === 'object') {
    const record = input as Record<string, unknown>
    if (typeof record.href === 'string') return record.href
    if (typeof record.url === 'string') return record.url
  }
  return ''
}

function requestMethod(input: unknown, init: any): string {
  const raw = init?.method ?? (input !== null && typeof input === 'object' ? (input as any).method : undefined)
  return typeof raw === 'string' && raw !== '' ? raw.toUpperCase() : 'GET'
}

function headerValue(input: unknown, init: any, name: string): string | null {
  const read = (headers: any): string | null => {
    if (!headers) return null
    try {
      if (typeof headers.get === 'function') {
        const value = headers.get(name)
        return typeof value === 'string' ? value : null
      }
      if (Array.isArray(headers)) {
        for (const entry of headers) {
          if (Array.isArray(entry) && String(entry[0]).toLowerCase() === name) return String(entry[1])
        }
        return null
      }
      if (typeof headers === 'object') {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === name) return String(headers[key])
        }
      }
    } catch {
      return null
    }
    return null
  }
  return read(init?.headers) ?? read((input as any)?.headers)
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function readCapped(response: any, limit: number): Promise<string> {
  const body = response?.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const step = await reader.read()
      if (step.done) break
      const value = step.value
      if (!value) continue
      size += value.byteLength ?? value.length ?? 0
      if (size > limit) {
        try {
          await reader.cancel()
        } catch {
          /* already closed */
        }
        break
      }
      chunks.push(value)
    }
    return new TextDecoder().decode(concatBytes(chunks))
  }
  if (typeof response?.text === 'function') {
    const text: string = await response.text()
    return text.length > limit ? text.slice(0, limit) : text
  }
  return ''
}

export interface TransportOptions {
  stats?: TransportStats
  onTools?: (tool: WireToolUse, sessionId: string | null) => void
}

export interface TransportHandle {
  dispose: () => void
  original: any
}

function observeInBackground(
  response: any,
  sessionId: string | null,
  options: TransportOptions,
  stats: TransportStats,
): void {
  void (async () => {
    try {
      if (!response || response.ok !== true || typeof response.clone !== 'function') return
      const parsed = parseWireUsage(await readCapped(response.clone(), MAX_PARSE_BYTES))
      if (parsed.malformed === true) stats.errors += 1
      if (parsed.usage !== null) stats.usageParsed += 1
      for (const tool of parsed.tools) {
        try {
          options.onTools?.(tool, sessionId)
        } catch {
          stats.errors += 1
        }
        stats.serverToolFees += 1
      }
    } catch {
      stats.errors += 1
    }
  })()
}

/**
 * Install the transparent fetch wrapper once per process. Returns a disposer
 * that restores the previous fetch when it is still the active wrapper. A
 * second install is a no-op: it returns an idempotent `() => {}` so it cannot
 * tear down the owning installer's wrapper.
 */
export function installFetchTransport(options: TransportOptions = {}): () => void {
  const target: any = globalThis
  const existing = target[TRANSPORT_SYMBOL]
  if (existing && typeof existing.dispose === 'function') return () => {}
  if (typeof target.fetch !== 'function') return () => {}
  const stats = options.stats ?? createTransportStats()
  const original = target.fetch

  function wrappedFetch(this: any, input: any, init?: any): any {
    let url = ''
    let method = 'GET'
    let sessionId: string | null = null
    try {
      url = requestUrl(input)
      method = requestMethod(input, init)
      sessionId = headerValue(input, init, 'x-deepseek-harness-session-id')
    } catch {
      stats.errors += 1
    }

    let effectiveInit = init
    if (init && typeof init.body === 'string' && method === 'POST' && isIncludeUsageUrl(url)) {
      try {
        const nextBody = addIncludeUsage(init.body)
        if (nextBody !== init.body) effectiveInit = { ...init, body: nextBody }
      } catch {
        stats.errors += 1
      }
    }

    if (!isModelEndpoint(url)) return original.call(this, input, effectiveInit)

    stats.intercepted += 1
    const result = original.call(this, input, effectiveInit)
    if (!result || typeof result.then !== 'function') return result
    return result.then(
      (response: any) => {
        observeInBackground(response, sessionId, options, stats)
        return response
      },
      (error: any) => {
        throw error
      },
    )
  }

  target.fetch = wrappedFetch
  stats.installed = true
  let disposed = false
  const handle: TransportHandle = {
    original,
    dispose: () => {
      if (disposed) return
      disposed = true
      try {
        if (target.fetch === wrappedFetch) target.fetch = original
      } catch {
        /* another layer replaced it; leave theirs alone */
      }
      try {
        if (target[TRANSPORT_SYMBOL] === handle) delete target[TRANSPORT_SYMBOL]
        else target[TRANSPORT_SYMBOL] = undefined
      } catch {
        target[TRANSPORT_SYMBOL] = undefined
      }
      stats.installed = false
    },
  }
  target[TRANSPORT_SYMBOL] = handle
  return handle.dispose
}

export { serverToolFee }
