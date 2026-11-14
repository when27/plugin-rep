// usage-popup — True-Sync Universal Cost Ledger for DeepSeek Harness.
//
// The composer dock entry (`conversation.composer.dock`) is only a small
// toggle: it shows the live total and hides/shows a free-floating HUD. The HUD
// itself is rendered through a portal into `document.body`, so `position:
// fixed` is viewport-relative instead of being captured by the docked
// composer's containing block. The HUD is always visible by default, can be
// dragged anywhere (clamped to the viewport, position persisted in
// localStorage), and can collapse into a tiny pill.
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
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
export const inject = ['slots']

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
}

export function apply(ctx: Context) {
  // Register our control into the composer statistics dock. `order: 2` puts it
  // after the built-in `usage` (order 1) control.
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: 'usage-popup', // new id => a new control is appended
        order: 2,
      },
      UsagePopControl,
    ),
  )

  // dsh-plugin-save-token's composer strip now lives inside this HUD (the
  // "Token saver" face). Replace its dock cell with an empty component at the
  // same id + order so the saver UI costs no extra composer space; the
  // plugin's settings section and host behavior are untouched.
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
const VISIBLE_KEY = 'usage-popup.hud.visible.v1'
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
/** `search` is reserved for server-tool-search charges recorded by the host. */
type ModelClass = ModelId | 'search'
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

interface SessionSummary {
  sessionId: string
  title: string
  tokens: number
  costRmb: number
  lastAt: number
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
}

const CONTEXT_BLOAT_TOKENS = 1_500_000
/** Rough assistant-response size used to estimate the session's turn count. */
const TURN_OUTPUT_TOKENS = 600

const MODEL_LABELS: Record<ModelClass, string> = {
  flash: 'deepseek-flash',
  pro: 'deepseek-v4-pro',
  search: 'server-tool-search',
}

const MODEL_COLORS: Record<ModelClass, string> = {
  flash: '#3fb950',
  pro: '#58a6ff',
  search: '#d29922',
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

function usageCostRmb(usage: TokenUsage, model: ModelClass, peak: boolean): number {
  const card = rateCard(model, peak)
  const weighted =
    usage.uncachedInputTokens * card.uncachedInput +
    usage.cacheReadTokens * card.cacheRead +
    usage.cacheWriteTokens * card.cacheWrite +
    usage.outputTokens * card.output
  return weighted / 1_000_000
}

/** The one true price of a ledger row, used by every total and by-model split. */
function entryCostRmb(entry: LedgerEntry): number {
  if (entry.model === 'search') return Math.max(0, entry.costRmb)
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
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  }
}

function usageDelta(next: TokenUsage, previous: TokenUsage): TokenUsage {
  return {
    uncachedInputTokens: Math.max(0, next.uncachedInputTokens - previous.uncachedInputTokens),
    outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
    cacheReadTokens: Math.max(0, next.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, next.cacheWriteTokens - previous.cacheWriteTokens),
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
    left.cacheWriteTokens === right.cacheWriteTokens
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

function entryDedupKey(entry: LedgerEntry): string {
  return [
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
  if (
    uncachedInputTokens === null &&
    outputTokens === null &&
    cacheReadTokens === null &&
    cacheWriteTokens === null
  ) {
    return null
  }
  return {
    uncachedInputTokens: uncachedInputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
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
  if (/search|tool/.test(text)) return 'search'
  return classifyModelText(text) ?? (text === 'pro' ? 'pro' : 'flash')
}

function normalizeEntry(value: unknown, fallbackSessionId?: string | null): LedgerEntry | null {
  if (!isRecord(value)) return null
  const record = value

  const rawSessionId =
    typeof record.sessionId === 'string' && record.sessionId.length > 0
      ? record.sessionId
      : typeof fallbackSessionId === 'string' && fallbackSessionId.length > 0
        ? fallbackSessionId
        : null
  if (rawSessionId === null) return null

  const usage = normalizeUsage(record)
  if (usage === null || isZeroUsage(usage)) return null

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

  const costCandidate = record.costRmb ?? record.cost
  const parsedCost =
    typeof costCandidate === 'number'
      ? costCandidate
      : typeof costCandidate === 'string'
        ? Number(costCandidate)
        : Number.NaN
  const costRmb =
    Number.isFinite(parsedCost) && parsedCost >= 0
      ? parsedCost
      : usageCostRmb(usage, model, tier === 'peak')

  const rawTitle = record.sessionTitle ?? record.title ?? record.session_title
  const sessionTitle = cleanTitle(rawTitle) ?? 'Untitled chat'

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
function apiSpendInWindow(
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

const dockButtonStyle = (visible: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'transparent',
  color: 'inherit',
  border: 0,
  borderRadius: 6,
  padding: '6px 8px',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  opacity: visible ? 1 : 0.72,
})

const dockDotStyle = (visible: boolean): CSSProperties => ({
  width: 6,
  height: 6,
  flex: '0 0 auto',
  borderRadius: 999,
  background: visible
    ? 'var(--dsw-alias-state-success-primary, #3fb950)'
    : 'var(--dsw-alias-state-idle-primary, GrayText)',
})

const dockStateStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary, CanvasText)',
  opacity: 0.72,
}

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
// The dock control. It renders the show/hide toggle and, when visible, the
// portal'd HUD. The HUD's `useProjection` subscription lives here because the
// dock slot is session-scoped; `shell.overlay` is root-scoped and has no
// `useProjection` prop.
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

function UsagePopControl(props: PropsRuntime<'conversation.composer.dock'>) {
  const { useProjection, sessionId } = props

  // Read the smallest slice we need. `tokenUsage` is `undefined` until the
  // session has a projected value (no session bound yet, or not yet loaded).
  // Normalize on every render instead of memoizing: it guarantees a fresh
  // reading even if a host mutates its projection object in place.
  const rawUsage = useProjection('tokenUsage')
  const usage = normalizeUsage(rawUsage)
  // The durable model selection: `{ lastUsed, next }` (or a bare selection on
  // older hosts). `lastUsed` is the route that produced settled tokens.
  const rawModelSelection = useProjection('modelSelection')
  const models = liveModelInfo(rawModelSelection)

  // The host's window caption band (Windows only) must never be part of the
  // draggable area. Recomputed on render so a fullscreen toggle recovers.
  const topInset = hudTopInset()

  const [visible, setVisible] = useState(() => readStoredFlag(VISIBLE_KEY, true))
  const [minimized, setMinimized] = useState(() => readStoredFlag(MINIMIZED_KEY, false))
  // Which face the HUD shows: the usage ledger or the merged token-saver
  // dashboard. Both share the same floating card, so the composer dock has
  // exactly one control.
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

  const hudRef = useRef<HTMLDivElement | null>(null)
  const positionRef = useRef<HudPosition>(position)
  const dragRef = useRef<DragState | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const syncInFlightRef = useRef(false)
  const lastSyncAttemptRef = useRef(0)

  const propSessionId = sessionId == null ? null : String(sessionId)
  const sessionKey = propSessionId ?? domSessionId
  const currentModel: ModelId | null = models.selected ?? domModel
  const lastUsedModel: ModelId | null = models.used ?? domModel

  const runtimeTitle = runtimeSessionTitle(props as unknown as Record<string, unknown>)
  const sessionTitle =
    runtimeTitle ??
    (domSessionTitle.sessionKey === sessionKey ? domSessionTitle.title : null) ??
    (sessionKey === null ? 'No active chat' : `Chat ${sessionKey.slice(0, 8)}`)

  const activeTotal = usage === null ? 0 : usageTotal(usage)
  const contextBloat = activeTotal > CONTEXT_BLOAT_TOKENS
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
    const totals: Record<ModelClass, number> = { flash: 0, pro: 0, search: 0 }
    for (const entry of selectedEntries) totals[entry.model] += usageTotal(entry.usage)
    return totals
  }, [selectedEntries])

  const modelRows = useMemo<ModelRow[]>(() => {
    const costs: Record<ModelClass, number> = { flash: 0, pro: 0, search: 0 }
    for (const entry of selectedEntries) costs[entry.model] += entryCostRmb(entry)
    const total =
      costs.flash + costs.pro + costs.search > 0
        ? costs.flash + costs.pro + costs.search
        : trueSelectedCost
    const ids: ModelClass[] = ['flash', 'pro', 'search']
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
  const badgeText = `Live · ${liveLabel ?? '—'}`
  const badgeTitle =
    `True tracked cost. Flash ${exactCount(modelTokens.flash)} tok · Pro ${exactCount(
      modelTokens.pro,
    )} tok. Each delta is priced at the model and UTC peak/off-peak tier active when it arrived.`

  const estimatedTurns =
    displayedUsage.outputTokens <= 0
      ? null
      : Math.ceil(displayedUsage.outputTokens / TURN_OUTPUT_TOKENS)
  const burnPerTurn = estimatedTurns === null ? null : trueSelectedCost / estimatedTurns

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

  // Dynamic daily budget: the true API balance spread across the target runway.
  const dailyTargetBudget =
    trueBalance !== null && targetRunwayDays > 0 ? trueBalance / targetRunwayDays : null
  const budgetRatio =
    dailyTargetBudget === null
      ? null
      : dailyTargetBudget > 0
        ? todaySpend / dailyTargetBudget
        : todaySpend > 0
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

  const elapsedDays = useMemo(() => {
    if (periodWindowStart === null) return 1
    return Math.max(1 / 24, (nowMs - periodWindowStart) / DAY_MS)
  }, [periodWindowStart, nowMs])

  const trackedSessions = useMemo<SessionSummary[]>(() => {
    const map = new Map<string, SessionSummary>()
    for (const entry of ledgerEntries) {
      const existing = map.get(entry.sessionId)
      if (existing === undefined) {
        map.set(entry.sessionId, {
          sessionId: entry.sessionId,
          title: entry.sessionTitle,
          tokens: usageTotal(entry.usage),
          costRmb: entryCostRmb(entry),
          lastAt: entry.at,
        })
        continue
      }
      existing.title = entry.sessionTitle
      existing.tokens += usageTotal(entry.usage)
      existing.costRmb += entryCostRmb(entry)
      existing.lastAt = Math.max(existing.lastAt, entry.at)
    }
    if (sessionKey !== null) {
      const current = map.get(sessionKey)
      if (current === undefined) {
        map.set(sessionKey, {
          sessionId: sessionKey,
          title: sessionTitle,
          tokens: activeTotal,
          costRmb: 0,
          lastAt: Date.now(),
        })
      } else {
        current.title = sessionTitle
        current.tokens = Math.max(current.tokens, activeTotal)
      }
    }
    return Array.from(map.values()).sort((left, right) => right.lastAt - left.lastAt)
  }, [ledgerEntries, sessionKey, sessionTitle, activeTotal])

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
    writeStored(VISIBLE_KEY, visible ? '1' : '0')
  }, [visible])

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
    if (!visible || minimized || panel !== 'usage') return
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
  }, [visible, minimized, panel, sessionKey])

  // Fold any legacy per-session ledgers into the global database once on mount.
  useEffect(() => {
    const database = mergeLedger(ledgerRef.current, migrateLegacyLedgers())
    ledgerRef.current = database
    setLedgerEntries(database)
    notifyLedgerChanged()
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

  // Runs on every cumulative usage change; a zero or negative delta only
  // resyncs the anchor (and never invents a refund). Anchors are re-read from
  // storage before every write so sibling HUD instances cannot clobber them.
  useEffect(() => {
    if (sessionKey === null || usage === null) return

    const anchors = readAnchors()
    const anchor = anchors[sessionKey]
    const attributed = lastUsedModel ?? currentModel ?? anchor?.lastModel ?? 'flash'

    const saveAnchor = (next: SessionAnchor): void => {
      anchors[next.sessionId] = next
      writeAnchors(anchors)
    }

    if (anchor === undefined) {
      // First sight of this Session: anchor at the current totals, record no
      // cost. Everything after this point is a true incremental delta.
      saveAnchor({
        sessionId: sessionKey,
        sessionTitle,
        lastUsage: usage,
        lastModel: attributed,
        updatedAt: Date.now(),
      })
      return
    }

    const delta = usageDelta(usage, anchor.lastUsage)
    const titleChanged = anchor.sessionTitle !== sessionTitle

    // A reload/reset can make the cumulative projection briefly report less
    // than the anchor. Lowering the anchor here would re-bill every token when
    // the real total comes back, so keep the high-water mark instead.
    if (usageTotal(usage) < usageTotal(anchor.lastUsage)) {
      if (anchor.sessionTitle !== sessionTitle || anchor.lastModel !== attributed) {
        saveAnchor({
          ...anchor,
          sessionTitle,
          lastModel: attributed,
          updatedAt: Date.now(),
        })
      }
      return
    }

    if (isZeroUsage(delta)) {
      if (!sameUsage(usage, anchor.lastUsage) || anchor.lastModel !== attributed || titleChanged) {
        saveAnchor({
          ...anchor,
          sessionTitle,
          lastUsage: usage,
          lastModel: attributed,
          updatedAt: Date.now(),
        })
        if (titleChanged) {
          const updated = mergeLedger(ledgerRef.current, readLedgerDatabase()).map((entry) =>
            entry.sessionId === sessionKey ? { ...entry, sessionTitle } : entry,
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
      sessionId: sessionKey,
      sessionTitle,
      date: localDateKey(at),
      model: attributed,
      tier,
      usage: delta,
      costRmb: usageCostRmb(delta, attributed, tier === 'peak'),
      at,
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
      sessionId: sessionKey,
      sessionTitle,
      lastUsage: usage,
      lastModel: attributed,
      updatedAt: at,
    })
  }, [usage, sessionKey, lastUsedModel, currentModel, sessionTitle])

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
        'data-active-session-id',
        'aria-current',
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
      const meta: BalanceMeta = { balanceRmb, syncedAt: at, currency: 'CNY' }
      writeStored(BALANCE_KEY, JSON.stringify(meta))
      setBalanceMeta(meta)
      setBalanceHistory(appendBalancePoint(balanceRmb, at))
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
    if (!visible) return
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
  }, [visible, minimized, usage === null, timeframe, keyEditorOpen, apiKey.length, topInset])

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

  const toggleVisible = (): void => setVisible((current) => !current)
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
      const parsed: unknown = JSON.parse(text)
      const rawEntries = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.entries)
          ? parsed.entries
          : null
      if (rawEntries === null) throw new Error('No ledger entries array found in the JSON.')
      const imported: LedgerEntry[] = []
      for (const candidate of rawEntries) {
        // Imported rows without a session id are still real spend: attribute them
        // to a synthetic chat so the global Day / Week / Month totals include them.
        const entry = normalizeEntry(candidate, 'imported:ledger')
        if (entry !== null) imported.push(entry)
      }
      if (imported.length === 0) throw new Error('The file contained no valid ledger entries.')
      const current = mergeLedger(ledgerRef.current, readLedgerDatabase())
      const merged = mergeLedger(current, imported)
      writeUniversalLedger(merged)
      ledgerRef.current = merged
      setLedgerEntries(merged)
      notifyLedgerChanged()
      setDataMessage(
        `Imported ${(merged.length - current.length).toLocaleString()} new entries (${(
          imported.length - (merged.length - current.length)
        ).toLocaleString()} duplicates skipped).`,
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
    if (sessionKey !== null && usage !== null) {
      freshAnchors[sessionKey] = {
        sessionId: sessionKey,
        sessionTitle,
        lastUsage: usage,
        lastModel: lastUsedModel ?? currentModel ?? 'flash',
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
      <button
        type="button"
        className="usage-popup"
        data-composer-stat="usage-popup"
        aria-pressed={visible}
        aria-label={visible ? 'Hide the token usage HUD' : 'Show the token usage HUD'}
        title={visible ? 'Hide token usage HUD' : 'Show token usage HUD'}
        onClick={toggleVisible}
        style={dockButtonStyle(visible)}
      >
        <span aria-hidden="true" style={dockDotStyle(visible)} />
        <span style={contextBloat ? bloatTextStyle : undefined}>
          {activeTotal === 0 ? 'Usage: —' : `Usage: ${compactCount(activeTotal)} tok`}
        </span>
        <span style={dockStateStyle}>{visible ? 'HUD on' : 'HUD off'}</span>
      </button>

      {visible && createPortal(
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
                      ? `Runaway context: ${exactCount(activeTotal)} tokens in the active chat (over 1.5M).`
                      : 'Active chat tokens'
                  }
                >
                  {activeTotal === 0 ? 'Usage —' : `Usage ${compactCount(activeTotal)} tok`}
                </span>
                <span
                  style={pillStatsStyle}
                  title="Live true session cost · true CNY balance remaining (api.deepseek.com)"
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
                      ? `Runaway context: ${exactCount(activeTotal)} tokens in the active chat (over 1.5M).`
                      : `${exactCount(activeTotal)} tokens in the active chat`
                  }
                >
                  {activeTotal === 0 ? '—' : `${compactCount(activeTotal)} tok`}
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

              <div
                style={scopeRowStyle}
                title={
                  isGlobalScope
                    ? 'This view sums every chat in the universal ledger for the selected time range. It is not scoped to the open conversation.'
                    : 'This view is scoped to the currently open chat.'
                }
              >
                <span style={scopeBadgeStyle(isGlobalScope)}>
                  {isGlobalScope ? 'All chats · global' : 'This chat only'}
                </span>
                <span style={countdownStyle}>
                  {isGlobalScope
                    ? `${ledgerEntries.length.toLocaleString()} ledger entries`
                    : sessionKey === null
                      ? 'no active chat'
                      : `${selectedEntries.length.toLocaleString()} entries`}
                </span>
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
                          ? `Runaway context: ${exactCount(activeTotal)} tokens in the active chat (over 1.5M).`
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
                    title="True tracked cost: every token delta is priced at the model and UTC peak/off-peak tier active when it arrived."
                  >
                    <span style={totalNumberStyle}>{yuan(trueSelectedCost)}</span>
                    <span style={totalUnitStyle}>
                      {timeframe === 'session' ? 'session cost' : `${timeframeLabel.toLowerCase()} cost`}
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

                  <div
                    style={metricRowStyle}
                    title="Estimated selected-timeframe cost per assistant turn (estimated from output tokens at ~600 per turn)."
                  >
                    <span style={metricLabelStyle}>Avg burn / turn</span>
                    <span style={metricValueStyle}>{burnPerTurn === null ? '—' : yuan(burnPerTurn)}</span>
                  </div>
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
                  Runaway context: {exactCount(activeTotal)} tokens in this chat (over 1.5M).
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
                    <span style={balanceMetricLabelStyle}>Today spend</span>
                    <span style={balanceMetricValueStyle}>{yuan(todaySpend)}</span>
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
                          ? 'Not enough API balance samples in this window yet; showing the local ledger estimate.'
                          : `Measured from ${balanceHistory.length} API balance samples.`
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
                    Today {yuan(todaySpend)} / {dailyTargetBudget === null ? '—' : yuan(dailyTargetBudget)}
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
                  {reconciliationDrift !== null && Math.abs(reconciliationDrift) >= 0.005
                    ? `API Δ vs ledger Δ: ${reconciliationDrift >= 0 ? '+' : ''}${yuan(
                        reconciliationDrift,
                      )} over ${timeframeLabel.toLowerCase()}. `
                    : ''}
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
                  title="Merge a previously exported universal ledger"
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
                  {ledgerEntries.length.toLocaleString()} entries · {trackedSessions.length} chats
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
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
        </div>,
        document.body,
      )}
    </>
  )
}
