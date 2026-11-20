// usage-popup — True-Sync Universal Cost Ledger for DeepSeek Harness.
//
// The one visible entry point is the unified Plugin Tools menu: this client
// registers `True-sync ledger` into `plugin-launcher`'s shared registry and
// keeps `shell.overlay` (the root-level floating layer) for the panel itself.
// Nothing is contributed to `sidebar.footer.action` or
// `conversation.composer.dock`, so the global sidebar keeps one short button
// and the chat footer keeps only the DSH-native token tracker. Because the
// panel lives at the application shell, it opens from New Session, Plugins,
// Automation tasks, Memory System and any chat, and keeps syncing while closed.
//
// Opening the panel follows the app's active chat automatically: the main-view
// session is the one retained with source `mainView` (the same signal the
// workspace tree uses), and a Session tab dropdown lets the user lock onto any
// historical chat stored in the ledger. The dropdown is built from ledger rows,
// so a chat appears the moment its first turn is recorded.
//
// Design rules for this ledger:
//
//  * The ledger is GLOBAL. Every saved entry lives in one database
//    (`usage-popup.universal-ledger.v2`) and the Day / Week / Month views sum
//    every entry in it — never just the entries of the active chat. Legacy
//    per-session ledgers are migrated/merged on load so older data is not lost.
//  * Costs are derived from the ledger tokens: uncached input and cache writes
//    at the uncached-input rate, cache reads at the cache-read rate and output
//    at the output rate, each with an explicit peak and off-peak card. Peak is
//    Mon–Fri 01:00–04:00 and 06:00–10:00 UTC; everything else is off-peak.
//  * The CNY `total_balance` returned by https://api.deepseek.com/user/balance
//    is the absolute source of truth for runway, the daily target budget and
//    "true period spend". It is fetched automatically on load and every five
//    minutes whenever an API key exists in localStorage. There is deliberately
//    no manual "sync" step.
//  * The ledger is shared by every mounted HUD instance (and every tab): writes
//    merge with a fresh read, and `storage` / BroadcastChannel / DOM events
//    refresh the other instances.
//
// DO NOT add/remove the `name` export — the loader keys on it.

import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'

export const name = 'usage-popup'

// Services this client plugin needs before it may activate. `slots` is
// provided by the renderer plugin (a sibling fiber), so reading `ctx.slots`
// without declaring it throws `cannot get property "slots" without inject`
// and the web-boot audit reports `usage-popup: failed`.
export const inject = ['slots', 'sessions']

// ---------------------------------------------------------------------------
// plugin-launcher registration bridge.
//
// The launcher is a sibling client bundle, not an import: both halves pin the
// same versioned global registry. Whichever bundle the client module loader
// evaluates first creates it; the other adopts it, so registration is
// order-independent. Keep this contract byte-compatible with
// `plugins/plugin-launcher/src/index.tsx`.
// ---------------------------------------------------------------------------

const LAUNCHER_REGISTRY_KEY = '__DSH_PLUGIN_LAUNCHER_V1__'

type LauncherTool = {
  id: string
  label: string
  description?: string
  icon?: unknown
  badge?: string
  order?: number
  onOpen: () => void
}

function launcherRegistry(host: any = typeof window === 'undefined' ? {} : window): any {
  const existing = host[LAUNCHER_REGISTRY_KEY]
  if (
    existing !== null &&
    typeof existing === 'object' &&
    existing.version === 1 &&
    typeof existing.register === 'function' &&
    typeof existing.getSnapshot === 'function' &&
    typeof existing.subscribe === 'function'
  ) {
    return existing
  }
  const tools = new Map<string, LauncherTool>()
  const listeners = new Set<() => void>()
  let snapshot: LauncherTool[] = []
  const emit = (): void => {
    snapshot = Array.from(tools.values()).sort((left, right) => {
      const order = (left.order ?? 0) - (right.order ?? 0)
      return order !== 0 ? order : left.label.localeCompare(right.label)
    })
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        /* a broken subscriber must not break registration */
      }
    }
  }
  const registry = {
    version: 1,
    register(tool: LauncherTool) {
      tools.set(tool.id, tool)
      emit()
      return () => {
        if (tools.get(tool.id) !== tool) return
        tools.delete(tool.id)
        emit()
      }
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: (id: string) => tools.get(id) ?? null,
    select(id: string) {
      const tool = tools.get(id)
      if (tool === undefined) return false
      tool.onOpen()
      return true
    },
  }
  try {
    Object.defineProperty(host, LAUNCHER_REGISTRY_KEY, {
      value: registry,
      configurable: true,
      enumerable: false,
    })
  } catch {
    host[LAUNCHER_REGISTRY_KEY] = registry
  }
  return registry
}

/** Register this plugin's tool, returning the unregister disposer. */
function registerLauncherTool(tool: LauncherTool): () => void {
  return launcherRegistry().register(tool)
}

/** Run a registration on the Cordis effect scope when the client provides one. */
function effectOnce(ctx: Context, callback: () => () => void, label: string): void {
  const effect = (ctx as any).effect
  if (typeof effect === 'function') effect.call(ctx, callback, label)
  else callback()
}


// ---------------------------------------------------------------------------
// The live usage shape. The canonical exported type is `TokenUsageProjection`
// from the session projections package; inline it here so the plugin has no
// extra import to guess at. All four fields are token counts.
// ---------------------------------------------------------------------------
interface TokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens?: number
}

/**
 * DeepSeek's `outputTokens` normally already includes reasoning tokens. If a
 * source reports only reasoning, bill that; if it reports both, never add them
 * together (the larger number is the one already counted).
 */
export function billedOutputTokens(usage: {
  outputTokens?: number
  reasoningTokens?: number
}): number {
  const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
  const reasoning = typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0
  return Math.max(output, reasoning)
}

/** The host collector lives in the same plugin package and owns this route. */
const HOST_USAGE_ENDPOINT = '/usage-popup/api/usage'
const HOST_CURSOR_KEY = 'usage-popup.host-cursor.v1'
const HOST_REFRESH_MS = 10_000
const HOST_FETCH_TIMEOUT_MS = 8_000
const USD_CNY = 7.2

/**
 * Host-collector probe state. `pending` (mount, before the first poll settles)
 * and `active` both suppress the local projection so the same tokens are never
 * counted twice; only a confirmed-absent host half (`inactive`, HTTP 404 or a
 * format mismatch) re-enables projection attribution. Network errors/timeouts
 * deliberately keep the previous state, and an active host stays active forever
 * (no TTL): its 10s poll can be throttled by background tabs without ever
 * re-enabling projection.
 */
export type HostProbeState = 'pending' | 'active' | 'inactive'

/** Pure projection gate: `skip` suppresses local attribution, `project` runs it. */
export function resolveProjectionMode(hostProbe: HostProbeState): 'skip' | 'project' {
  return hostProbe === 'inactive' ? 'project' : 'skip'
}

/**
 * Whether a host payload means the persisted cursor must be reset. A store
 * restart/rotation restarts seq at 1, so a stored cursor can exceed the
 * payload's (optional `reset` flag, or a cursor below the stored one).
 */
export function hostCursorWasReset(
  payloadCursor: number,
  storedCursor: number,
  resetFlag: unknown,
): boolean {
  return resetFlag === true || payloadCursor < storedCursor
}

// The host context is needed by the client to resolve session origins (subagent
// vs main) for host-collected records. Never assume the optional `sessions`
// service exists; all reads are guarded.
let pluginContext: Context | null = null

export function apply(ctx: Context) {
  pluginContext = ctx
  const controller = createLedgerController(ctx)

  // Frame-wide floating panel. `shell.overlay` is root-scoped and sits above
  // every column, so the panel is reachable from any screen — not only from an
  // open conversation.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'usage-popup-ledger', order: 110 },
      (props) => createElement(LedgerOverlay, { ...props, controller }),
    ),
  )

  // The single visible entry point is `plugin-launcher`'s global sidebar
  // button. Register the ledger as one of its selectable tools; the returned
  // disposer keeps Cordis hot-reloads and plugin unloads from leaving a stale
  // row behind.
  effectOnce(
    ctx,
    () =>
      registerLauncherTool({
        id: 'usage-popup.ledger',
        label: 'True-sync ledger',
        description: 'Token, cost and balance ledger for every chat',
        badge: 'LIVE',
        order: 20,
        icon: createElement(LedgerGlyph, { size: 18 }),
        onOpen: () => controller.setOpen(true),
      }),
    'usage-popup: plugin-launcher tool',
  )

  // dsh-plugin-save-token's composer strip now lives inside this panel (the
  // "Token saver" face). Replace its dock cell with an empty component at the
  // same id + order so the saver UI costs no extra composer space; the
  // plugin's settings section and host behavior are untouched. This occupant
  // renders nothing and is not this plugin's entry point.
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: 'save-token-strip',
        order: 85,
        priority: -1,
      },
      () => null,
    ),
  )
}

// ---------------------------------------------------------------------------
// Launcher controller. The Plugin Tools menu and the root overlay are separate
// mounts with no common ancestor, so open state lives in one small controller
// shared through `apply` instead of React context.
// ---------------------------------------------------------------------------

/** New key so a previously "always visible" dock HUD does not start open. */
const OPEN_KEY = 'usage-popup.ledger.open.v1'

interface LedgerController {
  readonly ctx: Context
  getOpen(): boolean
  setOpen(open: boolean): void
  toggle(): void
  subscribe(listener: () => void): () => void
}

function createLedgerController(ctx: Context): LedgerController {
  let open = readStoredFlag(OPEN_KEY, false)
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        /* a broken listener must not break the launcher */
      }
    }
  }
  return {
    ctx,
    getOpen: () => open,
    setOpen: (next: boolean) => {
      if (open === next) return
      open = next
      writeStored(OPEN_KEY, next ? '1' : '0')
      emit()
    },
    toggle: () => {
      open = !open
      writeStored(OPEN_KEY, open ? '1' : '0')
      emit()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Subscribe a component to the shared open state. */
function useLedgerOpen(controller: LedgerController): boolean {
  const [open, setOpenState] = useState(() => controller.getOpen())
  useEffect(() => {
    const sync = (): void => setOpenState(controller.getOpen())
    sync()
    return controller.subscribe(sync)
  }, [controller])
  return open
}

function LedgerGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      <path d="M5 3.5h11.5L20 7v13.5H5z" />
      <path d="M8.5 9.5h8" />
      <path d="M8.5 13h8" />
      <path d="M8.5 16.5h5" />
    </svg>
  )
}

function LedgerOverlay(props: PropsRuntime<'shell.overlay'> & { controller: LedgerController }) {
  const open = useLedgerOpen(props.controller)
  return createElement(LedgerHud, { ...props, open })
}

// ---------------------------------------------------------------------------
// HUD geometry, persistence keys, and display helpers.
// ---------------------------------------------------------------------------

const HUD_WIDTH = 424
const VIEWPORT_MARGIN = 8
const HUD_Z_INDEX = 2_147_483_000
const DAY_MS = 86_400_000
const WINDOWS_TITLEBAR_FALLBACK = 40

/**
 * The Windows desktop frame paints a `-webkit-app-region: drag` caption band
 * across the top of the window (40px unless the host overrides the CSS
 * variable). Chromium hands that band to the OS window-drag hit test, so a
 * body-level portal sitting inside it never receives pointer events: it cannot
 * be clicked, hovered, or dragged. The HUD is such a portal, so it must stay
 * below the band *and* exclude itself from the caption region.
 */
function windowsTitlebarHeight(): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') return 0
  const root = document.documentElement
  if (root === null || !root.hasAttribute('data-windows-titlebar')) return 0
  // In fullscreen the frame hides the band, so the whole viewport is usable.
  if (root.hasAttribute('data-fullscreen')) return 0
  const raw = window.getComputedStyle(root).getPropertyValue('--dsh-windows-titlebar-height')
  const height = Number.parseFloat(raw)
  return Number.isFinite(height) && height > 0 ? height : WINDOWS_TITLEBAR_FALLBACK
}

/** Smallest `top` the HUD may occupy without landing in the caption band. */
function hudTopInset(): number {
  return VIEWPORT_MARGIN + windowsTitlebarHeight()
}

const POSITION_KEY = 'usage-popup.hud.position.v1'
const MINIMIZED_KEY = 'usage-popup.hud.minimized.v1'
const TIMEFRAME_KEY = 'usage-popup.hud.timeframe.v1'
const CUSTOM_START_KEY = 'usage-popup.hud.custom-start.v1'
const CUSTOM_END_KEY = 'usage-popup.hud.custom-end.v1'
const TARGET_RUNWAY_KEY = 'usage-popup.hud.target-runway.v1'
const DEFAULT_TARGET_RUNWAY_DAYS = 30
const MAX_TARGET_RUNWAY_DAYS = 3650

// One unified ledger across every chat. The per-session anchor stores only the
// last cumulative projection so the next incremental delta can be derived
// without ever inventing a refund when the projection is reset/reloaded.
const UNIVERSAL_LEDGER_KEY = 'usage-popup.universal-ledger.v2'
const ANCHORS_KEY = 'usage-popup.session-anchors.v2'
const BALANCE_KEY = 'usage-popup.api-balance.v1'
const BALANCE_HISTORY_KEY = 'usage-popup.balance-history.v1'
const API_KEY_KEY = 'usage-popup.deepseek-api-key.v1'
const LEGACY_SESSION_LEDGER_PREFIX = 'usage-popup.session-ledger.v1.'

const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'
const BALANCE_REFRESH_MS = 5 * 60_000
const MAX_BALANCE_POINTS = 2_880 // 10 days at one sample every 5 minutes

const LEDGER_EVENT = 'usage-popup:ledger-changed'
const LEDGER_CHANNEL = 'usage-popup.ledger.v1'

type ModelId = 'flash' | 'pro'
/**
 * `search` is reserved for server-tool-search charges recorded by the host.
 * `unattributed` carries costs that cannot be priced from tokens (reconciliation
 * rows, dashboard imports and provider routes with no local price card).
 */
type ModelClass = ModelId | 'search' | 'unattributed'
type Tier = 'off-peak' | 'peak'
type Timeframe = 'session' | 'day' | 'week' | 'month' | 'custom'

interface HudPosition {
  x: number
  y: number
}

interface DragState {
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  width: number
  height: number
}

/**
 * One immutable row in the universal ledger. `at` and `date` are captured when
 * the delta arrives. `costRmb` is persisted for export/back-compat, while the
 * UI re-derives the same value from tokens + tier via the rate cards below so
 * the by-model breakdown always sums exactly to the headline cost.
 */
interface LedgerEntry {
  id: string
  sessionId: string
  sessionTitle: string
  date: string
  model: ModelClass
  tier: Tier
  usage: TokenUsage
  costRmb: number
  at: number
  reasoningTokens?: number
  sessionType?:
    | 'main'
    | 'subagent'
    | 'background'
    | 'compaction'
    | 'reconcile'
    | 'import'
    | 'unknown'
  source?: 'projection' | 'host' | 'host-tool' | 'reconcile' | 'import'
  hostId?: string
  calls?: number
  costUsd?: number
  importKey?: string
  /**
   * `false` means the row's `costRmb` is the authoritative recorded cost (for
   * example a non-DeepSeek provider route with no local price card). Pricing it
   * from tokens would invent money we never measured.
   */
  costKnown?: boolean
}

interface SessionAnchor {
  sessionId: string
  sessionTitle: string
  lastUsage: TokenUsage
  lastModel: ModelId | null
  updatedAt: number
}

interface BalanceMeta {
  balanceRmb: number
  syncedAt: number
  currency: 'CNY'
}

interface BalancePoint {
  at: number
  balanceRmb: number
}

interface ModelRow {
  id: ModelClass
  label: string
  color: string
  tokens: number
  costRmb: number
  share: number
}

/**
 * One actual route's LOCAL token counters, as reported by the tier router.
 * These are token counts only — no provider balance/billing API is involved.
 */
interface RoutedUsageBuckets {
  provider: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface RoutedUsageSnapshot {
  totals: RoutedUsageBuckets
  byModel: Record<string, RoutedUsageBuckets>
  sessions: Record<
    string,
    { total: RoutedUsageBuckets; byModel: Record<string, RoutedUsageBuckets>; updatedAt: number }
  >
  workers: Record<string, RoutedUsageBuckets>
  updatedAt: number
}

interface RoutedModelRow {
  key: string
  label: string
  color: string
  calls: number
  tokens: number
  costRmb: number
  costKnown: boolean
  share: number
}

/** 517 / 12.2K / 517K / 1.2M — matches the built-in stat pills. */
function compactCount(value: number): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

function exactCount(value: number): string {
  return value.toLocaleString()
}

/** One decimal is enough; a partial hit must never read as a full 100%. */
function percent(ratio: number): string {
  const rounded = Math.round(ratio * 1_000) / 10
  if (ratio < 1 && rounded >= 100) return '99.9%'
  return `${rounded}%`
}

/** ¥0.284 / ¥1.28 — enough precision that a cheap session never reads as 0. */
function yuan(value: number): string {
  if (!Number.isFinite(value)) return '¥—'
  if (value < 0) return `-¥${Math.abs(value).toFixed(2)}`
  if (value === 0) return '¥0.00'
  const digits = value >= 1 ? 2 : value >= 0.01 ? 3 : 4
  return `¥${value.toFixed(digits)}`
}

function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------
// RMB pricing. DeepSeek list prices in Yuan per 1M tokens. The rate card is
// explicit per tier so uncached input, cache reads, cache writes and output can
// each carry their own peak/off-peak price. Peak windows are Mon–Fri
// 01:00–04:00 and 06:00–10:00 UTC; everything else (including all weekend
// traffic) is off-peak. Cache writes are billed at the uncached-input rate.
// ---------------------------------------------------------------------------

interface RateCard {
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
}

const RATE_CARDS: Record<ModelClass, { peak: RateCard; offPeak: RateCard }> = {
  flash: {
    offPeak: { uncachedInput: 1.0, cacheRead: 0.02, cacheWrite: 1.0, output: 4.0 },
    peak: { uncachedInput: 2.0, cacheRead: 0.04, cacheWrite: 2.0, output: 8.0 },
  },
  pro: {
    offPeak: { uncachedInput: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 },
    peak: { uncachedInput: 9.0, cacheRead: 0.3, cacheWrite: 9.0, output: 27.0 },
  },
  // Server-tool-search is not a token meter in this plugin. Its cost is taken
  // from the recorded entry instead of being invented from a token rate.
  search: {
    offPeak: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    peak: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  },
  // Costs that cannot be token-priced (reconciliation, imports, non-DeepSeek
  // routes). The recorded costRmb is the only source of truth for these rows.
  unattributed: {
    offPeak: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    peak: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  },
}

const CONTEXT_BLOAT_TOKENS = 1_500_000

const MODEL_LABELS: Record<ModelClass, string> = {
  flash: 'deepseek-flash',
  pro: 'deepseek-v4-pro',
  search: 'server-tool-search',
  unattributed: 'Unattributed',
}

const MODEL_COLORS: Record<ModelClass, string> = {
  flash: '#3fb950',
  pro: '#58a6ff',
  search: '#d29922',
  unattributed: '#8b949e',
}

// ---------------------------------------------------------------------------
// Routed-model registry. The tier router records one row per actual
// provider/model that answered (DeepSeek, Gemini, GLM, ...). Pricing cards
// exist only for DeepSeek; every other route is shown as local token counts
// and is deliberately NOT synced against any provider billing API.
// ---------------------------------------------------------------------------
const ROUTER_USAGE_ENDPOINT = '/tier-router/api/usage'
const ROUTER_USAGE_REFRESH_MS = 5_000
const SAVE_TOKEN_DASHBOARD_ENDPOINT = '/save-token/api/dashboard'
const SAVE_TOKEN_TOGGLE_ENDPOINT = '/save-token/api/set-enabled'
const SAVER_REFRESH_MS = 4_000

interface RoutedModelMeta {
  label: string
  color: string
  pricing?: ModelId
}

const ROUTED_MODEL_META: Record<string, RoutedModelMeta> = {
  'deepseek-account/deepseek-flash': { label: 'deepseek-flash', color: MODEL_COLORS.flash, pricing: 'flash' },
  'deepseek-account/deepseek-v4-pro': { label: 'deepseek-v4-pro', color: MODEL_COLORS.pro, pricing: 'pro' },
  'deepseek-account/deepseek-pro': { label: 'deepseek-v4-pro', color: MODEL_COLORS.pro, pricing: 'pro' },
  'google/gemini-3.5-flash': { label: 'gemini-3.5-flash', color: '#3fb950' },
  'google/gemini-3.1-flash-lite': { label: 'gemini-3.1-flash-lite', color: '#2ea043' },
  'google-vertex/gemini-3.5-flash': { label: 'vertex · gemini-3.5-flash', color: '#39c5cf' },
  'zai/glm-5.3-flash': { label: 'glm-5.3-flash', color: '#d29922' },
  'zai/glm-5.3': { label: 'glm-5.3', color: '#bb8009' },
  'zai-2/glm-5.3-flash': { label: 'glm-5.3-flash (key 2)', color: '#e3b341' },
  'zai-2/glm-5.3': { label: 'glm-5.3 (key 2)', color: '#c69026' },
}

const ROUTED_FALLBACK_COLORS = ['#58a6ff', '#bc8cff', '#ff7b72', '#56d4dd', '#f0883e', '#7ee787']

function hashText(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

function routedModelMeta(provider: string, model: string): RoutedModelMeta {
  const key = `${provider}/${model}`
  const registered = ROUTED_MODEL_META[key]
  if (registered !== undefined) return registered
  const providerLabel = provider === '' ? 'unknown' : provider
  return {
    label: model === '' ? providerLabel : `${providerLabel} · ${model}`,
    color: ROUTED_FALLBACK_COLORS[hashText(key) % ROUTED_FALLBACK_COLORS.length],
  }
}

function nonnegativeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function normalizeRoutedBuckets(value: unknown): RoutedUsageBuckets | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider : ''
  const model = typeof record.model === 'string' ? record.model : ''
  return {
    provider,
    model,
    calls: nonnegativeCount(record.calls),
    inputTokens: nonnegativeCount(record.inputTokens),
    outputTokens: nonnegativeCount(record.outputTokens),
    cacheReadTokens: nonnegativeCount(record.cacheReadTokens),
    cacheWriteTokens: nonnegativeCount(record.cacheWriteTokens),
  }
}

function normalizeRoutedBucketsMap(value: unknown): Record<string, RoutedUsageBuckets> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, RoutedUsageBuckets> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const buckets = normalizeRoutedBuckets(entry)
    if (buckets !== null) out[key] = buckets
  }
  return out
}

function normalizeRoutedUsage(value: unknown): RoutedUsageSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const totals = normalizeRoutedBuckets(record.totals)
  if (totals === null) return null
  const sessions: RoutedUsageSnapshot['sessions'] = {}
  if (typeof record.sessions === 'object' && record.sessions !== null && !Array.isArray(record.sessions)) {
    for (const [sessionId, sessionValue] of Object.entries(
      record.sessions as Record<string, unknown>,
    )) {
      if (typeof sessionValue !== 'object' || sessionValue === null) continue
      const sessionRecord = sessionValue as Record<string, unknown>
      const sessionTotals = normalizeRoutedBuckets(sessionRecord.total)
      if (sessionTotals === null) continue
      sessions[sessionId] = {
        total: sessionTotals,
        byModel: normalizeRoutedBucketsMap(sessionRecord.byModel),
        updatedAt: nonnegativeCount(sessionRecord.updatedAt),
      }
    }
  }
  return {
    totals,
    byModel: normalizeRoutedBucketsMap(record.byModel),
    sessions,
    workers: normalizeRoutedBucketsMap(record.workers),
    updatedAt: nonnegativeCount(record.updatedAt),
  }
}

function routedUsageTotal(buckets: RoutedUsageBuckets): number {
  return buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
}

function routedUsageAsTokenUsage(buckets: RoutedUsageBuckets): TokenUsage {
  return {
    uncachedInputTokens: buckets.inputTokens,
    outputTokens: buckets.outputTokens,
    cacheReadTokens: buckets.cacheReadTokens,
    cacheWriteTokens: buckets.cacheWriteTokens,
  }
}
function routedRowsOf(
  map: Record<string, RoutedUsageBuckets>,
  tier: Tier,
): RoutedModelRow[] {
  const rows = Object.entries(map)
    .map(([key, buckets]) => {
      const meta = routedModelMeta(buckets.provider, buckets.model)
      const tokens = routedUsageTotal(buckets)
      return {
        key,
        label: meta.label,
        color: meta.color,
        calls: buckets.calls,
        tokens,
        costKnown: meta.pricing !== undefined,
        costRmb:
          meta.pricing === undefined
            ? 0
            : usageCostRmb(routedUsageAsTokenUsage(buckets), meta.pricing, tier === 'peak'),
        share: 0,
      } satisfies RoutedModelRow
    })
    .filter((row) => row.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens)
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  return rows.map((row) => ({ ...row, share: total > 0 ? row.tokens / total : 0 }))
}

// ---------------------------------------------------------------------------
// dsh-plugin-save-token dashboard (merged into this HUD). The numbers are the
// plugin's own local counters; the strip that used to sit in the composer dock
// is replaced by an empty cell so the saver UI costs no extra GUI space.
// ---------------------------------------------------------------------------
interface SaveTokenRecent {
  ts: number
  kind: string
  label: string
  detail: string
  saved: number
}

interface SaveTokenDashboard {
  uptimeSec: number
  flags: { compress: boolean; dedupe: boolean; expandTool: boolean }
  reliefPct: number
  cacheHitPct: number
  totals: {
    requests: number
    auxRequests: number
    inputTokens: number
    cachedTokens: number
    cacheReadTokens: number
    outputTokens: number
    avoidedTokens: number
  }
  compression: {
    count: number
    bytesBefore: number
    bytesAfter: number
    dedupeHits: number
    dedupeSavedBytes: number
    losslessEncodes: number
    tabularWindows: number
  }
  recent: SaveTokenRecent[]
}

function normalizeSaverDashboard(value: unknown): SaveTokenDashboard | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const totals = typeof record.totals === 'object' && record.totals !== null
    ? (record.totals as Record<string, unknown>)
    : {}
  const compression = typeof record.compression === 'object' && record.compression !== null
    ? (record.compression as Record<string, unknown>)
    : {}
  const flags = typeof record.flags === 'object' && record.flags !== null
    ? (record.flags as Record<string, unknown>)
    : {}
  const recent: SaveTokenRecent[] = Array.isArray(record.recent)
    ? record.recent.slice(0, 6).flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return []
        const row = entry as Record<string, unknown>
        return [{
          ts: nonnegativeCount(row.ts),
          kind: typeof row.kind === 'string' ? row.kind : 'request',
          label: typeof row.label === 'string' ? row.label : '',
          detail: typeof row.detail === 'string' ? row.detail : '',
          saved: nonnegativeCount(row.saved),
        }]
      })
    : []
  return {
    uptimeSec: nonnegativeCount(record.uptimeSec),
    flags: {
      compress: flags.compress === true,
      dedupe: flags.dedupe === true,
      expandTool: flags.expandTool === true,
    },
    reliefPct: nonnegativeCount(record.reliefPct),
    cacheHitPct: nonnegativeCount(record.cacheHitPct),
    totals: {
      requests: nonnegativeCount(totals.requests),
      auxRequests: nonnegativeCount(totals.auxRequests),
      inputTokens: nonnegativeCount(totals.inputTokens),
      cachedTokens: nonnegativeCount(totals.cachedTokens),
      cacheReadTokens: nonnegativeCount(totals.cacheReadTokens),
      outputTokens: nonnegativeCount(totals.outputTokens),
      avoidedTokens: nonnegativeCount(totals.avoidedTokens),
    },
    compression: {
      count: nonnegativeCount(compression.count),
      bytesBefore: nonnegativeCount(compression.bytesBefore),
      bytesAfter: nonnegativeCount(compression.bytesAfter),
      dedupeHits: nonnegativeCount(compression.dedupeHits),
      dedupeSavedBytes: nonnegativeCount(compression.dedupeSavedBytes),
      losslessEncodes: nonnegativeCount(compression.losslessEncodes),
      tabularWindows: nonnegativeCount(compression.tabularWindows),
    },
    recent,
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB']
  let scaled = value / 1024
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`
}

function rateCard(model: ModelClass, peak: boolean): RateCard {
  const cards = RATE_CARDS[model]
  return peak ? cards.peak : cards.offPeak
}

function isPeakUtc(date: Date): boolean {
  const day = date.getUTCDay() // 0 = Sunday … 6 = Saturday
  if (day === 0 || day === 6) return false
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)
}

function peakTier(peak: boolean): Tier {
  return peak ? 'peak' : 'off-peak'
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export function usageCostRmb(usage: TokenUsage, model: ModelClass, peak: boolean): number {
  const card = rateCard(model, peak)
  const weighted =
    usage.uncachedInputTokens * card.uncachedInput +
    usage.cacheReadTokens * card.cacheRead +
    usage.cacheWriteTokens * card.cacheWrite +
    billedOutputTokens(usage) * card.output
  return weighted / 1_000_000
}

/**
 * The one true price of a ledger row, used by every total and by-model split.
 * Rows that carry an authoritative recorded cost (reconciliation, imports,
 * server tools, provider routes without a price card) must never be re-priced
 * from tokens; only genuinely token-priced rows use the rate card.
 */
export function entryCostRmb(entry: LedgerEntry): number {
  if (entry.model === 'unattributed') return Math.max(0, entry.costRmb)
  if (entry.model === 'search') return Math.max(0, entry.costRmb)
  if (entry.costKnown === false) return Math.max(0, entry.costRmb)
  if (entry.source === 'reconcile' || entry.source === 'host-tool') {
    return Math.max(0, entry.costRmb)
  }
  if (entry.source === 'import' && entry.costRmb > 0) return Math.max(0, entry.costRmb)
  if (isZeroUsage(entry.usage) && entry.costRmb > 0) return Math.max(0, entry.costRmb)
  return usageCostRmb(entry.usage, entry.model, entry.tier === 'peak')
}

function cacheSavingsRmb(usage: TokenUsage, model: ModelClass, peak: boolean): number {
  const card = rateCard(model, peak)
  const difference = Math.max(0, card.uncachedInput - card.cacheRead)
  return (usage.cacheReadTokens * difference) / 1_000_000
}

// ---------------------------------------------------------------------------
// Calendar helpers. Ledger dates are local calendar days (what a person means
// by "today"), while the rate tier is always computed in UTC.
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function localDateKey(value: number | Date): string {
  const date = typeof value === 'number' ? new Date(value) : value
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function startOfLocalDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function startOfNextLocalDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + 1)
  return date.getTime()
}

function startOfLocalWeek(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  const offset = (date.getDay() + 6) % 7 // Monday = 0
  date.setDate(date.getDate() - offset)
  return date.getTime()
}

function startOfLocalMonth(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  date.setDate(1)
  return date.getTime()
}

function parseLocalDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  const date = new Date(year, month - 1, day, 0, 0, 0, 0)
  return Number.isFinite(date.getTime()) ? date.getTime() : null
}

function inclusiveDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`)
  const to = Date.parse(`${end}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 1
  return Math.max(1, Math.round((to - from) / DAY_MS) + 1)
}

function formatClockCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now'
  const seconds = Math.ceil(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h`
}

/**
 * Peak windows change only at fixed UTC hours. Checking those boundaries for
 * the next week is cheap and exact, including the long weekend off-peak run.
 */
function nextRateSwitch(fromMs: number): { at: number; tier: Tier } {
  const now = new Date(fromMs)
  const current = isPeakUtc(now)
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const boundaries = [0, 1, 4, 6, 10]
  for (let dayOffset = 0; dayOffset < 9; dayOffset += 1) {
    const dayBase = base + dayOffset * DAY_MS
    for (const hour of boundaries) {
      const candidate = dayBase + hour * 3_600_000
      if (candidate <= fromMs) continue
      const candidatePeak = isPeakUtc(new Date(candidate))
      if (candidatePeak !== current) return { at: candidate, tier: peakTier(candidatePeak) }
    }
  }
  return { at: fromMs + DAY_MS, tier: peakTier(!current) }
}

// ---------------------------------------------------------------------------
// Usage helpers.
// ---------------------------------------------------------------------------

function zeroUsage(): TokenUsage {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
  }
}

function usageDelta(next: TokenUsage, previous: TokenUsage): TokenUsage {
  return {
    uncachedInputTokens: Math.max(0, next.uncachedInputTokens - previous.uncachedInputTokens),
    outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
    cacheReadTokens: Math.max(0, next.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, next.cacheWriteTokens - previous.cacheWriteTokens),
    reasoningTokens: Math.max(
      0,
      (next.reasoningTokens ?? 0) - (previous.reasoningTokens ?? 0),
    ),
  }
}

function isZeroUsage(usage: TokenUsage): boolean {
  return (
    usage.uncachedInputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheWriteTokens === 0
  )
}

function sameUsage(left: TokenUsage, right: TokenUsage): boolean {
  return (
    left.uncachedInputTokens === right.uncachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    (left.reasoningTokens ?? 0) === (right.reasoningTokens ?? 0)
  )
}

function usageTotal(usage: TokenUsage): number {
  return (
    usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  )
}

function sumUsage(entries: readonly LedgerEntry[]): TokenUsage {
  return entries.reduce((total, entry) => addUsage(total, entry.usage), zeroUsage())
}

function makeEntryId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function entryDedupKey(entry: LedgerEntry): string {
  return [
    entry.hostId ?? '',
    entry.importKey ?? '',
    entry.sessionId,
    entry.at,
    entry.model,
    entry.tier,
    entry.usage.uncachedInputTokens,
    entry.usage.cacheReadTokens,
    entry.usage.cacheWriteTokens,
    entry.usage.outputTokens,
  ].join('|')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Accept both the canonical counters and the aliases used by older projections
 * and exported ledgers. Returns `null` only when no counter exists at all, so a
 * genuinely zeroed session still normalizes to four zeros.
 */
function normalizeUsage(value: unknown): TokenUsage | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const nested = record.usage ?? record.tokens ?? record.tokenUsage
  const source: Record<string, unknown> =
    typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ? { ...(nested as Record<string, unknown>), ...record }
      : record
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const candidate = source[key]
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
        return candidate
      }
      if (typeof candidate === 'string') {
        const parsed = Number(candidate)
        if (Number.isFinite(parsed) && parsed >= 0) return parsed
      }
    }
    return null
  }
  const uncachedInputTokens = pick(
    'uncachedInputTokens',
    'uncachedInput',
    'inputTokens',
    'promptTokens',
    'input_tokens',
  )
  const outputTokens = pick('outputTokens', 'completionTokens', 'output_tokens')
  const cacheReadTokens = pick(
    'cacheReadTokens',
    'cacheReadInputTokens',
    'cachedInputTokens',
    'cacheHitTokens',
    'cache_read_tokens',
  )
  const cacheWriteTokens = pick(
    'cacheWriteTokens',
    'cacheWriteInputTokens',
    'cacheCreationTokens',
    'cache_write_tokens',
  )
  const reasoningTokens = pick('reasoningTokens', 'reasoning_tokens', 'reasoning')
  if (
    uncachedInputTokens === null &&
    outputTokens === null &&
    cacheReadTokens === null &&
    cacheWriteTokens === null &&
    reasoningTokens === null
  ) {
    return null
  }
  return {
    uncachedInputTokens: uncachedInputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    reasoningTokens: reasoningTokens ?? undefined,
  }
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value.replace(/\s+/g, ' ').trim()
  if (title.length < 2 || title.length > 120) return null
  if (/(?:^|\s)(?:usage-popup|deepseek harness)(?:\s|$)/i.test(title)) return null
  return title
}

// ---------------------------------------------------------------------------
// Universal localStorage ledger. Every access is guarded: the plugin must keep
// working when storage is unavailable (private mode, embedded webview policy).
// ---------------------------------------------------------------------------

function normalizeModelClass(value: unknown): ModelClass {
  if (typeof value !== 'string') return 'flash'
  const text = value.toLowerCase()
  if (/unattributed|reconcile|unknown/.test(text)) return 'unattributed'
  if (/search|tool/.test(text)) return 'search'
  return classifyModelText(text) ?? (text === 'pro' ? 'pro' : 'flash')
}

const LEDGER_SOURCES = ['projection', 'host', 'host-tool', 'reconcile', 'import'] as const
const LEDGER_SESSION_TYPES = [
  'main',
  'subagent',
  'background',
  'compaction',
  'reconcile',
  'import',
  'unknown',
] as const

function normalizeSource(value: unknown): LedgerEntry['source'] | undefined {
  return typeof value === 'string' && (LEDGER_SOURCES as readonly string[]).includes(value)
    ? (value as LedgerEntry['source'])
    : undefined
}

function normalizeSessionType(value: unknown): LedgerEntry['sessionType'] | undefined {
  return typeof value === 'string' && (LEDGER_SESSION_TYPES as readonly string[]).includes(value)
    ? (value as LedgerEntry['sessionType'])
    : undefined
}

export function normalizeEntry(
  value: unknown,
  fallbackSessionId?: string | null,
): LedgerEntry | null {
  if (!isRecord(value)) return null
  const record = value

  const rawSessionId =
    typeof record.sessionId === 'string' && record.sessionId.length > 0
      ? record.sessionId
      : typeof fallbackSessionId === 'string' && fallbackSessionId.length > 0
        ? fallbackSessionId
        : null
  if (rawSessionId === null) return null

  const atCandidate = record.at ?? record.timestamp ?? record.time
  const at =
    typeof atCandidate === 'number' && Number.isFinite(atCandidate) && atCandidate > 0
      ? atCandidate
      : typeof atCandidate === 'string'
        ? Date.parse(atCandidate)
        : Number.NaN
  if (!Number.isFinite(at) || at <= 0) return null

  const model = normalizeModelClass(record.model)
  const tier: Tier =
    record.tier === 'peak' || record.tier === 'off-peak'
      ? record.tier
      : peakTier(isPeakUtc(new Date(at)))
  const date =
    typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date)
      ? record.date
      : localDateKey(at)

  const usage = normalizeUsage(record) ?? zeroUsage()
  const source = normalizeSource(record.source)
  const sessionType = normalizeSessionType(record.sessionType)

  const costCandidate = record.costRmb ?? record.cost
  const parsedCost =
    typeof costCandidate === 'number'
      ? costCandidate
      : typeof costCandidate === 'string'
        ? Number(costCandidate)
        : Number.NaN
  const hasRecordedCost = Number.isFinite(parsedCost) && parsedCost >= 0
  const costRmb = hasRecordedCost
    ? parsedCost
    : usageCostRmb(usage, model, tier === 'peak')

  // Zero-usage rows are real spend only when they carry a recorded cost and a
  // source that says so (reconciliation, imports, server tools). Everything
  // else with no tokens is an accidental empty row and must be dropped.
  if (isZeroUsage(usage)) {
    const costBearingSource =
      source === 'reconcile' || source === 'import' || source === 'host-tool'
    const serverToolRow = isRecord(record.serverTool)
    if (!(costBearingSource || serverToolRow) || !(costRmb > 0)) return null
  }

  const reasoningTokensRaw = record.reasoningTokens
  const reasoningTokens =
    typeof reasoningTokensRaw === 'number' && Number.isFinite(reasoningTokensRaw)
      ? Math.max(0, reasoningTokensRaw)
      : usage.reasoningTokens

  const rawTitle = record.sessionTitle ?? record.title ?? record.session_title
  const sessionTitle = cleanTitle(rawTitle) ?? 'Untitled chat'

  const callsRaw = record.calls
  const calls =
    typeof callsRaw === 'number' && Number.isFinite(callsRaw) && callsRaw >= 0
      ? Math.round(callsRaw)
      : undefined
  const costUsdRaw = record.costUsd
  const costUsd =
    typeof costUsdRaw === 'number' && Number.isFinite(costUsdRaw)
      ? Math.max(0, costUsdRaw)
      : undefined

  return {
    id:
      typeof record.id === 'string' && record.id.length > 0
        ? record.id
        : `${rawSessionId}-${at}-${model}-${tier}-${usageTotal(usage)}`,
    sessionId: rawSessionId,
    sessionTitle,
    date,
    model,
    tier,
    usage,
    costRmb,
    at,
    reasoningTokens,
    sessionType,
    source,
    hostId: typeof record.hostId === 'string' && record.hostId.length > 0 ? record.hostId : undefined,
    calls,
    costUsd,
    importKey:
      typeof record.importKey === 'string' && record.importKey.length > 0
        ? record.importKey
        : undefined,
    costKnown: record.costKnown === false ? false : undefined,
  }
}

/**
 * Pull ledger rows out of every shape a stored value can take: a bare array, an
 * `{ entries: [...] }` envelope, an `{ entries: { entries: [...] } }` envelope
 * (older builds nested one level), a `{ ledger: [...] }` envelope, or a single
 * row object.
 */
function entriesFromUnknown(raw: unknown, fallbackSessionId: string | null): LedgerEntry[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) {
    list = raw
  } else if (isRecord(raw)) {
    if (Array.isArray(raw.entries)) list = raw.entries
    else if (isRecord(raw.entries) && Array.isArray(raw.entries.entries)) list = raw.entries.entries
    else if (Array.isArray(raw.ledger)) list = raw.ledger
    else if (Array.isArray(raw.rows)) list = raw.rows
    else list = [raw]
  }
  const entries: LedgerEntry[] = []
  for (const candidate of list) {
    const entry = normalizeEntry(candidate, fallbackSessionId)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

function mergeLedger(
  left: readonly LedgerEntry[],
  right: readonly LedgerEntry[],
): LedgerEntry[] {
  const seen = new Set<string>()
  const merged: LedgerEntry[] = []
  for (const entry of [...left, ...right]) {
    const key = entryDedupKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
  }
  merged.sort((a, b) => a.at - b.at)
  return merged
}

/**
 * Merge freshly imported rows: any existing `source:'import'` row whose stable
 * `importKey` is re-imported is dropped first (latest wins), so a grown
 * dashboard row replaces instead of double counting.
 */
export function replaceImportedEntries(
  existing: readonly LedgerEntry[],
  incoming: readonly LedgerEntry[],
): LedgerEntry[] {
  const freshKeys = new Set<string>()
  for (const entry of incoming) {
    if (entry.source === 'import' && typeof entry.importKey === 'string') {
      freshKeys.add(entry.importKey)
    }
  }
  const kept = existing.filter(
    (entry) =>
      !(entry.source === 'import' && entry.importKey !== undefined && freshKeys.has(entry.importKey)),
  )
  return mergeLedger(kept, incoming)
}

/** Every storage key that could hold ledger rows (legacy per-session included). */
function ledgerStorageKeys(): string[] {
  const keys: string[] = []
  try {
    const storage = window.localStorage
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null || key === UNIVERSAL_LEDGER_KEY) continue
      // Stay inside this plugin's namespace: never parse or delete another
      // plugin's "ledger"-named keys.
      if (!key.startsWith('usage-popup.')) continue
      if (/ledger/i.test(key)) keys.push(key)
    }
  } catch {
    // Storage unavailable: no legacy keys to migrate.
  }
  return keys
}

/**
 * Read the whole database: the global ledger plus every legacy per-session
 * ledger key. This is what the Day / Week / Month tabs aggregate, so the totals
 * cannot be constrained by the active session id.
 */
function readLedgerDatabase(): LedgerEntry[] {
  const collected: LedgerEntry[] = []
  try {
    const primary = window.localStorage.getItem(UNIVERSAL_LEDGER_KEY)
    if (primary !== null) {
      try {
        collected.push(...entriesFromUnknown(JSON.parse(primary), null))
      } catch {
        // A corrupt primary blob must not hide migrated legacy data.
      }
    }
  } catch {
    // Storage unavailable.
  }

  for (const key of ledgerStorageKeys()) {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw === null) continue
      // A legacy per-session key carries its session id in the suffix. Any other
      // ledger-shaped key (for example a v1 global ledger) has no id at all, so
      // it gets a synthetic one: those rows must still be counted by the global
      // Day / Week / Month totals, while never matching a real chat's Session tab.
      const fallbackSessionId = key.startsWith(LEGACY_SESSION_LEDGER_PREFIX)
        ? key.slice(LEGACY_SESSION_LEDGER_PREFIX.length)
        : `legacy:${key}`
      try {
        collected.push(...entriesFromUnknown(JSON.parse(raw), fallbackSessionId))
      } catch {
        // Skip unparseable legacy blobs.
      }
    } catch {
      // Ignore a single unreadable key.
    }
  }

  return mergeLedger([], collected)
}

function writeUniversalLedger(entries: readonly LedgerEntry[]): void {
  try {
    window.localStorage.setItem(UNIVERSAL_LEDGER_KEY, JSON.stringify({ entries }))
  } catch {
    // Storage pressure must never take down the HUD. The in-memory ledger keeps
    // working for the rest of the session.
  }
}

// ---------------------------------------------------------------------------
// Host-record ingestion. The host collector inside this same package exposes
// `/usage-popup/api/usage`; it is the authoritative source for every LLM call
// and server-tool charge (including subagents and background turns). The
// projection path stays as the fallback when that route is absent.
// ---------------------------------------------------------------------------

interface HostSessionMeta {
  parentId?: string | null
  origin?: string | null
}

function readSessionIndex(): Record<string, HostSessionMeta> {
  const ctx = pluginContext as unknown as { sessions?: { list?: unknown } } | null
  try {
    const list = ctx?.sessions?.list
    if (list === undefined || list === null) return {}
    // The real SDK exposes `ctx.sessions.list` as an ObservableSnapshot
    // (`get()`); a plain service may expose `list()`; tolerate `.value`.
    const state: unknown =
      typeof list === 'function'
        ? (list as () => unknown)()
        : ((list as { get?: () => unknown }).get?.() ?? (list as { value?: unknown }).value)
    const out: Record<string, HostSessionMeta> = {}
    const add = (id: unknown, item: unknown): void => {
      if (typeof id !== 'string' || id.length === 0 || !isRecord(item)) return
      // SessionSummary carries `parentId`/`origin`; a live Session nests them
      // under `header` (`parentSession`/`origin`).
      const header = isRecord(item.header) ? item.header : item
      const parentRaw = header.parentSession ?? item.parentId ?? item.parentSession ?? null
      const parentId =
        typeof parentRaw === 'string'
          ? parentRaw === ''
            ? null
            : parentRaw
          : isRecord(parentRaw) && typeof parentRaw.id === 'string'
            ? parentRaw.id
            : null
      const originRaw = header.origin ?? item.origin ?? null
      out[id] = { parentId, origin: typeof originRaw === 'string' ? originRaw : null }
    }
    if (isRecord(state)) {
      const byId = state.byId
      if (isRecord(byId)) {
        for (const [id, item] of Object.entries(byId)) add(id, item)
      }
      if (Array.isArray(state.ids)) {
        for (const id of state.ids) {
          if (typeof id !== 'string' || out[id] !== undefined) continue
          add(id, isRecord(byId) ? byId[id] : undefined)
        }
      }
      if (isRecord(byId) || Array.isArray(state.ids)) return out
    }
    if (state instanceof Map) {
      for (const [key, item] of state) add(key, item)
    } else if (Array.isArray(state)) {
      for (const item of state) if (isRecord(item)) add(item.id, item)
    } else if (isRecord(state)) {
      for (const [key, item] of Object.entries(state)) add(key, item)
    }
    return out
  } catch {
    return {}
  }
}

function hostSessionType(
  record: Record<string, unknown>,
  sessionId: string,
  sessionIndex: Record<string, HostSessionMeta>,
): LedgerEntry['sessionType'] {
  const declared = normalizeSessionType(record.sessionType) ?? 'unknown'
  if (declared !== 'unknown') return declared
  const meta = sessionIndex[sessionId]
  if (meta !== undefined && (meta.origin === 'subagent' || (meta.parentId ?? '') !== '')) {
    return 'subagent'
  }
  return 'unknown'
}

function hostCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * Pure mapper from the host's `UsageRecord` list to ledger rows. Exported so
 * the test suite can drive it without a running host.
 */
export function entriesForHostRecords(
  records: readonly unknown[],
  sessionIndex: Record<string, HostSessionMeta> = {},
): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  for (const candidate of records) {
    if (!isRecord(candidate)) continue
    const record = candidate
    const atRaw = record.at
    const at =
      typeof atRaw === 'number' && Number.isFinite(atRaw) && atRaw > 0 ? atRaw : Number.NaN
    if (!Number.isFinite(at)) continue
    const rawSessionId =
      typeof record.sessionId === 'string' && record.sessionId.length > 0
        ? record.sessionId
        : null
    const hostId =
      typeof record.id === 'string' && record.id.length > 0
        ? record.id
        : `h:${typeof record.seq === 'number' ? record.seq : at}`
    const tier = peakTier(isPeakUtc(new Date(at)))

    if (record.kind === 'tool') {
      const tool = isRecord(record.serverTool) ? record.serverTool : null
      const feeUsd =
        tool !== null && typeof tool.feeUsd === 'number' && Number.isFinite(tool.feeUsd)
          ? Math.max(0, tool.feeUsd)
          : 0
      if (feeUsd <= 0) continue
      const name =
        tool !== null && typeof tool.name === 'string' && tool.name.length > 0
          ? tool.name
          : 'server-tool'
      const requests =
        tool !== null && typeof tool.requests === 'number' && Number.isFinite(tool.requests)
          ? Math.max(1, Math.round(tool.requests))
          : 1
      const sessionId = rawSessionId ?? 'server-tool'
      entries.push({
        id: hostId,
        sessionId,
        sessionTitle: cleanTitle(name) ?? 'server-tool',
        date: localDateKey(at),
        model: 'search',
        tier,
        usage: zeroUsage(),
        costRmb: round4(feeUsd * USD_CNY),
        at,
        sessionType: hostSessionType(record, sessionId, sessionIndex),
        source: 'host-tool',
        hostId,
        calls: requests,
        costUsd: feeUsd,
      })
      continue
    }

    if (record.kind !== 'llm') continue
    const rawUsage = isRecord(record.usage) ? record.usage : null
    if (rawUsage === null) continue
    const inputTokens = hostCount(rawUsage.inputTokens)
    const outputTokens = hostCount(rawUsage.outputTokens)
    const reasoningTokens = hostCount(rawUsage.reasoningTokens)
    const cacheReadTokens = hostCount(rawUsage.cacheReadTokens)
    const cacheWriteTokens = hostCount(rawUsage.cacheWriteTokens)
    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      reasoningTokens === 0 &&
      cacheReadTokens === 0 &&
      cacheWriteTokens === 0
    ) {
      continue
    }
    const modelText =
      typeof record.model === 'string' && record.model.length > 0 ? record.model : ''
    const provider = typeof record.provider === 'string' ? record.provider.toLowerCase() : ''
    // Only DeepSeek-billed routes belong in the DeepSeek token/cost totals.
    // Everything else keeps its tokens but is priced as `unattributed`, so it
    // cannot pollute the flash/pro token sums with an invented model class.
    const deepseekBilled = provider.includes('deepseek') || /^deepseek/i.test(modelText)
    const modelClass: ModelClass = deepseekBilled
      ? (classifyModelText(modelText) ?? 'flash')
      : 'unattributed'
    const sessionId = rawSessionId ?? 'unknown'
    const usage: TokenUsage = {
      uncachedInputTokens: inputTokens,
      outputTokens: billedOutputTokens({ outputTokens, reasoningTokens }),
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
    }
    entries.push({
      id: hostId,
      sessionId,
      sessionTitle:
        cleanTitle(record.purpose) ??
        cleanTitle(record.agentPreset) ??
        MODEL_LABELS[modelClass],
      date: localDateKey(at),
      model: modelClass,
      tier,
      usage,
      costRmb: deepseekBilled ? usageCostRmb(usage, modelClass, tier === 'peak') : 0,
      at,
      reasoningTokens: usage.reasoningTokens,
      sessionType: hostSessionType(record, sessionId, sessionIndex),
      source: 'host',
      hostId,
      calls: 1,
      costKnown: deepseekBilled ? undefined : false,
    })
  }
  return entries
}

/**
 * Fold legacy per-session keys into the global database. The legacy keys are
 * intentionally left in place: re-reading them is deduplicated by
 * `entryDedupKey`, so keeping them is safer than deleting a format this build
 * might not fully understand. Only a non-empty database is written, which also
 * means a transient storage/parse failure can never blank the ledger.
 */
function migrateLegacyLedgers(): LedgerEntry[] {
  const database = readLedgerDatabase()
  if (database.length > 0) writeUniversalLedger(database)
  return database
}

function normalizeAnchor(value: unknown, sessionId: string): SessionAnchor | null {
  if (!isRecord(value)) return null
  const lastUsage = normalizeUsage(value.lastUsage)
  if (lastUsage === null) return null
  const lastModel =
    value.lastModel === 'flash' || value.lastModel === 'pro' ? value.lastModel : null
  const updatedAt =
    typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0
  const rawTitle = value.sessionTitle ?? value.title
  return {
    sessionId,
    sessionTitle: cleanTitle(rawTitle) ?? 'Untitled chat',
    lastUsage,
    lastModel,
    updatedAt,
  }
}

function readAnchors(): Record<string, SessionAnchor> {
  try {
    const raw = window.localStorage.getItem(ANCHORS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const anchors: Record<string, SessionAnchor> = {}
    for (const [sessionId, candidate] of Object.entries(parsed)) {
      const anchor = normalizeAnchor(candidate, sessionId)
      if (anchor !== null) anchors[sessionId] = anchor
    }
    return anchors
  } catch {
    return {}
  }
}

function writeAnchors(anchors: Record<string, SessionAnchor>): void {
  try {
    window.localStorage.setItem(ANCHORS_KEY, JSON.stringify(anchors))
  } catch {
    // See writeUniversalLedger: persistence is a convenience.
  }
}

function readBalanceMeta(): BalanceMeta | null {
  try {
    const raw = window.localStorage.getItem(BALANCE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const balance =
      typeof parsed.balanceRmb === 'number' && Number.isFinite(parsed.balanceRmb)
        ? parsed.balanceRmb
        : null
    const syncedAt =
      typeof parsed.syncedAt === 'number' && Number.isFinite(parsed.syncedAt)
        ? parsed.syncedAt
        : null
    if (balance === null || syncedAt === null) return null
    return { balanceRmb: balance, syncedAt, currency: 'CNY' }
  } catch {
    return null
  }
}

function readBalanceHistory(): BalancePoint[] {
  try {
    const raw = window.localStorage.getItem(BALANCE_HISTORY_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    const list = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.points)
        ? parsed.points
        : []
    const points: BalancePoint[] = []
    for (const candidate of list) {
      if (!isRecord(candidate)) continue
      const at = candidate.at
      const balanceRmb = candidate.balanceRmb
      if (
        typeof at === 'number' &&
        Number.isFinite(at) &&
        at > 0 &&
        typeof balanceRmb === 'number' &&
        Number.isFinite(balanceRmb)
      ) {
        points.push({ at, balanceRmb })
      }
    }
    points.sort((a, b) => a.at - b.at)
    return points.slice(-MAX_BALANCE_POINTS)
  } catch {
    return []
  }
}

function writeBalanceHistory(points: readonly BalancePoint[]): void {
  try {
    window.localStorage.setItem(BALANCE_HISTORY_KEY, JSON.stringify({ points }))
  } catch {
    // Non-fatal: the last-known balance still lives in BALANCE_KEY.
  }
}

function appendBalancePoint(balanceRmb: number, at: number): BalancePoint[] {
  const stored = readBalanceHistory()
  const last = stored[stored.length - 1]
  if (
    last !== undefined &&
    at - last.at < 30_000 &&
    Math.abs(last.balanceRmb - balanceRmb) < 1e-9
  ) {
    return stored
  }
  stored.push({ at, balanceRmb })
  const trimmed = stored.slice(-MAX_BALANCE_POINTS)
  writeBalanceHistory(trimmed)
  return trimmed
}

/**
 * True spend inside a window, measured from API balance samples only:
 * the sum of every negative balance move between the last sample at/ before
 * `windowStartMs` (or the first sample inside the window) and now. Top-ups are
 * therefore ignored instead of producing a negative spend. Returns `null` when
 * the history cannot cover the window with at least two samples.
 */
export function apiSpendInWindow(
  points: readonly BalancePoint[],
  currentBalanceRmb: number | null,
  windowStartMs: number | null,
  nowMs: number,
): number | null {
  if (windowStartMs === null || currentBalanceRmb === null) return null
  const ordered = [...points].sort((a, b) => a.at - b.at)
  const series: BalancePoint[] = []
  let baseline: BalancePoint | null = null
  for (const point of ordered) {
    if (point.at <= windowStartMs) baseline = point
    else if (point.at < nowMs) series.push(point)
  }
  // Without a sample at or before the window start, the measured delta would
  // silently omit the beginning of the period. Report "unknown" instead and let
  // the UI fall back to the explicitly-labelled ledger estimate.
  if (baseline === null) return null
  series.unshift(baseline)
  const last = series[series.length - 1]
  if (last === undefined || Math.abs(last.balanceRmb - currentBalanceRmb) > 1e-9) {
    series.push({ at: nowMs, balanceRmb: currentBalanceRmb })
  }
  if (series.length < 2) return null
  let spend = 0
  for (let index = 1; index < series.length; index += 1) {
    spend += Math.max(0, series[index - 1].balanceRmb - series[index].balanceRmb)
  }
  return spend
}

/**
 * A1/A2 reconciliation: when two balance samples bracket real API spend that
 * the local ledger does not explain, the gap is Subagent / server-tool /
 * background spend that never reached a projection. Emit one explicit row so
 * the ledger sums to 100% of the measured API delta.
 */
export interface ReconciliationInput {
  prevBalance: number
  prevAt: number
  newBalance: number
  nowMs: number
  entries: readonly LedgerEntry[]
  /** Injected for callers that price differently; unused by the default plan. */
  rateCardFor?: (model: ModelClass) => RateCard
}

export function planReconciliation(input: ReconciliationInput): LedgerEntry | null {
  void input.rateCardFor
  const { prevBalance, prevAt, newBalance, nowMs, entries } = input
  const apiDelta = Math.max(0, prevBalance - newBalance)
  const ledgerDelta = entries.reduce(
    (sum, entry) =>
      entry.source !== 'reconcile' && entry.at > prevAt && entry.at <= nowMs
        ? sum + entryCostRmb(entry)
        : sum,
    0,
  )
  const diff = apiDelta - ledgerDelta
  if (!(diff > 0.005)) return null
  return {
    id: makeEntryId(),
    sessionId: 'reconcile:balance',
    sessionTitle: 'Unattributed / Subagent & Tool Spend',
    date: localDateKey(nowMs),
    at: nowMs,
    model: 'unattributed',
    tier: peakTier(isPeakUtc(new Date(nowMs))),
    costRmb: round4(diff),
    usage: zeroUsage(),
    source: 'reconcile',
    sessionType: 'reconcile',
    calls: 0,
  }
}

// ---------------------------------------------------------------------------
// D1 — dashboard export import. Accepts JSON envelopes/rows and CSV/TSV with
// the column aliases the DeepSeek dashboard (and older exports) emit.
// ---------------------------------------------------------------------------

const DASHBOARD_ALIASES: Record<string, readonly string[]> = {
  date: ['date', 'day', 'timestamp', 'createdat', 'time'],
  model: ['model', 'modelname'],
  apiKey: ['apikey', 'apikeyname', 'keyname', 'key'],
  input: ['input', 'inputtokens', 'prompttokens', 'uncachedinputtokens'],
  output: ['output', 'outputtokens', 'completiontokens'],
  cacheHit: ['cachehit', 'cachehittokens', 'cachereadtokens'],
  cacheMiss: [
    'cachemiss',
    'cachemisstokens',
    'promptcachemisstokens',
    'uncachedinput',
    'uncachedinputtokens',
  ],
  cacheWrite: ['cachewrite', 'cachecreationtokens'],
  cost: ['cost', 'amount', 'totalcost', 'charge', 'spend'],
  currency: ['currency'],
  requests: ['requests', 'requestcount'],
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function dashboardFieldForHeader(value: unknown): string | null {
  const normalized = normalizeHeader(value)
  if (normalized.length === 0) return null
  for (const [field, aliases] of Object.entries(DASHBOARD_ALIASES)) {
    if (aliases.includes(normalized)) return field
  }
  return null
}

function dashboardNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return null
}

export function parseDashboardDate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1_000) : Math.round(value)
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  if (/^\d+$/.test(text)) {
    const numeric = Number(text)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    return numeric < 1e11 ? numeric * 1_000 : numeric
  }
  const local = parseLocalDate(text)
  if (local !== null) return local
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** RFC4180-ish splitter: quoted fields, escaped quotes, CRLF, embedded delimiters. */
function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
    } else if (character === delimiter) {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else if (character !== '\r') {
      field += character
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim() !== ''))
}

function pickDashboardField(
  record: Record<string, unknown>,
  field: string,
): unknown {
  const aliases = DASHBOARD_ALIASES[field] ?? []
  for (const [key, value] of Object.entries(record)) {
    if (aliases.includes(normalizeHeader(key))) return value
  }
  return undefined
}

function dashboardEntryFromFields(
  picked: Record<string, unknown>,
): LedgerEntry | null {
  const at = parseDashboardDate(picked.date)
  if (at === null) return null
  const modelText = typeof picked.model === 'string' ? picked.model.trim() : ''
  const cacheRead = dashboardNumber(picked.cacheHit)
  // Exports may give the total prompt and the cache-hit count separately; in
  // that case the uncached input is total - cacheHit. An explicit miss/uncached
  // field is authoritative and must never be reduced again.
  const explicitMiss =
    picked.cacheMiss !== undefined ? dashboardNumber(picked.cacheMiss) : null
  const totalPrompt = dashboardNumber(picked.input)
  let input: number | null
  if (explicitMiss !== null) input = explicitMiss
  else if (totalPrompt !== null && cacheRead !== null && cacheRead > 0) {
    input = Math.max(0, totalPrompt - cacheRead)
  } else input = totalPrompt
  const output = dashboardNumber(picked.output)
  const cacheWrite = dashboardNumber(picked.cacheWrite)
  const hasTokens =
    input !== null || output !== null || cacheRead !== null || cacheWrite !== null
  const costValue = dashboardNumber(picked.cost)
  if (!hasTokens && costValue === null) return null
  const currency = String(picked.currency ?? '').trim().toUpperCase()
  const costRmb =
    costValue === null
      ? 0
      : round4(Math.max(0, currency === 'USD' ? costValue * USD_CNY : costValue))
  const usage: TokenUsage = {
    uncachedInputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
  }
  const keyName =
    typeof picked.apiKey === 'string' && picked.apiKey.trim().length > 0
      ? picked.apiKey.trim()
      : 'dashboard'
  const sessionId = `import:${keyName}`
  const model = classifyModelText(modelText) ?? 'flash'
  const dateKey = localDateKey(at)
  // A stable identity for dashboard rows: one (date, apiKey, model) row is the
  // same logical row across re-imports, so a grown export replaces it instead of
  // double counting. Without date/key/model identity, fall back to a rounded
  // token+cost signature so identical replays still dedupe.
  const hasStableIdentity = keyName !== 'dashboard' && modelText !== '' && dateKey !== ''
  const importKey = `d${hashText(
    hasStableIdentity
      ? `${dateKey}|${keyName}|${modelText}`
      : [
          dateKey,
          modelText,
          Math.round(usage.uncachedInputTokens),
          Math.round(usage.outputTokens),
          Math.round(usage.cacheReadTokens),
          Math.round(usage.cacheWriteTokens),
          round4(costRmb),
        ].join('|'),
  )}`
  return {
    id: makeEntryId(),
    sessionId,
    sessionTitle: sessionId,
    date: dateKey,
    model,
    tier: peakTier(isPeakUtc(new Date(at))),
    usage,
    costRmb,
    at,
    sessionType: 'import',
    source: 'import',
    calls: dashboardNumber(picked.requests) ?? 1,
    importKey,
  }
}

export interface DashboardImportResult {
  entries: LedgerEntry[]
  skipped: number
  warnings: string[]
}

/**
 * Parse a DeepSeek dashboard export (CSV / TSV / JSON) or a previously exported
 * universal ledger. Never throws; unparseable rows are counted as `skipped`.
 */
export function parseDashboardExport(text: string, filename: string): DashboardImportResult {
  const warnings: string[] = []
  const entries: LedgerEntry[] = []
  let skipped = 0
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (trimmed.length === 0) {
    return { entries, skipped, warnings: ['The file was empty.'] }
  }

  const isJsonCandidate = trimmed.startsWith('[') || trimmed.startsWith('{')
  if (isJsonCandidate) {
    let parsed: unknown = null
    let parsedOk = false
    try {
      parsed = JSON.parse(trimmed)
      parsedOk = true
    } catch (error) {
      warnings.push(
        `JSON parse failed${error instanceof Error ? `: ${error.message}` : ''}.`,
      )
    }
    if (parsedOk) {
      let list: unknown[] | null = null
      if (Array.isArray(parsed)) list = parsed
      else if (isRecord(parsed)) {
        for (const key of ['entries', 'data', 'items', 'rows']) {
          if (Array.isArray(parsed[key])) {
            list = parsed[key] as unknown[]
            break
          }
        }
      }
      if (list === null) {
        return { entries, skipped, warnings: [...warnings, 'No entries/data/items/rows array found.'] }
      }
      for (const candidate of list) {
        if (!isRecord(candidate)) {
          skipped += 1
          continue
        }
        const canonical =
          typeof candidate.sessionId === 'string' ||
          isRecord(candidate.usage) ||
          typeof candidate.tier === 'string'
        if (canonical) {
          const entry = normalizeEntry(candidate, 'import:ledger')
          if (entry === null) skipped += 1
          else entries.push(entry)
          continue
        }
        const picked: Record<string, unknown> = {}
        for (const field of Object.keys(DASHBOARD_ALIASES)) {
          const value = pickDashboardField(candidate, field)
          if (value !== undefined) picked[field] = value
        }
        const entry = dashboardEntryFromFields(picked)
        if (entry === null) skipped += 1
        else entries.push(entry)
      }
      return { entries, skipped, warnings }
    }
  }

  const looksTabSeparated =
    /\.tsv$/i.test(filename) ||
    (trimmed.split('\n')[0]?.split('\t').length ?? 0) >
      (trimmed.split('\n')[0]?.split(',').length ?? 0)
  const rows = parseDelimitedRows(trimmed, looksTabSeparated ? '\t' : ',')
  if (rows.length < 1) {
    return { entries, skipped, warnings: [...warnings, 'No rows found.'] }
  }
  const header = rows[0].map((cell) => dashboardFieldForHeader(cell))
  const knownColumns = header.some((field) => field !== null)
  if (!knownColumns) {
    return {
      entries,
      skipped,
      warnings: [...warnings, 'No recognized dashboard columns in the header row.'],
    }
  }
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index]
    const picked: Record<string, unknown> = {}
    for (let column = 0; column < header.length; column += 1) {
      const field = header[column]
      if (field === null) continue
      const value = cells[column]
      if (value !== undefined && value.trim() !== '') picked[field] = value
    }
    const entry = dashboardEntryFromFields(picked)
    if (entry === null) skipped += 1
    else entries.push(entry)
  }
  if (entries.length === 0 && skipped === 0) {
    warnings.push('The file had a header but no data rows.')
  }
  return { entries, skipped, warnings }
}

function encodeApiKey(value: string): string {
  try {
    return `b64:${window.btoa(value)}`
  } catch {
    return value
  }
}

function decodeApiKey(value: string): string {
  if (!value.startsWith('b64:')) return value
  try {
    return window.atob(value.slice(4))
  } catch {
    return ''
  }
}

function readApiKey(): string {
  try {
    const raw = window.localStorage.getItem(API_KEY_KEY)
    return raw === null ? '' : decodeApiKey(raw).trim()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Cross-instance ledger notification. `storage` events only fire in other
// documents, so a same-document custom event plus a BroadcastChannel keep every
// mounted HUD (and every tab) reading the same global database.
// ---------------------------------------------------------------------------

let channelHandle: BroadcastChannel | null | undefined

function ledgerChannel(): BroadcastChannel | null {
  if (channelHandle !== undefined) return channelHandle
  try {
    channelHandle =
      typeof BroadcastChannel === 'function' ? new BroadcastChannel(LEDGER_CHANNEL) : null
  } catch {
    channelHandle = null
  }
  return channelHandle
}

function notifyLedgerChanged(): void {
  try {
    window.dispatchEvent(new Event(LEDGER_EVENT))
  } catch {
    // Same-document notification is best-effort.
  }
  try {
    ledgerChannel()?.postMessage('changed')
  } catch {
    // Cross-tab notification is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Which pricing model is live? The durable `modelSelection` projection carries
// `{ lastUsed, next }`; `lastUsed` is what produced the settled tokens, while
// `next` is the user's pending choice. Billing therefore prefers `lastUsed`.
// The composer model label also exposes `data-model-id`/`data-provider-id`, so
// a DOM fallback still works when the projection is absent.
// ---------------------------------------------------------------------------

function classifyModelText(raw: string | null | undefined): ModelId | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const text = raw.toLowerCase()
  if (/(^|[^a-z0-9])flash([^a-z0-9]|$)/.test(text)) return 'flash'
  if (/(^|[^a-z0-9])pro([^a-z0-9]|$)/.test(text)) return 'pro'
  if (/reasoner|reasoning|\br1\b|thinking|deepseek-r/.test(text)) return 'pro'
  if (/deepseek-chat|\bchat\b|v3|v4|exp|fast|turbo|lite|mini|air/.test(text)) return 'flash'
  return null
}

function modelIdFromSelection(value: unknown): ModelId | null {
  if (typeof value === 'string') return classifyModelText(value)
  if (!isRecord(value)) return null
  for (const key of ['model', 'modelId', 'id', 'name', 'displayName']) {
    const candidate = value[key]
    if (typeof candidate === 'string') {
      const model = classifyModelText(candidate)
      if (model !== null) return model
    }
  }
  const badge = value.badge
  if (isRecord(badge) && typeof badge.text === 'string') {
    const model = classifyModelText(badge.text)
    if (model !== null) return model
  }
  return null
}

interface LiveModelInfo {
  used: ModelId | null
  selected: ModelId | null
}

function liveModelInfo(value: unknown): LiveModelInfo {
  if (!isRecord(value)) {
    const model = modelIdFromSelection(value)
    return { used: model, selected: model }
  }
  const lastUsed = modelIdFromSelection(value.lastUsed)
  const next = modelIdFromSelection(value.next)
  if (lastUsed !== null || next !== null) {
    return { used: lastUsed ?? next, selected: next ?? lastUsed }
  }
  // Some hosts publish the selection itself rather than `{ lastUsed, next }`.
  const direct = modelIdFromSelection(value)
  return { used: direct, selected: direct }
}

function modelFromDom(): ModelId | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null

  const readElement = (element: HTMLElement): ModelId | null =>
    classifyModelText(element.getAttribute('data-model-id')) ??
    classifyModelText(element.textContent) ??
    classifyModelText(element.getAttribute('data-provider-id')) ??
    classifyModelText(element.getAttribute('aria-label')) ??
    classifyModelText(element.getAttribute('title'))

  const usable = (element: HTMLElement): boolean => {
    if (element.closest('[data-usage-popup-hud]') !== null) return false
    if (
      element.closest('[role="menu"], [role="listbox"], [role="dialog"], [aria-modal="true"]') !==
      null
    ) {
      return false
    }
    // Never read model names out of transcript cards; only the composer counts.
    if (element.closest('[data-conversation-scroll]') !== null) return false
    const rect = element.getBoundingClientRect()
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight
    )
  }

  const labelled = document.querySelectorAll<HTMLElement>('[data-model-id], [data-provider-id]')
  let best: ModelId | null = null
  let bestTop = Number.NEGATIVE_INFINITY
  for (const element of Array.from(labelled)) {
    if (!usable(element)) continue
    const model = readElement(element)
    if (model === null) continue
    const top = element.getBoundingClientRect().top
    if (top > bestTop) {
      best = model
      bestTop = top
    }
  }
  if (best !== null) return best

  // Last resort: a compact control in the composer that shows a Flash/Pro name.
  for (const element of Array.from(
    document.querySelectorAll<HTMLElement>('button, [role="combobox"], [aria-haspopup="menu"]'),
  )) {
    if (!usable(element)) continue
    const rect = element.getBoundingClientRect()
    if (rect.top < window.innerHeight * 0.5) continue
    const model = readElement(element)
    if (model !== null) return model
  }
  return null
}

// ---------------------------------------------------------------------------
// Best-effort session title/id. The standard dock props do not promise a title
// or even a session id on every host, so read optional runtime fields first and
// fall back to the active sidebar row or the page heading.
// ---------------------------------------------------------------------------

function runtimeSessionTitle(props: Record<string, unknown>): string | null {
  for (const key of [
    'sessionTitle',
    'session_title',
    'conversationTitle',
    'conversation_title',
    'title',
    'label',
  ]) {
    const title = cleanTitle(props[key])
    if (title !== null) return title
  }
  for (const key of ['session', 'conversation', 'sessionMeta', 'meta']) {
    const nested = props[key]
    if (!isRecord(nested)) continue
    for (const titleKey of ['title', 'name', 'label', 'displayName', 'summary']) {
      const title = cleanTitle(nested[titleKey])
      if (title !== null) return title
    }
  }
  return null
}

function activeSessionIdFromDom(): string | null {
  if (typeof document === 'undefined') return null
  for (const selector of ['[data-active-session-id]', '[data-current-session-id]']) {
    const element = document.querySelector<HTMLElement>(selector)
    if (element === null) continue
    const value =
      element.getAttribute('data-active-session-id') ??
      element.getAttribute('data-current-session-id')
    if (value !== null && value.length > 0) return value
  }
  // The DSH workspace tree marks the open chat with `aria-selected` on a row
  // keyed `session:<id>`. This is a fallback for hosts whose retention source
  // is unavailable; the retention signal above is preferred.
  for (const row of Array.from(
    document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]'),
  )) {
    if (row.closest('[data-usage-popup-hud]') !== null) continue
    if (row.getAttribute('aria-selected') !== 'true') continue
    const key = row.getAttribute('data-row-key')
    const id = key === null ? '' : key.slice('session:'.length)
    if (id.length > 0) return id
  }
  for (const row of Array.from(document.querySelectorAll<HTMLElement>('[data-session-id]'))) {
    if (row.closest('[data-usage-popup-hud]') !== null) continue
    const active =
      row.getAttribute('aria-current') === 'page' ||
      row.getAttribute('aria-selected') === 'true' ||
      row.getAttribute('data-active') === 'true' ||
      row.getAttribute('data-state') === 'active'
    if (!active) continue
    const id = row.getAttribute('data-session-id')
    if (id !== null && id.length > 0) return id
  }
  return null
}

function sessionTitleFromDom(sessionId: string | null): string | null {
  if (typeof document === 'undefined') return null

  const readElement = (element: HTMLElement): string | null =>
    cleanTitle(element.getAttribute('data-session-title')) ??
    cleanTitle(element.getAttribute('aria-label')) ??
    cleanTitle(element.textContent)

  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-session-id]'))
  for (const row of rows) {
    if (row.closest('[data-usage-popup-hud]') !== null) continue
    const id = row.getAttribute('data-session-id')
    if (sessionId !== null && id !== sessionId) continue
    const active =
      row.getAttribute('aria-current') === 'page' ||
      row.getAttribute('aria-selected') === 'true' ||
      row.getAttribute('data-active') === 'true' ||
      row.getAttribute('data-state') === 'active'
    if (sessionId === null && !active) continue
    const title = readElement(row)
    if (title !== null) return title
  }

  for (const selector of [
    '[data-session-header] h1',
    'header h1',
    'main h1',
    '[role="main"] h1',
  ]) {
    const heading = document.querySelector<HTMLElement>(selector)
    if (heading === null) continue
    const title = cleanTitle(heading.textContent)
    if (title !== null) return title
  }
  return null
}

// ---------------------------------------------------------------------------
// Generic localStorage helpers.
// ---------------------------------------------------------------------------

function readStoredPosition(): HudPosition | null {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const x = parsed.x
    const y = parsed.y
    if (typeof x !== 'number' || typeof y !== 'number') return null
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  } catch {
    return null
  }
}

function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === '1') return true
    if (raw === '0') return false
    return fallback
  } catch {
    return fallback
  }
}

function readStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return allowed.includes(raw as T) ? (raw as T) : fallback
  } catch {
    return fallback
  }
}

function readStoredText(key: string, fallback: string): string {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : raw
  } catch {
    return fallback
  }
}

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Persistence is a convenience; never break the HUD over it.
  }
}

function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Ignore unavailable storage.
  }
}

function persistPosition(position: HudPosition): void {
  writeStored(POSITION_KEY, JSON.stringify({ x: Math.round(position.x), y: Math.round(position.y) }))
}

/** Keep the whole card inside the viewport, with a small breathing margin. */
function clampPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  topInset: number = VIEWPORT_MARGIN,
): HudPosition {
  const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)
  const maxY = Math.max(topInset, window.innerHeight - height - VIEWPORT_MARGIN)
  return {
    x: Math.round(Math.min(Math.max(x, VIEWPORT_MARGIN), maxX)),
    y: Math.round(Math.min(Math.max(y, topInset), maxY)),
  }
}

function initialPosition(topInset: number = VIEWPORT_MARGIN): HudPosition {
  const stored = readStoredPosition()
  if (stored !== null) return stored
  const viewportWidth = typeof window === 'undefined' ? HUD_WIDTH + 48 : window.innerWidth
  return {
    x: Math.max(VIEWPORT_MARGIN, viewportWidth - HUD_WIDTH - 24),
    y: Math.max(88, topInset),
  }
}

// ---------------------------------------------------------------------------
// Inline glyphs — no icon package, no external asset.
// ---------------------------------------------------------------------------

function GripGlyph() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <circle cx="3" cy="3" r="1.15" fill="currentColor" />
      <circle cx="7" cy="3" r="1.15" fill="currentColor" />
      <circle cx="3" cy="7" r="1.15" fill="currentColor" />
      <circle cx="7" cy="7" r="1.15" fill="currentColor" />
      <circle cx="3" cy="11" r="1.15" fill="currentColor" />
      <circle cx="7" cy="11" r="1.15" fill="currentColor" />
    </svg>
  )
}

function CollapseGlyph({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      {collapsed ? (
        <rect
          x="2.2"
          y="2.2"
          width="7.6"
          height="7.6"
          rx="1.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      ) : (
        <line x1="2.2" y1="6" x2="9.8" y2="6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      )}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Styles. Only theme tokens (with literal fallbacks) are used, so light/dark
// switching follows the host automatically.
// ---------------------------------------------------------------------------

const hudStyle = (
  position: HudPosition,
  minimized: boolean,
  dragging: boolean,
  topInset: number,
): CSSProperties => ({
  position: 'fixed',
  left: position.x,
  top: position.y,
  zIndex: HUD_Z_INDEX,
  width: minimized ? undefined : HUD_WIDTH,
  maxWidth: 'calc(100vw - 16px)',
  boxSizing: 'border-box',
  maxHeight: `calc(100vh - ${topInset + VIEWPORT_MARGIN}px)`,
  overflowX: 'hidden',
  overflowY: 'auto',
  textAlign: 'left',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.35))',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-overlay, Canvas)',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
  fontSize: 12,
  lineHeight: '18px',
  userSelect: dragging ? 'none' : 'auto',
  pointerEvents: 'auto',
  // Even if the card ends up over the host's Windows caption band, opt this
  // subtree out of window dragging so its own controls keep receiving input.
  WebkitAppRegion: 'no-drag',
})

const handleStyle = (minimized: boolean, dragging: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  cursor: dragging ? 'grabbing' : 'grab',
  touchAction: 'none',
  borderBottom: minimized ? 0 : '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25))',
})

const gripStyle: CSSProperties = {
  display: 'inline-flex',
  flex: '0 0 auto',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  opacity: 0.55,
}

const titleStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary, CanvasText)',
}

const headerTotalStyle: CSSProperties = {
  marginLeft: 'auto',
  flex: '0 0 auto',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontVariantNumeric: 'tabular-nums',
}

/** Runaway-context alert: bold amber, never a quiet tint. */
const bloatTextStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-warning-primary, #d29922)',
  background: 'rgba(210, 153, 34, 0.14)',
  border: '1px solid rgba(210, 153, 34, 0.42)',
  borderRadius: 5,
  padding: '1px 5px',
  fontWeight: 700,
}

const pillTextStyle: CSSProperties = {
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  fontVariantNumeric: 'tabular-nums',
}

const pillStatsStyle: CSSProperties = {
  flex: '0 0 auto',
  paddingLeft: 7,
  borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25))',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 10,
  lineHeight: '15px',
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
  width: 22,
  height: 22,
  marginLeft: 2,
  padding: 0,
  border: 0,
  borderRadius: 5,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  cursor: 'pointer',
}

const bodyStyle: CSSProperties = {
  padding: '10px 12px 12px',
}

const totalRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  marginBottom: 8,
}

const totalNumberStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 650,
  lineHeight: '24px',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  fontVariantNumeric: 'tabular-nums',
}

const totalUnitStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  opacity: 0.72,
}

const cacheHitStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '6px 8px',
  marginBottom: 10,
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
}

const cacheHitValueStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontVariantNumeric: 'tabular-nums',
}

const detailsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(96px, auto) minmax(0, 1fr)',
  gap: '4px 12px',
  margin: 0,
}

const labelStyle: CSSProperties = {
  minWidth: 0,
  margin: 0,
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  opacity: 0.78,
}

const valueStyle: CSSProperties = {
  minWidth: 0,
  margin: 0,
  textAlign: 'right',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontVariantNumeric: 'tabular-nums',
}

const hintStyle: CSSProperties = {
  margin: '8px 0 0',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  opacity: 0.72,
}

// Two side-by-side columns inside the one draggable card: token breakdown on
// the left, RMB cost & burn-rate telemetry on the right.
const hudColumnsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
  alignItems: 'start',
}

const leftColumnStyle: CSSProperties = {
  minWidth: 0,
  paddingRight: 12,
}

const rightColumnStyle: CSSProperties = {
  minWidth: 0,
  paddingLeft: 12,
  borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25))',
}

const segmentGroupStyle: CSSProperties = {
  display: 'flex',
  gap: 2,
  padding: 2,
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
}

const timeframeGroupStyle: CSSProperties = {
  ...segmentGroupStyle,
  marginBottom: 8,
}

/** Inverted chip reads correctly in both light and dark themes. */
const segmentButtonStyle = (active: boolean): CSSProperties => ({
  flex: '1 1 0',
  minWidth: 0,
  padding: '2px 0',
  border: 0,
  borderRadius: 4,
  background: active ? 'var(--dsw-alias-label-primary, CanvasText)' : 'transparent',
  color: active ? 'var(--dsw-alias-bg-overlay, Canvas)' : 'var(--dsw-alias-label-secondary, CanvasText)',
  font: 'inherit',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: active ? 600 : 500,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  opacity: active ? 1 : 0.78,
})

const timeframeButtonStyle = (active: boolean): CSSProperties => ({
  ...segmentButtonStyle(active),
  fontSize: 10,
  letterSpacing: -0.1,
})

/**
 * Explicit scope badge. Day / Week / Month / Custom always print "All chats" so
 * a global total can never be mistaken for the open conversation's total.
 */
const scopeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  margin: '-2px 0 8px',
}

const scopeBadgeStyle = (global: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '0 6px',
  borderRadius: 999,
  background: global ? 'rgba(63, 185, 80, 0.14)' : 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
  color: global
    ? 'var(--dsw-alias-state-success-primary, #3fb950)'
    : 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 9,
  lineHeight: '15px',
  fontWeight: 650,
  whiteSpace: 'nowrap',
})

const tierRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  marginBottom: 6,
}

const tierBadgeStyle = (peak: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '1px 7px',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
  color: peak
    ? 'var(--dsw-alias-state-warning-primary, #d29922)'
    : 'var(--dsw-alias-state-success-primary, #3fb950)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
})

const tierDotStyle: CSSProperties = {
  width: 5,
  height: 5,
  flex: '0 0 auto',
  borderRadius: 999,
  background: 'currentColor',
}

const countdownStyle: CSSProperties = {
  minWidth: 0,
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 10,
  lineHeight: '15px',
  opacity: 0.68,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const liveBadgeRowStyle: CSSProperties = {
  display: 'flex',
  marginBottom: 8,
}

/** Small live / mixed badge under the session total. */
const liveBadgeStyle = (mixed: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  minWidth: 0,
  maxWidth: '100%',
  padding: '1px 7px',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
  color: mixed
    ? 'var(--dsw-alias-state-warning-primary, #d29922)'
    : 'var(--dsw-alias-state-success-primary, #3fb950)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
})

const metricRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  marginTop: 6,
}

const metricLabelStyle: CSSProperties = {
  minWidth: 0,
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 11,
  lineHeight: '16px',
  opacity: 0.78,
  whiteSpace: 'nowrap',
}

const metricValueStyle: CSSProperties = {
  minWidth: 0,
  textAlign: 'right',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 11,
  lineHeight: '16px',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const savingsValueStyle: CSSProperties = {
  ...metricValueStyle,
  color: 'var(--dsw-alias-state-success-primary, #3fb950)',
}

const gaugeTrackStyle: CSSProperties = {
  height: 5,
  marginTop: 5,
  borderRadius: 999,
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
}

const gaugeFillStyle = (ratio: number | null): CSSProperties => {
  const filled = ratio === null ? 0 : Math.min(1, Math.max(0, ratio))
  // Green under 80% of the daily target, amber from 80%, red at/over 100%.
  const color =
    ratio === null
      ? 'var(--dsw-alias-state-idle-primary, GrayText)'
      : ratio >= 1
        ? 'var(--dsw-alias-state-danger-primary, #f85149)'
        : ratio >= 0.8
          ? 'var(--dsw-alias-state-warning-primary, #d29922)'
          : 'var(--dsw-alias-state-success-primary, #3fb950)'
  return {
    width: `${filled * 100}%`,
    height: '100%',
    borderRadius: 999,
    background: color,
    transition: 'width 160ms ease, background 160ms ease',
  }
}

const sectionStyle: CSSProperties = {
  marginTop: 10,
  padding: '8px 9px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22))',
  background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.07))',
}

const sectionTitleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 20,
}

const sectionTitleStyle: CSSProperties = {
  minWidth: 0,
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 650,
  whiteSpace: 'nowrap',
}

const sectionValueStyle: CSSProperties = {
  marginLeft: 'auto',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 11,
  lineHeight: '16px',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const modelBarStyle: CSSProperties = {
  display: 'flex',
  gap: 1,
  height: 6,
  marginTop: 7,
  borderRadius: 999,
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
}

const modelSegmentStyle = (color: string, share: number): CSSProperties => {
  const clamped = Math.max(0, Math.min(1, share))
  return {
    width: `${clamped * 100}%`,
    minWidth: clamped > 0 ? 2 : 0,
    height: '100%',
    background: color,
    opacity: 0.85,
    transition: 'width 160ms ease',
  }
}

const modelRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 4,
  fontSize: 10,
  lineHeight: '14px',
}

const modelDotStyle = (color: string): CSSProperties => ({
  width: 6,
  height: 6,
  flex: '0 0 auto',
  borderRadius: 2,
  background: color,
})

const modelNameStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
}

const modelTokensStyle: CSSProperties = {
  flex: '0 0 auto',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  opacity: 0.68,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const modelCostStyle: CSSProperties = {
  flex: '0 0 auto',
  minWidth: 58,
  textAlign: 'right',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const modelShareStyle: CSSProperties = {
  flex: '0 0 auto',
  width: 34,
  textAlign: 'right',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  opacity: 0.62,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const balanceHeadlineRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  marginTop: 4,
}

const balanceHeadlineStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 650,
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  fontVariantNumeric: 'tabular-nums',
}

const balanceHeadlineUnitStyle: CSSProperties = {
  fontSize: 9,
  lineHeight: '13px',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  opacity: 0.6,
  whiteSpace: 'nowrap',
}

const balanceGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 6,
  marginTop: 7,
}

const balanceMetricStyle: CSSProperties = {
  minWidth: 0,
}

const balanceMetricLabelStyle: CSSProperties = {
  display: 'block',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 9,
  lineHeight: '13px',
  opacity: 0.66,
  whiteSpace: 'nowrap',
}

const balanceMetricValueStyle: CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  fontSize: 12,
  lineHeight: '17px',
  fontWeight: 650,
  fontVariantNumeric: 'tabular-nums',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const budgetRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  marginTop: 9,
}

const dailyTargetStyle: CSSProperties = {
  marginLeft: 'auto',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 10,
  lineHeight: '15px',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const budgetCaptionRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  marginTop: 4,
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 9,
  lineHeight: '13px',
  opacity: 0.78,
  fontVariantNumeric: 'tabular-nums',
}

const dangerTextStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-danger-primary, #f85149)',
}

const warnTextStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-warning-primary, #d29922)',
}

const tinyHintStyle: CSSProperties = {
  marginTop: 6,
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 9,
  lineHeight: '13px',
  opacity: 0.62,
}

const syncRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  marginTop: 6,
}

const syncStatusStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  marginLeft: 6,
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 9,
  lineHeight: '13px',
  opacity: 0.7,
  whiteSpace: 'nowrap',
}

const syncDotStyle = (color: string): CSSProperties => ({
  width: 5,
  height: 5,
  flex: '0 0 auto',
  borderRadius: 999,
  background: color,
})

const passwordInputStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '3px 6px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.35))',
  borderRadius: 5,
  background: 'var(--dsw-alias-bg-overlay, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  font: 'inherit',
  fontSize: 10,
  lineHeight: '16px',
}

const miniButtonStyle: CSSProperties = {
  flex: '0 0 auto',
  padding: '2px 6px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.35))',
  borderRadius: 5,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  font: 'inherit',
  fontSize: 9,
  lineHeight: '14px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const primaryMiniButtonStyle: CSSProperties = {
  ...miniButtonStyle,
  borderColor: 'transparent',
  background: 'var(--dsw-alias-label-primary, CanvasText)',
  color: 'var(--dsw-alias-bg-overlay, Canvas)',
  fontWeight: 600,
}

const linkButtonStyle: CSSProperties = {
  flex: '0 0 auto',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  font: 'inherit',
  fontSize: 9,
  lineHeight: '14px',
  textDecoration: 'underline',
  opacity: 0.64,
  cursor: 'pointer',
}

const customPanelStyle: CSSProperties = {
  marginBottom: 9,
  padding: '7px 8px',
  borderRadius: 7,
  background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.09))',
}

const customDateRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
}

const dateInputStyle: CSSProperties = {
  minWidth: 0,
  flex: '1 1 0',
  boxSizing: 'border-box',
  padding: '2px 4px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.35))',
  borderRadius: 4,
  background: 'var(--dsw-alias-bg-overlay, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  font: 'inherit',
  fontSize: 9,
  lineHeight: '14px',
}

const sessionCountStyle: CSSProperties = {
  flex: '0 0 auto',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 9,
  opacity: 0.64,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 5,
  marginTop: 10,
  paddingTop: 8,
  borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22))',
}

const stopLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  fontSize: 9,
  lineHeight: '14px',
  whiteSpace: 'nowrap',
}

const stopInputStyle: CSSProperties = {
  width: 46,
  boxSizing: 'border-box',
  padding: '1px 3px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.35))',
  borderRadius: 4,
  background: 'var(--dsw-alias-bg-overlay, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  font: 'inherit',
  fontSize: 9,
  lineHeight: '14px',
  fontVariantNumeric: 'tabular-nums',
}

// ---------------------------------------------------------------------------
// Token-saver face (previously the separate composer strip).
// ---------------------------------------------------------------------------
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

const saverWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 2,
}

const saverHeadlineStyle: CSSProperties = {
  fontSize: 26,
  fontWeight: 650,
  lineHeight: 1.05,
  fontVariantNumeric: 'tabular-nums',
}

const saverHeadlineUnitStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.7,
  marginLeft: 6,
}

const saverGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 6,
}

const saverMetricStyle: CSSProperties = {
  minWidth: 0,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
}

const saverMetricLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 10,
  lineHeight: 1.25,
  opacity: 0.66,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const saverMetricValueStyle: CSSProperties = {
  display: 'block',
  marginTop: 2,
  fontSize: 13,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const saverToggleRowStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
}

const saverToggleStyle = (on: boolean): CSSProperties => ({
  border: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3))',
  borderRadius: 999,
  padding: '2px 9px',
  fontSize: 11,
  cursor: 'pointer',
  color: on
    ? 'var(--dsw-alias-state-success-primary, #3fb950)'
    : 'var(--dsw-alias-label-secondary, inherit)',
  background: on
    ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #3fb950) 14%, transparent)'
    : 'transparent',
  opacity: 0.95,
})

const saverRecentRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '38px minmax(0, 1fr) auto',
  gap: 6,
  alignItems: 'baseline',
  fontSize: 11,
  lineHeight: 1.35,
}

/**
 * The merged dsh-plugin-save-token dashboard. Everything is read from the
 * saver's own local `/save-token/api/dashboard` counters; no model calls, no
 * provider API.
 */
function SaverPanel() {
  const [data, setData] = useState<SaveTokenDashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer = 0
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(SAVE_TOKEN_DASHBOARD_ENDPOINT, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload: unknown = await response.json()
        const normalized = normalizeSaverDashboard(payload)
        if (cancelled) return
        setData(normalized)
        setError(normalized === null ? 'unexpected dashboard payload' : null)
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : 'unavailable')
      }
      if (!cancelled) timer = window.setTimeout(() => void load(), SAVER_REFRESH_MS)
    }
    void load()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  const toggle = async (key: 'compress' | 'dedupe'): Promise<void> => {
    if (data === null || busy) return
    const next = !data.flags[key]
    setBusy(true)
    try {
      const response = await fetch(SAVE_TOKEN_TOGGLE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value: next }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setData((previous) =>
        previous === null ? previous : { ...previous, flags: { ...previous.flags, [key]: next } },
      )
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'toggle failed')
    } finally {
      setBusy(false)
    }
  }

  if (data === null) {
    return (
      <div style={saverWrapStyle}>
        <div style={sectionTitleRowStyle}>
          <span style={sectionTitleStyle}>Token saver</span>
          <span style={sectionValueStyle}>—</span>
        </div>
        <div style={tinyHintStyle}>
          {error === null
            ? 'Loading local save-token counters…'
            : `Token saver unavailable (${error}). Install dsh-plugin-save-token to populate this tab.`}
        </div>
      </div>
    )
  }

  const compressedBytes = Math.max(0, data.compression.bytesBefore - data.compression.bytesAfter)
  const dedupeBytes = data.compression.dedupeSavedBytes
  const recent = data.recent.slice(0, 4)

  return (
    <div style={saverWrapStyle}>
      <div style={sectionTitleRowStyle}>
        <span style={sectionTitleStyle}>Token saver</span>
        <span style={syncStatusStyle} title={`Local counters · uptime ${formatUptime(data.uptimeSec)}`}>
          <span
            aria-hidden="true"
            style={syncDotStyle(
              data.flags.compress ? 'var(--dsw-alias-state-success-primary, #3fb950)' : 'var(--dsw-alias-label-secondary, #8b949e)',
            )}
          />
          live
        </span>
      </div>

      <div style={balanceHeadlineRowStyle}>
        <span style={saverHeadlineStyle}>{compactCount(data.totals.avoidedTokens)}</span>
        <span style={saverHeadlineUnitStyle}>tokens avoided</span>
      </div>
      <div style={tinyHintStyle}>
        {data.reliefPct}% of billed input relief · no model calls, no provider sync
      </div>

      <div style={saverGridStyle}>
        <div style={saverMetricStyle}>
          <span style={saverMetricLabelStyle}>Requests</span>
          <span style={saverMetricValueStyle}>{compactCount(data.totals.requests)}</span>
        </div>
        <div style={saverMetricStyle}>
          <span style={saverMetricLabelStyle}>Compressed</span>
          <span style={saverMetricValueStyle}>{compactCount(data.compression.count)}</span>
        </div>
        <div style={saverMetricStyle}>
          <span style={saverMetricLabelStyle}>Cache hit</span>
          <span style={saverMetricValueStyle}>{data.cacheHitPct}%</span>
        </div>
        <div style={saverMetricStyle}>
          <span style={saverMetricLabelStyle}>Lossless</span>
          <span style={saverMetricValueStyle}>{compactCount(data.compression.losslessEncodes)}</span>
        </div>
        <div style={saverMetricStyle}>
          <span style={saverMetricLabelStyle}>Dedupe hits</span>
          <span style={saverMetricValueStyle}>{compactCount(data.compression.dedupeHits)}</span>
        </div>
        <div style={saverMetricStyle}>
          <span style={saverMetricLabelStyle}>Bytes cut</span>
          <span style={saverMetricValueStyle}>{formatBytes(compressedBytes + dedupeBytes)}</span>
        </div>
      </div>

      <div style={saverToggleRowStyle}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle('compress')}
          style={saverToggleStyle(data.flags.compress)}
          title="Toggle dsh-plugin-save-token compression"
        >
          compress {data.flags.compress ? 'on' : 'off'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle('dedupe')}
          style={saverToggleStyle(data.flags.dedupe)}
          title="Toggle duplicate-output dedupe"
        >
          dedupe {data.flags.dedupe ? 'on' : 'off'}
        </button>
        <span style={{ ...tinyHintStyle, marginLeft: 'auto' }}>
          {data.totals.auxRequests} aux
        </span>
      </div>

      {recent.length > 0 && (
        <div>
          <div style={{ ...tinyHintStyle, marginBottom: 3 }}>Recent</div>
          {recent.map((row, index) => (
            <div key={`${row.ts}-${index}`} style={saverRecentRowStyle}>
              <span style={{ opacity: 0.6 }}>
                {row.ts > 0
                  ? new Date(row.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : '—'}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.label || row.kind}
                {row.detail !== '' ? <span style={{ opacity: 0.6 }}> · {row.detail}</span> : null}
              </span>
              <span style={{ opacity: 0.72 }}>
                {row.saved > 0 ? `-${compactCount(row.saved)}` : '—'}
              </span>
            </div>
          ))}
        </div>
      )}

      {error !== null && (
        <div style={{ ...tinyHintStyle, ...dangerTextStyle }}>{error}</div>
      )}
      <div style={tinyHintStyle}>
        Merged from dsh-plugin-save-token · dashboard moved here so the composer stays clean.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chat selector data
// ---------------------------------------------------------------------------

/** One selectable chat, aggregated out of the universal ledger. */
export interface ChatOption {
  sessionId: string
  title: string | null
  entries: number
  tokens: number
  costRmb: number
  lastAt: number
}

const EMPTY_MODELS: LiveModelInfo = { used: null, selected: null }

/**
 * Aggregate ledger rows into per-chat options, newest activity first.
 *
 * Only chats with at least one recorded turn are listed: a row contributes
 * `entries > 0`, and the followed chat contributes live tokens as soon as its
 * first turn starts. A blank New Session draft therefore never appears.
 */
export function buildChatOptions(
  ledgerEntries: readonly LedgerEntry[],
  activeChatId: string | null,
  activeTokens: number,
): ChatOption[] {
  const map = new Map<string, ChatOption>()
  for (const entry of ledgerEntries) {
    const id = entry.sessionId
    if (typeof id !== 'string' || id.length === 0) continue
    const title = cleanTitle(entry.sessionTitle)
    const existing = map.get(id)
    if (existing === undefined) {
      map.set(id, {
        sessionId: id,
        title,
        entries: 1,
        tokens: usageTotal(entry.usage),
        costRmb: entryCostRmb(entry),
        lastAt: entry.at,
      })
      continue
    }
    if (title !== null) existing.title = title
    existing.entries += 1
    existing.tokens += usageTotal(entry.usage)
    existing.costRmb += entryCostRmb(entry)
    existing.lastAt = Math.max(existing.lastAt, entry.at)
  }
  if (activeChatId !== null) {
    const tracked = map.get(activeChatId)
    if (tracked !== undefined) {
      tracked.tokens = Math.max(tracked.tokens, activeTokens)
    } else if (activeTokens > 0) {
      // First turn of a brand-new chat: register it at the top immediately,
      // before the asynchronous ledger poll lands.
      map.set(activeChatId, {
        sessionId: activeChatId,
        title: null,
        entries: 0,
        tokens: activeTokens,
        costRmb: 0,
        lastAt: Date.now(),
      })
    }
  }
  return Array.from(map.values())
    .filter((option) => option.entries > 0 || option.tokens > 0)
    .sort((left, right) => right.lastAt - left.lastAt)
}

/**
 * Live `tokenUsage` / `modelSelection` for exactly one chat, read at the root
 * scope where no Session-scoped `useProjection` exists. The retained
 * generation exposes an identity-stable face per projection key, so this
 * follows the active chat's stream without the plugin holding the conversation
 * open.
 */
function useLiveSessionUsage(ctx: Context | null, sessionId: string | null): {
  usage: TokenUsage | null
  models: LiveModelInfo
} {
  const [state, setState] = useState<{ usage: TokenUsage | null; models: LiveModelInfo }>({
    usage: null,
    models: EMPTY_MODELS,
  })

  useEffect(() => {
    setState({ usage: null, models: EMPTY_MODELS })
    if (ctx === null || sessionId === null) return
    const sessions = (ctx as unknown as { sessions?: any }).sessions
    if (sessions === undefined || typeof sessions.retain !== 'function') return

    let cancelled = false
    let subscribed = false
    let reference: any = null
    const disposers: Array<() => void> = []

    const read = (): void => {
      if (cancelled || subscribed) return
      try {
        const session = reference.binding.session
        const usageFace = session.projections.faceOf('tokenUsage')
        const modelFace = session.projections.faceOf('modelSelection')
        subscribed = true
        const publish = (): void => {
          if (cancelled) return
          try {
            setState({
              usage: normalizeUsage(usageFace.getSnapshot()),
              models: liveModelInfo(modelFace.getSnapshot()),
            })
          } catch {
            /* a torn-down generation must never break the panel */
          }
        }
        publish()
        if (typeof usageFace.subscribe === 'function') disposers.push(usageFace.subscribe(publish))
        if (typeof modelFace.subscribe === 'function') disposers.push(modelFace.subscribe(publish))
      } catch {
        /* projections appear once the retained generation opens */
      }
    }

    try {
      reference = sessions.retain(sessionId, { source: 'usagePopup' })
      read()
      const ready = reference.ready
      if (ready !== undefined && typeof ready.then === 'function') {
        ready.then(read).catch(() => undefined)
      }
    } catch {
      /* unknown session on this surface: fall back to ledger rows */
    }

    return () => {
      cancelled = true
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
      try {
        reference?.release?.()
      } catch {
        /* already released */
      }
    }
  }, [ctx, sessionId])

  return state
}

// ---------------------------------------------------------------------------
// Session / chat selector (rendered in the Session tab)
// ---------------------------------------------------------------------------

const chatSelectRootStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  flex: '0 1 auto',
}

const chatSelectButtonStyle = (open: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  maxWidth: 232,
  padding: '2px 8px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
  borderRadius: 8,
  background: open
    ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.18))'
    : 'transparent',
  color: 'var(--dsw-alias-label-primary, inherit)',
  font: 'inherit',
  fontSize: 11,
  lineHeight: '18px',
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'left',
})

const chatSelectTitleStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const chatSelectChevronStyle: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 9,
  opacity: 0.6,
}

const chatSelectDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  flex: '0 0 auto',
  borderRadius: 999,
  background: 'var(--dsw-alias-state-success-primary, #3fb950)',
}

const chatSelectMenuStyle: CSSProperties = {
  zIndex: HUD_Z_INDEX + 1,
  width: 320,
  maxHeight: 300,
  overflowY: 'auto',
  padding: 4,
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-overlay, Canvas)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  boxShadow: '0 10px 28px rgba(0,0,0,.4)',
}

const chatSelectRowStyle = (selected: boolean): CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  columnGap: 8,
  rowGap: 1,
  width: '100%',
  padding: '6px 8px',
  border: 0,
  borderRadius: 7,
  background: selected
    ? 'rgba(126, 224, 189, 0.14)'
    : 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 11,
  lineHeight: '16px',
  textAlign: 'left',
  cursor: 'pointer',
})

const currentChatPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
  borderRadius: 999,
  background: 'rgba(126, 224, 189, 0.12)',
  color: '#7ee0bd',
  font: 'inherit',
  fontSize: 10,
  lineHeight: '16px',
  fontWeight: 650,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

function chatOptionTitle(option: ChatOption): string {
  if (option.title !== null && option.title.length > 0) return option.title
  if (option.sessionId.length > 0) return `Chat ${option.sessionId.slice(0, 8)}`
  return 'Untitled chat'
}

function chatOptionAge(lastAt: number): string {
  const delta = Date.now() - lastAt
  if (!Number.isFinite(delta) || delta <= 0) return 'just now'
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
  return `${Math.round(delta / 86_400_000)}d ago`
}

function ChatSelect({
  options,
  value,
  onChange,
}: {
  options: ChatOption[]
  value: string | null
  onChange: (sessionId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const selected = options.find((option) => option.sessionId === value) ?? null

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) === true) return
      if (buttonRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect !== undefined) {
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, rect.left),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - 320 - VIEWPORT_MARGIN),
      )
      setAnchor({ left, top: rect.bottom + 4, width: rect.width })
    }
    setOpen(true)
  }

  return (
    <div style={chatSelectRootStyle}>
      <button
        ref={buttonRef}
        type="button"
        style={chatSelectButtonStyle(open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select a chat stored in the ledger"
        title={
          selected === null
            ? 'Select a chat stored in the ledger'
            : `${chatOptionTitle(selected)} · ${selected.entries.toLocaleString()} entries`
        }
        onClick={toggle}
        data-usage-hud-no-drag=""
      >
        <span aria-hidden="true" style={chatSelectDotStyle} />
        <span style={chatSelectTitleStyle}>
          {selected === null ? 'Select chat' : chatOptionTitle(selected)}
        </span>
        <span aria-hidden="true" style={chatSelectChevronStyle}>
          ▾
        </span>
      </button>

      {open &&
        anchor !== null &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Chats stored in the ledger"
            data-usage-hud-no-drag=""
            style={{ ...chatSelectMenuStyle, position: 'fixed', left: anchor.left, top: anchor.top }}
          >
            {options.length === 0 ? (
              <div style={{ ...tinyHintStyle, padding: '6px 8px' }}>
                No recorded chats yet.
              </div>
            ) : (
              options.map((option) => (
                <button
                  key={option.sessionId}
                  type="button"
                  role="option"
                  aria-selected={option.sessionId === value}
                  style={chatSelectRowStyle(option.sessionId === value)}
                  onClick={() => {
                    onChange(option.sessionId)
                    setOpen(false)
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.18))'
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background =
                      option.sessionId === value ? 'rgba(126, 224, 189, 0.14)' : 'transparent'
                  }}
                >
                  <span style={chatSelectTitleStyle}>{chatOptionTitle(option)}</span>
                  <span style={{ ...countdownStyle, textAlign: 'right' }}>
                    {option.entries.toLocaleString()} ent · {compactCount(option.tokens)} tok
                  </span>
                  <span style={{ ...countdownStyle, opacity: 0.55 }}>
                    {yuan(option.costRmb)} · {chatOptionAge(option.lastAt)}
                  </span>
                  <span style={{ ...countdownStyle, textAlign: 'right', opacity: 0.55 }}>
                    {option.sessionId.slice(0, 8)}
                  </span>
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}


function LedgerHud(
  props: PropsRuntime<'shell.overlay'> & { controller: LedgerController; open: boolean },
) {
  const { useSessions, usePanelInfo, controller, open } = props

  // The app's active chat. `mainView` is the retention source the workspace
  // tree and its shortcuts use to identify the selected Session; a blank New
  // Session draft is not a chat yet. A global panel (Plugins, Automation
  // tasks, Memory System, ...) hides the conversation entirely, so there is no
  // active chat to follow there even though a Session stays retained.
  const panelId = usePanelInfo((info) => info.activePanelId)
  const mainViewChatId = useSessions((list) => {
    for (const id of Object.keys(list.byId)) {
      const row = list.byId[id as keyof typeof list.byId]
      if (row !== undefined && row.blank !== true && (row.retainedBy.mainView ?? 0) > 0) return id
    }
    return null
  })
  const activeChatId = panelId === null ? mainViewChatId : null

  // Live projection of exactly the followed chat. Historical chats are read
  // from the ledger instead (below), which is already per-session.
  const live = useLiveSessionUsage(controller.ctx, activeChatId)
  // Manual override: a historical chat chosen from the Session dropdown.
  const [lockedChatId, setLockedChatId] = useState<string | null>(null)

  // Opening the ledger always resumes live tracking, even if the previous
  // visit ended on a historical chat.
  useEffect(() => {
    if (open) setLockedChatId(null)
  }, [open])

  // The host's window caption band (Windows only) must never be part of the
  // draggable area. Recomputed on render so a fullscreen toggle recovers.
  const topInset = hudTopInset()

  const [minimized, setMinimized] = useState(() => readStoredFlag(MINIMIZED_KEY, false))
  const [panel, setPanel] = useState<'usage' | 'saver'>('usage')
  // Local per-model / per-session token counters fetched from the tier router.
  // `null` means the router is absent or has not recorded a call yet.
  const [routedUsage, setRoutedUsage] = useState<RoutedUsageSnapshot | null>(null)
  const [position, setPosition] = useState<HudPosition>(() => initialPosition(topInset))
  const [dragging, setDragging] = useState(false)
  const [timeframe, setTimeframe] = useState<Timeframe>(() =>
    readStoredChoice(
      TIMEFRAME_KEY,
      ['session', 'day', 'week', 'month', 'custom'] as const,
      'session',
    ),
  )
  const [customStart, setCustomStart] = useState(() =>
    readStoredText(CUSTOM_START_KEY, localDateKey(Date.now() - 6 * DAY_MS)),
  )
  const [customEnd, setCustomEnd] = useState(() =>
    readStoredText(CUSTOM_END_KEY, localDateKey(Date.now())),
  )
  const [runwayDraft, setRunwayDraft] = useState(() =>
    String(readStoredNumber(TARGET_RUNWAY_KEY, DEFAULT_TARGET_RUNWAY_DAYS)),
  )
  // Drives the live peak/off-peak countdown, the calendar boundaries and the
  // "synced Nm ago" label.
  const [nowMs, setNowMs] = useState(() => Date.now())
  // DOM fallbacks for hosts whose model/session/title projections are absent.
  const [domModel, setDomModel] = useState<ModelId | null>(null)
  const [domSessionId, setDomSessionId] = useState<string | null>(null)
  const [domSessionTitle, setDomSessionTitle] = useState<{
    sessionKey: string | null
    title: string | null
  }>({ sessionKey: null, title: null })

  // The universal ledger database. `ledgerRef` mirrors the state so a rapid
  // sequence of projection updates can never race a React state write.
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>(() =>
    readLedgerDatabase(),
  )
  const ledgerRef = useRef<LedgerEntry[]>(ledgerEntries)

  const [balanceMeta, setBalanceMeta] = useState<BalanceMeta | null>(() => readBalanceMeta())
  const [balanceHistory, setBalanceHistory] = useState<BalancePoint[]>(() => {
    const stored = readBalanceHistory()
    if (stored.length > 0) return stored
    const meta = readBalanceMeta()
    return meta === null ? [] : [{ at: meta.syncedAt, balanceRmb: meta.balanceRmb }]
  })
  const [apiKey, setApiKey] = useState<string>(() => readApiKey())
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [keyEditorOpen, setKeyEditorOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  const [dataMessage, setDataMessage] = useState<string | null>(null)
  // Host-collector probe state. `pending` on mount (first poll has not settled)
  // and `active` both suppress the projection diff; only a confirmed-absent host
  // half (`inactive`) lets the projection write ledger rows.
  const [hostProbe, setHostProbe] = useState<HostProbeState>('pending')

  const hudRef = useRef<HTMLDivElement | null>(null)
  const positionRef = useRef<HudPosition>(position)
  const dragRef = useRef<DragState | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const syncInFlightRef = useRef(false)
  const lastSyncAttemptRef = useRef(0)
  const hostPollInFlightRef = useRef(false)

  const activeTotalLive = live.usage === null ? 0 : usageTotal(live.usage)
  // Every chat stored in the ledger, newest activity first. A live chat with a
  // first turn but no ledger row yet (host poll is asynchronous) is inserted at
  // the top immediately; unstarted drafts with no turns never enter the list.
  const chatOptions = useMemo(
    () => buildChatOptions(ledgerEntries, activeChatId, activeTotalLive),
    [ledgerEntries, activeChatId, activeTotalLive],
  )
  const fallbackChatId = chatOptions.length > 0 ? chatOptions[0].sessionId : null
  // Auto target: the chat the app has open, else the most recently active one
  // in the ledger (New Session, Plugins, Automation tasks, Memory System, ...).
  const autoChatId = activeChatId ?? fallbackChatId
  // Priority: manual lock → auto target → DOM fallback.
  const sessionKey = lockedChatId ?? autoChatId ?? domSessionId
  // A lock that points at the auto target is not an override; it is the same
  // live chat, so no "Current chat" snap-back pill is needed.
  const manualOverride = lockedChatId !== null && lockedChatId !== autoChatId
  const followingChat = sessionKey !== null && sessionKey === activeChatId
  // Only the followed chat may show the live projection; a historical chat is
  // a pure ledger slice so its numbers never borrow the open chat's tokens.
  const usage = followingChat ? live.usage : null
  const models = followingChat ? live.models : EMPTY_MODELS

  const currentModel: ModelId | null = followingChat ? (models.selected ?? domModel) : null

  const selectedRowTitle = useSessions((list) =>
    sessionKey === null
      ? null
      : (list.byId[sessionKey as keyof typeof list.byId]?.displayTitle ?? null),
  )
  const chatOption = chatOptions.find((option) => option.sessionId === sessionKey)
  const runtimeTitle = followingChat
    ? runtimeSessionTitle(props as unknown as Record<string, unknown>)
    : null
  const sessionTitle =
    runtimeTitle ??
    chatOption?.title ??
    (selectedRowTitle !== null && selectedRowTitle !== sessionKey ? selectedRowTitle : null) ??
    (domSessionTitle.sessionKey === sessionKey ? domSessionTitle.title : null) ??
    (sessionKey === null ? 'No active chat' : `Chat ${sessionKey.slice(0, 8)}`)

  // Durable title of the chat the app has open, used for the anchor and for
  // the ledger rows the projection path writes. It is independent of the
  // Session-tab selection.
  const activeRowTitle = useSessions((list) =>
    activeChatId === null
      ? null
      : (list.byId[activeChatId as keyof typeof list.byId]?.displayTitle ?? null),
  )
  const activeChatOption = chatOptions.find((option) => option.sessionId === activeChatId)
  const activeChatTitle =
    activeChatId === null
      ? 'No active chat'
      : activeRowTitle !== null && activeRowTitle !== activeChatId
        ? activeRowTitle
        : (activeChatOption?.title ?? `Chat ${activeChatId.slice(0, 8)}`)

  const activeTotal = usage === null ? 0 : usageTotal(usage)
  const naturalPeak = isPeakUtc(new Date(nowMs))

  const targetRunwayDays = useMemo(() => {
    const parsed = Number(runwayDraft)
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TARGET_RUNWAY_DAYS
    return Math.min(MAX_TARGET_RUNWAY_DAYS, parsed)
  }, [runwayDraft])

  const dayStart = startOfLocalDay(nowMs)
  const dayEnd = startOfNextLocalDay(nowMs)
  const weekStart = startOfLocalWeek(nowMs)
  const monthStart = startOfLocalMonth(nowMs)

  const customStartMs = parseLocalDate(customStart)
  const customEndMs = parseLocalDate(customEnd)
  const customEndExclusive =
    customEndMs === null ? null : startOfNextLocalDay(customEndMs)

  /**
   * THE single aggregation point for the whole HUD.
   *
   * The Session tab is the only session-scoped view: it filters by
   * `entry.sessionId`. Day / Week / Month / Custom NEVER read `sessionId` — they
   * only test `entry.at`, so they sum every row in
   * `usage-popup.universal-ledger.v2` across all chats. Custom is a pure date
   * range as well; there is no hidden "active chat" narrowing anywhere in this
   * function. Any future predicate added here must be time-based only.
   */
  const selectedEntries = useMemo(() => {
    if (timeframe === 'session') {
      if (sessionKey === null) return []
      return ledgerEntries.filter((entry) => entry.sessionId === sessionKey)
    }
    if (timeframe === 'day') {
      return ledgerEntries.filter((entry) => entry.at >= dayStart && entry.at < dayEnd)
    }
    if (timeframe === 'week') {
      return ledgerEntries.filter((entry) => entry.at >= weekStart)
    }
    if (timeframe === 'month') {
      return ledgerEntries.filter((entry) => entry.at >= monthStart)
    }
    // Custom: inclusive local calendar dates, global across every chat.
    if (customStartMs === null || customEndExclusive === null) return []
    return ledgerEntries.filter(
      (entry) => entry.at >= customStartMs && entry.at < customEndExclusive,
    )
  }, [
    ledgerEntries,
    timeframe,
    sessionKey,
    dayStart,
    dayEnd,
    weekStart,
    monthStart,
    customStartMs,
    customEndExclusive,
  ])

  /** True when the active tab must not be scoped to the open chat. */
  const isGlobalScope = timeframe !== 'session'

  const selectedLedgerUsage = useMemo(() => sumUsage(selectedEntries), [selectedEntries])
  // The Session view shows the host's cumulative projection so tokens earned
  // before this plugin first anchored the chat are still visible. Other views
  // are pure ledger slices (incremental deltas only).
  const displayedUsage: TokenUsage =
    timeframe === 'session' && usage !== null && usageTotal(usage) > 0
      ? usage
      : selectedLedgerUsage
  const displayedTotal = usageTotal(displayedUsage)
  const contextBloat = timeframe === 'session' && displayedTotal > CONTEXT_BLOAT_TOKENS
  const untrackedTokens =
    timeframe === 'session' ? Math.max(0, activeTotal - usageTotal(selectedLedgerUsage)) : 0
  const hitRatio = (() => {
    const input = displayedUsage.uncachedInputTokens + displayedUsage.cacheReadTokens
    return input > 0 ? displayedUsage.cacheReadTokens / input : null
  })()

  const trueSelectedCost = useMemo(
    () => selectedEntries.reduce((sum, entry) => sum + entryCostRmb(entry), 0),
    [selectedEntries],
  )
  const displaySavings = useMemo(
    () =>
      selectedEntries.reduce(
        (sum, entry) => sum + cacheSavingsRmb(entry.usage, entry.model, entry.tier === 'peak'),
        0,
      ),
    [selectedEntries],
  )

  const modelTokens = useMemo(() => {
    const totals: Record<ModelClass, number> = {
      flash: 0,
      pro: 0,
      search: 0,
      unattributed: 0,
    }
    for (const entry of selectedEntries) totals[entry.model] += usageTotal(entry.usage)
    return totals
  }, [selectedEntries])

  const modelRows = useMemo<ModelRow[]>(() => {
    const costs: Record<ModelClass, number> = {
      flash: 0,
      pro: 0,
      search: 0,
      unattributed: 0,
    }
    for (const entry of selectedEntries) costs[entry.model] += entryCostRmb(entry)
    const total =
      costs.flash + costs.pro + costs.search + costs.unattributed > 0
        ? costs.flash + costs.pro + costs.search + costs.unattributed
        : trueSelectedCost
    const ids: ModelClass[] = ['flash', 'pro', 'search', 'unattributed']
    return ids.map((id) => ({
      id,
      label: MODEL_LABELS[id],
      color: MODEL_COLORS[id],
      tokens: modelTokens[id],
      costRmb: costs[id],
      share: total > 0 ? costs[id] / total : 0,
    }))
  }, [modelTokens, selectedEntries, trueSelectedCost])

  // Actual routes that answered this session (DeepSeek + any fetch-boy route).
  // Only available when the patched tier router is loaded; otherwise the
  // DeepSeek ledger breakdown above is the fallback.
  const routedTier = peakTier(naturalPeak)
  const routedRows = useMemo<RoutedModelRow[] | null>(() => {
    if (routedUsage === null || sessionKey === null) return null
    const session = routedUsage.sessions[sessionKey]
    if (session === undefined) return null
    const rows = routedRowsOf(session.byModel, routedTier)
    return rows.length > 0 ? rows : null
  }, [routedUsage, sessionKey, routedTier])
  const routedSessionTokens = useMemo(
    () => (routedRows === null ? 0 : routedRows.reduce((sum, row) => sum + row.tokens, 0)),
    [routedRows],
  )
  const workerRows = useMemo<RoutedModelRow[]>(
    () => (routedUsage === null ? [] : routedRowsOf(routedUsage.workers, routedTier)),
    [routedUsage, routedTier],
  )
  const workerTokens = useMemo(
    () => workerRows.reduce((sum, row) => sum + row.tokens, 0),
    [workerRows],
  )

  const flashUsed = modelTokens.flash > 0
  const proUsed = modelTokens.pro > 0
  const usedLabel: 'Mixed' | 'Flash' | 'Pro' | null =
    flashUsed && proUsed ? 'Mixed' : proUsed ? 'Pro' : flashUsed ? 'Flash' : null
  const liveLabel =
    usedLabel ?? (currentModel === 'pro' ? 'Pro' : currentModel === 'flash' ? 'Flash' : null)
  const badgeText = `${followingChat ? 'Live' : 'History'} · ${liveLabel ?? '—'}`
  const badgeTitle =
    `True tracked cost. Flash ${exactCount(modelTokens.flash)} tok · Pro ${exactCount(
      modelTokens.pro,
    )} tok. Each delta is priced at the model and UTC peak/off-peak tier active when it arrived.`


  const liveSessionCost = useMemo(
    () =>
      ledgerEntries.reduce(
        (sum, entry) => (entry.sessionId === sessionKey ? sum + entryCostRmb(entry) : sum),
        0,
      ),
    [ledgerEntries, sessionKey],
  )

  const todaySpend = useMemo(
    () =>
      ledgerEntries.reduce(
        (sum, entry) =>
          entry.at >= dayStart && entry.at < dayEnd ? sum + entryCostRmb(entry) : sum,
        0,
      ),
    [ledgerEntries, dayStart, dayEnd],
  )

  const trueBalance = balanceMeta === null ? null : balanceMeta.balanceRmb

  // Trailing burn is normalised by the real span it covers, so a brand-new
  // ledger does not report a 1/7th-of-reality burn rate.
  const burnTelemetry = useMemo(() => {
    const floor = nowMs - 7 * DAY_MS
    let spend = 0
    let oldest = nowMs
    for (const entry of ledgerEntries) {
      if (entry.at < floor) continue
      spend += entryCostRmb(entry)
      if (entry.at < oldest) oldest = entry.at
    }
    const spanDays = Math.min(7, Math.max(1, (nowMs - oldest) / DAY_MS))
    return { spend, spanDays, averageDailySpend: spend / spanDays }
  }, [ledgerEntries, nowMs])
  const averageDailySpend = burnTelemetry.averageDailySpend

  const runwayDays =
    trueBalance === null
      ? null
      : trueBalance <= 0
        ? 0
        : averageDailySpend <= 0
          ? Number.POSITIVE_INFINITY
          : trueBalance / averageDailySpend
  const runwayLabel =
    runwayDays === null
      ? '—'
      : runwayDays === Number.POSITIVE_INFINITY
        ? 'no burn'
        : runwayDays <= 0
          ? 'empty'
          : runwayDays < 1
            ? `${Math.max(1, Math.round(runwayDays * 24))}h`
            : runwayDays >= 100
              ? '99+ d'
              : `${runwayDays.toFixed(runwayDays < 10 ? 1 : 0)} d`

  // A1: when the API key is present the balance movement is the primary cost
  // number. The ledger is still shown explicitly, but never claims to be the
  // primary spend when measured samples exist. Computed before the budget gauge
  // so "today" means the same thing in the Today card and the runway gauge.
  const apiSpendToday = useMemo(
    () => apiSpendInWindow(balanceHistory, trueBalance, dayStart, nowMs),
    [balanceHistory, trueBalance, dayStart, nowMs],
  )
  const todayApiSpend = apiSpendToday !== null && apiKey.length > 0 ? apiSpendToday : null
  const todayBudgetSpend = todayApiSpend ?? todaySpend

  // Dynamic daily budget: the true API balance spread across the target runway.
  const dailyTargetBudget =
    trueBalance !== null && targetRunwayDays > 0 ? trueBalance / targetRunwayDays : null
  const budgetRatio =
    dailyTargetBudget === null
      ? null
      : dailyTargetBudget > 0
        ? todayBudgetSpend / dailyTargetBudget
        : todayBudgetSpend > 0
          ? Number.POSITIVE_INFINITY
          : 0
  const budgetPercentLabel =
    budgetRatio === null
      ? '—'
      : Number.isFinite(budgetRatio)
        ? percent(budgetRatio)
        : '∞'

  const balanceSampledAt = balanceMeta === null ? null : balanceMeta.syncedAt
  const postSyncSpend = useMemo(
    () =>
      balanceSampledAt === null
        ? 0
        : ledgerEntries.reduce(
            (sum, entry) => (entry.at >= balanceSampledAt ? sum + entryCostRmb(entry) : sum),
            0,
          ),
    [ledgerEntries, balanceSampledAt],
  )

  const periodWindowStart = useMemo(() => {
    if (timeframe === 'day') return dayStart
    if (timeframe === 'week') return weekStart
    if (timeframe === 'month') return monthStart
    if (timeframe === 'custom') return customStartMs
    if (timeframe === 'session') {
      let oldest: number | null = null
      for (const entry of selectedEntries) {
        if (oldest === null || entry.at < oldest) oldest = entry.at
      }
      return oldest
    }
    return null
  }, [timeframe, dayStart, weekStart, monthStart, customStartMs, selectedEntries])

  // "True period spend" is the API's own balance movement, not local math.
  const apiPeriodSpend = useMemo(
    () => apiSpendInWindow(balanceHistory, trueBalance, periodWindowStart, nowMs),
    [balanceHistory, trueBalance, periodWindowStart, nowMs],
  )
  const ledgerPeriodSpend = trueSelectedCost
  const periodSpendIsEstimate = apiPeriodSpend === null
  const periodSpendLabel =
    apiPeriodSpend === null
      ? ledgerPeriodSpend > 0
        ? `≈ ${yuan(ledgerPeriodSpend)}`
        : '—'
      : yuan(apiPeriodSpend)
  const reconciliationDrift =
    apiPeriodSpend === null ? null : apiPeriodSpend - ledgerPeriodSpend

  // A1: when the API key is present the balance movement is the primary cost
  // number. The ledger is still shown explicitly, but never claims to be the
  // primary spend when measured samples exist.
  const primaryUsesApi = apiPeriodSpend !== null && apiKey.length > 0
  const primaryPeriodCost =
    primaryUsesApi && apiPeriodSpend !== null ? apiPeriodSpend : trueSelectedCost
  const primaryPeriodLabel = primaryUsesApi ? 'API balance Δ' : 'ledger estimate'
  const todayDisplaySpend = todayApiSpend ?? todaySpend

  // Exact recorded-call metrics replace the old ~600-tokens-per-turn guess.
  const recordedCalls = useMemo(
    () =>
      selectedEntries.reduce(
        (sum, entry) => sum + (typeof entry.calls === 'number' ? entry.calls : 1),
        0,
      ),
    [selectedEntries],
  )
  const burnPerCall =
    selectedEntries.length === 0 || recordedCalls <= 0
      ? null
      : primaryPeriodCost / Math.max(1, recordedCalls)

  // Subagent / background / compaction share of the selected window. These
  // calls are often invisible in the projection, so surface them explicitly.
  const delegatedSummary = useMemo(() => {
    let tokens = 0
    let costRmb = 0
    let calls = 0
    let entries = 0
    for (const entry of selectedEntries) {
      if (
        entry.sessionType !== 'subagent' &&
        entry.sessionType !== 'background' &&
        entry.sessionType !== 'compaction'
      ) {
        continue
      }
      entries += 1
      tokens += usageTotal(entry.usage)
      costRmb += entryCostRmb(entry)
      calls += typeof entry.calls === 'number' && entry.calls > 0 ? entry.calls : 1
    }
    return { entries, tokens, costRmb, calls }
  }, [selectedEntries])

  const elapsedDays = useMemo(() => {
    if (periodWindowStart === null) return 1
    return Math.max(1 / 24, (nowMs - periodWindowStart) / DAY_MS)
  }, [periodWindowStart, nowMs])

  const nextSwitch = useMemo(() => nextRateSwitch(nowMs), [nowMs])
  const countdown = formatClockCountdown(nextSwitch.at - nowMs)
  const countdownLabel = `${nextSwitch.tier === 'peak' ? 'Peak' : 'Off-Peak'} in ${countdown}`

  const timeframeLabel =
    timeframe === 'session'
      ? 'Session'
      : timeframe === 'day'
        ? 'Today'
        : timeframe === 'week'
          ? 'This week'
          : timeframe === 'month'
            ? 'This month'
            : 'Custom range'

  const syncStatusColor = syncing
    ? 'var(--dsw-alias-state-success-primary, #3fb950)'
    : syncError !== null
      ? 'var(--dsw-alias-state-danger-primary, #f85149)'
      : balanceMeta === null
        ? 'var(--dsw-alias-state-idle-primary, GrayText)'
        : nowMs - balanceMeta.syncedAt > BALANCE_REFRESH_MS * 2
          ? 'var(--dsw-alias-state-warning-primary, #d29922)'
          : 'var(--dsw-alias-state-success-primary, #3fb950)'
  const syncStatusLabel =
    apiKey.length === 0
      ? 'auto-sync off'
      : syncing
        ? 'syncing…'
        : syncError !== null
          ? 'sync error'
          : balanceMeta === null
            ? 'waiting for first sync'
            : `synced ${formatAgo(nowMs - balanceMeta.syncedAt)}`

  // --- persistence effects --------------------------------------------------

  useEffect(() => {
    writeStored(MINIMIZED_KEY, minimized ? '1' : '0')
  }, [minimized])

  useEffect(() => {
    writeStored(TIMEFRAME_KEY, timeframe)
  }, [timeframe])

  useEffect(() => {
    writeStored(CUSTOM_START_KEY, customStart)
  }, [customStart])

  useEffect(() => {
    writeStored(CUSTOM_END_KEY, customEnd)
  }, [customEnd])

  useEffect(() => {
    writeStored(TARGET_RUNWAY_KEY, String(targetRunwayDays))
  }, [targetRunwayDays])

  // Poll the tier router's LOCAL per-model counters. The router only records
  // what its adapters reported, so this works for Google/Z.ai routes too with
  // no provider API. Failure is non-fatal: the DeepSeek ledger breakdown stays.
  useEffect(() => {
    if (!open || minimized || panel !== 'usage') return
    let cancelled = false
    let timer = 0
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(ROUTER_USAGE_ENDPOINT, {
          headers: { accept: 'application/json' },
        })
        if (response.ok) {
          const payload: unknown = await response.json()
          const record =
            typeof payload === 'object' && payload !== null
              ? (payload as Record<string, unknown>)
              : {}
          const normalized = normalizeRoutedUsage(record.usage)
          if (!cancelled) setRoutedUsage(normalized)
        }
      } catch {
        // Router absent or still booting; keep the last snapshot.
      }
      if (!cancelled) timer = window.setTimeout(() => void load(), ROUTER_USAGE_REFRESH_MS)
    }
    void load()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, minimized, panel, sessionKey])

  // Fold any legacy per-session ledgers into the global database once on mount.
  useEffect(() => {
    const database = mergeLedger(ledgerRef.current, migrateLegacyLedgers())
    ledgerRef.current = database
    setLedgerEntries(database)
    notifyLedgerChanged()
  }, [])

  // Poll the host collector once at mount and then every 10s. Its records are
  // authoritative (subagents, background turns and server tools included).
  // Probe state machine: `pending` until the first poll settles; a valid 200
  // means `active` (stays active, no TTL); a 404 or format mismatch means
  // `inactive` (projection fallback); network errors/timeouts keep the previous
  // state. The effect is mount-only so no dependency can cause re-probing.
  useEffect(() => {
    let cancelled = false
    let timer = 0
    const settle = (next: HostProbeState): void => {
      if (!cancelled) setHostProbe(next)
    }
    const poll = async (): Promise<void> => {
      if (hostPollInFlightRef.current) return
      hostPollInFlightRef.current = true
      const storedCursor = readStoredNumber(HOST_CURSOR_KEY, 0)
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), HOST_FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(`${HOST_USAGE_ENDPOINT}?since=${storedCursor}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        })
        if (response.status === 404) {
          // The host half is not installed on this surface: project locally.
          settle('inactive')
          return
        }
        // Any other non-2xx is transient; keep the previous probe state and retry.
        if (!response.ok) return
        const payload: unknown = await response.json()
        if (
          !isRecord(payload) ||
          payload.format !== 'usage-popup.host-usage' ||
          payload.version !== 1 ||
          !Array.isArray(payload.records) ||
          typeof payload.cursor !== 'number'
        ) {
          settle('inactive')
          return
        }
        const entries = entriesForHostRecords(payload.records, readSessionIndex())
        const reset = hostCursorWasReset(payload.cursor, storedCursor, payload.reset)
        if (entries.length > 0 || reset) {
          const merged = mergeLedger(
            mergeLedger(ledgerRef.current, readLedgerDatabase()),
            entries,
          )
          writeUniversalLedger(merged)
          ledgerRef.current = merged
          if (!cancelled) setLedgerEntries(merged)
          notifyLedgerChanged()
        }
        writeStored(HOST_CURSOR_KEY, String(payload.cursor))
        settle('active')
      } catch {
        // Network error or timeout: keep the previous state (never flip to
        // inactive, which would re-enable projection and double count).
      } finally {
        window.clearTimeout(timeout)
        hostPollInFlightRef.current = false
      }
    }
    void poll()
    timer = window.setInterval(() => void poll(), HOST_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  // Seed the balance history from the last persisted sync. Without this the
  // first new 5-minute sample would replace the only point we have, making the
  // API-measured period spend unavailable until two more syncs have passed.
  useEffect(() => {
    const meta = readBalanceMeta()
    if (meta === null) return
    if (readBalanceHistory().length > 0) return
    writeBalanceHistory([{ at: meta.syncedAt, balanceRmb: meta.balanceRmb }])
  }, [])

  // Keep every HUD instance and tab on the same database, balance and key.
  useEffect(() => {
    const refreshLedger = (): void => {
      try {
        // Distinguish "storage unavailable" from "legitimately empty": a
        // throwing read must not blank the in-memory ledger.
        window.localStorage.getItem(UNIVERSAL_LEDGER_KEY)
      } catch {
        return
      }
      const next = readLedgerDatabase()
      ledgerRef.current = next
      setLedgerEntries(next)
    }
    const refreshBalance = (): void => {
      setBalanceMeta(readBalanceMeta())
      setBalanceHistory(readBalanceHistory())
      setApiKey(readApiKey())
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || /ledger/i.test(event.key)) refreshLedger()
      else if (
        event.key === BALANCE_KEY ||
        event.key === BALANCE_HISTORY_KEY ||
        event.key === API_KEY_KEY
      ) {
        refreshBalance()
      }
    }
    const onLocalLedger = (): void => refreshLedger()
    window.addEventListener('storage', onStorage)
    window.addEventListener(LEDGER_EVENT, onLocalLedger)
    const channel = ledgerChannel()
    channel?.addEventListener('message', onLocalLedger)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(LEDGER_EVENT, onLocalLedger)
      channel?.removeEventListener('message', onLocalLedger)
    }
  }, [])

  // --- true delta attribution ----------------------------------------------

  // Runs on every cumulative usage change of the ACTIVE chat; a zero or
  // negative delta only resyncs the anchor (and never invents a refund).
  // Anchors are re-read from storage before every write so sibling HUD
  // instances cannot clobber them. Selecting a historical chat in the Session
  // tab never changes what is tracked here: the live chat keeps recording while
  // the user reads the past.
  useEffect(() => {
    if (activeChatId === null || live.usage === null) return

    const anchors = readAnchors()
    const anchor = anchors[activeChatId]
    const attributed = live.models.used ?? live.models.selected ?? anchor?.lastModel ?? 'flash'

    const saveAnchor = (next: SessionAnchor): void => {
      anchors[next.sessionId] = next
      writeAnchors(anchors)
    }

    // While the host collector is live (or its first probe is still pending) it
    // records every call for this session (including subagent traffic the
    // projection never surfaces). Keep the anchor in sync silently — writing a
    // ledger row here would double-count — so a later host outage resumes
    // cleanly from the current totals.
    if (resolveProjectionMode(hostProbe) === 'skip') {
      if (
        anchor === undefined ||
        !sameUsage(live.usage, anchor.lastUsage) ||
        anchor.lastModel !== attributed ||
        anchor.sessionTitle !== activeChatTitle
      ) {
        saveAnchor({
          sessionId: activeChatId,
          sessionTitle: activeChatTitle,
          lastUsage: live.usage,
          lastModel: attributed,
          updatedAt: Date.now(),
        })
      }
      return
    }

    if (anchor === undefined) {
      // First sight of this Session: anchor at the current totals, record no
      // cost. Everything after this point is a true incremental delta.
      saveAnchor({
        sessionId: activeChatId,
        sessionTitle: activeChatTitle,
        lastUsage: live.usage,
        lastModel: attributed,
        updatedAt: Date.now(),
      })
      return
    }

    const delta = usageDelta(live.usage, anchor.lastUsage)
    const titleChanged = anchor.sessionTitle !== activeChatTitle

    // A reload/reset can make the cumulative projection briefly report less
    // than the anchor. Lowering the anchor here would re-bill every token when
    // the real total comes back, so keep the high-water mark instead.
    if (usageTotal(live.usage) < usageTotal(anchor.lastUsage)) {
      if (anchor.sessionTitle !== activeChatTitle || anchor.lastModel !== attributed) {
        saveAnchor({
          ...anchor,
          sessionTitle: activeChatTitle,
          lastModel: attributed,
          updatedAt: Date.now(),
        })
      }
      return
    }

    if (isZeroUsage(delta)) {
      if (
        !sameUsage(live.usage, anchor.lastUsage) ||
        anchor.lastModel !== attributed ||
        titleChanged
      ) {
        saveAnchor({
          ...anchor,
          sessionTitle: activeChatTitle,
          lastUsage: live.usage,
          lastModel: attributed,
          updatedAt: Date.now(),
        })
        if (titleChanged) {
          const updated = mergeLedger(ledgerRef.current, readLedgerDatabase()).map((entry) =>
            entry.sessionId === activeChatId
              ? { ...entry, sessionTitle: activeChatTitle }
              : entry,
          )
          writeUniversalLedger(updated)
          ledgerRef.current = updated
          setLedgerEntries(updated)
          notifyLedgerChanged()
        }
      }
      return
    }

    const at = Date.now()
    const tier = peakTier(isPeakUtc(new Date(at)))
    const entry: LedgerEntry = {
      id: makeEntryId(),
      sessionId: activeChatId,
      sessionTitle: activeChatTitle,
      date: localDateKey(at),
      model: attributed,
      tier,
      usage: delta,
      costRmb: usageCostRmb(delta, attributed, tier === 'peak'),
      at,
      reasoningTokens: delta.reasoningTokens,
      sessionType: 'main',
      source: 'projection',
    }

    // Merge with a fresh read (and the in-memory copy, in case storage is
    // briefly unavailable) so entries written by another HUD instance or tab
    // between renders are never overwritten.
    const nextEntries = mergeLedger(
      mergeLedger(ledgerRef.current, readLedgerDatabase()),
      [entry],
    )
    writeUniversalLedger(nextEntries)
    ledgerRef.current = nextEntries
    setLedgerEntries(nextEntries)
    notifyLedgerChanged()

    saveAnchor({
      sessionId: activeChatId,
      sessionTitle: activeChatTitle,
      lastUsage: live.usage,
      lastModel: attributed,
      updatedAt: at,
    })
  }, [activeChatId, live.usage, live.models, activeChatTitle, hostProbe])

  // Keep the DOM fallbacks current without reading transcript text: model-seat
  // contributions write data-model-id / data-provider-id and aria-label, and
  // the active session row/header supplies a best-effort id and title.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    let frame = 0
    const refresh = (): void => {
      frame = 0
      const nextModel = modelFromDom()
      setDomModel((previous) => (previous === nextModel ? previous : nextModel))
      const nextSessionId = activeSessionIdFromDom()
      setDomSessionId((previous) => (previous === nextSessionId ? previous : nextSessionId))
      const nextTitle = sessionTitleFromDom(sessionKey)
      setDomSessionTitle((previous) =>
        previous.sessionKey === sessionKey && previous.title === nextTitle
          ? previous
          : { sessionKey, title: nextTitle },
      )
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(refresh)
    }
    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-model-id',
        'data-provider-id',
        'aria-label',
        'title',
        'data-session-title',
        'data-session-id',
        'data-row-key',
        'data-active-session-id',
        'aria-current',
        'aria-selected',
        'data-active',
        'data-state',
      ],
    })
    const timer = window.setInterval(schedule, 1_500)
    return () => {
      observer.disconnect()
      window.clearInterval(timer)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [sessionKey])

  // One-second tick keeps the countdown, budget caption and sync age live.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  // --- automatic true-balance sync -----------------------------------------

  async function syncBalance(keyRaw: string): Promise<void> {
    const key = keyRaw.trim()
    if (key.length === 0) return
    const attemptedAt = Date.now()
    if (attemptedAt - lastSyncAttemptRef.current < 2_000) return
    lastSyncAttemptRef.current = attemptedAt
    if (syncInFlightRef.current) return
    syncInFlightRef.current = true
    setSyncing(true)
    setSyncError(null)

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15_000)

    try {
      const response = await fetch(BALANCE_ENDPOINT, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
        },
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload: unknown = await response.json()
      const infos =
        isRecord(payload) && Array.isArray(payload.balance_infos) ? payload.balance_infos : []
      let cny: Record<string, unknown> | null = null
      for (const candidate of infos) {
        if (!isRecord(candidate)) continue
        if (String(candidate.currency ?? '').toUpperCase() === 'CNY') {
          cny = candidate
          break
        }
      }
      if (cny === null) throw new Error('no CNY balance entry in the response')
      const rawBalance = cny.total_balance
      const balanceRmb =
        typeof rawBalance === 'number' ? rawBalance : Number.parseFloat(String(rawBalance))
      if (!Number.isFinite(balanceRmb)) throw new Error('CNY total_balance was not a number')

      const at = Date.now()
      // Capture the previous sample *before* the new point is appended: it is
      // the baseline for the automatic reconciliation below.
      const previousPoints = readBalanceHistory()
      const prior = previousPoints.filter((point) => point.at < at).slice(-1)[0]
      const points = appendBalancePoint(balanceRmb, at)
      // A2: reconcile the measured balance drop against the ledger for exactly
      // this interval. A gap means subagent / server-tool / background spend
      // that never reached the projection path; record it explicitly. This is
      // best-effort and must never fail the balance sync itself.
      try {
        if (prior !== undefined) {
          const reconciliation = planReconciliation({
            prevBalance: prior.balanceRmb,
            prevAt: prior.at,
            newBalance: balanceRmb,
            nowMs: at,
            entries: readLedgerDatabase(),
          })
          if (reconciliation !== null) {
            const merged = mergeLedger(
              mergeLedger(ledgerRef.current, readLedgerDatabase()),
              [reconciliation],
            )
            writeUniversalLedger(merged)
            ledgerRef.current = merged
            setLedgerEntries(merged)
            notifyLedgerChanged()
          }
        }
      } catch {
        // Reconciliation is an enhancement; a failure must not surface as a
        // sync error.
      }
      const meta: BalanceMeta = { balanceRmb, syncedAt: at, currency: 'CNY' }
      writeStored(BALANCE_KEY, JSON.stringify(meta))
      setBalanceMeta(meta)
      setBalanceHistory(points)
      setSyncError(null)
      setSyncNotice(null)
    } catch (error) {
      const detail =
        error instanceof DOMException && error.name === 'AbortError'
          ? 'request timed out'
          : error instanceof Error
            ? error.message
            : 'network error'
      setSyncError(`Auto-sync failed: ${detail}`)
    } finally {
      window.clearTimeout(timeout)
      syncInFlightRef.current = false
      setSyncing(false)
    }
  }

  // Fetch on load / key change, then every 5 minutes. Re-checking when the tab
  // becomes visible catches up after the browser throttled background timers.
  // A failed sync is retried on the next 5-minute tick instead of disabling the
  // scheduler, so a transient 401/offline window cannot silently stop sync.
  useEffect(() => {
    if (apiKey.length === 0) return
    let disposed = false
    const tick = (): void => {
      if (disposed) return
      void syncBalance(apiKey)
    }
    tick()
    const timer = window.setInterval(tick, BALANCE_REFRESH_MS)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', tick)
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', tick)
    }
    // `syncBalance` only touches refs and state setters, so the key is the only
    // meaningful dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey])

  // --- drag handling -------------------------------------------------------

  const rememberPosition = (next: HudPosition): void => {
    positionRef.current = next
    setPosition(next)
  }

  // Re-clamp after the card mounts, expands, or is shown again. The card's
  // measured size decides the lower bound, so the first render from storage is
  // corrected before paint.
  useLayoutEffect(() => {
    if (!open) return
    const card = hudRef.current
    if (card === null) return
    const rect = card.getBoundingClientRect()
    const next = clampPosition(
      positionRef.current.x,
      positionRef.current.y,
      rect.width,
      rect.height,
      topInset,
    )
    if (next.x !== positionRef.current.x || next.y !== positionRef.current.y) {
      rememberPosition(next)
      persistPosition(next)
    }
  }, [open, minimized, usage === null, timeframe, keyEditorOpen, apiKey.length, topInset])

  // A viewport resize must not strand the HUD off-screen.
  useEffect(() => {
    const onResize = (): void => {
      const card = hudRef.current
      if (card === null) return
      const rect = card.getBoundingClientRect()
      const next = clampPosition(
        positionRef.current.x,
        positionRef.current.y,
        rect.width,
        rect.height,
        topInset,
      )
      if (next.x !== positionRef.current.x || next.y !== positionRef.current.y) {
        rememberPosition(next)
        persistPosition(next)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [topInset])

  const closePanel = (): void => controller.setOpen(false)
  const toggleMinimized = (): void => setMinimized((current) => !current)

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest('[data-usage-hud-no-drag]') !== null) return
    const card = hudRef.current
    if (card === null) return
    const rect = card.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: positionRef.current.x,
      startY: positionRef.current.y,
      width: rect.width,
      height: rect.height,
    }
    setDragging(true)
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleDragMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const next = clampPosition(
      drag.startX + (event.clientX - drag.startClientX),
      drag.startY + (event.clientY - drag.startClientY),
      drag.width,
      drag.height,
      topInset,
    )
    rememberPosition(next)
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    persistPosition(positionRef.current)
  }

  const handleLostPointerCapture = (): void => {
    if (dragRef.current === null) return
    dragRef.current = null
    setDragging(false)
    persistPosition(positionRef.current)
  }

  // --- ledger portability --------------------------------------------------

  const saveApiKey = (): void => {
    const key = apiKeyDraft.trim()
    if (key.length === 0) return
    writeStored(API_KEY_KEY, encodeApiKey(key))
    lastSyncAttemptRef.current = 0
    setApiKey(key)
    setApiKeyDraft('')
    setKeyEditorOpen(false)
    setSyncError(null)
    setSyncNotice('API key saved — the true balance now auto-syncs every 5 minutes.')
    // The key-change effect performs the immediate fetch; this direct call also
    // covers re-saving the same key after a transient failure.
    void syncBalance(key)
  }

  const forgetApiKey = (): void => {
    removeStored(API_KEY_KEY)
    removeStored(BALANCE_KEY)
    removeStored(BALANCE_HISTORY_KEY)
    setApiKey('')
    setApiKeyDraft('')
    setKeyEditorOpen(true)
    setBalanceMeta(null)
    setBalanceHistory([])
    setSyncNotice(null)
    setSyncError(null)
  }

  const exportLedger = (): void => {
    const payload = {
      format: 'usage-popup.universal-ledger',
      version: 3,
      exportedAt: new Date().toISOString(),
      entries: ledgerRef.current,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `usage-popup-ledger-${localDateKey(Date.now())}.json`
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
    setDataMessage(`Exported ${ledgerRef.current.length.toLocaleString()} ledger entries.`)
  }

  const importLedger = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (file === undefined) return
    try {
      const text = await file.text()
      const parsed = parseDashboardExport(text, file.name)
      const warnings =
        parsed.warnings.length > 0 ? ` ${parsed.warnings.slice(0, 2).join(' ')}` : ''
      if (parsed.entries.length === 0) {
        setDataMessage(
          `Imported 0 rows (skipped ${parsed.skipped}).${warnings}`.trim(),
        )
        return
      }
      const current = mergeLedger(ledgerRef.current, readLedgerDatabase())
      const merged = replaceImportedEntries(current, parsed.entries)
      writeUniversalLedger(merged)
      ledgerRef.current = merged
      setLedgerEntries(merged)
      notifyLedgerChanged()
      const added = merged.length - current.length
      setDataMessage(
        `Imported ${added.toLocaleString()} rows (skipped ${parsed.skipped.toLocaleString()}).${warnings}`.trim(),
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown import error.'
      setDataMessage(`Import failed: ${detail}`)
    }
  }

  const resetLogs = (): void => {
    if (
      !window.confirm(
        'Clear every locally recorded usage log? The API balance sync, balance history and HUD settings are kept.',
      )
    ) {
      return
    }
    writeUniversalLedger([])
    ledgerRef.current = []
    setLedgerEntries([])
    notifyLedgerChanged()
    const freshAnchors: Record<string, SessionAnchor> = {}
    if (activeChatId !== null && live.usage !== null) {
      freshAnchors[activeChatId] = {
        sessionId: activeChatId,
        sessionTitle: activeChatTitle,
        lastUsage: live.usage,
        lastModel: live.models.used ?? live.models.selected ?? 'flash',
        updatedAt: Date.now(),
      }
    }
    writeAnchors(freshAnchors)
    try {
      const storage = window.localStorage
      const doomed: string[] = []
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key === null || key === UNIVERSAL_LEDGER_KEY) continue
        if (!key.startsWith('usage-popup.')) continue
        if (/ledger/i.test(key)) doomed.push(key)
      }
      for (const key of doomed) storage.removeItem(key)
    } catch {
      // Best-effort cleanup of the old per-session keys.
    }
    setDataMessage('Local usage logs cleared. The current session is re-anchored.')
  }

  const breakdown: ReadonlyArray<readonly [string, number]> = [
    ['Uncached input', displayedUsage.uncachedInputTokens],
    ['Cache read', displayedUsage.cacheReadTokens],
    ['Cache write', displayedUsage.cacheWriteTokens],
    ['Output', displayedUsage.outputTokens],
  ]

  const customDays =
    customStart.length > 0 && customEnd.length > 0 ? inclusiveDays(customStart, customEnd) : 1

  return (
    <>
      {open && (
        <div
          ref={hudRef}
          className="usage-popup__hud"
          data-usage-popup-hud=""
          role="region"
          aria-label="True-sync universal multi-chat token usage and RMB cost ledger"
          style={hudStyle(position, minimized, dragging, topInset)}
        >
          <div
            className="usage-popup__hud-handle"
            style={handleStyle(minimized, dragging)}
            title="Drag to move"
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onLostPointerCapture={handleLostPointerCapture}
          >
            <span style={gripStyle} aria-hidden="true">
              <GripGlyph />
            </span>

            {minimized ? (
              <>
                <span
                  style={contextBloat ? { ...pillTextStyle, ...bloatTextStyle } : pillTextStyle}
                  title={
                    contextBloat
                      ? `Runaway context: ${exactCount(displayedTotal)} tokens in this chat (over 1.5M).`
                      : 'Selected chat tokens'
                  }
                >
                  {displayedTotal === 0 ? 'Usage —' : `Usage ${compactCount(displayedTotal)} tok`}
                </span>
                <span
                  style={pillStatsStyle}
                  title="Ledger cost of the selected chat · true CNY balance remaining (api.deepseek.com)"
                >
                  {yuan(liveSessionCost)} · {trueBalance === null ? '— left' : `${yuan(trueBalance)} left`}
                </span>
              </>
            ) : (
              <>
                <span style={titleStyle}>True-sync ledger</span>
                <span
                  style={contextBloat ? { ...headerTotalStyle, ...bloatTextStyle } : headerTotalStyle}
                  title={
                    contextBloat
                      ? `Runaway context: ${exactCount(displayedTotal)} tokens in this chat (over 1.5M).`
                      : `${exactCount(displayedTotal)} tokens in the selected chat`
                  }
                >
                  {displayedTotal === 0 ? '—' : `${compactCount(displayedTotal)} tok`}
                </span>
              </>
            )}

            <button
              type="button"
              data-usage-hud-no-drag=""
              aria-label={minimized ? 'Expand the token usage HUD' : 'Minimize the token usage HUD'}
              aria-pressed={minimized}
              title={minimized ? 'Expand' : 'Minimize'}
              onClick={toggleMinimized}
              style={iconButtonStyle}
            >
              <CollapseGlyph collapsed={minimized} />
            </button>

            <button
              type="button"
              data-usage-hud-no-drag=""
              aria-label="Close the True-sync ledger"
              title="Close the ledger (reopen it from the sidebar)"
              onClick={closePanel}
              style={iconButtonStyle}
            >
              <span aria-hidden="true" style={{ fontSize: 14, lineHeight: '14px' }}>
                ×
              </span>
            </button>
          </div>

          {!minimized && (
            <div style={bodyStyle}>
              <div
                style={{ ...segmentGroupStyle, marginBottom: 8 }}
                role="group"
                aria-label="Usage panel"
              >
                <button
                  type="button"
                  aria-pressed={panel === 'usage'}
                  onClick={() => setPanel('usage')}
                  style={segmentButtonStyle(panel === 'usage')}
                >
                  Usage
                </button>
                <button
                  type="button"
                  aria-pressed={panel === 'saver'}
                  onClick={() => setPanel('saver')}
                  style={segmentButtonStyle(panel === 'saver')}
                  title="dsh-plugin-save-token dashboard, merged into this HUD"
                >
                  Token saver
                </button>
              </div>

              {panel === 'saver' ? (
                <SaverPanel />
              ) : (
                <>
              <div
                style={timeframeGroupStyle}
                role="group"
                aria-label="Usage timeframe"
                title="Day, Week and Month always sum every saved chat in the global ledger. Custom also lets you include/exclude individual chats."
              >
                {(
                  [
                    ['session', 'Session'],
                    ['day', 'Day'],
                    ['week', 'Week'],
                    ['month', 'Month'],
                    ['custom', 'Custom'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={timeframe === value}
                    onClick={() => setTimeframe(value)}
                    style={timeframeButtonStyle(timeframe === value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div style={scopeRowStyle}>
                {isGlobalScope ? (
                  <>
                    <span
                      style={scopeBadgeStyle(true)}
                      title="This view sums every chat in the universal ledger for the selected time range. It is not scoped to the open conversation."
                    >
                      All chats · global
                    </span>
                    <span style={countdownStyle}>
                      {ledgerEntries.length.toLocaleString()} entries · {chatOptions.length} chats
                    </span>
                  </>
                ) : (
                  <>
                    <ChatSelect
                      options={chatOptions}
                      value={sessionKey}
                      onChange={(id) => setLockedChatId(id === autoChatId ? null : id)}
                    />
                    {manualOverride && (
                      <button
                        type="button"
                        style={currentChatPillStyle}
                        title="Manual history selection — click to auto-follow the current chat again."
                        aria-label="Follow the current chat again"
                        onClick={() => setLockedChatId(null)}
                        data-usage-hud-no-drag=""
                      >
                        <span aria-hidden="true" style={chatSelectDotStyle} />
                        Current chat
                      </button>
                    )}
                    <span style={countdownStyle}>
                      {sessionKey === null
                        ? 'no chat selected'
                        : `${selectedEntries.length.toLocaleString()} entries`}
                      {sessionKey === null ? '' : followingChat ? ' · live' : ' · history'}
                    </span>
                  </>
                )}
              </div>

              {timeframe === 'custom' && (
                <div style={customPanelStyle}>
                  <div style={customDateRowStyle}>
                    <span style={metricLabelStyle}>From</span>
                    <input
                      type="date"
                      aria-label="Custom range start"
                      value={customStart}
                      max={customEnd.length > 0 ? customEnd : undefined}
                      onChange={(event) => setCustomStart(event.target.value)}
                      style={dateInputStyle}
                    />
                    <span style={metricLabelStyle}>To</span>
                    <input
                      type="date"
                      aria-label="Custom range end"
                      value={customEnd}
                      min={customStart.length > 0 ? customStart : undefined}
                      onChange={(event) => setCustomEnd(event.target.value)}
                      style={dateInputStyle}
                    />
                  </div>
                  <div style={{ ...tinyHintStyle, marginTop: 6 }}>
                    Global range: every chat in the ledger is included.
                  </div>
                </div>
              )}

              <div style={hudColumnsStyle}>
                <div style={leftColumnStyle}>
                  <div style={totalRowStyle}>
                    <span
                      style={
                        timeframe === 'session' && contextBloat
                          ? { ...totalNumberStyle, ...bloatTextStyle }
                          : totalNumberStyle
                      }
                      title={
                        timeframe === 'session' && contextBloat
                          ? `Runaway context: ${exactCount(displayedTotal)} tokens in this chat (over 1.5M).`
                          : undefined
                      }
                    >
                      {exactCount(displayedTotal)}
                    </span>
                    <span style={totalUnitStyle}>
                      {timeframe === 'session'
                        ? 'session tokens'
                        : `${timeframeLabel.toLowerCase()} tokens`}
                    </span>
                  </div>

                  <div style={cacheHitStyle}>
                    <span>Cache hit</span>
                    <span style={cacheHitValueStyle}>{hitRatio === null ? '—' : percent(hitRatio)}</span>
                  </div>

                  <dl style={detailsStyle}>
                    {breakdown.map(([label, value]) => (
                      <Fragment key={label}>
                        <dt style={labelStyle}>{label}</dt>
                        <dd style={valueStyle}>{exactCount(value)}</dd>
                      </Fragment>
                    ))}
                  </dl>

                  <div
                    style={metricRowStyle}
                    title="RMB avoided by reading cached input instead of paying the uncached input rate."
                  >
                    <span style={metricLabelStyle}>Cache savings</span>
                    <span style={savingsValueStyle}>{yuan(displaySavings)}</span>
                  </div>
                </div>

                <div style={rightColumnStyle}>
                  <div
                    style={totalRowStyle}
                    title={
                      primaryUsesApi
                        ? 'Primary spend: the measured API balance decrease in this window (top-ups ignored).'
                        : 'Ledger estimate: priced token deltas at the model and UTC peak/off-peak tier active when they arrived.'
                    }
                  >
                    <span style={totalNumberStyle}>
                      {primaryUsesApi ? yuan(primaryPeriodCost) : `≈ ${yuan(primaryPeriodCost)}`}
                    </span>
                    <span style={totalUnitStyle}>
                      {timeframe === 'session'
                        ? 'session cost'
                        : `${timeframeLabel.toLowerCase()} cost`}
                      {primaryUsesApi ? ` · ${primaryPeriodLabel}` : ' · ledger estimate'}
                    </span>
                  </div>

                  <div style={liveBadgeRowStyle}>
                    <span style={liveBadgeStyle(usedLabel === 'Mixed')} title={badgeTitle}>
                      <span aria-hidden="true" style={tierDotStyle} />
                      {badgeText}
                    </span>
                  </div>

                  <div style={tierRowStyle}>
                    <span
                      style={tierBadgeStyle(naturalPeak)}
                      title={
                        naturalPeak
                          ? 'Peak window: Mon–Fri 01:00–04:00 or 06:00–10:00 UTC — peak rate card'
                          : 'Off-peak: off-peak rate card (all weekend traffic is off-peak)'
                      }
                    >
                      <span aria-hidden="true" style={tierDotStyle} />
                      {naturalPeak ? 'Peak' : 'Off-Peak'}
                    </span>
                    <span
                      style={countdownStyle}
                      title="Live countdown to the next natural UTC peak/off-peak rate switch"
                    >
                      {countdownLabel}
                    </span>
                  </div>

                  {burnPerCall !== null && (
                    <div
                      style={metricRowStyle}
                      title={`Derived from recorded API calls in this window (${recordedCalls.toLocaleString()} call${
                        recordedCalls === 1 ? '' : 's'
                      }).`}
                    >
                      <span style={metricLabelStyle}>Avg burn / recorded call</span>
                      <span style={metricValueStyle}>{yuan(burnPerCall)}</span>
                    </div>
                  )}

                  <div
                    style={metricRowStyle}
                    title="Sum of the priced ledger entries in this window. Reconciliation rows are included so this can be compared with the API balance delta."
                  >
                    <span style={metricLabelStyle}>Ledger total</span>
                    <span style={metricValueStyle}>{yuan(ledgerPeriodSpend)}</span>
                  </div>

                  {reconciliationDrift !== null && Math.abs(reconciliationDrift) >= 0.005 && (
                    <div style={tinyHintStyle} title="Measured API balance Δ minus the ledger total for the same window.">
                      API Δ vs ledger Δ:{' '}
                      {`${reconciliationDrift >= 0 ? '+' : ''}${yuan(reconciliationDrift)}`} over{' '}
                      {timeframeLabel.toLowerCase()}.
                    </div>
                  )}
                </div>
              </div>

              {timeframe === 'session' && untrackedTokens > 0 && usage !== null && (
                <div style={tinyHintStyle}>
                  Tracking began after ~{compactCount(untrackedTokens)} earlier tokens in this chat;
                  only tracked deltas are priced.
                </div>
              )}

              {contextBloat && (
                <div style={{ ...tinyHintStyle, ...bloatTextStyle, marginTop: 8 }} role="status">
                  Runaway context: {exactCount(displayedTotal)} tokens in this chat (over 1.5M).
                </div>
              )}

              {timeframe === 'session' && routedRows !== null ? (
                <div style={sectionStyle}>
                  <div style={sectionTitleRowStyle}>
                    <span style={sectionTitleStyle}>Models · this session</span>
                    <span style={sectionValueStyle}>{compactCount(routedSessionTokens)} tok</span>
                  </div>
                  <div style={modelBarStyle} aria-hidden="true">
                    {routedRows.map((row) => (
                      <div
                        key={row.key}
                        style={modelSegmentStyle(row.color, row.share)}
                        title={`${row.label}: ${exactCount(row.tokens)} tokens`}
                      />
                    ))}
                  </div>
                  {routedRows.map((row) => (
                    <div
                      key={row.key}
                      style={modelRowStyle}
                      title={`${row.label} · ${exactCount(row.tokens)} tokens · ${row.calls} call${
                        row.calls === 1 ? '' : 's'
                      }${
                        row.costKnown
                          ? ` · ${yuan(row.costRmb)}`
                          : ' · local token count (no provider sync)'
                      }`}
                    >
                      <span aria-hidden="true" style={modelDotStyle(row.color)} />
                      <span style={modelNameStyle}>{row.label}</span>
                      <span style={modelTokensStyle}>{compactCount(row.tokens)} tok</span>
                      <span style={modelCostStyle}>{row.costKnown ? yuan(row.costRmb) : 'local'}</span>
                      <span style={modelShareStyle}>{percent(row.share)}</span>
                    </div>
                  ))}
                  <div style={tinyHintStyle}>
                    Local route counts from the tier router. DeepSeek rows are priced; other
                    models stay tokens-only and are never synced against a provider API.
                  </div>
                </div>
              ) : (
                <div style={sectionStyle}>
                  <div style={sectionTitleRowStyle}>
                    <span style={sectionTitleStyle}>Cost by model</span>
                    <span style={sectionValueStyle}>{yuan(trueSelectedCost)}</span>
                  </div>
                  <div style={modelBarStyle} aria-hidden="true">
                    {modelRows.map((row) => (
                      <div
                        key={row.id}
                        style={modelSegmentStyle(row.color, row.share)}
                        title={`${row.label}: ${yuan(row.costRmb)}`}
                      />
                    ))}
                  </div>
                  {modelRows.map((row) => (
                    <div
                      key={row.id}
                      style={modelRowStyle}
                      title={
                        row.id === 'search'
                          ? 'server-tool-search charges. Recorded only when the host ledger carries such entries; otherwise ¥0.00.'
                          : `${row.label} · ${exactCount(row.tokens)} tokens · ${yuan(row.costRmb)}`
                      }
                    >
                      <span aria-hidden="true" style={modelDotStyle(row.color)} />
                      <span style={modelNameStyle}>{row.label}</span>
                      <span style={modelTokensStyle}>
                        {row.tokens === 0 ? '—' : `${compactCount(row.tokens)} tok`}
                      </span>
                      <span style={modelCostStyle}>{yuan(row.costRmb)}</span>
                      <span style={modelShareStyle}>
                        {row.costRmb <= 0 ? '0%' : percent(row.share)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {delegatedSummary.entries > 0 && (
                <div style={sectionStyle}>
                  <div style={sectionTitleRowStyle}>
                    <span style={sectionTitleStyle}>Subagents &amp; background</span>
                    <span style={sectionValueStyle}>
                      {delegatedSummary.tokens === 0
                        ? '—'
                        : `${compactCount(delegatedSummary.tokens)} tok`}
                    </span>
                  </div>
                  <div
                    style={modelRowStyle}
                    title={`${delegatedSummary.entries.toLocaleString()} recorded subagent/background/compaction ${
                      delegatedSummary.entries === 1 ? 'entry' : 'entries'
                    } · ${delegatedSummary.calls.toLocaleString()} call${
                      delegatedSummary.calls === 1 ? '' : 's'
                    }`}
                  >
                    <span aria-hidden="true" style={modelDotStyle(MODEL_COLORS.unattributed)} />
                    <span style={modelNameStyle}>Delegated &amp; background</span>
                    <span style={modelTokensStyle}>
                      {delegatedSummary.tokens === 0
                        ? '—'
                        : `${compactCount(delegatedSummary.tokens)} tok`}
                    </span>
                    <span style={modelCostStyle}>{yuan(delegatedSummary.costRmb)}</span>
                    <span style={modelShareStyle}>{`${delegatedSummary.calls}×`}</span>
                  </div>
                  <div style={tinyHintStyle}>
                    Calls recorded by the host collector outside the main chat thread. Their cost is
                    included in the totals above.
                  </div>
                </div>
              )}

              {timeframe === 'session' && workerRows.length > 0 && (
                <div style={sectionStyle}>
                  <div style={sectionTitleRowStyle}>
                    <span style={sectionTitleStyle}>Fetch boys · this run</span>
                    <span style={sectionValueStyle}>{compactCount(workerTokens)} tok</span>
                  </div>
                  {workerRows.map((row) => (
                    <div
                      key={row.key}
                      style={modelRowStyle}
                      title={`${row.label} · ${exactCount(row.tokens)} tokens · ${row.calls} call${
                        row.calls === 1 ? '' : 's'
                      } · delegated session, local count only`}
                    >
                      <span aria-hidden="true" style={modelDotStyle(row.color)} />
                      <span style={modelNameStyle}>{row.label}</span>
                      <span style={modelTokensStyle}>{compactCount(row.tokens)} tok</span>
                      <span style={modelCostStyle}>local</span>
                      <span style={modelShareStyle}>{row.calls}×</span>
                    </div>
                  ))}
                  <div style={tinyHintStyle}>
                    Delegated subagent sessions since the router last started. Tokens only — no
                    provider sync.
                  </div>
                </div>
              )}

              <div style={sectionStyle}>
                <div style={sectionTitleRowStyle}>
                  <span style={sectionTitleStyle}>True balance</span>
                  <span style={syncStatusStyle} title="Automatic sync from api.deepseek.com/user/balance">
                    <span aria-hidden="true" style={syncDotStyle(syncStatusColor)} />
                    {syncStatusLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => setKeyEditorOpen((current) => !current)}
                    style={{ ...linkButtonStyle, marginLeft: 'auto' }}
                    title="Add, replace or forget the saved DeepSeek API key"
                  >
                    {apiKey.length > 0 ? 'API key' : 'Add key'}
                  </button>
                </div>

                <div style={balanceHeadlineRowStyle}>
                  <span
                    style={{
                      ...balanceHeadlineStyle,
                      ...(trueBalance !== null && trueBalance <= 0 ? dangerTextStyle : {}),
                    }}
                  >
                    {trueBalance === null ? '—' : yuan(trueBalance)}
                  </span>
                  <span style={balanceHeadlineUnitStyle}>CNY · source of truth</span>
                </div>

                <div style={balanceGridStyle}>
                  <div style={balanceMetricStyle}>
                    <span style={balanceMetricLabelStyle}>Runway</span>
                    <span style={balanceMetricValueStyle}>{runwayLabel}</span>
                  </div>
                  <div style={balanceMetricStyle}>
                    <span
                      style={balanceMetricLabelStyle}
                      title={
                        todayApiSpend !== null
                          ? 'API balance decrease since local midnight (top-ups ignored)'
                          : 'Ledger spend since local midnight'
                      }
                    >
                      Today · {todayApiSpend !== null ? 'API Δ' : 'ledger'}
                    </span>
                    <span style={balanceMetricValueStyle}>
                      {todayApiSpend !== null ? yuan(todayApiSpend) : `≈ ${yuan(todayDisplaySpend)}`}
                    </span>
                  </div>
                  <div style={balanceMetricStyle}>
                    <span
                      style={balanceMetricLabelStyle}
                      title="API balance decrease inside the selected window (top-ups ignored)"
                    >
                      True period spend
                    </span>
                    <span
                      style={balanceMetricValueStyle}
                      title={
                        periodSpendIsEstimate
                          ? 'Not enough /user/balance samples in this window yet; showing the local ledger estimate.'
                          : `Measured from ${balanceHistory.length} /user/balance samples.`
                      }
                    >
                      {periodSpendLabel}
                    </span>
                  </div>
                </div>

                <div style={budgetRowStyle}>
                  <label style={stopLabelStyle} title="Target number of days the true balance should last">
                    Target runway
                    <input
                      type="number"
                      min={1}
                      max={MAX_TARGET_RUNWAY_DAYS}
                      step={1}
                      value={runwayDraft}
                      onChange={(event) => setRunwayDraft(event.target.value)}
                      onBlur={() => setRunwayDraft(String(targetRunwayDays))}
                      style={stopInputStyle}
                    />
                    d
                  </label>
                  <span style={dailyTargetStyle} title="True API balance ÷ target runway">
                    Daily target {dailyTargetBudget === null ? '—' : yuan(dailyTargetBudget)}
                  </span>
                </div>

                <div
                  style={gaugeTrackStyle}
                  role="progressbar"
                  aria-label="Today's spend versus the daily target budget"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    budgetRatio === null ? 0 : Math.round(Math.min(1, budgetRatio) * 100)
                  }
                  title="Today's true tracked spend versus the balance-derived daily target budget."
                >
                  <div style={gaugeFillStyle(budgetRatio)} />
                </div>
                <div style={budgetCaptionRowStyle}>
                  <span>
                    Today {yuan(todayDisplaySpend)} / {dailyTargetBudget === null ? '—' : yuan(dailyTargetBudget)}
                    {todayApiSpend !== null ? ' · API Δ' : ' · ledger'}
                  </span>
                  <span
                    style={
                      budgetRatio !== null && budgetRatio >= 1
                        ? dangerTextStyle
                        : budgetRatio !== null && budgetRatio >= 0.8
                          ? warnTextStyle
                          : undefined
                    }
                  >
                    {budgetPercentLabel}
                  </span>
                </div>

                {(keyEditorOpen || apiKey.length === 0) && (
                  <>
                    <div style={syncRowStyle}>
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="DeepSeek API key"
                        placeholder={apiKey.length > 0 ? 'Replace API key' : 'sk-…'}
                        value={apiKeyDraft}
                        onChange={(event) => setApiKeyDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') saveApiKey()
                        }}
                        style={passwordInputStyle}
                      />
                      <button
                        type="button"
                        disabled={apiKeyDraft.trim().length === 0}
                        onClick={saveApiKey}
                        style={{
                          ...primaryMiniButtonStyle,
                          opacity: apiKeyDraft.trim().length === 0 ? 0.55 : 1,
                        }}
                      >
                        Save key
                      </button>
                      {apiKey.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setKeyEditorOpen(false)
                            setApiKeyDraft('')
                            setSyncError(null)
                          }}
                          style={miniButtonStyle}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                    {apiKey.length > 0 && (
                      <button
                        type="button"
                        onClick={forgetApiKey}
                        style={{ ...linkButtonStyle, marginTop: 4 }}
                      >
                        Forget saved key
                      </button>
                    )}
                    <div style={tinyHintStyle}>
                      Stored only in this browser's localStorage, base64-encoded, never included in
                      JSON exports. The balance is fetched automatically every 5 minutes.
                    </div>
                  </>
                )}

                {syncError !== null && (
                  <div style={{ ...tinyHintStyle, ...dangerTextStyle }}>{syncError}</div>
                )}
                {syncNotice !== null && syncError === null && (
                  <div style={{ ...tinyHintStyle, color: 'var(--dsw-alias-state-success-primary, #3fb950)' }}>
                    {syncNotice}
                  </div>
                )}

                <div style={tinyHintStyle}>
                  {apiKey.length === 0
                    ? 'Add a DeepSeek API key to auto-sync the true CNY balance.'
                    : balanceMeta === null
                      ? 'Auto-sync runs on load and every 5 minutes.'
                      : `Last sync ${new Date(balanceMeta.syncedAt).toLocaleString()} · ledger spend since sync ${yuan(
                          postSyncSpend,
                        )}.`}
                </div>
              </div>

              <div style={footerStyle}>
                <button
                  type="button"
                  onClick={exportLedger}
                  style={miniButtonStyle}
                  title="Download the universal ledger as JSON"
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  style={miniButtonStyle}
                  title="Merge a universal ledger JSON export or a DeepSeek dashboard CSV / TSV / JSON export"
                >
                  Import
                </button>
                <button
                  type="button"
                  onClick={resetLogs}
                  style={miniButtonStyle}
                  title="Clear all local usage logs"
                >
                  Reset
                </button>
                <span style={{ ...sessionCountStyle, marginLeft: 'auto' }}>
                  {ledgerEntries.length.toLocaleString()} entries · {chatOptions.length} chats
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.csv,.tsv,application/json,text/csv,text/tab-separated-values"
                  onChange={(event) => void importLedger(event)}
                  style={{ display: 'none' }}
                />
              </div>

              <div style={tinyHintStyle}>
                {timeframe === 'custom'
                  ? `${customDays} day${customDays === 1 ? '' : 's'} · ${elapsedDays.toFixed(
                      1,
                    )}d elapsed · ${balanceHistory.length} API balance samples`
                  : `${timeframeLabel} · ${balanceHistory.length} API balance samples · avg burn ${yuan(
                      averageDailySpend,
                    )}/day`}
              </div>

              {dataMessage !== null && <div style={tinyHintStyle}>{dataMessage}</div>}
              {usage === null && displayedTotal === 0 && (
                <p style={hintStyle}>No session data yet.</p>
              )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}
