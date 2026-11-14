// Host half of the `usage-popup` bundle plugin.
//
// Wires three feeds into one append-only collector:
//   * `llm/stream`      -> token usage records (single token source of truth)
//   * `session/event`   -> session tagging + server-tool event fees
//   * global `fetch`    -> include_usage on stream requests + wire tool fees
//
// and exposes them at `/usage-popup/api/{usage,health}`. Everything is
// best-effort: a missing service or a broken feed must never fail host load.

import { Collector, wrapLlmStream } from './host/collector.js'
import { createRouteHandler, ROUTE_PREFIX } from './host/route.js'
import { resolveRecordsPath, UsageStore } from './host/store.js'
import { createTransportStats, installFetchTransport } from './host/transport.js'

export const name = 'usage-popup'

function warn(ctx: any, message: string): void {
  try {
    ctx?.logger?.warn?.(message)
  } catch {
    /* logging must never throw */
  }
}

function registerRoutes(ctx: any, handler: (req: any, res: any) => void | Promise<void>): Array<() => void> {
  const disposers: Array<() => void> = []
  const register = (webServer: any): void => {
    try {
      if (!webServer || typeof webServer.register !== 'function') return
      const dispose = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch {
      /* no web server on this surface */
    }
  }

  // Prefer a directly reachable service; otherwise wait for the dynamic inject.
  const direct = ctx?.webServer ?? (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined)
  if (direct !== undefined) {
    register(direct)
    return disposers
  }
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['webServer'], (webCtx: any) => {
        register(webCtx?.webServer ?? (typeof webCtx?.get === 'function' ? webCtx.get('webServer') : undefined))
      })
    } catch {
      /* no inject API: run collector-only */
    }
  }
  return disposers
}

export function apply(ctx: any): (() => void) | undefined {
  const disposers: Array<() => void> = []
  try {
    const store = new UsageStore({ file: resolveRecordsPath() })
    store.load()
    const collector = new Collector(store)
    const transportStats = createTransportStats()

    const disposeTransport = installFetchTransport({
      stats: transportStats,
      onTools: (tool, sessionId) => {
        try {
          collector.recordTool({
            source: 'wire',
            sessionId,
            name: tool.name,
            requests: tool.requests,
            status: 200,
          })
        } catch {
          /* accounting must never break a response */
        }
      },
    })
    disposers.push(disposeTransport)

    if (typeof ctx?.on === 'function') {
      const offSession = ctx.on(
        'session/event',
        (session: any, event: any) => {
          try {
            collector.observeSession(session, event)
          } catch {
            /* best effort */
          }
        },
        { global: true },
      )
      if (typeof offSession === 'function') disposers.push(offSession)

      const offStream = ctx.on(
        'llm/stream',
        (options: any, next: () => AsyncIterable<any>) => wrapLlmStream(collector, options, next),
        { global: true },
      )
      if (typeof offStream === 'function') disposers.push(offStream)
    }

    const handler = createRouteHandler(() => ({
      store,
      startedAt: collector.startedAt,
      transport: transportStats,
    }))
    for (const dispose of registerRoutes(ctx, handler)) disposers.push(dispose)

    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  } catch (error) {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    warn(ctx, `usage-popup host collector disabled: ${message}`)
    return undefined
  }
}

// Keep the path helper exported for diagnostics without coupling to it.
export { resolveRecordsPath }
