// HTTP surface of the host collector.
//
//   GET /usage-popup/api/usage?since=<seq>[&limit=<n>]
//   GET /usage-popup/api/health
//
// The route is registered as a prefix by host.ts; unknown paths get a JSON 404
// and known paths with the wrong method get a JSON 405.

import { FORMAT, FORMAT_VERSION } from './store.js'
import type { UsageStore } from './store.js'
import type { TransportStats } from './transport.js'

export const ROUTE_PREFIX = '/usage-popup'
export const USAGE_PATH = '/usage-popup/api/usage'
export const HEALTH_PATH = '/usage-popup/api/health'
export const MAX_LIMIT = 500

export interface RouteState {
  store: UsageStore
  startedAt: number
  transport: TransportStats
}

function sendJson(res: any, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  const length = new TextEncoder().encode(text).byteLength
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(length),
    'cache-control': 'no-store',
    ...extraHeaders,
  }
  try {
    if (typeof res?.writeHead === 'function') {
      res.writeHead(status, headers)
    } else if (res && typeof res === 'object') {
      res.statusCode = status
      res.headers = headers
    }
    res?.end?.(text)
  } catch {
    /* the socket may already be gone */
  }
}

function parseNonNegativeInt(raw: string | null): number | null | undefined {
  // null => absent (use the default); undefined => invalid (400).
  if (raw === null) return null
  if (!/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

export function createRouteHandler(getState: () => RouteState) {
  return async function handleRequest(req: any, res: any): Promise<void> {
    let url: URL
    try {
      url = new URL(String(req?.url ?? '/'), 'http://localhost')
    } catch {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    const path = url.pathname
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (path !== USAGE_PATH && path !== HEALTH_PATH) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return
    }
    const state = getState()
    if (path === HEALTH_PATH) {
      sendJson(res, 200, {
        ok: true,
        format: FORMAT,
        version: FORMAT_VERSION,
        cursor: state.store.cursor,
        startedAt: state.startedAt,
        records: state.store.count,
        transport: {
          installed: state.transport.installed,
          intercepted: state.transport.intercepted,
          usageParsed: state.transport.usageParsed,
          serverToolFees: state.transport.serverToolFees,
          errors: state.transport.errors,
        },
      })
      return
    }

    const since = parseNonNegativeInt(url.searchParams.get('since'))
    if (since === undefined) {
      sendJson(res, 400, { error: 'since must be a non-negative integer' })
      return
    }
    const limit = parseNonNegativeInt(url.searchParams.get('limit'))
    if (limit === undefined || (limit !== null && limit < 1)) {
      sendJson(res, 400, { error: 'limit must be a positive integer' })
      return
    }
    const effectiveLimit = Math.min(limit ?? MAX_LIMIT, MAX_LIMIT)
    const cursor = state.store.cursor
    const requestedSince = since ?? 0
    // A store restart/rotation resets seq to 1 while a browser cursor persists.
    // `since > cursor` can never match, so replay from 0 and tell the client the
    // cursor was reset (optional contract addition; older clients ignore it).
    const reset = requestedSince > cursor
    sendJson(res, 200, {
      format: FORMAT,
      version: FORMAT_VERSION,
      cursor,
      ...(reset ? { reset: true } : {}),
      records: state.store.since(reset ? 0 : requestedSince, effectiveLimit),
    })
  }
}
