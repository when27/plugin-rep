// Turns LLM stream chunks and session events into UsageRecords.
//
// Two independent feeds:
//   * `llm/stream` waterfall -> one `kind:'llm'` record per yielded usage chunk.
//   * `session/event` (global) -> session metadata for tagging, plus one
//     `kind:'tool'` record per successful server-tool call.
//
// Wire-level server-tool fees are emitted by transport.ts; this module only
// owns the token source of truth so the same tokens are never double counted.
export const SERVER_TOOL_NAMES = new Set([
    'deepseek_web_search',
    'deepseek_read_url',
    'web_search',
    'read_url',
    'toolSearch',
    'toolFetch',
    'tool_search',
    'tool_fetch',
]);
export const FEE_PER_SERVER_TOOL_REQUEST_USD = 0.00075;
/** Wire and session-event paths may both observe one server-tool request. */
export const TOOL_FEE_DEDUPE_WINDOW_MS = 5_000;
/**
 * Process-level claim table for server-tool fees. The wire parser and the
 * `session/event` path can both see the same tool request; the first claim for a
 * `sessionId::name` pair wins and a second claim inside the window is a
 * duplicate. Exported so tests can drive the window directly.
 */
const toolFeeClaims = new Map();
export function claimToolFee(sessionId, name, atMs = Date.now()) {
    const key = `${sessionId ?? ''}::${name}`;
    const previous = toolFeeClaims.get(key);
    if (previous !== undefined && atMs - previous < TOOL_FEE_DEDUPE_WINDOW_MS)
        return false;
    toolFeeClaims.set(key, atMs);
    if (toolFeeClaims.size > 5_000) {
        const oldest = toolFeeClaims.keys().next();
        if (!oldest.done)
            toolFeeClaims.delete(oldest.value);
    }
    return true;
}
/** Reset the process-level claim table (tests only). */
export function resetToolFeeClaims() {
    toolFeeClaims.clear();
}
/** Canonical wire names used by the client for server-tool rows. */
export function canonicalServerTool(name) {
    if (typeof name !== 'string')
        return null;
    const lower = name.trim().toLowerCase();
    switch (lower) {
        case 'deepseek_web_search':
        case 'web_search':
        case 'websearch':
        case 'web-search':
            return 'web_search';
        case 'deepseek_read_url':
        case 'read_url':
        case 'readurl':
        case 'read-url':
            return 'read_url';
        case 'toolsearch':
        case 'tool_search':
        case 'tool-search':
            return 'tool_search';
        case 'toolfetch':
        case 'tool_fetch':
        case 'tool-fetch':
            return 'tool_fetch';
        default:
            return null;
    }
}
/** Dollar fee for N successful server-tool requests (0.00075 USD each). */
export function serverToolFee(requests) {
    if (!Number.isFinite(requests) || requests <= 0)
        return 0;
    return Math.round(requests * FEE_PER_SERVER_TOOL_REQUEST_USD * 1e10) / 1e10;
}
function asString(value) {
    return typeof value === 'string' && value !== '' ? value : null;
}
function parentSessionIdOf(container) {
    const parent = container?.parentSession;
    if (typeof parent === 'string')
        return parent === '' ? null : parent;
    if (parent && typeof parent === 'object')
        return asString(parent.id);
    return asString(container?.parentSessionId);
}
/**
 * Derive the tagging metadata carried by a live session object.
 *
 * The live Session nests lineage under `session.header` (`origin`,
 * `parentSession`, `delegationDepth`, `agentPreset`); older/flat shapes carry
 * those fields directly on the session. Prefer the header when present and
 * fall back to the flat shape for compatibility.
 */
export function readSessionMeta(session) {
    const header = session?.header ?? session;
    const parentSessionId = parentSessionIdOf(header);
    const delegationDepth = Number.isInteger(header?.delegationDepth)
        ? header.delegationDepth
        : null;
    const agentPreset = asString(header?.agentPreset);
    const origin = asString(header?.origin);
    const isSubagent = origin === 'subagent' || parentSessionId !== null;
    let type;
    if (origin === 'background')
        type = 'background';
    else if (origin === 'compaction')
        type = 'compaction';
    else if (isSubagent)
        type = 'subagent';
    else if (origin === 'main')
        type = 'main';
    else
        type = 'main';
    return { parentSessionId, delegationDepth, agentPreset, isSubagent, type };
}
export function normalizeUsage(usage) {
    const int = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
    const total = usage?.totalTokens;
    return {
        inputTokens: int(usage?.inputTokens),
        outputTokens: int(usage?.outputTokens),
        reasoningTokens: int(usage?.reasoningTokens),
        cacheReadTokens: int(usage?.cacheReadTokens),
        cacheWriteTokens: int(usage?.cacheWriteTokens),
        totalTokens: typeof total === 'number' && Number.isFinite(total) ? Math.trunc(total) : null,
    };
}
/** Purpose values that mark the compaction summary request. */
export function isCompactionPurpose(purpose) {
    return typeof purpose === 'string' && purpose.toLowerCase().includes('compact');
}
export class Collector {
    store;
    startedAt;
    sessions = new Map();
    pendingTools = new Map();
    emittedTools = new Set();
    constructor(store, options = {}) {
        this.store = store;
        this.startedAt = options.startedAt ?? Date.now();
    }
    sessionTypeOf(sessionId, purpose) {
        if (sessionId !== null) {
            const meta = this.sessions.get(sessionId);
            if (meta)
                return meta.type;
        }
        if (isCompactionPurpose(purpose))
            return 'compaction';
        return 'unknown';
    }
    metaOf(sessionId) {
        return sessionId === null ? undefined : this.sessions.get(sessionId);
    }
    /** Record one token usage chunk. Never throws into the stream. */
    recordLlm(options, usage) {
        const sessionId = options?.sessionId == null ? null : String(options.sessionId);
        const purpose = asString(options?.purpose);
        const meta = this.metaOf(sessionId);
        return this.store.append({
            at: Date.now(),
            kind: 'llm',
            source: 'llm-stream',
            sessionId,
            sessionType: meta?.type ?? this.sessionTypeOf(sessionId, purpose),
            parentSessionId: meta?.parentSessionId ?? null,
            delegationDepth: meta?.delegationDepth ?? null,
            agentPreset: meta?.agentPreset ?? null,
            model: asString(options?.model) ?? 'unknown',
            provider: asString(options?.provider),
            purpose,
            usage: normalizeUsage(usage),
            serverTool: null,
        });
    }
    /** Record one server-tool fee event; `source` is 'tool-event' or 'wire'. */
    recordTool(input) {
        const name = canonicalServerTool(input.name);
        if (name === null)
            return null;
        const requests = Number.isFinite(input.requests) ? Math.max(1, Math.trunc(input.requests)) : 1;
        const status = typeof input.status === 'number' ? input.status : null;
        const feeUsd = typeof input.feeUsd === 'number' ? input.feeUsd : serverToolFee(requests);
        const sessionId = input.sessionId == null || input.sessionId === '' ? null : String(input.sessionId);
        if (!claimToolFee(sessionId, name))
            return null;
        const meta = this.metaOf(sessionId);
        const serverTool = { name, requests, status, feeUsd };
        return this.store.append({
            at: Date.now(),
            kind: 'tool',
            source: input.source,
            sessionId,
            sessionType: meta?.type ?? this.sessionTypeOf(sessionId, null),
            parentSessionId: meta?.parentSessionId ?? null,
            delegationDepth: meta?.delegationDepth ?? null,
            agentPreset: meta?.agentPreset ?? null,
            model: 'server-tool',
            provider: null,
            purpose: null,
            usage: null,
            serverTool,
        });
    }
    /**
     * Feed one `session/event`. Updates the metadata map on every event and emits
     * a tool record when a tracked server-tool call settles successfully.
     */
    observeSession(session, event) {
        const sessionId = asString(session?.id) ?? asString(session?.header?.id);
        if (sessionId !== null)
            this.sessions.set(sessionId, readSessionMeta(session));
        if (event?.type === 'tool/call')
            return this.observeToolCall(sessionId, event);
        if (event?.type === 'tool/result')
            return this.observeToolResult(sessionId, event);
        return null;
    }
    observeToolCall(sessionId, event) {
        const callId = asString(event?.data?.callId);
        const name = canonicalServerTool(event?.data?.name);
        if (callId === null || name === null)
            return null;
        const key = `${sessionId ?? ''}\u0000${callId}`;
        this.pendingTools.set(key, { name, at: Date.now() });
        if (this.pendingTools.size > 5000) {
            // Drop the oldest started calls; their result no longer arrives.
            const first = this.pendingTools.keys().next();
            if (!first.done)
                this.pendingTools.delete(first.value);
        }
        return null;
    }
    observeToolResult(sessionId, event) {
        const data = event?.data ?? {};
        const message = data?.message ?? {};
        const callId = asString(message?.source?.callId) ?? asString(message?.toolCallId);
        if (callId === null)
            return null;
        const key = `${sessionId ?? ''}\u0000${callId}`;
        const pending = this.pendingTools.get(key);
        if (pending === undefined)
            return null;
        this.pendingTools.delete(key);
        const dedupeKey = `${sessionId ?? ''}\u0000${pending.name}\u0000${callId}`;
        if (this.emittedTools.has(dedupeKey))
            return null;
        this.emittedTools.add(dedupeKey);
        if (this.emittedTools.size > 10_000)
            this.emittedTools.clear();
        const success = message?.isError !== true && data?.error === undefined;
        // Failed tool calls are not billed: never invent a fee for an error result.
        if (!success)
            return null;
        return this.recordTool({
            source: 'tool-event',
            sessionId,
            name: pending.name,
            requests: 1,
            status: 200,
            feeUsd: serverToolFee(1),
        });
    }
}
/**
 * Wrap the downstream `llm/stream` iterable: re-yield every chunk unchanged and
 * record exactly one token-usage record when the stream finishes. DSH protocol
 * is last-chunk-wins, so every usage chunk replaces the previously buffered one;
 * the final (latest) usage is emitted once in `finally`, even when the consumer
 * breaks early or the stream throws after a usage chunk. `next` is called
 * exactly once, and recording failures never disturb the stream.
 */
export function wrapLlmStream(collector, options, next) {
    const source = next();
    return {
        [Symbol.asyncIterator]() {
            const iterator = source[Symbol.asyncIterator]();
            let pendingUsage = null;
            let emitted = false;
            const flush = () => {
                if (emitted || pendingUsage === null)
                    return;
                emitted = true;
                try {
                    collector.recordLlm(options, pendingUsage);
                }
                catch {
                    /* never break the model stream */
                }
            };
            return {
                async next() {
                    try {
                        const step = await iterator.next();
                        if (step.done) {
                            flush();
                            return step;
                        }
                        const chunk = step.value;
                        if (chunk && chunk.type === 'usage' && chunk.usage)
                            pendingUsage = chunk.usage;
                        return step;
                    }
                    catch (error) {
                        flush();
                        throw error;
                    }
                },
                async return(value) {
                    flush();
                    if (typeof iterator.return === 'function')
                        return iterator.return(value);
                    return { done: true, value };
                },
                async throw(error) {
                    flush();
                    if (typeof iterator.throw === 'function')
                        return iterator.throw(error);
                    throw error;
                },
            };
        },
    };
}
