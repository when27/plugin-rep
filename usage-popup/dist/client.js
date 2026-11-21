window.__ModuleLoader__.load({
  id: "usage-popup",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.inject = exports.name = void 0;
    exports.apply = apply;
    const jsx_runtime_1 = require("react/jsx-runtime");
    const react_1 = require("react");
    const react_dom_1 = require("react-dom");
    exports.name = 'usage-popup';
    // Services this client plugin needs before it may activate. `slots` is
    // provided by the renderer plugin (a sibling fiber), so reading `ctx.slots`
    // without declaring it throws `cannot get property "slots" without inject`
    // and the web-boot audit reports `usage-popup: failed`.
    exports.inject = ['slots'];
    function apply(ctx) {
        // Register our control into the composer statistics dock. `order: 2` puts it
        // after the built-in `usage` (order 1) control.
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'usage-popup', // new id => a new control is appended
            order: 2,
        }, UsagePopControl));
        // dsh-plugin-save-token's composer strip now lives inside this HUD (the
        // "Token saver" face). Replace its dock cell with an empty component at the
        // same id + order so the saver UI costs no extra composer space; the
        // plugin's settings section and host behavior are untouched.
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'save-token-strip',
            order: 85,
            priority: -1,
        }, () => null));
    }
    // ---------------------------------------------------------------------------
    // HUD geometry, persistence keys, and display helpers.
    // ---------------------------------------------------------------------------
    const HUD_WIDTH = 424;
    const VIEWPORT_MARGIN = 8;
    const HUD_Z_INDEX = 2_147_483_000;
    const DAY_MS = 86_400_000;
    const WINDOWS_TITLEBAR_FALLBACK = 40;
    /**
     * The Windows desktop frame paints a `-webkit-app-region: drag` caption band
     * across the top of the window (40px unless the host overrides the CSS
     * variable). Chromium hands that band to the OS window-drag hit test, so a
     * body-level portal sitting inside it never receives pointer events: it cannot
     * be clicked, hovered, or dragged. The HUD is such a portal, so it must stay
     * below the band *and* exclude itself from the caption region.
     */
    function windowsTitlebarHeight() {
        if (typeof document === 'undefined' || typeof window === 'undefined')
            return 0;
        const root = document.documentElement;
        if (root === null || !root.hasAttribute('data-windows-titlebar'))
            return 0;
        // In fullscreen the frame hides the band, so the whole viewport is usable.
        if (root.hasAttribute('data-fullscreen'))
            return 0;
        const raw = window.getComputedStyle(root).getPropertyValue('--dsh-windows-titlebar-height');
        const height = Number.parseFloat(raw);
        return Number.isFinite(height) && height > 0 ? height : WINDOWS_TITLEBAR_FALLBACK;
    }
    /** Smallest `top` the HUD may occupy without landing in the caption band. */
    function hudTopInset() {
        return VIEWPORT_MARGIN + windowsTitlebarHeight();
    }
    const POSITION_KEY = 'usage-popup.hud.position.v1';
    const VISIBLE_KEY = 'usage-popup.hud.visible.v1';
    const MINIMIZED_KEY = 'usage-popup.hud.minimized.v1';
    const TIMEFRAME_KEY = 'usage-popup.hud.timeframe.v1';
    const CUSTOM_START_KEY = 'usage-popup.hud.custom-start.v1';
    const CUSTOM_END_KEY = 'usage-popup.hud.custom-end.v1';
    const TARGET_RUNWAY_KEY = 'usage-popup.hud.target-runway.v1';
    const DEFAULT_TARGET_RUNWAY_DAYS = 30;
    const MAX_TARGET_RUNWAY_DAYS = 3650;
    // One unified ledger across every chat. The per-session anchor stores only the
    // last cumulative projection so the next incremental delta can be derived
    // without ever inventing a refund when the projection is reset/reloaded.
    const UNIVERSAL_LEDGER_KEY = 'usage-popup.universal-ledger.v2';
    const ANCHORS_KEY = 'usage-popup.session-anchors.v2';
    const BALANCE_KEY = 'usage-popup.api-balance.v1';
    const BALANCE_HISTORY_KEY = 'usage-popup.balance-history.v1';
    const API_KEY_KEY = 'usage-popup.deepseek-api-key.v1';
    const LEGACY_SESSION_LEDGER_PREFIX = 'usage-popup.session-ledger.v1.';
    const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance';
    const BALANCE_REFRESH_MS = 5 * 60_000;
    const MAX_BALANCE_POINTS = 2_880; // 10 days at one sample every 5 minutes
    const LEDGER_EVENT = 'usage-popup:ledger-changed';
    const LEDGER_CHANNEL = 'usage-popup.ledger.v1';
    /** 517 / 12.2K / 517K / 1.2M — matches the built-in stat pills. */
    function compactCount(value) {
        const scaled = (candidate) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
        if (value < 1_000)
            return String(value);
        if (value < 1_000_000)
            return `${scaled(value / 1_000)}K`;
        return `${scaled(value / 1_000_000)}M`;
    }
    function exactCount(value) {
        return value.toLocaleString();
    }
    /** One decimal is enough; a partial hit must never read as a full 100%. */
    function percent(ratio) {
        const rounded = Math.round(ratio * 1_000) / 10;
        if (ratio < 1 && rounded >= 100)
            return '99.9%';
        return `${rounded}%`;
    }
    /** ¥0.284 / ¥1.28 — enough precision that a cheap session never reads as 0. */
    function yuan(value) {
        if (!Number.isFinite(value))
            return '¥—';
        if (value < 0)
            return `-¥${Math.abs(value).toFixed(2)}`;
        if (value === 0)
            return '¥0.00';
        const digits = value >= 1 ? 2 : value >= 0.01 ? 3 : 4;
        return `¥${value.toFixed(digits)}`;
    }
    function formatAgo(ms) {
        if (!Number.isFinite(ms) || ms < 0)
            return 'just now';
        const seconds = Math.floor(ms / 1_000);
        if (seconds < 45)
            return 'just now';
        const minutes = Math.round(seconds / 60);
        if (minutes < 60)
            return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24)
            return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    }
    const RATE_CARDS = {
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
    };
    const CONTEXT_BLOAT_TOKENS = 1_500_000;
    /** Rough assistant-response size used to estimate the session's turn count. */
    const TURN_OUTPUT_TOKENS = 600;
    const MODEL_LABELS = {
        flash: 'deepseek-flash',
        pro: 'deepseek-v4-pro',
        search: 'server-tool-search',
    };
    const MODEL_COLORS = {
        flash: '#3fb950',
        pro: '#58a6ff',
        search: '#d29922',
    };
    // ---------------------------------------------------------------------------
    // Routed-model registry. The tier router records one row per actual
    // provider/model that answered (DeepSeek, Gemini, GLM, ...). Pricing cards
    // exist only for DeepSeek; every other route is shown as local token counts
    // and is deliberately NOT synced against any provider billing API.
    // ---------------------------------------------------------------------------
    const ROUTER_USAGE_ENDPOINT = '/tier-router/api/usage';
    const ROUTER_USAGE_REFRESH_MS = 5_000;
    const SAVE_TOKEN_DASHBOARD_ENDPOINT = '/save-token/api/dashboard';
    const SAVE_TOKEN_TOGGLE_ENDPOINT = '/save-token/api/set-enabled';
    const SAVER_REFRESH_MS = 4_000;
    const ROUTED_MODEL_META = {
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
    };
    const ROUTED_FALLBACK_COLORS = ['#58a6ff', '#bc8cff', '#ff7b72', '#56d4dd', '#f0883e', '#7ee787'];
    function hashText(value) {
        let hash = 0;
        for (let index = 0; index < value.length; index += 1) {
            hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
        }
        return hash;
    }
    function routedModelMeta(provider, model) {
        const key = `${provider}/${model}`;
        const registered = ROUTED_MODEL_META[key];
        if (registered !== undefined)
            return registered;
        const providerLabel = provider === '' ? 'unknown' : provider;
        return {
            label: model === '' ? providerLabel : `${providerLabel} · ${model}`,
            color: ROUTED_FALLBACK_COLORS[hashText(key) % ROUTED_FALLBACK_COLORS.length],
        };
    }
    function nonnegativeCount(value) {
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    }
    function normalizeRoutedBuckets(value) {
        if (typeof value !== 'object' || value === null)
            return null;
        const record = value;
        const provider = typeof record.provider === 'string' ? record.provider : '';
        const model = typeof record.model === 'string' ? record.model : '';
        return {
            provider,
            model,
            calls: nonnegativeCount(record.calls),
            inputTokens: nonnegativeCount(record.inputTokens),
            outputTokens: nonnegativeCount(record.outputTokens),
            cacheReadTokens: nonnegativeCount(record.cacheReadTokens),
            cacheWriteTokens: nonnegativeCount(record.cacheWriteTokens),
        };
    }
    function normalizeRoutedBucketsMap(value) {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return {};
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            const buckets = normalizeRoutedBuckets(entry);
            if (buckets !== null)
                out[key] = buckets;
        }
        return out;
    }
    function normalizeRoutedUsage(value) {
        if (typeof value !== 'object' || value === null)
            return null;
        const record = value;
        const totals = normalizeRoutedBuckets(record.totals);
        if (totals === null)
            return null;
        const sessions = {};
        if (typeof record.sessions === 'object' && record.sessions !== null && !Array.isArray(record.sessions)) {
            for (const [sessionId, sessionValue] of Object.entries(record.sessions)) {
                if (typeof sessionValue !== 'object' || sessionValue === null)
                    continue;
                const sessionRecord = sessionValue;
                const sessionTotals = normalizeRoutedBuckets(sessionRecord.total);
                if (sessionTotals === null)
                    continue;
                sessions[sessionId] = {
                    total: sessionTotals,
                    byModel: normalizeRoutedBucketsMap(sessionRecord.byModel),
                    updatedAt: nonnegativeCount(sessionRecord.updatedAt),
                };
            }
        }
        return {
            totals,
            byModel: normalizeRoutedBucketsMap(record.byModel),
            sessions,
            workers: normalizeRoutedBucketsMap(record.workers),
            updatedAt: nonnegativeCount(record.updatedAt),
        };
    }
    function routedUsageTotal(buckets) {
        return buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
    }
    function routedUsageAsTokenUsage(buckets) {
        return {
            uncachedInputTokens: buckets.inputTokens,
            outputTokens: buckets.outputTokens,
            cacheReadTokens: buckets.cacheReadTokens,
            cacheWriteTokens: buckets.cacheWriteTokens,
        };
    }
    function routedRowsOf(map, tier) {
        const rows = Object.entries(map)
            .map(([key, buckets]) => {
            const meta = routedModelMeta(buckets.provider, buckets.model);
            const tokens = routedUsageTotal(buckets);
            return {
                key,
                label: meta.label,
                color: meta.color,
                calls: buckets.calls,
                tokens,
                costKnown: meta.pricing !== undefined,
                costRmb: meta.pricing === undefined
                    ? 0
                    : usageCostRmb(routedUsageAsTokenUsage(buckets), meta.pricing, tier === 'peak'),
                share: 0,
            };
        })
            .filter((row) => row.tokens > 0)
            .sort((left, right) => right.tokens - left.tokens);
        const total = rows.reduce((sum, row) => sum + row.tokens, 0);
        return rows.map((row) => ({ ...row, share: total > 0 ? row.tokens / total : 0 }));
    }
    function normalizeSaverDashboard(value) {
        if (typeof value !== 'object' || value === null)
            return null;
        const record = value;
        const totals = typeof record.totals === 'object' && record.totals !== null
            ? record.totals
            : {};
        const compression = typeof record.compression === 'object' && record.compression !== null
            ? record.compression
            : {};
        const flags = typeof record.flags === 'object' && record.flags !== null
            ? record.flags
            : {};
        const recent = Array.isArray(record.recent)
            ? record.recent.slice(0, 6).flatMap((entry) => {
                if (typeof entry !== 'object' || entry === null)
                    return [];
                const row = entry;
                return [{
                        ts: nonnegativeCount(row.ts),
                        kind: typeof row.kind === 'string' ? row.kind : 'request',
                        label: typeof row.label === 'string' ? row.label : '',
                        detail: typeof row.detail === 'string' ? row.detail : '',
                        saved: nonnegativeCount(row.saved),
                    }];
            })
            : [];
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
        };
    }
    function formatBytes(value) {
        if (!Number.isFinite(value) || value <= 0)
            return '0 B';
        if (value < 1024)
            return `${Math.round(value)} B`;
        const units = ['KB', 'MB', 'GB'];
        let scaled = value / 1024;
        let unit = 0;
        while (scaled >= 1024 && unit < units.length - 1) {
            scaled /= 1024;
            unit += 1;
        }
        return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`;
    }
    function rateCard(model, peak) {
        const cards = RATE_CARDS[model];
        return peak ? cards.peak : cards.offPeak;
    }
    function isPeakUtc(date) {
        const day = date.getUTCDay(); // 0 = Sunday … 6 = Saturday
        if (day === 0 || day === 6)
            return false;
        const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
        return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600);
    }
    function peakTier(peak) {
        return peak ? 'peak' : 'off-peak';
    }
    function usageCostRmb(usage, model, peak) {
        const card = rateCard(model, peak);
        const weighted = usage.uncachedInputTokens * card.uncachedInput +
            usage.cacheReadTokens * card.cacheRead +
            usage.cacheWriteTokens * card.cacheWrite +
            usage.outputTokens * card.output;
        return weighted / 1_000_000;
    }
    /** The one true price of a ledger row, used by every total and by-model split. */
    function entryCostRmb(entry) {
        if (entry.model === 'search')
            return Math.max(0, entry.costRmb);
        return usageCostRmb(entry.usage, entry.model, entry.tier === 'peak');
    }
    function cacheSavingsRmb(usage, model, peak) {
        const card = rateCard(model, peak);
        const difference = Math.max(0, card.uncachedInput - card.cacheRead);
        return (usage.cacheReadTokens * difference) / 1_000_000;
    }
    // ---------------------------------------------------------------------------
    // Calendar helpers. Ledger dates are local calendar days (what a person means
    // by "today"), while the rate tier is always computed in UTC.
    // ---------------------------------------------------------------------------
    function pad2(value) {
        return String(value).padStart(2, '0');
    }
    function localDateKey(value) {
        const date = typeof value === 'number' ? new Date(value) : value;
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }
    function startOfLocalDay(value) {
        const date = new Date(value);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
    }
    function startOfNextLocalDay(value) {
        const date = new Date(value);
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + 1);
        return date.getTime();
    }
    function startOfLocalWeek(value) {
        const date = new Date(value);
        date.setHours(0, 0, 0, 0);
        const offset = (date.getDay() + 6) % 7; // Monday = 0
        date.setDate(date.getDate() - offset);
        return date.getTime();
    }
    function startOfLocalMonth(value) {
        const date = new Date(value);
        date.setHours(0, 0, 0, 0);
        date.setDate(1);
        return date.getTime();
    }
    function parseLocalDate(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (match === null)
            return null;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day))
            return null;
        const date = new Date(year, month - 1, day, 0, 0, 0, 0);
        return Number.isFinite(date.getTime()) ? date.getTime() : null;
    }
    function inclusiveDays(start, end) {
        const from = Date.parse(`${start}T00:00:00Z`);
        const to = Date.parse(`${end}T00:00:00Z`);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from)
            return 1;
        return Math.max(1, Math.round((to - from) / DAY_MS) + 1);
    }
    function formatClockCountdown(ms) {
        if (!Number.isFinite(ms) || ms <= 0)
            return 'now';
        const seconds = Math.ceil(ms / 1_000);
        if (seconds < 60)
            return `${seconds}s`;
        const minutes = Math.ceil(seconds / 60);
        if (minutes < 60)
            return `${minutes}m`;
        if (minutes < 1_440)
            return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
        return `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h`;
    }
    /**
     * Peak windows change only at fixed UTC hours. Checking those boundaries for
     * the next week is cheap and exact, including the long weekend off-peak run.
     */
    function nextRateSwitch(fromMs) {
        const now = new Date(fromMs);
        const current = isPeakUtc(now);
        const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        const boundaries = [0, 1, 4, 6, 10];
        for (let dayOffset = 0; dayOffset < 9; dayOffset += 1) {
            const dayBase = base + dayOffset * DAY_MS;
            for (const hour of boundaries) {
                const candidate = dayBase + hour * 3_600_000;
                if (candidate <= fromMs)
                    continue;
                const candidatePeak = isPeakUtc(new Date(candidate));
                if (candidatePeak !== current)
                    return { at: candidate, tier: peakTier(candidatePeak) };
            }
        }
        return { at: fromMs + DAY_MS, tier: peakTier(!current) };
    }
    // ---------------------------------------------------------------------------
    // Usage helpers.
    // ---------------------------------------------------------------------------
    function zeroUsage() {
        return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    }
    function addUsage(left, right) {
        return {
            uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
            outputTokens: left.outputTokens + right.outputTokens,
            cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
            cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
        };
    }
    function usageDelta(next, previous) {
        return {
            uncachedInputTokens: Math.max(0, next.uncachedInputTokens - previous.uncachedInputTokens),
            outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
            cacheReadTokens: Math.max(0, next.cacheReadTokens - previous.cacheReadTokens),
            cacheWriteTokens: Math.max(0, next.cacheWriteTokens - previous.cacheWriteTokens),
        };
    }
    function isZeroUsage(usage) {
        return (usage.uncachedInputTokens === 0 &&
            usage.outputTokens === 0 &&
            usage.cacheReadTokens === 0 &&
            usage.cacheWriteTokens === 0);
    }
    function sameUsage(left, right) {
        return (left.uncachedInputTokens === right.uncachedInputTokens &&
            left.outputTokens === right.outputTokens &&
            left.cacheReadTokens === right.cacheReadTokens &&
            left.cacheWriteTokens === right.cacheWriteTokens);
    }
    function usageTotal(usage) {
        return (usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
    }
    function sumUsage(entries) {
        return entries.reduce((total, entry) => addUsage(total, entry.usage), zeroUsage());
    }
    function makeEntryId() {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    function entryDedupKey(entry) {
        return [
            entry.sessionId,
            entry.at,
            entry.model,
            entry.tier,
            entry.usage.uncachedInputTokens,
            entry.usage.cacheReadTokens,
            entry.usage.cacheWriteTokens,
            entry.usage.outputTokens,
        ].join('|');
    }
    function isRecord(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
    /**
     * Accept both the canonical counters and the aliases used by older projections
     * and exported ledgers. Returns `null` only when no counter exists at all, so a
     * genuinely zeroed session still normalizes to four zeros.
     */
    function normalizeUsage(value) {
        if (typeof value !== 'object' || value === null)
            return null;
        const record = value;
        const nested = record.usage ?? record.tokens ?? record.tokenUsage;
        const source = typeof nested === 'object' && nested !== null && !Array.isArray(nested)
            ? { ...nested, ...record }
            : record;
        const pick = (...keys) => {
            for (const key of keys) {
                const candidate = source[key];
                if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
                    return candidate;
                }
                if (typeof candidate === 'string') {
                    const parsed = Number(candidate);
                    if (Number.isFinite(parsed) && parsed >= 0)
                        return parsed;
                }
            }
            return null;
        };
        const uncachedInputTokens = pick('uncachedInputTokens', 'uncachedInput', 'inputTokens', 'promptTokens', 'input_tokens');
        const outputTokens = pick('outputTokens', 'completionTokens', 'output_tokens');
        const cacheReadTokens = pick('cacheReadTokens', 'cacheReadInputTokens', 'cachedInputTokens', 'cacheHitTokens', 'cache_read_tokens');
        const cacheWriteTokens = pick('cacheWriteTokens', 'cacheWriteInputTokens', 'cacheCreationTokens', 'cache_write_tokens');
        if (uncachedInputTokens === null &&
            outputTokens === null &&
            cacheReadTokens === null &&
            cacheWriteTokens === null) {
            return null;
        }
        return {
            uncachedInputTokens: uncachedInputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            cacheReadTokens: cacheReadTokens ?? 0,
            cacheWriteTokens: cacheWriteTokens ?? 0,
        };
    }
    function cleanTitle(value) {
        if (typeof value !== 'string')
            return null;
        const title = value.replace(/\s+/g, ' ').trim();
        if (title.length < 2 || title.length > 120)
            return null;
        if (/(?:^|\s)(?:usage-popup|deepseek harness)(?:\s|$)/i.test(title))
            return null;
        return title;
    }
    // ---------------------------------------------------------------------------
    // Universal localStorage ledger. Every access is guarded: the plugin must keep
    // working when storage is unavailable (private mode, embedded webview policy).
    // ---------------------------------------------------------------------------
    function normalizeModelClass(value) {
        if (typeof value !== 'string')
            return 'flash';
        const text = value.toLowerCase();
        if (/search|tool/.test(text))
            return 'search';
        return classifyModelText(text) ?? (text === 'pro' ? 'pro' : 'flash');
    }
    function normalizeEntry(value, fallbackSessionId) {
        if (!isRecord(value))
            return null;
        const record = value;
        const rawSessionId = typeof record.sessionId === 'string' && record.sessionId.length > 0
            ? record.sessionId
            : typeof fallbackSessionId === 'string' && fallbackSessionId.length > 0
                ? fallbackSessionId
                : null;
        if (rawSessionId === null)
            return null;
        const usage = normalizeUsage(record);
        if (usage === null || isZeroUsage(usage))
            return null;
        const atCandidate = record.at ?? record.timestamp ?? record.time;
        const at = typeof atCandidate === 'number' && Number.isFinite(atCandidate) && atCandidate > 0
            ? atCandidate
            : typeof atCandidate === 'string'
                ? Date.parse(atCandidate)
                : Number.NaN;
        if (!Number.isFinite(at) || at <= 0)
            return null;
        const model = normalizeModelClass(record.model);
        const tier = record.tier === 'peak' || record.tier === 'off-peak'
            ? record.tier
            : peakTier(isPeakUtc(new Date(at)));
        const date = typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date)
            ? record.date
            : localDateKey(at);
        const costCandidate = record.costRmb ?? record.cost;
        const parsedCost = typeof costCandidate === 'number'
            ? costCandidate
            : typeof costCandidate === 'string'
                ? Number(costCandidate)
                : Number.NaN;
        const costRmb = Number.isFinite(parsedCost) && parsedCost >= 0
            ? parsedCost
            : usageCostRmb(usage, model, tier === 'peak');
        const rawTitle = record.sessionTitle ?? record.title ?? record.session_title;
        const sessionTitle = cleanTitle(rawTitle) ?? 'Untitled chat';
        return {
            id: typeof record.id === 'string' && record.id.length > 0
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
        };
    }
    /**
     * Pull ledger rows out of every shape a stored value can take: a bare array, an
     * `{ entries: [...] }` envelope, an `{ entries: { entries: [...] } }` envelope
     * (older builds nested one level), a `{ ledger: [...] }` envelope, or a single
     * row object.
     */
    function entriesFromUnknown(raw, fallbackSessionId) {
        let list = [];
        if (Array.isArray(raw)) {
            list = raw;
        }
        else if (isRecord(raw)) {
            if (Array.isArray(raw.entries))
                list = raw.entries;
            else if (isRecord(raw.entries) && Array.isArray(raw.entries.entries))
                list = raw.entries.entries;
            else if (Array.isArray(raw.ledger))
                list = raw.ledger;
            else if (Array.isArray(raw.rows))
                list = raw.rows;
            else
                list = [raw];
        }
        const entries = [];
        for (const candidate of list) {
            const entry = normalizeEntry(candidate, fallbackSessionId);
            if (entry !== null)
                entries.push(entry);
        }
        return entries;
    }
    function mergeLedger(left, right) {
        const seen = new Set();
        const merged = [];
        for (const entry of [...left, ...right]) {
            const key = entryDedupKey(entry);
            if (seen.has(key))
                continue;
            seen.add(key);
            merged.push(entry);
        }
        merged.sort((a, b) => a.at - b.at);
        return merged;
    }
    /** Every storage key that could hold ledger rows (legacy per-session included). */
    function ledgerStorageKeys() {
        const keys = [];
        try {
            const storage = window.localStorage;
            for (let index = 0; index < storage.length; index += 1) {
                const key = storage.key(index);
                if (key === null || key === UNIVERSAL_LEDGER_KEY)
                    continue;
                // Stay inside this plugin's namespace: never parse or delete another
                // plugin's "ledger"-named keys.
                if (!key.startsWith('usage-popup.'))
                    continue;
                if (/ledger/i.test(key))
                    keys.push(key);
            }
        }
        catch {
            // Storage unavailable: no legacy keys to migrate.
        }
        return keys;
    }
    /**
     * Read the whole database: the global ledger plus every legacy per-session
     * ledger key. This is what the Day / Week / Month tabs aggregate, so the totals
     * cannot be constrained by the active session id.
     */
    function readLedgerDatabase() {
        const collected = [];
        try {
            const primary = window.localStorage.getItem(UNIVERSAL_LEDGER_KEY);
            if (primary !== null) {
                try {
                    collected.push(...entriesFromUnknown(JSON.parse(primary), null));
                }
                catch {
                    // A corrupt primary blob must not hide migrated legacy data.
                }
            }
        }
        catch {
            // Storage unavailable.
        }
        for (const key of ledgerStorageKeys()) {
            try {
                const raw = window.localStorage.getItem(key);
                if (raw === null)
                    continue;
                // A legacy per-session key carries its session id in the suffix. Any other
                // ledger-shaped key (for example a v1 global ledger) has no id at all, so
                // it gets a synthetic one: those rows must still be counted by the global
                // Day / Week / Month totals, while never matching a real chat's Session tab.
                const fallbackSessionId = key.startsWith(LEGACY_SESSION_LEDGER_PREFIX)
                    ? key.slice(LEGACY_SESSION_LEDGER_PREFIX.length)
                    : `legacy:${key}`;
                try {
                    collected.push(...entriesFromUnknown(JSON.parse(raw), fallbackSessionId));
                }
                catch {
                    // Skip unparseable legacy blobs.
                }
            }
            catch {
                // Ignore a single unreadable key.
            }
        }
        return mergeLedger([], collected);
    }
    function writeUniversalLedger(entries) {
        try {
            window.localStorage.setItem(UNIVERSAL_LEDGER_KEY, JSON.stringify({ entries }));
        }
        catch {
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
    function migrateLegacyLedgers() {
        const database = readLedgerDatabase();
        if (database.length > 0)
            writeUniversalLedger(database);
        return database;
    }
    function normalizeAnchor(value, sessionId) {
        if (!isRecord(value))
            return null;
        const lastUsage = normalizeUsage(value.lastUsage);
        if (lastUsage === null)
            return null;
        const lastModel = value.lastModel === 'flash' || value.lastModel === 'pro' ? value.lastModel : null;
        const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
        const rawTitle = value.sessionTitle ?? value.title;
        return {
            sessionId,
            sessionTitle: cleanTitle(rawTitle) ?? 'Untitled chat',
            lastUsage,
            lastModel,
            updatedAt,
        };
    }
    function readAnchors() {
        try {
            const raw = window.localStorage.getItem(ANCHORS_KEY);
            if (raw === null)
                return {};
            const parsed = JSON.parse(raw);
            if (!isRecord(parsed))
                return {};
            const anchors = {};
            for (const [sessionId, candidate] of Object.entries(parsed)) {
                const anchor = normalizeAnchor(candidate, sessionId);
                if (anchor !== null)
                    anchors[sessionId] = anchor;
            }
            return anchors;
        }
        catch {
            return {};
        }
    }
    function writeAnchors(anchors) {
        try {
            window.localStorage.setItem(ANCHORS_KEY, JSON.stringify(anchors));
        }
        catch {
            // See writeUniversalLedger: persistence is a convenience.
        }
    }
    function readBalanceMeta() {
        try {
            const raw = window.localStorage.getItem(BALANCE_KEY);
            if (raw === null)
                return null;
            const parsed = JSON.parse(raw);
            if (!isRecord(parsed))
                return null;
            const balance = typeof parsed.balanceRmb === 'number' && Number.isFinite(parsed.balanceRmb)
                ? parsed.balanceRmb
                : null;
            const syncedAt = typeof parsed.syncedAt === 'number' && Number.isFinite(parsed.syncedAt)
                ? parsed.syncedAt
                : null;
            if (balance === null || syncedAt === null)
                return null;
            return { balanceRmb: balance, syncedAt, currency: 'CNY' };
        }
        catch {
            return null;
        }
    }
    function readBalanceHistory() {
        try {
            const raw = window.localStorage.getItem(BALANCE_HISTORY_KEY);
            if (raw === null)
                return [];
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed)
                ? parsed
                : isRecord(parsed) && Array.isArray(parsed.points)
                    ? parsed.points
                    : [];
            const points = [];
            for (const candidate of list) {
                if (!isRecord(candidate))
                    continue;
                const at = candidate.at;
                const balanceRmb = candidate.balanceRmb;
                if (typeof at === 'number' &&
                    Number.isFinite(at) &&
                    at > 0 &&
                    typeof balanceRmb === 'number' &&
                    Number.isFinite(balanceRmb)) {
                    points.push({ at, balanceRmb });
                }
            }
            points.sort((a, b) => a.at - b.at);
            return points.slice(-MAX_BALANCE_POINTS);
        }
        catch {
            return [];
        }
    }
    function writeBalanceHistory(points) {
        try {
            window.localStorage.setItem(BALANCE_HISTORY_KEY, JSON.stringify({ points }));
        }
        catch {
            // Non-fatal: the last-known balance still lives in BALANCE_KEY.
        }
    }
    function appendBalancePoint(balanceRmb, at) {
        const stored = readBalanceHistory();
        const last = stored[stored.length - 1];
        if (last !== undefined &&
            at - last.at < 30_000 &&
            Math.abs(last.balanceRmb - balanceRmb) < 1e-9) {
            return stored;
        }
        stored.push({ at, balanceRmb });
        const trimmed = stored.slice(-MAX_BALANCE_POINTS);
        writeBalanceHistory(trimmed);
        return trimmed;
    }
    /**
     * True spend inside a window, measured from API balance samples only:
     * the sum of every negative balance move between the last sample at/ before
     * `windowStartMs` (or the first sample inside the window) and now. Top-ups are
     * therefore ignored instead of producing a negative spend. Returns `null` when
     * the history cannot cover the window with at least two samples.
     */
    function apiSpendInWindow(points, currentBalanceRmb, windowStartMs, nowMs) {
        if (windowStartMs === null || currentBalanceRmb === null)
            return null;
        const ordered = [...points].sort((a, b) => a.at - b.at);
        const series = [];
        let baseline = null;
        for (const point of ordered) {
            if (point.at <= windowStartMs)
                baseline = point;
            else if (point.at < nowMs)
                series.push(point);
        }
        // Without a sample at or before the window start, the measured delta would
        // silently omit the beginning of the period. Report "unknown" instead and let
        // the UI fall back to the explicitly-labelled ledger estimate.
        if (baseline === null)
            return null;
        series.unshift(baseline);
        const last = series[series.length - 1];
        if (last === undefined || Math.abs(last.balanceRmb - currentBalanceRmb) > 1e-9) {
            series.push({ at: nowMs, balanceRmb: currentBalanceRmb });
        }
        if (series.length < 2)
            return null;
        let spend = 0;
        for (let index = 1; index < series.length; index += 1) {
            spend += Math.max(0, series[index - 1].balanceRmb - series[index].balanceRmb);
        }
        return spend;
    }
    function encodeApiKey(value) {
        try {
            return `b64:${window.btoa(value)}`;
        }
        catch {
            return value;
        }
    }
    function decodeApiKey(value) {
        if (!value.startsWith('b64:'))
            return value;
        try {
            return window.atob(value.slice(4));
        }
        catch {
            return '';
        }
    }
    function readApiKey() {
        try {
            const raw = window.localStorage.getItem(API_KEY_KEY);
            return raw === null ? '' : decodeApiKey(raw).trim();
        }
        catch {
            return '';
        }
    }
    // ---------------------------------------------------------------------------
    // Cross-instance ledger notification. `storage` events only fire in other
    // documents, so a same-document custom event plus a BroadcastChannel keep every
    // mounted HUD (and every tab) reading the same global database.
    // ---------------------------------------------------------------------------
    let channelHandle;
    function ledgerChannel() {
        if (channelHandle !== undefined)
            return channelHandle;
        try {
            channelHandle =
                typeof BroadcastChannel === 'function' ? new BroadcastChannel(LEDGER_CHANNEL) : null;
        }
        catch {
            channelHandle = null;
        }
        return channelHandle;
    }
    function notifyLedgerChanged() {
        try {
            window.dispatchEvent(new Event(LEDGER_EVENT));
        }
        catch {
            // Same-document notification is best-effort.
        }
        try {
            ledgerChannel()?.postMessage('changed');
        }
        catch {
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
    function classifyModelText(raw) {
        if (typeof raw !== 'string' || raw.length === 0)
            return null;
        const text = raw.toLowerCase();
        if (/(^|[^a-z0-9])flash([^a-z0-9]|$)/.test(text))
            return 'flash';
        if (/(^|[^a-z0-9])pro([^a-z0-9]|$)/.test(text))
            return 'pro';
        if (/reasoner|reasoning|\br1\b|thinking|deepseek-r/.test(text))
            return 'pro';
        if (/deepseek-chat|\bchat\b|v3|v4|exp|fast|turbo|lite|mini|air/.test(text))
            return 'flash';
        return null;
    }
    function modelIdFromSelection(value) {
        if (typeof value === 'string')
            return classifyModelText(value);
        if (!isRecord(value))
            return null;
        for (const key of ['model', 'modelId', 'id', 'name', 'displayName']) {
            const candidate = value[key];
            if (typeof candidate === 'string') {
                const model = classifyModelText(candidate);
                if (model !== null)
                    return model;
            }
        }
        const badge = value.badge;
        if (isRecord(badge) && typeof badge.text === 'string') {
            const model = classifyModelText(badge.text);
            if (model !== null)
                return model;
        }
        return null;
    }
    function liveModelInfo(value) {
        if (!isRecord(value)) {
            const model = modelIdFromSelection(value);
            return { used: model, selected: model };
        }
        const lastUsed = modelIdFromSelection(value.lastUsed);
        const next = modelIdFromSelection(value.next);
        if (lastUsed !== null || next !== null) {
            return { used: lastUsed ?? next, selected: next ?? lastUsed };
        }
        // Some hosts publish the selection itself rather than `{ lastUsed, next }`.
        const direct = modelIdFromSelection(value);
        return { used: direct, selected: direct };
    }
    function modelFromDom() {
        if (typeof document === 'undefined' || typeof window === 'undefined')
            return null;
        const readElement = (element) => classifyModelText(element.getAttribute('data-model-id')) ??
            classifyModelText(element.textContent) ??
            classifyModelText(element.getAttribute('data-provider-id')) ??
            classifyModelText(element.getAttribute('aria-label')) ??
            classifyModelText(element.getAttribute('title'));
        const usable = (element) => {
            if (element.closest('[data-usage-popup-hud]') !== null)
                return false;
            if (element.closest('[role="menu"], [role="listbox"], [role="dialog"], [aria-modal="true"]') !==
                null) {
                return false;
            }
            // Never read model names out of transcript cards; only the composer counts.
            if (element.closest('[data-conversation-scroll]') !== null)
                return false;
            const rect = element.getBoundingClientRect();
            return (rect.width > 0 &&
                rect.height > 0 &&
                rect.bottom > 0 &&
                rect.top < window.innerHeight);
        };
        const labelled = document.querySelectorAll('[data-model-id], [data-provider-id]');
        let best = null;
        let bestTop = Number.NEGATIVE_INFINITY;
        for (const element of Array.from(labelled)) {
            if (!usable(element))
                continue;
            const model = readElement(element);
            if (model === null)
                continue;
            const top = element.getBoundingClientRect().top;
            if (top > bestTop) {
                best = model;
                bestTop = top;
            }
        }
        if (best !== null)
            return best;
        // Last resort: a compact control in the composer that shows a Flash/Pro name.
        for (const element of Array.from(document.querySelectorAll('button, [role="combobox"], [aria-haspopup="menu"]'))) {
            if (!usable(element))
                continue;
            const rect = element.getBoundingClientRect();
            if (rect.top < window.innerHeight * 0.5)
                continue;
            const model = readElement(element);
            if (model !== null)
                return model;
        }
        return null;
    }
    // ---------------------------------------------------------------------------
    // Best-effort session title/id. The standard dock props do not promise a title
    // or even a session id on every host, so read optional runtime fields first and
    // fall back to the active sidebar row or the page heading.
    // ---------------------------------------------------------------------------
    function runtimeSessionTitle(props) {
        for (const key of [
            'sessionTitle',
            'session_title',
            'conversationTitle',
            'conversation_title',
            'title',
            'label',
        ]) {
            const title = cleanTitle(props[key]);
            if (title !== null)
                return title;
        }
        for (const key of ['session', 'conversation', 'sessionMeta', 'meta']) {
            const nested = props[key];
            if (!isRecord(nested))
                continue;
            for (const titleKey of ['title', 'name', 'label', 'displayName', 'summary']) {
                const title = cleanTitle(nested[titleKey]);
                if (title !== null)
                    return title;
            }
        }
        return null;
    }
    function activeSessionIdFromDom() {
        if (typeof document === 'undefined')
            return null;
        for (const selector of ['[data-active-session-id]', '[data-current-session-id]']) {
            const element = document.querySelector(selector);
            if (element === null)
                continue;
            const value = element.getAttribute('data-active-session-id') ??
                element.getAttribute('data-current-session-id');
            if (value !== null && value.length > 0)
                return value;
        }
        for (const row of Array.from(document.querySelectorAll('[data-session-id]'))) {
            if (row.closest('[data-usage-popup-hud]') !== null)
                continue;
            const active = row.getAttribute('aria-current') === 'page' ||
                row.getAttribute('aria-selected') === 'true' ||
                row.getAttribute('data-active') === 'true' ||
                row.getAttribute('data-state') === 'active';
            if (!active)
                continue;
            const id = row.getAttribute('data-session-id');
            if (id !== null && id.length > 0)
                return id;
        }
        return null;
    }
    function sessionTitleFromDom(sessionId) {
        if (typeof document === 'undefined')
            return null;
        const readElement = (element) => cleanTitle(element.getAttribute('data-session-title')) ??
            cleanTitle(element.getAttribute('aria-label')) ??
            cleanTitle(element.textContent);
        const rows = Array.from(document.querySelectorAll('[data-session-id]'));
        for (const row of rows) {
            if (row.closest('[data-usage-popup-hud]') !== null)
                continue;
            const id = row.getAttribute('data-session-id');
            if (sessionId !== null && id !== sessionId)
                continue;
            const active = row.getAttribute('aria-current') === 'page' ||
                row.getAttribute('aria-selected') === 'true' ||
                row.getAttribute('data-active') === 'true' ||
                row.getAttribute('data-state') === 'active';
            if (sessionId === null && !active)
                continue;
            const title = readElement(row);
            if (title !== null)
                return title;
        }
        for (const selector of [
            '[data-session-header] h1',
            'header h1',
            'main h1',
            '[role="main"] h1',
        ]) {
            const heading = document.querySelector(selector);
            if (heading === null)
                continue;
            const title = cleanTitle(heading.textContent);
            if (title !== null)
                return title;
        }
        return null;
    }
    // ---------------------------------------------------------------------------
    // Generic localStorage helpers.
    // ---------------------------------------------------------------------------
    function readStoredPosition() {
        try {
            const raw = window.localStorage.getItem(POSITION_KEY);
            if (raw === null)
                return null;
            const parsed = JSON.parse(raw);
            if (!isRecord(parsed))
                return null;
            const x = parsed.x;
            const y = parsed.y;
            if (typeof x !== 'number' || typeof y !== 'number')
                return null;
            if (!Number.isFinite(x) || !Number.isFinite(y))
                return null;
            return { x, y };
        }
        catch {
            return null;
        }
    }
    function readStoredFlag(key, fallback) {
        try {
            const raw = window.localStorage.getItem(key);
            if (raw === '1')
                return true;
            if (raw === '0')
                return false;
            return fallback;
        }
        catch {
            return fallback;
        }
    }
    function readStoredChoice(key, allowed, fallback) {
        try {
            const raw = window.localStorage.getItem(key);
            return allowed.includes(raw) ? raw : fallback;
        }
        catch {
            return fallback;
        }
    }
    function readStoredText(key, fallback) {
        try {
            const raw = window.localStorage.getItem(key);
            return raw === null ? fallback : raw;
        }
        catch {
            return fallback;
        }
    }
    function readStoredNumber(key, fallback) {
        try {
            const raw = window.localStorage.getItem(key);
            if (raw === null)
                return fallback;
            const parsed = Number(raw);
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
        }
        catch {
            return fallback;
        }
    }
    function writeStored(key, value) {
        try {
            window.localStorage.setItem(key, value);
        }
        catch {
            // Persistence is a convenience; never break the HUD over it.
        }
    }
    function removeStored(key) {
        try {
            window.localStorage.removeItem(key);
        }
        catch {
            // Ignore unavailable storage.
        }
    }
    function persistPosition(position) {
        writeStored(POSITION_KEY, JSON.stringify({ x: Math.round(position.x), y: Math.round(position.y) }));
    }
    /** Keep the whole card inside the viewport, with a small breathing margin. */
    function clampPosition(x, y, width, height, topInset = VIEWPORT_MARGIN) {
        const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
        const maxY = Math.max(topInset, window.innerHeight - height - VIEWPORT_MARGIN);
        return {
            x: Math.round(Math.min(Math.max(x, VIEWPORT_MARGIN), maxX)),
            y: Math.round(Math.min(Math.max(y, topInset), maxY)),
        };
    }
    function initialPosition(topInset = VIEWPORT_MARGIN) {
        const stored = readStoredPosition();
        if (stored !== null)
            return stored;
        const viewportWidth = typeof window === 'undefined' ? HUD_WIDTH + 48 : window.innerWidth;
        return {
            x: Math.max(VIEWPORT_MARGIN, viewportWidth - HUD_WIDTH - 24),
            y: Math.max(88, topInset),
        };
    }
    // ---------------------------------------------------------------------------
    // Inline glyphs — no icon package, no external asset.
    // ---------------------------------------------------------------------------
    function GripGlyph() {
        return ((0, jsx_runtime_1.jsxs)("svg", { width: "10", height: "14", viewBox: "0 0 10 14", "aria-hidden": "true", focusable: "false", style: { display: 'block' }, children: [(0, jsx_runtime_1.jsx)("circle", { cx: "3", cy: "3", r: "1.15", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("circle", { cx: "7", cy: "3", r: "1.15", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("circle", { cx: "3", cy: "7", r: "1.15", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("circle", { cx: "7", cy: "7", r: "1.15", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("circle", { cx: "3", cy: "11", r: "1.15", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("circle", { cx: "7", cy: "11", r: "1.15", fill: "currentColor" })] }));
    }
    function CollapseGlyph({ collapsed }) {
        return ((0, jsx_runtime_1.jsx)("svg", { width: "12", height: "12", viewBox: "0 0 12 12", "aria-hidden": "true", focusable: "false", style: { display: 'block' }, children: collapsed ? ((0, jsx_runtime_1.jsx)("rect", { x: "2.2", y: "2.2", width: "7.6", height: "7.6", rx: "1.4", fill: "none", stroke: "currentColor", strokeWidth: "1.3" })) : ((0, jsx_runtime_1.jsx)("line", { x1: "2.2", y1: "6", x2: "9.8", y2: "6", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" })) }));
    }
    // ---------------------------------------------------------------------------
    // Styles. Only theme tokens (with literal fallbacks) are used, so light/dark
    // switching follows the host automatically.
    // ---------------------------------------------------------------------------
    const dockButtonStyle = (visible) => ({
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
    });
    const dockDotStyle = (visible) => ({
        width: 6,
        height: 6,
        flex: '0 0 auto',
        borderRadius: 999,
        background: visible
            ? 'var(--dsw-alias-state-success-primary, #3fb950)'
            : 'var(--dsw-alias-state-idle-primary, GrayText)',
    });
    const dockStateStyle = {
        fontSize: 11,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        opacity: 0.72,
    };
    const hudStyle = (position, minimized, dragging, topInset) => ({
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
    });
    const handleStyle = (minimized, dragging) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        cursor: dragging ? 'grabbing' : 'grab',
        touchAction: 'none',
        borderBottom: minimized ? 0 : '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25))',
    });
    const gripStyle = {
        display: 'inline-flex',
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        opacity: 0.55,
    };
    const titleStyle = {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary, CanvasText)',
    };
    const headerTotalStyle = {
        marginLeft: 'auto',
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontVariantNumeric: 'tabular-nums',
    };
    /** Runaway-context alert: bold amber, never a quiet tint. */
    const bloatTextStyle = {
        color: 'var(--dsw-alias-state-warning-primary, #d29922)',
        background: 'rgba(210, 153, 34, 0.14)',
        border: '1px solid rgba(210, 153, 34, 0.42)',
        borderRadius: 5,
        padding: '1px 5px',
        fontWeight: 700,
    };
    const pillTextStyle = {
        flex: '0 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        fontVariantNumeric: 'tabular-nums',
    };
    const pillStatsStyle = {
        flex: '0 0 auto',
        paddingLeft: 7,
        borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25))',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 10,
        lineHeight: '15px',
        opacity: 0.7,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
    };
    const iconButtonStyle = {
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
    };
    const bodyStyle = {
        padding: '10px 12px 12px',
    };
    const totalRowStyle = {
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        marginBottom: 8,
    };
    const totalNumberStyle = {
        fontSize: 20,
        fontWeight: 650,
        lineHeight: '24px',
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        fontVariantNumeric: 'tabular-nums',
    };
    const totalUnitStyle = {
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        opacity: 0.72,
    };
    const cacheHitStyle = {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '6px 8px',
        marginBottom: 10,
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
    };
    const cacheHitValueStyle = {
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontVariantNumeric: 'tabular-nums',
    };
    const detailsStyle = {
        display: 'grid',
        gridTemplateColumns: 'minmax(96px, auto) minmax(0, 1fr)',
        gap: '4px 12px',
        margin: 0,
    };
    const labelStyle = {
        minWidth: 0,
        margin: 0,
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        opacity: 0.78,
    };
    const valueStyle = {
        minWidth: 0,
        margin: 0,
        textAlign: 'right',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontVariantNumeric: 'tabular-nums',
    };
    const hintStyle = {
        margin: '8px 0 0',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        opacity: 0.72,
    };
    // Two side-by-side columns inside the one draggable card: token breakdown on
    // the left, RMB cost & burn-rate telemetry on the right.
    const hudColumnsStyle = {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        alignItems: 'start',
    };
    const leftColumnStyle = {
        minWidth: 0,
        paddingRight: 12,
    };
    const rightColumnStyle = {
        minWidth: 0,
        paddingLeft: 12,
        borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25))',
    };
    const segmentGroupStyle = {
        display: 'flex',
        gap: 2,
        padding: 2,
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
    };
    const timeframeGroupStyle = {
        ...segmentGroupStyle,
        marginBottom: 8,
    };
    /** Inverted chip reads correctly in both light and dark themes. */
    const segmentButtonStyle = (active) => ({
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
    });
    const timeframeButtonStyle = (active) => ({
        ...segmentButtonStyle(active),
        fontSize: 10,
        letterSpacing: -0.1,
    });
    /**
     * Explicit scope badge. Day / Week / Month / Custom always print "All chats" so
     * a global total can never be mistaken for the open conversation's total.
     */
    const scopeRowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        margin: '-2px 0 8px',
    };
    const scopeBadgeStyle = (global) => ({
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
    });
    const tierRowStyle = {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        marginBottom: 6,
    };
    const tierBadgeStyle = (peak) => ({
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
    });
    const tierDotStyle = {
        width: 5,
        height: 5,
        flex: '0 0 auto',
        borderRadius: 999,
        background: 'currentColor',
    };
    const countdownStyle = {
        minWidth: 0,
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 10,
        lineHeight: '15px',
        opacity: 0.68,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
    };
    const liveBadgeRowStyle = {
        display: 'flex',
        marginBottom: 8,
    };
    /** Small live / mixed badge under the session total. */
    const liveBadgeStyle = (mixed) => ({
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
    });
    const metricRowStyle = {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        marginTop: 6,
    };
    const metricLabelStyle = {
        minWidth: 0,
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 11,
        lineHeight: '16px',
        opacity: 0.78,
        whiteSpace: 'nowrap',
    };
    const metricValueStyle = {
        minWidth: 0,
        textAlign: 'right',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 11,
        lineHeight: '16px',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
    };
    const savingsValueStyle = {
        ...metricValueStyle,
        color: 'var(--dsw-alias-state-success-primary, #3fb950)',
    };
    const gaugeTrackStyle = {
        height: 5,
        marginTop: 5,
        borderRadius: 999,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
    };
    const gaugeFillStyle = (ratio) => {
        const filled = ratio === null ? 0 : Math.min(1, Math.max(0, ratio));
        // Green under 80% of the daily target, amber from 80%, red at/over 100%.
        const color = ratio === null
            ? 'var(--dsw-alias-state-idle-primary, GrayText)'
            : ratio >= 1
                ? 'var(--dsw-alias-state-danger-primary, #f85149)'
                : ratio >= 0.8
                    ? 'var(--dsw-alias-state-warning-primary, #d29922)'
                    : 'var(--dsw-alias-state-success-primary, #3fb950)';
        return {
            width: `${filled * 100}%`,
            height: '100%',
            borderRadius: 999,
            background: color,
            transition: 'width 160ms ease, background 160ms ease',
        };
    };
    const sectionStyle = {
        marginTop: 10,
        padding: '8px 9px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.07))',
    };
    const sectionTitleRowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 20,
    };
    const sectionTitleStyle = {
        minWidth: 0,
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        fontSize: 11,
        lineHeight: '16px',
        fontWeight: 650,
        whiteSpace: 'nowrap',
    };
    const sectionValueStyle = {
        marginLeft: 'auto',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 11,
        lineHeight: '16px',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
    };
    const modelBarStyle = {
        display: 'flex',
        gap: 1,
        height: 6,
        marginTop: 7,
        borderRadius: 999,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
    };
    const modelSegmentStyle = (color, share) => {
        const clamped = Math.max(0, Math.min(1, share));
        return {
            width: `${clamped * 100}%`,
            minWidth: clamped > 0 ? 2 : 0,
            height: '100%',
            background: color,
            opacity: 0.85,
            transition: 'width 160ms ease',
        };
    };
    const modelRowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginTop: 4,
        fontSize: 10,
        lineHeight: '14px',
    };
    const modelDotStyle = (color) => ({
        width: 6,
        height: 6,
        flex: '0 0 auto',
        borderRadius: 2,
        background: color,
    });
    const modelNameStyle = {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary, CanvasText)',
    };
    const modelTokensStyle = {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        opacity: 0.68,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
    };
    const modelCostStyle = {
        flex: '0 0 auto',
        minWidth: 58,
        textAlign: 'right',
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
    };
    const modelShareStyle = {
        flex: '0 0 auto',
        width: 34,
        textAlign: 'right',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        opacity: 0.62,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
    };
    const balanceHeadlineRowStyle = {
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        marginTop: 4,
    };
    const balanceHeadlineStyle = {
        fontSize: 18,
        fontWeight: 650,
        lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        fontVariantNumeric: 'tabular-nums',
    };
    const balanceHeadlineUnitStyle = {
        fontSize: 9,
        lineHeight: '13px',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        opacity: 0.6,
        whiteSpace: 'nowrap',
    };
    const balanceGridStyle = {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 6,
        marginTop: 7,
    };
    const balanceMetricStyle = {
        minWidth: 0,
    };
    const balanceMetricLabelStyle = {
        display: 'block',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 9,
        lineHeight: '13px',
        opacity: 0.66,
        whiteSpace: 'nowrap',
    };
    const balanceMetricValueStyle = {
        display: 'block',
        overflow: 'hidden',
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        fontSize: 12,
        lineHeight: '17px',
        fontWeight: 650,
        fontVariantNumeric: 'tabular-nums',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    };
    const budgetRowStyle = {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 9,
    };
    const dailyTargetStyle = {
        marginLeft: 'auto',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 10,
        lineHeight: '15px',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
    };
    const budgetCaptionRowStyle = {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
        marginTop: 4,
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 9,
        lineHeight: '13px',
        opacity: 0.78,
        fontVariantNumeric: 'tabular-nums',
    };
    const dangerTextStyle = {
        color: 'var(--dsw-alias-state-danger-primary, #f85149)',
    };
    const warnTextStyle = {
        color: 'var(--dsw-alias-state-warning-primary, #d29922)',
    };
    const tinyHintStyle = {
        marginTop: 6,
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 9,
        lineHeight: '13px',
        opacity: 0.62,
    };
    const syncRowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        marginTop: 6,
    };
    const syncStatusStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginLeft: 6,
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 9,
        lineHeight: '13px',
        opacity: 0.7,
        whiteSpace: 'nowrap',
    };
    const syncDotStyle = (color) => ({
        width: 5,
        height: 5,
        flex: '0 0 auto',
        borderRadius: 999,
        background: color,
    });
    const passwordInputStyle = {
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
    };
    const miniButtonStyle = {
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
    };
    const primaryMiniButtonStyle = {
        ...miniButtonStyle,
        borderColor: 'transparent',
        background: 'var(--dsw-alias-label-primary, CanvasText)',
        color: 'var(--dsw-alias-bg-overlay, Canvas)',
        fontWeight: 600,
    };
    const linkButtonStyle = {
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
    };
    const customPanelStyle = {
        marginBottom: 9,
        padding: '7px 8px',
        borderRadius: 7,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.09))',
    };
    const customDateRowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 5,
    };
    const dateInputStyle = {
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
    };
    const sessionCountStyle = {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 9,
        opacity: 0.64,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
    };
    const footerStyle = {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 5,
        marginTop: 10,
        paddingTop: 8,
        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22))',
    };
    const stopLabelStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: 'var(--dsw-alias-label-secondary, CanvasText)',
        fontSize: 9,
        lineHeight: '14px',
        whiteSpace: 'nowrap',
    };
    const stopInputStyle = {
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
    };
    // ---------------------------------------------------------------------------
    // The dock control. It renders the show/hide toggle and, when visible, the
    // portal'd HUD. The HUD's `useProjection` subscription lives here because the
    // dock slot is session-scoped; `shell.overlay` is root-scoped and has no
    // `useProjection` prop.
    // ---------------------------------------------------------------------------
    function formatUptime(seconds) {
        if (seconds < 60)
            return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60)
            return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m`;
    }
    const saverWrapStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 2,
    };
    const saverHeadlineStyle = {
        fontSize: 26,
        fontWeight: 650,
        lineHeight: 1.05,
        fontVariantNumeric: 'tabular-nums',
    };
    const saverHeadlineUnitStyle = {
        fontSize: 11,
        opacity: 0.7,
        marginLeft: 6,
    };
    const saverGridStyle = {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 6,
    };
    const saverMetricStyle = {
        minWidth: 0,
        padding: '6px 8px',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
    };
    const saverMetricLabelStyle = {
        display: 'block',
        fontSize: 10,
        lineHeight: 1.25,
        opacity: 0.66,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    };
    const saverMetricValueStyle = {
        display: 'block',
        marginTop: 2,
        fontSize: 13,
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    };
    const saverToggleRowStyle = {
        display: 'flex',
        gap: 6,
        alignItems: 'center',
    };
    const saverToggleStyle = (on) => ({
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
    });
    const saverRecentRowStyle = {
        display: 'grid',
        gridTemplateColumns: '38px minmax(0, 1fr) auto',
        gap: 6,
        alignItems: 'baseline',
        fontSize: 11,
        lineHeight: 1.35,
    };
    /**
     * The merged dsh-plugin-save-token dashboard. Everything is read from the
     * saver's own local `/save-token/api/dashboard` counters; no model calls, no
     * provider API.
     */
    function SaverPanel() {
        const [data, setData] = (0, react_1.useState)(null);
        const [error, setError] = (0, react_1.useState)(null);
        const [busy, setBusy] = (0, react_1.useState)(false);
        (0, react_1.useEffect)(() => {
            let cancelled = false;
            let timer = 0;
            const load = async () => {
                try {
                    const response = await fetch(SAVE_TOKEN_DASHBOARD_ENDPOINT, {
                        headers: { accept: 'application/json' },
                    });
                    if (!response.ok)
                        throw new Error(`HTTP ${response.status}`);
                    const payload = await response.json();
                    const normalized = normalizeSaverDashboard(payload);
                    if (cancelled)
                        return;
                    setData(normalized);
                    setError(normalized === null ? 'unexpected dashboard payload' : null);
                }
                catch (cause) {
                    if (cancelled)
                        return;
                    setError(cause instanceof Error ? cause.message : 'unavailable');
                }
                if (!cancelled)
                    timer = window.setTimeout(() => void load(), SAVER_REFRESH_MS);
            };
            void load();
            return () => {
                cancelled = true;
                window.clearTimeout(timer);
            };
        }, []);
        const toggle = async (key) => {
            if (data === null || busy)
                return;
            const next = !data.flags[key];
            setBusy(true);
            try {
                const response = await fetch(SAVE_TOKEN_TOGGLE_ENDPOINT, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ key, value: next }),
                });
                if (!response.ok)
                    throw new Error(`HTTP ${response.status}`);
                setData((previous) => previous === null ? previous : { ...previous, flags: { ...previous.flags, [key]: next } });
                setError(null);
            }
            catch (cause) {
                setError(cause instanceof Error ? cause.message : 'toggle failed');
            }
            finally {
                setBusy(false);
            }
        };
        if (data === null) {
            return ((0, jsx_runtime_1.jsxs)("div", { style: saverWrapStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: sectionTitleRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: sectionTitleStyle, children: "Token saver" }), (0, jsx_runtime_1.jsx)("span", { style: sectionValueStyle, children: "\u2014" })] }), (0, jsx_runtime_1.jsx)("div", { style: tinyHintStyle, children: error === null
                            ? 'Loading local save-token counters…'
                            : `Token saver unavailable (${error}). Install dsh-plugin-save-token to populate this tab.` })] }));
        }
        const compressedBytes = Math.max(0, data.compression.bytesBefore - data.compression.bytesAfter);
        const dedupeBytes = data.compression.dedupeSavedBytes;
        const recent = data.recent.slice(0, 4);
        return ((0, jsx_runtime_1.jsxs)("div", { style: saverWrapStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: sectionTitleRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: sectionTitleStyle, children: "Token saver" }), (0, jsx_runtime_1.jsxs)("span", { style: syncStatusStyle, title: `Local counters · uptime ${formatUptime(data.uptimeSec)}`, children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", style: syncDotStyle(data.flags.compress ? 'var(--dsw-alias-state-success-primary, #3fb950)' : 'var(--dsw-alias-label-secondary, #8b949e)') }), "live"] })] }), (0, jsx_runtime_1.jsxs)("div", { style: balanceHeadlineRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: saverHeadlineStyle, children: compactCount(data.totals.avoidedTokens) }), (0, jsx_runtime_1.jsx)("span", { style: saverHeadlineUnitStyle, children: "tokens avoided" })] }), (0, jsx_runtime_1.jsxs)("div", { style: tinyHintStyle, children: [data.reliefPct, "% of billed input relief \u00B7 no model calls, no provider sync"] }), (0, jsx_runtime_1.jsxs)("div", { style: saverGridStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: saverMetricStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: saverMetricLabelStyle, children: "Requests" }), (0, jsx_runtime_1.jsx)("span", { style: saverMetricValueStyle, children: compactCount(data.totals.requests) })] }), (0, jsx_runtime_1.jsxs)("div", { style: saverMetricStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: saverMetricLabelStyle, children: "Compressed" }), (0, jsx_runtime_1.jsx)("span", { style: saverMetricValueStyle, children: compactCount(data.compression.count) })] }), (0, jsx_runtime_1.jsxs)("div", { style: saverMetricStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: saverMetricLabelStyle, children: "Cache hit" }), (0, jsx_runtime_1.jsxs)("span", { style: saverMetricValueStyle, children: [data.cacheHitPct, "%"] })] }), (0, jsx_runtime_1.jsxs)("div", { style: saverMetricStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: saverMetricLabelStyle, children: "Lossless" }), (0, jsx_runtime_1.jsx)("span", { style: saverMetricValueStyle, children: compactCount(data.compression.losslessEncodes) })] }), (0, jsx_runtime_1.jsxs)("div", { style: saverMetricStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: saverMetricLabelStyle, children: "Dedupe hits" }), (0, jsx_runtime_1.jsx)("span", { style: saverMetricValueStyle, children: compactCount(data.compression.dedupeHits) })] }), (0, jsx_runtime_1.jsxs)("div", { style: saverMetricStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: saverMetricLabelStyle, children: "Bytes cut" }), (0, jsx_runtime_1.jsx)("span", { style: saverMetricValueStyle, children: formatBytes(compressedBytes + dedupeBytes) })] })] }), (0, jsx_runtime_1.jsxs)("div", { style: saverToggleRowStyle, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", disabled: busy, onClick: () => void toggle('compress'), style: saverToggleStyle(data.flags.compress), title: "Toggle dsh-plugin-save-token compression", children: ["compress ", data.flags.compress ? 'on' : 'off'] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", disabled: busy, onClick: () => void toggle('dedupe'), style: saverToggleStyle(data.flags.dedupe), title: "Toggle duplicate-output dedupe", children: ["dedupe ", data.flags.dedupe ? 'on' : 'off'] }), (0, jsx_runtime_1.jsxs)("span", { style: { ...tinyHintStyle, marginLeft: 'auto' }, children: [data.totals.auxRequests, " aux"] })] }), recent.length > 0 && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("div", { style: { ...tinyHintStyle, marginBottom: 3 }, children: "Recent" }), recent.map((row, index) => ((0, jsx_runtime_1.jsxs)("div", { style: saverRecentRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: { opacity: 0.6 }, children: row.ts > 0
                                        ? new Date(row.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                        : '—' }), (0, jsx_runtime_1.jsxs)("span", { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: [row.label || row.kind, row.detail !== '' ? (0, jsx_runtime_1.jsxs)("span", { style: { opacity: 0.6 }, children: [" \u00B7 ", row.detail] }) : null] }), (0, jsx_runtime_1.jsx)("span", { style: { opacity: 0.72 }, children: row.saved > 0 ? `-${compactCount(row.saved)}` : '—' })] }, `${row.ts}-${index}`)))] })), error !== null && ((0, jsx_runtime_1.jsx)("div", { style: { ...tinyHintStyle, ...dangerTextStyle }, children: error })), (0, jsx_runtime_1.jsx)("div", { style: tinyHintStyle, children: "Merged from dsh-plugin-save-token \u00B7 dashboard moved here so the composer stays clean." })] }));
    }
    function UsagePopControl(props) {
        const { useProjection, sessionId } = props;
        // Read the smallest slice we need. `tokenUsage` is `undefined` until the
        // session has a projected value (no session bound yet, or not yet loaded).
        // Normalize on every render instead of memoizing: it guarantees a fresh
        // reading even if a host mutates its projection object in place.
        const rawUsage = useProjection('tokenUsage');
        const usage = normalizeUsage(rawUsage);
        // The durable model selection: `{ lastUsed, next }` (or a bare selection on
        // older hosts). `lastUsed` is the route that produced settled tokens.
        const rawModelSelection = useProjection('modelSelection');
        const models = liveModelInfo(rawModelSelection);
        // The host's window caption band (Windows only) must never be part of the
        // draggable area. Recomputed on render so a fullscreen toggle recovers.
        const topInset = hudTopInset();
        const [visible, setVisible] = (0, react_1.useState)(() => readStoredFlag(VISIBLE_KEY, true));
        const [minimized, setMinimized] = (0, react_1.useState)(() => readStoredFlag(MINIMIZED_KEY, false));
        // Which face the HUD shows: the usage ledger or the merged token-saver
        // dashboard. Both share the same floating card, so the composer dock has
        // exactly one control.
        const [panel, setPanel] = (0, react_1.useState)('usage');
        // Local per-model / per-session token counters fetched from the tier router.
        // `null` means the router is absent or has not recorded a call yet.
        const [routedUsage, setRoutedUsage] = (0, react_1.useState)(null);
        const [position, setPosition] = (0, react_1.useState)(() => initialPosition(topInset));
        const [dragging, setDragging] = (0, react_1.useState)(false);
        const [timeframe, setTimeframe] = (0, react_1.useState)(() => readStoredChoice(TIMEFRAME_KEY, ['session', 'day', 'week', 'month', 'custom'], 'session'));
        const [customStart, setCustomStart] = (0, react_1.useState)(() => readStoredText(CUSTOM_START_KEY, localDateKey(Date.now() - 6 * DAY_MS)));
        const [customEnd, setCustomEnd] = (0, react_1.useState)(() => readStoredText(CUSTOM_END_KEY, localDateKey(Date.now())));
        const [runwayDraft, setRunwayDraft] = (0, react_1.useState)(() => String(readStoredNumber(TARGET_RUNWAY_KEY, DEFAULT_TARGET_RUNWAY_DAYS)));
        // Drives the live peak/off-peak countdown, the calendar boundaries and the
        // "synced Nm ago" label.
        const [nowMs, setNowMs] = (0, react_1.useState)(() => Date.now());
        // DOM fallbacks for hosts whose model/session/title projections are absent.
        const [domModel, setDomModel] = (0, react_1.useState)(null);
        const [domSessionId, setDomSessionId] = (0, react_1.useState)(null);
        const [domSessionTitle, setDomSessionTitle] = (0, react_1.useState)({ sessionKey: null, title: null });
        // The universal ledger database. `ledgerRef` mirrors the state so a rapid
        // sequence of projection updates can never race a React state write.
        const [ledgerEntries, setLedgerEntries] = (0, react_1.useState)(() => readLedgerDatabase());
        const ledgerRef = (0, react_1.useRef)(ledgerEntries);
        const [balanceMeta, setBalanceMeta] = (0, react_1.useState)(() => readBalanceMeta());
        const [balanceHistory, setBalanceHistory] = (0, react_1.useState)(() => {
            const stored = readBalanceHistory();
            if (stored.length > 0)
                return stored;
            const meta = readBalanceMeta();
            return meta === null ? [] : [{ at: meta.syncedAt, balanceRmb: meta.balanceRmb }];
        });
        const [apiKey, setApiKey] = (0, react_1.useState)(() => readApiKey());
        const [apiKeyDraft, setApiKeyDraft] = (0, react_1.useState)('');
        const [keyEditorOpen, setKeyEditorOpen] = (0, react_1.useState)(false);
        const [syncing, setSyncing] = (0, react_1.useState)(false);
        const [syncError, setSyncError] = (0, react_1.useState)(null);
        const [syncNotice, setSyncNotice] = (0, react_1.useState)(null);
        const [dataMessage, setDataMessage] = (0, react_1.useState)(null);
        const hudRef = (0, react_1.useRef)(null);
        const positionRef = (0, react_1.useRef)(position);
        const dragRef = (0, react_1.useRef)(null);
        const fileInputRef = (0, react_1.useRef)(null);
        const syncInFlightRef = (0, react_1.useRef)(false);
        const lastSyncAttemptRef = (0, react_1.useRef)(0);
        const propSessionId = sessionId == null ? null : String(sessionId);
        const sessionKey = propSessionId ?? domSessionId;
        const currentModel = models.selected ?? domModel;
        const lastUsedModel = models.used ?? domModel;
        const runtimeTitle = runtimeSessionTitle(props);
        const sessionTitle = runtimeTitle ??
            (domSessionTitle.sessionKey === sessionKey ? domSessionTitle.title : null) ??
            (sessionKey === null ? 'No active chat' : `Chat ${sessionKey.slice(0, 8)}`);
        const activeTotal = usage === null ? 0 : usageTotal(usage);
        const contextBloat = activeTotal > CONTEXT_BLOAT_TOKENS;
        const naturalPeak = isPeakUtc(new Date(nowMs));
        const targetRunwayDays = (0, react_1.useMemo)(() => {
            const parsed = Number(runwayDraft);
            if (!Number.isFinite(parsed) || parsed < 1)
                return DEFAULT_TARGET_RUNWAY_DAYS;
            return Math.min(MAX_TARGET_RUNWAY_DAYS, parsed);
        }, [runwayDraft]);
        const dayStart = startOfLocalDay(nowMs);
        const dayEnd = startOfNextLocalDay(nowMs);
        const weekStart = startOfLocalWeek(nowMs);
        const monthStart = startOfLocalMonth(nowMs);
        const customStartMs = parseLocalDate(customStart);
        const customEndMs = parseLocalDate(customEnd);
        const customEndExclusive = customEndMs === null ? null : startOfNextLocalDay(customEndMs);
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
        const selectedEntries = (0, react_1.useMemo)(() => {
            if (timeframe === 'session') {
                if (sessionKey === null)
                    return [];
                return ledgerEntries.filter((entry) => entry.sessionId === sessionKey);
            }
            if (timeframe === 'day') {
                return ledgerEntries.filter((entry) => entry.at >= dayStart && entry.at < dayEnd);
            }
            if (timeframe === 'week') {
                return ledgerEntries.filter((entry) => entry.at >= weekStart);
            }
            if (timeframe === 'month') {
                return ledgerEntries.filter((entry) => entry.at >= monthStart);
            }
            // Custom: inclusive local calendar dates, global across every chat.
            if (customStartMs === null || customEndExclusive === null)
                return [];
            return ledgerEntries.filter((entry) => entry.at >= customStartMs && entry.at < customEndExclusive);
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
        ]);
        /** True when the active tab must not be scoped to the open chat. */
        const isGlobalScope = timeframe !== 'session';
        const selectedLedgerUsage = (0, react_1.useMemo)(() => sumUsage(selectedEntries), [selectedEntries]);
        // The Session view shows the host's cumulative projection so tokens earned
        // before this plugin first anchored the chat are still visible. Other views
        // are pure ledger slices (incremental deltas only).
        const displayedUsage = timeframe === 'session' && usage !== null && usageTotal(usage) > 0
            ? usage
            : selectedLedgerUsage;
        const displayedTotal = usageTotal(displayedUsage);
        const untrackedTokens = timeframe === 'session' ? Math.max(0, activeTotal - usageTotal(selectedLedgerUsage)) : 0;
        const hitRatio = (() => {
            const input = displayedUsage.uncachedInputTokens + displayedUsage.cacheReadTokens;
            return input > 0 ? displayedUsage.cacheReadTokens / input : null;
        })();
        const trueSelectedCost = (0, react_1.useMemo)(() => selectedEntries.reduce((sum, entry) => sum + entryCostRmb(entry), 0), [selectedEntries]);
        const displaySavings = (0, react_1.useMemo)(() => selectedEntries.reduce((sum, entry) => sum + cacheSavingsRmb(entry.usage, entry.model, entry.tier === 'peak'), 0), [selectedEntries]);
        const modelTokens = (0, react_1.useMemo)(() => {
            const totals = { flash: 0, pro: 0, search: 0 };
            for (const entry of selectedEntries)
                totals[entry.model] += usageTotal(entry.usage);
            return totals;
        }, [selectedEntries]);
        const modelRows = (0, react_1.useMemo)(() => {
            const costs = { flash: 0, pro: 0, search: 0 };
            for (const entry of selectedEntries)
                costs[entry.model] += entryCostRmb(entry);
            const total = costs.flash + costs.pro + costs.search > 0
                ? costs.flash + costs.pro + costs.search
                : trueSelectedCost;
            const ids = ['flash', 'pro', 'search'];
            return ids.map((id) => ({
                id,
                label: MODEL_LABELS[id],
                color: MODEL_COLORS[id],
                tokens: modelTokens[id],
                costRmb: costs[id],
                share: total > 0 ? costs[id] / total : 0,
            }));
        }, [modelTokens, selectedEntries, trueSelectedCost]);
        // Actual routes that answered this session (DeepSeek + any fetch-boy route).
        // Only available when the patched tier router is loaded; otherwise the
        // DeepSeek ledger breakdown above is the fallback.
        const routedTier = peakTier(naturalPeak);
        const routedRows = (0, react_1.useMemo)(() => {
            if (routedUsage === null || sessionKey === null)
                return null;
            const session = routedUsage.sessions[sessionKey];
            if (session === undefined)
                return null;
            const rows = routedRowsOf(session.byModel, routedTier);
            return rows.length > 0 ? rows : null;
        }, [routedUsage, sessionKey, routedTier]);
        const routedSessionTokens = (0, react_1.useMemo)(() => (routedRows === null ? 0 : routedRows.reduce((sum, row) => sum + row.tokens, 0)), [routedRows]);
        const workerRows = (0, react_1.useMemo)(() => (routedUsage === null ? [] : routedRowsOf(routedUsage.workers, routedTier)), [routedUsage, routedTier]);
        const workerTokens = (0, react_1.useMemo)(() => workerRows.reduce((sum, row) => sum + row.tokens, 0), [workerRows]);
        const flashUsed = modelTokens.flash > 0;
        const proUsed = modelTokens.pro > 0;
        const usedLabel = flashUsed && proUsed ? 'Mixed' : proUsed ? 'Pro' : flashUsed ? 'Flash' : null;
        const liveLabel = usedLabel ?? (currentModel === 'pro' ? 'Pro' : currentModel === 'flash' ? 'Flash' : null);
        const badgeText = `Live · ${liveLabel ?? '—'}`;
        const badgeTitle = `True tracked cost. Flash ${exactCount(modelTokens.flash)} tok · Pro ${exactCount(modelTokens.pro)} tok. Each delta is priced at the model and UTC peak/off-peak tier active when it arrived.`;
        const estimatedTurns = displayedUsage.outputTokens <= 0
            ? null
            : Math.ceil(displayedUsage.outputTokens / TURN_OUTPUT_TOKENS);
        const burnPerTurn = estimatedTurns === null ? null : trueSelectedCost / estimatedTurns;
        const liveSessionCost = (0, react_1.useMemo)(() => ledgerEntries.reduce((sum, entry) => (entry.sessionId === sessionKey ? sum + entryCostRmb(entry) : sum), 0), [ledgerEntries, sessionKey]);
        const todaySpend = (0, react_1.useMemo)(() => ledgerEntries.reduce((sum, entry) => entry.at >= dayStart && entry.at < dayEnd ? sum + entryCostRmb(entry) : sum, 0), [ledgerEntries, dayStart, dayEnd]);
        const trueBalance = balanceMeta === null ? null : balanceMeta.balanceRmb;
        // Trailing burn is normalised by the real span it covers, so a brand-new
        // ledger does not report a 1/7th-of-reality burn rate.
        const burnTelemetry = (0, react_1.useMemo)(() => {
            const floor = nowMs - 7 * DAY_MS;
            let spend = 0;
            let oldest = nowMs;
            for (const entry of ledgerEntries) {
                if (entry.at < floor)
                    continue;
                spend += entryCostRmb(entry);
                if (entry.at < oldest)
                    oldest = entry.at;
            }
            const spanDays = Math.min(7, Math.max(1, (nowMs - oldest) / DAY_MS));
            return { spend, spanDays, averageDailySpend: spend / spanDays };
        }, [ledgerEntries, nowMs]);
        const averageDailySpend = burnTelemetry.averageDailySpend;
        const runwayDays = trueBalance === null
            ? null
            : trueBalance <= 0
                ? 0
                : averageDailySpend <= 0
                    ? Number.POSITIVE_INFINITY
                    : trueBalance / averageDailySpend;
        const runwayLabel = runwayDays === null
            ? '—'
            : runwayDays === Number.POSITIVE_INFINITY
                ? 'no burn'
                : runwayDays <= 0
                    ? 'empty'
                    : runwayDays < 1
                        ? `${Math.max(1, Math.round(runwayDays * 24))}h`
                        : runwayDays >= 100
                            ? '99+ d'
                            : `${runwayDays.toFixed(runwayDays < 10 ? 1 : 0)} d`;
        // Dynamic daily budget: the true API balance spread across the target runway.
        const dailyTargetBudget = trueBalance !== null && targetRunwayDays > 0 ? trueBalance / targetRunwayDays : null;
        const budgetRatio = dailyTargetBudget === null
            ? null
            : dailyTargetBudget > 0
                ? todaySpend / dailyTargetBudget
                : todaySpend > 0
                    ? Number.POSITIVE_INFINITY
                    : 0;
        const budgetPercentLabel = budgetRatio === null
            ? '—'
            : Number.isFinite(budgetRatio)
                ? percent(budgetRatio)
                : '∞';
        const balanceSampledAt = balanceMeta === null ? null : balanceMeta.syncedAt;
        const postSyncSpend = (0, react_1.useMemo)(() => balanceSampledAt === null
            ? 0
            : ledgerEntries.reduce((sum, entry) => (entry.at >= balanceSampledAt ? sum + entryCostRmb(entry) : sum), 0), [ledgerEntries, balanceSampledAt]);
        const periodWindowStart = (0, react_1.useMemo)(() => {
            if (timeframe === 'day')
                return dayStart;
            if (timeframe === 'week')
                return weekStart;
            if (timeframe === 'month')
                return monthStart;
            if (timeframe === 'custom')
                return customStartMs;
            if (timeframe === 'session') {
                let oldest = null;
                for (const entry of selectedEntries) {
                    if (oldest === null || entry.at < oldest)
                        oldest = entry.at;
                }
                return oldest;
            }
            return null;
        }, [timeframe, dayStart, weekStart, monthStart, customStartMs, selectedEntries]);
        // "True period spend" is the API's own balance movement, not local math.
        const apiPeriodSpend = (0, react_1.useMemo)(() => apiSpendInWindow(balanceHistory, trueBalance, periodWindowStart, nowMs), [balanceHistory, trueBalance, periodWindowStart, nowMs]);
        const ledgerPeriodSpend = trueSelectedCost;
        const periodSpendIsEstimate = apiPeriodSpend === null;
        const periodSpendLabel = apiPeriodSpend === null
            ? ledgerPeriodSpend > 0
                ? `≈ ${yuan(ledgerPeriodSpend)}`
                : '—'
            : yuan(apiPeriodSpend);
        const reconciliationDrift = apiPeriodSpend === null ? null : apiPeriodSpend - ledgerPeriodSpend;
        const elapsedDays = (0, react_1.useMemo)(() => {
            if (periodWindowStart === null)
                return 1;
            return Math.max(1 / 24, (nowMs - periodWindowStart) / DAY_MS);
        }, [periodWindowStart, nowMs]);
        const trackedSessions = (0, react_1.useMemo)(() => {
            const map = new Map();
            for (const entry of ledgerEntries) {
                const existing = map.get(entry.sessionId);
                if (existing === undefined) {
                    map.set(entry.sessionId, {
                        sessionId: entry.sessionId,
                        title: entry.sessionTitle,
                        tokens: usageTotal(entry.usage),
                        costRmb: entryCostRmb(entry),
                        lastAt: entry.at,
                    });
                    continue;
                }
                existing.title = entry.sessionTitle;
                existing.tokens += usageTotal(entry.usage);
                existing.costRmb += entryCostRmb(entry);
                existing.lastAt = Math.max(existing.lastAt, entry.at);
            }
            if (sessionKey !== null) {
                const current = map.get(sessionKey);
                if (current === undefined) {
                    map.set(sessionKey, {
                        sessionId: sessionKey,
                        title: sessionTitle,
                        tokens: activeTotal,
                        costRmb: 0,
                        lastAt: Date.now(),
                    });
                }
                else {
                    current.title = sessionTitle;
                    current.tokens = Math.max(current.tokens, activeTotal);
                }
            }
            return Array.from(map.values()).sort((left, right) => right.lastAt - left.lastAt);
        }, [ledgerEntries, sessionKey, sessionTitle, activeTotal]);
        const nextSwitch = (0, react_1.useMemo)(() => nextRateSwitch(nowMs), [nowMs]);
        const countdown = formatClockCountdown(nextSwitch.at - nowMs);
        const countdownLabel = `${nextSwitch.tier === 'peak' ? 'Peak' : 'Off-Peak'} in ${countdown}`;
        const timeframeLabel = timeframe === 'session'
            ? 'Session'
            : timeframe === 'day'
                ? 'Today'
                : timeframe === 'week'
                    ? 'This week'
                    : timeframe === 'month'
                        ? 'This month'
                        : 'Custom range';
        const syncStatusColor = syncing
            ? 'var(--dsw-alias-state-success-primary, #3fb950)'
            : syncError !== null
                ? 'var(--dsw-alias-state-danger-primary, #f85149)'
                : balanceMeta === null
                    ? 'var(--dsw-alias-state-idle-primary, GrayText)'
                    : nowMs - balanceMeta.syncedAt > BALANCE_REFRESH_MS * 2
                        ? 'var(--dsw-alias-state-warning-primary, #d29922)'
                        : 'var(--dsw-alias-state-success-primary, #3fb950)';
        const syncStatusLabel = apiKey.length === 0
            ? 'auto-sync off'
            : syncing
                ? 'syncing…'
                : syncError !== null
                    ? 'sync error'
                    : balanceMeta === null
                        ? 'waiting for first sync'
                        : `synced ${formatAgo(nowMs - balanceMeta.syncedAt)}`;
        // --- persistence effects --------------------------------------------------
        (0, react_1.useEffect)(() => {
            writeStored(VISIBLE_KEY, visible ? '1' : '0');
        }, [visible]);
        (0, react_1.useEffect)(() => {
            writeStored(MINIMIZED_KEY, minimized ? '1' : '0');
        }, [minimized]);
        (0, react_1.useEffect)(() => {
            writeStored(TIMEFRAME_KEY, timeframe);
        }, [timeframe]);
        (0, react_1.useEffect)(() => {
            writeStored(CUSTOM_START_KEY, customStart);
        }, [customStart]);
        (0, react_1.useEffect)(() => {
            writeStored(CUSTOM_END_KEY, customEnd);
        }, [customEnd]);
        (0, react_1.useEffect)(() => {
            writeStored(TARGET_RUNWAY_KEY, String(targetRunwayDays));
        }, [targetRunwayDays]);
        // Poll the tier router's LOCAL per-model counters. The router only records
        // what its adapters reported, so this works for Google/Z.ai routes too with
        // no provider API. Failure is non-fatal: the DeepSeek ledger breakdown stays.
        (0, react_1.useEffect)(() => {
            if (!visible || minimized || panel !== 'usage')
                return;
            let cancelled = false;
            let timer = 0;
            const load = async () => {
                try {
                    const response = await fetch(ROUTER_USAGE_ENDPOINT, {
                        headers: { accept: 'application/json' },
                    });
                    if (response.ok) {
                        const payload = await response.json();
                        const record = typeof payload === 'object' && payload !== null
                            ? payload
                            : {};
                        const normalized = normalizeRoutedUsage(record.usage);
                        if (!cancelled)
                            setRoutedUsage(normalized);
                    }
                }
                catch {
                    // Router absent or still booting; keep the last snapshot.
                }
                if (!cancelled)
                    timer = window.setTimeout(() => void load(), ROUTER_USAGE_REFRESH_MS);
            };
            void load();
            return () => {
                cancelled = true;
                window.clearTimeout(timer);
            };
        }, [visible, minimized, panel, sessionKey]);
        // Fold any legacy per-session ledgers into the global database once on mount.
        (0, react_1.useEffect)(() => {
            const database = mergeLedger(ledgerRef.current, migrateLegacyLedgers());
            ledgerRef.current = database;
            setLedgerEntries(database);
            notifyLedgerChanged();
        }, []);
        // Seed the balance history from the last persisted sync. Without this the
        // first new 5-minute sample would replace the only point we have, making the
        // API-measured period spend unavailable until two more syncs have passed.
        (0, react_1.useEffect)(() => {
            const meta = readBalanceMeta();
            if (meta === null)
                return;
            if (readBalanceHistory().length > 0)
                return;
            writeBalanceHistory([{ at: meta.syncedAt, balanceRmb: meta.balanceRmb }]);
        }, []);
        // Keep every HUD instance and tab on the same database, balance and key.
        (0, react_1.useEffect)(() => {
            const refreshLedger = () => {
                try {
                    // Distinguish "storage unavailable" from "legitimately empty": a
                    // throwing read must not blank the in-memory ledger.
                    window.localStorage.getItem(UNIVERSAL_LEDGER_KEY);
                }
                catch {
                    return;
                }
                const next = readLedgerDatabase();
                ledgerRef.current = next;
                setLedgerEntries(next);
            };
            const refreshBalance = () => {
                setBalanceMeta(readBalanceMeta());
                setBalanceHistory(readBalanceHistory());
                setApiKey(readApiKey());
            };
            const onStorage = (event) => {
                if (event.key === null || /ledger/i.test(event.key))
                    refreshLedger();
                else if (event.key === BALANCE_KEY ||
                    event.key === BALANCE_HISTORY_KEY ||
                    event.key === API_KEY_KEY) {
                    refreshBalance();
                }
            };
            const onLocalLedger = () => refreshLedger();
            window.addEventListener('storage', onStorage);
            window.addEventListener(LEDGER_EVENT, onLocalLedger);
            const channel = ledgerChannel();
            channel?.addEventListener('message', onLocalLedger);
            return () => {
                window.removeEventListener('storage', onStorage);
                window.removeEventListener(LEDGER_EVENT, onLocalLedger);
                channel?.removeEventListener('message', onLocalLedger);
            };
        }, []);
        // --- true delta attribution ----------------------------------------------
        // Runs on every cumulative usage change; a zero or negative delta only
        // resyncs the anchor (and never invents a refund). Anchors are re-read from
        // storage before every write so sibling HUD instances cannot clobber them.
        (0, react_1.useEffect)(() => {
            if (sessionKey === null || usage === null)
                return;
            const anchors = readAnchors();
            const anchor = anchors[sessionKey];
            const attributed = lastUsedModel ?? currentModel ?? anchor?.lastModel ?? 'flash';
            const saveAnchor = (next) => {
                anchors[next.sessionId] = next;
                writeAnchors(anchors);
            };
            if (anchor === undefined) {
                // First sight of this Session: anchor at the current totals, record no
                // cost. Everything after this point is a true incremental delta.
                saveAnchor({
                    sessionId: sessionKey,
                    sessionTitle,
                    lastUsage: usage,
                    lastModel: attributed,
                    updatedAt: Date.now(),
                });
                return;
            }
            const delta = usageDelta(usage, anchor.lastUsage);
            const titleChanged = anchor.sessionTitle !== sessionTitle;
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
                    });
                }
                return;
            }
            if (isZeroUsage(delta)) {
                if (!sameUsage(usage, anchor.lastUsage) || anchor.lastModel !== attributed || titleChanged) {
                    saveAnchor({
                        ...anchor,
                        sessionTitle,
                        lastUsage: usage,
                        lastModel: attributed,
                        updatedAt: Date.now(),
                    });
                    if (titleChanged) {
                        const updated = mergeLedger(ledgerRef.current, readLedgerDatabase()).map((entry) => entry.sessionId === sessionKey ? { ...entry, sessionTitle } : entry);
                        writeUniversalLedger(updated);
                        ledgerRef.current = updated;
                        setLedgerEntries(updated);
                        notifyLedgerChanged();
                    }
                }
                return;
            }
            const at = Date.now();
            const tier = peakTier(isPeakUtc(new Date(at)));
            const entry = {
                id: makeEntryId(),
                sessionId: sessionKey,
                sessionTitle,
                date: localDateKey(at),
                model: attributed,
                tier,
                usage: delta,
                costRmb: usageCostRmb(delta, attributed, tier === 'peak'),
                at,
            };
            // Merge with a fresh read (and the in-memory copy, in case storage is
            // briefly unavailable) so entries written by another HUD instance or tab
            // between renders are never overwritten.
            const nextEntries = mergeLedger(mergeLedger(ledgerRef.current, readLedgerDatabase()), [entry]);
            writeUniversalLedger(nextEntries);
            ledgerRef.current = nextEntries;
            setLedgerEntries(nextEntries);
            notifyLedgerChanged();
            saveAnchor({
                sessionId: sessionKey,
                sessionTitle,
                lastUsage: usage,
                lastModel: attributed,
                updatedAt: at,
            });
        }, [usage, sessionKey, lastUsedModel, currentModel, sessionTitle]);
        // Keep the DOM fallbacks current without reading transcript text: model-seat
        // contributions write data-model-id / data-provider-id and aria-label, and
        // the active session row/header supplies a best-effort id and title.
        (0, react_1.useEffect)(() => {
            if (typeof document === 'undefined' || typeof window === 'undefined')
                return;
            let frame = 0;
            const refresh = () => {
                frame = 0;
                const nextModel = modelFromDom();
                setDomModel((previous) => (previous === nextModel ? previous : nextModel));
                const nextSessionId = activeSessionIdFromDom();
                setDomSessionId((previous) => (previous === nextSessionId ? previous : nextSessionId));
                const nextTitle = sessionTitleFromDom(sessionKey);
                setDomSessionTitle((previous) => previous.sessionKey === sessionKey && previous.title === nextTitle
                    ? previous
                    : { sessionKey, title: nextTitle });
            };
            const schedule = () => {
                if (frame !== 0)
                    return;
                frame = window.requestAnimationFrame(refresh);
            };
            schedule();
            const observer = new MutationObserver(schedule);
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
            });
            const timer = window.setInterval(schedule, 1_500);
            return () => {
                observer.disconnect();
                window.clearInterval(timer);
                if (frame !== 0)
                    window.cancelAnimationFrame(frame);
            };
        }, [sessionKey]);
        // One-second tick keeps the countdown, budget caption and sync age live.
        (0, react_1.useEffect)(() => {
            const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
            return () => window.clearInterval(timer);
        }, []);
        // --- automatic true-balance sync -----------------------------------------
        async function syncBalance(keyRaw) {
            const key = keyRaw.trim();
            if (key.length === 0)
                return;
            const attemptedAt = Date.now();
            if (attemptedAt - lastSyncAttemptRef.current < 2_000)
                return;
            lastSyncAttemptRef.current = attemptedAt;
            if (syncInFlightRef.current)
                return;
            syncInFlightRef.current = true;
            setSyncing(true);
            setSyncError(null);
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), 15_000);
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
                });
                if (!response.ok)
                    throw new Error(`HTTP ${response.status}`);
                const payload = await response.json();
                const infos = isRecord(payload) && Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
                let cny = null;
                for (const candidate of infos) {
                    if (!isRecord(candidate))
                        continue;
                    if (String(candidate.currency ?? '').toUpperCase() === 'CNY') {
                        cny = candidate;
                        break;
                    }
                }
                if (cny === null)
                    throw new Error('no CNY balance entry in the response');
                const rawBalance = cny.total_balance;
                const balanceRmb = typeof rawBalance === 'number' ? rawBalance : Number.parseFloat(String(rawBalance));
                if (!Number.isFinite(balanceRmb))
                    throw new Error('CNY total_balance was not a number');
                const at = Date.now();
                const meta = { balanceRmb, syncedAt: at, currency: 'CNY' };
                writeStored(BALANCE_KEY, JSON.stringify(meta));
                setBalanceMeta(meta);
                setBalanceHistory(appendBalancePoint(balanceRmb, at));
                setSyncError(null);
                setSyncNotice(null);
            }
            catch (error) {
                const detail = error instanceof DOMException && error.name === 'AbortError'
                    ? 'request timed out'
                    : error instanceof Error
                        ? error.message
                        : 'network error';
                setSyncError(`Auto-sync failed: ${detail}`);
            }
            finally {
                window.clearTimeout(timeout);
                syncInFlightRef.current = false;
                setSyncing(false);
            }
        }
        // Fetch on load / key change, then every 5 minutes. Re-checking when the tab
        // becomes visible catches up after the browser throttled background timers.
        // A failed sync is retried on the next 5-minute tick instead of disabling the
        // scheduler, so a transient 401/offline window cannot silently stop sync.
        (0, react_1.useEffect)(() => {
            if (apiKey.length === 0)
                return;
            let disposed = false;
            const tick = () => {
                if (disposed)
                    return;
                void syncBalance(apiKey);
            };
            tick();
            const timer = window.setInterval(tick, BALANCE_REFRESH_MS);
            const onVisibility = () => {
                if (document.visibilityState === 'visible')
                    tick();
            };
            document.addEventListener('visibilitychange', onVisibility);
            window.addEventListener('online', tick);
            return () => {
                disposed = true;
                window.clearInterval(timer);
                document.removeEventListener('visibilitychange', onVisibility);
                window.removeEventListener('online', tick);
            };
            // `syncBalance` only touches refs and state setters, so the key is the only
            // meaningful dependency here.
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [apiKey]);
        // --- drag handling -------------------------------------------------------
        const rememberPosition = (next) => {
            positionRef.current = next;
            setPosition(next);
        };
        // Re-clamp after the card mounts, expands, or is shown again. The card's
        // measured size decides the lower bound, so the first render from storage is
        // corrected before paint.
        (0, react_1.useLayoutEffect)(() => {
            if (!visible)
                return;
            const card = hudRef.current;
            if (card === null)
                return;
            const rect = card.getBoundingClientRect();
            const next = clampPosition(positionRef.current.x, positionRef.current.y, rect.width, rect.height, topInset);
            if (next.x !== positionRef.current.x || next.y !== positionRef.current.y) {
                rememberPosition(next);
                persistPosition(next);
            }
        }, [visible, minimized, usage === null, timeframe, keyEditorOpen, apiKey.length, topInset]);
        // A viewport resize must not strand the HUD off-screen.
        (0, react_1.useEffect)(() => {
            const onResize = () => {
                const card = hudRef.current;
                if (card === null)
                    return;
                const rect = card.getBoundingClientRect();
                const next = clampPosition(positionRef.current.x, positionRef.current.y, rect.width, rect.height, topInset);
                if (next.x !== positionRef.current.x || next.y !== positionRef.current.y) {
                    rememberPosition(next);
                    persistPosition(next);
                }
            };
            window.addEventListener('resize', onResize);
            return () => window.removeEventListener('resize', onResize);
        }, [topInset]);
        const toggleVisible = () => setVisible((current) => !current);
        const toggleMinimized = () => setMinimized((current) => !current);
        const handleDragStart = (event) => {
            if (event.button !== 0)
                return;
            const target = event.target;
            if (target instanceof Element && target.closest('[data-usage-hud-no-drag]') !== null)
                return;
            const card = hudRef.current;
            if (card === null)
                return;
            const rect = card.getBoundingClientRect();
            dragRef.current = {
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startX: positionRef.current.x,
                startY: positionRef.current.y,
                width: rect.width,
                height: rect.height,
            };
            setDragging(true);
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
        };
        const handleDragMove = (event) => {
            const drag = dragRef.current;
            if (drag === null || drag.pointerId !== event.pointerId)
                return;
            const next = clampPosition(drag.startX + (event.clientX - drag.startClientX), drag.startY + (event.clientY - drag.startClientY), drag.width, drag.height, topInset);
            rememberPosition(next);
        };
        const finishDrag = (event) => {
            const drag = dragRef.current;
            if (drag === null || drag.pointerId !== event.pointerId)
                return;
            dragRef.current = null;
            setDragging(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
            persistPosition(positionRef.current);
        };
        const handleLostPointerCapture = () => {
            if (dragRef.current === null)
                return;
            dragRef.current = null;
            setDragging(false);
            persistPosition(positionRef.current);
        };
        // --- ledger portability --------------------------------------------------
        const saveApiKey = () => {
            const key = apiKeyDraft.trim();
            if (key.length === 0)
                return;
            writeStored(API_KEY_KEY, encodeApiKey(key));
            lastSyncAttemptRef.current = 0;
            setApiKey(key);
            setApiKeyDraft('');
            setKeyEditorOpen(false);
            setSyncError(null);
            setSyncNotice('API key saved — the true balance now auto-syncs every 5 minutes.');
            // The key-change effect performs the immediate fetch; this direct call also
            // covers re-saving the same key after a transient failure.
            void syncBalance(key);
        };
        const forgetApiKey = () => {
            removeStored(API_KEY_KEY);
            removeStored(BALANCE_KEY);
            removeStored(BALANCE_HISTORY_KEY);
            setApiKey('');
            setApiKeyDraft('');
            setKeyEditorOpen(true);
            setBalanceMeta(null);
            setBalanceHistory([]);
            setSyncNotice(null);
            setSyncError(null);
        };
        const exportLedger = () => {
            const payload = {
                format: 'usage-popup.universal-ledger',
                version: 3,
                exportedAt: new Date().toISOString(),
                entries: ledgerRef.current,
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `usage-popup-ledger-${localDateKey(Date.now())}.json`;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
            setDataMessage(`Exported ${ledgerRef.current.length.toLocaleString()} ledger entries.`);
        };
        const importLedger = async (event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            input.value = '';
            if (file === undefined)
                return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                const rawEntries = Array.isArray(parsed)
                    ? parsed
                    : isRecord(parsed) && Array.isArray(parsed.entries)
                        ? parsed.entries
                        : null;
                if (rawEntries === null)
                    throw new Error('No ledger entries array found in the JSON.');
                const imported = [];
                for (const candidate of rawEntries) {
                    // Imported rows without a session id are still real spend: attribute them
                    // to a synthetic chat so the global Day / Week / Month totals include them.
                    const entry = normalizeEntry(candidate, 'imported:ledger');
                    if (entry !== null)
                        imported.push(entry);
                }
                if (imported.length === 0)
                    throw new Error('The file contained no valid ledger entries.');
                const current = mergeLedger(ledgerRef.current, readLedgerDatabase());
                const merged = mergeLedger(current, imported);
                writeUniversalLedger(merged);
                ledgerRef.current = merged;
                setLedgerEntries(merged);
                notifyLedgerChanged();
                setDataMessage(`Imported ${(merged.length - current.length).toLocaleString()} new entries (${(imported.length - (merged.length - current.length)).toLocaleString()} duplicates skipped).`);
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : 'Unknown import error.';
                setDataMessage(`Import failed: ${detail}`);
            }
        };
        const resetLogs = () => {
            if (!window.confirm('Clear every locally recorded usage log? The API balance sync, balance history and HUD settings are kept.')) {
                return;
            }
            writeUniversalLedger([]);
            ledgerRef.current = [];
            setLedgerEntries([]);
            notifyLedgerChanged();
            const freshAnchors = {};
            if (sessionKey !== null && usage !== null) {
                freshAnchors[sessionKey] = {
                    sessionId: sessionKey,
                    sessionTitle,
                    lastUsage: usage,
                    lastModel: lastUsedModel ?? currentModel ?? 'flash',
                    updatedAt: Date.now(),
                };
            }
            writeAnchors(freshAnchors);
            try {
                const storage = window.localStorage;
                const doomed = [];
                for (let index = 0; index < storage.length; index += 1) {
                    const key = storage.key(index);
                    if (key === null || key === UNIVERSAL_LEDGER_KEY)
                        continue;
                    if (!key.startsWith('usage-popup.'))
                        continue;
                    if (/ledger/i.test(key))
                        doomed.push(key);
                }
                for (const key of doomed)
                    storage.removeItem(key);
            }
            catch {
                // Best-effort cleanup of the old per-session keys.
            }
            setDataMessage('Local usage logs cleared. The current session is re-anchored.');
        };
        const breakdown = [
            ['Uncached input', displayedUsage.uncachedInputTokens],
            ['Cache read', displayedUsage.cacheReadTokens],
            ['Cache write', displayedUsage.cacheWriteTokens],
            ['Output', displayedUsage.outputTokens],
        ];
        const customDays = customStart.length > 0 && customEnd.length > 0 ? inclusiveDays(customStart, customEnd) : 1;
        return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: "usage-popup", "data-composer-stat": "usage-popup", "aria-pressed": visible, "aria-label": visible ? 'Hide the token usage HUD' : 'Show the token usage HUD', title: visible ? 'Hide token usage HUD' : 'Show token usage HUD', onClick: toggleVisible, style: dockButtonStyle(visible), children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", style: dockDotStyle(visible) }), (0, jsx_runtime_1.jsx)("span", { style: contextBloat ? bloatTextStyle : undefined, children: activeTotal === 0 ? 'Usage: —' : `Usage: ${compactCount(activeTotal)} tok` }), (0, jsx_runtime_1.jsx)("span", { style: dockStateStyle, children: visible ? 'HUD on' : 'HUD off' })] }), visible && (0, react_dom_1.createPortal)((0, jsx_runtime_1.jsxs)("div", { ref: hudRef, className: "usage-popup__hud", "data-usage-popup-hud": "", role: "region", "aria-label": "True-sync universal multi-chat token usage and RMB cost ledger", style: hudStyle(position, minimized, dragging, topInset), children: [(0, jsx_runtime_1.jsxs)("div", { className: "usage-popup__hud-handle", style: handleStyle(minimized, dragging), title: "Drag to move", onPointerDown: handleDragStart, onPointerMove: handleDragMove, onPointerUp: finishDrag, onPointerCancel: finishDrag, onLostPointerCapture: handleLostPointerCapture, children: [(0, jsx_runtime_1.jsx)("span", { style: gripStyle, "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)(GripGlyph, {}) }), minimized ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { style: contextBloat ? { ...pillTextStyle, ...bloatTextStyle } : pillTextStyle, title: contextBloat
                                                ? `Runaway context: ${exactCount(activeTotal)} tokens in the active chat (over 1.5M).`
                                                : 'Active chat tokens', children: activeTotal === 0 ? 'Usage —' : `Usage ${compactCount(activeTotal)} tok` }), (0, jsx_runtime_1.jsxs)("span", { style: pillStatsStyle, title: "Live true session cost \u00B7 true CNY balance remaining (api.deepseek.com)", children: [yuan(liveSessionCost), " \u00B7 ", trueBalance === null ? '— left' : `${yuan(trueBalance)} left`] })] })) : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { style: titleStyle, children: "True-sync ledger" }), (0, jsx_runtime_1.jsx)("span", { style: contextBloat ? { ...headerTotalStyle, ...bloatTextStyle } : headerTotalStyle, title: contextBloat
                                                ? `Runaway context: ${exactCount(activeTotal)} tokens in the active chat (over 1.5M).`
                                                : `${exactCount(activeTotal)} tokens in the active chat`, children: activeTotal === 0 ? '—' : `${compactCount(activeTotal)} tok` })] })), (0, jsx_runtime_1.jsx)("button", { type: "button", "data-usage-hud-no-drag": "", "aria-label": minimized ? 'Expand the token usage HUD' : 'Minimize the token usage HUD', "aria-pressed": minimized, title: minimized ? 'Expand' : 'Minimize', onClick: toggleMinimized, style: iconButtonStyle, children: (0, jsx_runtime_1.jsx)(CollapseGlyph, { collapsed: minimized }) })] }), !minimized && ((0, jsx_runtime_1.jsxs)("div", { style: bodyStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: { ...segmentGroupStyle, marginBottom: 8 }, role: "group", "aria-label": "Usage panel", children: [(0, jsx_runtime_1.jsx)("button", { type: "button", "aria-pressed": panel === 'usage', onClick: () => setPanel('usage'), style: segmentButtonStyle(panel === 'usage'), children: "Usage" }), (0, jsx_runtime_1.jsx)("button", { type: "button", "aria-pressed": panel === 'saver', onClick: () => setPanel('saver'), style: segmentButtonStyle(panel === 'saver'), title: "dsh-plugin-save-token dashboard, merged into this HUD", children: "Token saver" })] }), panel === 'saver' ? ((0, jsx_runtime_1.jsx)(SaverPanel, {})) : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { style: timeframeGroupStyle, role: "group", "aria-label": "Usage timeframe", title: "Day, Week and Month always sum every saved chat in the global ledger. Custom also lets you include/exclude individual chats.", children: [
                                                ['session', 'Session'],
                                                ['day', 'Day'],
                                                ['week', 'Week'],
                                                ['month', 'Month'],
                                                ['custom', 'Custom'],
                                            ].map(([value, label]) => ((0, jsx_runtime_1.jsx)("button", { type: "button", "aria-pressed": timeframe === value, onClick: () => setTimeframe(value), style: timeframeButtonStyle(timeframe === value), children: label }, value))) }), (0, jsx_runtime_1.jsxs)("div", { style: scopeRowStyle, title: isGlobalScope
                                                ? 'This view sums every chat in the universal ledger for the selected time range. It is not scoped to the open conversation.'
                                                : 'This view is scoped to the currently open chat.', children: [(0, jsx_runtime_1.jsx)("span", { style: scopeBadgeStyle(isGlobalScope), children: isGlobalScope ? 'All chats · global' : 'This chat only' }), (0, jsx_runtime_1.jsx)("span", { style: countdownStyle, children: isGlobalScope
                                                        ? `${ledgerEntries.length.toLocaleString()} ledger entries`
                                                        : sessionKey === null
                                                            ? 'no active chat'
                                                            : `${selectedEntries.length.toLocaleString()} entries` })] }), timeframe === 'custom' && ((0, jsx_runtime_1.jsxs)("div", { style: customPanelStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: customDateRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: metricLabelStyle, children: "From" }), (0, jsx_runtime_1.jsx)("input", { type: "date", "aria-label": "Custom range start", value: customStart, max: customEnd.length > 0 ? customEnd : undefined, onChange: (event) => setCustomStart(event.target.value), style: dateInputStyle }), (0, jsx_runtime_1.jsx)("span", { style: metricLabelStyle, children: "To" }), (0, jsx_runtime_1.jsx)("input", { type: "date", "aria-label": "Custom range end", value: customEnd, min: customStart.length > 0 ? customStart : undefined, onChange: (event) => setCustomEnd(event.target.value), style: dateInputStyle })] }), (0, jsx_runtime_1.jsx)("div", { style: { ...tinyHintStyle, marginTop: 6 }, children: "Global range: every chat in the ledger is included." })] })), (0, jsx_runtime_1.jsxs)("div", { style: hudColumnsStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: leftColumnStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: totalRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: timeframe === 'session' && contextBloat
                                                                        ? { ...totalNumberStyle, ...bloatTextStyle }
                                                                        : totalNumberStyle, title: timeframe === 'session' && contextBloat
                                                                        ? `Runaway context: ${exactCount(activeTotal)} tokens in the active chat (over 1.5M).`
                                                                        : undefined, children: exactCount(displayedTotal) }), (0, jsx_runtime_1.jsx)("span", { style: totalUnitStyle, children: timeframe === 'session'
                                                                        ? 'session tokens'
                                                                        : `${timeframeLabel.toLowerCase()} tokens` })] }), (0, jsx_runtime_1.jsxs)("div", { style: cacheHitStyle, children: [(0, jsx_runtime_1.jsx)("span", { children: "Cache hit" }), (0, jsx_runtime_1.jsx)("span", { style: cacheHitValueStyle, children: hitRatio === null ? '—' : percent(hitRatio) })] }), (0, jsx_runtime_1.jsx)("dl", { style: detailsStyle, children: breakdown.map(([label, value]) => ((0, jsx_runtime_1.jsxs)(react_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("dt", { style: labelStyle, children: label }), (0, jsx_runtime_1.jsx)("dd", { style: valueStyle, children: exactCount(value) })] }, label))) }), (0, jsx_runtime_1.jsxs)("div", { style: metricRowStyle, title: "RMB avoided by reading cached input instead of paying the uncached input rate.", children: [(0, jsx_runtime_1.jsx)("span", { style: metricLabelStyle, children: "Cache savings" }), (0, jsx_runtime_1.jsx)("span", { style: savingsValueStyle, children: yuan(displaySavings) })] })] }), (0, jsx_runtime_1.jsxs)("div", { style: rightColumnStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: totalRowStyle, title: "True tracked cost: every token delta is priced at the model and UTC peak/off-peak tier active when it arrived.", children: [(0, jsx_runtime_1.jsx)("span", { style: totalNumberStyle, children: yuan(trueSelectedCost) }), (0, jsx_runtime_1.jsx)("span", { style: totalUnitStyle, children: timeframe === 'session' ? 'session cost' : `${timeframeLabel.toLowerCase()} cost` })] }), (0, jsx_runtime_1.jsx)("div", { style: liveBadgeRowStyle, children: (0, jsx_runtime_1.jsxs)("span", { style: liveBadgeStyle(usedLabel === 'Mixed'), title: badgeTitle, children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", style: tierDotStyle }), badgeText] }) }), (0, jsx_runtime_1.jsxs)("div", { style: tierRowStyle, children: [(0, jsx_runtime_1.jsxs)("span", { style: tierBadgeStyle(naturalPeak), title: naturalPeak
                                                                        ? 'Peak window: Mon–Fri 01:00–04:00 or 06:00–10:00 UTC — peak rate card'
                                                                        : 'Off-peak: off-peak rate card (all weekend traffic is off-peak)', children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", style: tierDotStyle }), naturalPeak ? 'Peak' : 'Off-Peak'] }), (0, jsx_runtime_1.jsx)("span", { style: countdownStyle, title: "Live countdown to the next natural UTC peak/off-peak rate switch", children: countdownLabel })] }), (0, jsx_runtime_1.jsxs)("div", { style: metricRowStyle, title: "Estimated selected-timeframe cost per assistant turn (estimated from output tokens at ~600 per turn).", children: [(0, jsx_runtime_1.jsx)("span", { style: metricLabelStyle, children: "Avg burn / turn" }), (0, jsx_runtime_1.jsx)("span", { style: metricValueStyle, children: burnPerTurn === null ? '—' : yuan(burnPerTurn) })] })] })] }), timeframe === 'session' && untrackedTokens > 0 && usage !== null && ((0, jsx_runtime_1.jsxs)("div", { style: tinyHintStyle, children: ["Tracking began after ~", compactCount(untrackedTokens), " earlier tokens in this chat; only tracked deltas are priced."] })), contextBloat && ((0, jsx_runtime_1.jsxs)("div", { style: { ...tinyHintStyle, ...bloatTextStyle, marginTop: 8 }, role: "status", children: ["Runaway context: ", exactCount(activeTotal), " tokens in this chat (over 1.5M)."] })), timeframe === 'session' && routedRows !== null ? ((0, jsx_runtime_1.jsxs)("div", { style: sectionStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: sectionTitleRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: sectionTitleStyle, children: "Models \u00B7 this session" }), (0, jsx_runtime_1.jsxs)("span", { style: sectionValueStyle, children: [compactCount(routedSessionTokens), " tok"] })] }), (0, jsx_runtime_1.jsx)("div", { style: modelBarStyle, "aria-hidden": "true", children: routedRows.map((row) => ((0, jsx_runtime_1.jsx)("div", { style: modelSegmentStyle(row.color, row.share), title: `${row.label}: ${exactCount(row.tokens)} tokens` }, row.key))) }), routedRows.map((row) => ((0, jsx_runtime_1.jsxs)("div", { style: modelRowStyle, title: `${row.label} · ${exactCount(row.tokens)} tokens · ${row.calls} call${row.calls === 1 ? '' : 's'}${row.costKnown
                                                        ? ` · ${yuan(row.costRmb)}`
                                                        : ' · local token count (no provider sync)'}`, children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", style: modelDotStyle(row.color) }), (0, jsx_runtime_1.jsx)("span", { style: modelNameStyle, children: row.label }), (0, jsx_runtime_1.jsxs)("span", { style: modelTokensStyle, children: [compactCount(row.tokens), " tok"] }), (0, jsx_runtime_1.jsx)("span", { style: modelCostStyle, children: row.costKnown ? yuan(row.costRmb) : 'local' }), (0, jsx_runtime_1.jsx)("span", { style: modelShareStyle, children: percent(row.share) })] }, row.key))), (0, jsx_runtime_1.jsx)("div", { style: tinyHintStyle, children: "Local route counts from the tier router. DeepSeek rows are priced; other models stay tokens-only and are never synced against a provider API." })] })) : ((0, jsx_runtime_1.jsxs)("div", { style: sectionStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: sectionTitleRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: sectionTitleStyle, children: "Cost by model" }), (0, jsx_runtime_1.jsx)("span", { style: sectionValueStyle, children: yuan(trueSelectedCost) })] }), (0, jsx_runtime_1.jsx)("div", { style: modelBarStyle, "aria-hidden": "true", children: modelRows.map((row) => ((0, jsx_runtime_1.jsx)("div", { style: modelSegmentStyle(row.color, row.share), title: `${row.label}: ${yuan(row.costRmb)}` }, row.id))) }), modelRows.map((row) => ((0, jsx_runtime_1.jsxs)("div", { style: modelRowStyle, title: row.id === 'search'
                                                        ? 'server-tool-search charges. Recorded only when the host ledger carries such entries; otherwise ¥0.00.'
                                                        : `${row.label} · ${exactCount(row.tokens)} tokens · ${yuan(row.costRmb)}`, children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", style: modelDotStyle(row.color) }), (0, jsx_runtime_1.jsx)("span", { style: modelNameStyle, children: row.label }), (0, jsx_runtime_1.jsx)("span", { style: modelTokensStyle, children: row.tokens === 0 ? '—' : `${compactCount(row.tokens)} tok` }), (0, jsx_runtime_1.jsx)("span", { style: modelCostStyle, children: yuan(row.costRmb) }), (0, jsx_runtime_1.jsx)("span", { style: modelShareStyle, children: row.costRmb <= 0 ? '0%' : percent(row.share) })] }, row.id)))] })), timeframe === 'session' && workerRows.length > 0 && ((0, jsx_runtime_1.jsxs)("div", { style: sectionStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: sectionTitleRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: sectionTitleStyle, children: "Fetch boys \u00B7 this run" }), (0, jsx_runtime_1.jsxs)("span", { style: sectionValueStyle, children: [compactCount(workerTokens), " tok"] })] }), workerRows.map((row) => ((0, jsx_runtime_1.jsxs)("div", { style: modelRowStyle, title: `${row.label} · ${exactCount(row.tokens)} tokens · ${row.calls} call${row.calls === 1 ? '' : 's'} · delegated session, local count only`, children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", style: modelDotStyle(row.color) }), (0, jsx_runtime_1.jsx)("span", { style: modelNameStyle, children: row.label }), (0, jsx_runtime_1.jsxs)("span", { style: modelTokensStyle, children: [compactCount(row.tokens), " tok"] }), (0, jsx_runtime_1.jsx)("span", { style: modelCostStyle, children: "local" }), (0, jsx_runtime_1.jsxs)("span", { style: modelShareStyle, children: [row.calls, "\u00D7"] })] }, row.key))), (0, jsx_runtime_1.jsx)("div", { style: tinyHintStyle, children: "Delegated subagent sessions since the router last started. Tokens only \u2014 no provider sync." })] })), (0, jsx_runtime_1.jsxs)("div", { style: sectionStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: sectionTitleRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: sectionTitleStyle, children: "True balance" }), (0, jsx_runtime_1.jsxs)("span", { style: syncStatusStyle, title: "Automatic sync from api.deepseek.com/user/balance", children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", style: syncDotStyle(syncStatusColor) }), syncStatusLabel] }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => setKeyEditorOpen((current) => !current), style: { ...linkButtonStyle, marginLeft: 'auto' }, title: "Add, replace or forget the saved DeepSeek API key", children: apiKey.length > 0 ? 'API key' : 'Add key' })] }), (0, jsx_runtime_1.jsxs)("div", { style: balanceHeadlineRowStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: {
                                                                ...balanceHeadlineStyle,
                                                                ...(trueBalance !== null && trueBalance <= 0 ? dangerTextStyle : {}),
                                                            }, children: trueBalance === null ? '—' : yuan(trueBalance) }), (0, jsx_runtime_1.jsx)("span", { style: balanceHeadlineUnitStyle, children: "CNY \u00B7 source of truth" })] }), (0, jsx_runtime_1.jsxs)("div", { style: balanceGridStyle, children: [(0, jsx_runtime_1.jsxs)("div", { style: balanceMetricStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: balanceMetricLabelStyle, children: "Runway" }), (0, jsx_runtime_1.jsx)("span", { style: balanceMetricValueStyle, children: runwayLabel })] }), (0, jsx_runtime_1.jsxs)("div", { style: balanceMetricStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: balanceMetricLabelStyle, children: "Today spend" }), (0, jsx_runtime_1.jsx)("span", { style: balanceMetricValueStyle, children: yuan(todaySpend) })] }), (0, jsx_runtime_1.jsxs)("div", { style: balanceMetricStyle, children: [(0, jsx_runtime_1.jsx)("span", { style: balanceMetricLabelStyle, title: "API balance decrease inside the selected window (top-ups ignored)", children: "True period spend" }), (0, jsx_runtime_1.jsx)("span", { style: balanceMetricValueStyle, title: periodSpendIsEstimate
                                                                        ? 'Not enough API balance samples in this window yet; showing the local ledger estimate.'
                                                                        : `Measured from ${balanceHistory.length} API balance samples.`, children: periodSpendLabel })] })] }), (0, jsx_runtime_1.jsxs)("div", { style: budgetRowStyle, children: [(0, jsx_runtime_1.jsxs)("label", { style: stopLabelStyle, title: "Target number of days the true balance should last", children: ["Target runway", (0, jsx_runtime_1.jsx)("input", { type: "number", min: 1, max: MAX_TARGET_RUNWAY_DAYS, step: 1, value: runwayDraft, onChange: (event) => setRunwayDraft(event.target.value), onBlur: () => setRunwayDraft(String(targetRunwayDays)), style: stopInputStyle }), "d"] }), (0, jsx_runtime_1.jsxs)("span", { style: dailyTargetStyle, title: "True API balance \u00F7 target runway", children: ["Daily target ", dailyTargetBudget === null ? '—' : yuan(dailyTargetBudget)] })] }), (0, jsx_runtime_1.jsx)("div", { style: gaugeTrackStyle, role: "progressbar", "aria-label": "Today's spend versus the daily target budget", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": budgetRatio === null ? 0 : Math.round(Math.min(1, budgetRatio) * 100), title: "Today's true tracked spend versus the balance-derived daily target budget.", children: (0, jsx_runtime_1.jsx)("div", { style: gaugeFillStyle(budgetRatio) }) }), (0, jsx_runtime_1.jsxs)("div", { style: budgetCaptionRowStyle, children: [(0, jsx_runtime_1.jsxs)("span", { children: ["Today ", yuan(todaySpend), " / ", dailyTargetBudget === null ? '—' : yuan(dailyTargetBudget)] }), (0, jsx_runtime_1.jsx)("span", { style: budgetRatio !== null && budgetRatio >= 1
                                                                ? dangerTextStyle
                                                                : budgetRatio !== null && budgetRatio >= 0.8
                                                                    ? warnTextStyle
                                                                    : undefined, children: budgetPercentLabel })] }), (keyEditorOpen || apiKey.length === 0) && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { style: syncRowStyle, children: [(0, jsx_runtime_1.jsx)("input", { type: "password", autoComplete: "off", spellCheck: false, "aria-label": "DeepSeek API key", placeholder: apiKey.length > 0 ? 'Replace API key' : 'sk-…', value: apiKeyDraft, onChange: (event) => setApiKeyDraft(event.target.value), onKeyDown: (event) => {
                                                                        if (event.key === 'Enter')
                                                                            saveApiKey();
                                                                    }, style: passwordInputStyle }), (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: apiKeyDraft.trim().length === 0, onClick: saveApiKey, style: {
                                                                        ...primaryMiniButtonStyle,
                                                                        opacity: apiKeyDraft.trim().length === 0 ? 0.55 : 1,
                                                                    }, children: "Save key" }), apiKey.length > 0 && ((0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => {
                                                                        setKeyEditorOpen(false);
                                                                        setApiKeyDraft('');
                                                                        setSyncError(null);
                                                                    }, style: miniButtonStyle, children: "Cancel" }))] }), apiKey.length > 0 && ((0, jsx_runtime_1.jsx)("button", { type: "button", onClick: forgetApiKey, style: { ...linkButtonStyle, marginTop: 4 }, children: "Forget saved key" })), (0, jsx_runtime_1.jsx)("div", { style: tinyHintStyle, children: "Stored only in this browser's localStorage, base64-encoded, never included in JSON exports. The balance is fetched automatically every 5 minutes." })] })), syncError !== null && ((0, jsx_runtime_1.jsx)("div", { style: { ...tinyHintStyle, ...dangerTextStyle }, children: syncError })), syncNotice !== null && syncError === null && ((0, jsx_runtime_1.jsx)("div", { style: { ...tinyHintStyle, color: 'var(--dsw-alias-state-success-primary, #3fb950)' }, children: syncNotice })), (0, jsx_runtime_1.jsxs)("div", { style: tinyHintStyle, children: [reconciliationDrift !== null && Math.abs(reconciliationDrift) >= 0.005
                                                            ? `API Δ vs ledger Δ: ${reconciliationDrift >= 0 ? '+' : ''}${yuan(reconciliationDrift)} over ${timeframeLabel.toLowerCase()}. `
                                                            : '', apiKey.length === 0
                                                            ? 'Add a DeepSeek API key to auto-sync the true CNY balance.'
                                                            : balanceMeta === null
                                                                ? 'Auto-sync runs on load and every 5 minutes.'
                                                                : `Last sync ${new Date(balanceMeta.syncedAt).toLocaleString()} · ledger spend since sync ${yuan(postSyncSpend)}.`] })] }), (0, jsx_runtime_1.jsxs)("div", { style: footerStyle, children: [(0, jsx_runtime_1.jsx)("button", { type: "button", onClick: exportLedger, style: miniButtonStyle, title: "Download the universal ledger as JSON", children: "Export" }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => fileInputRef.current?.click(), style: miniButtonStyle, title: "Merge a previously exported universal ledger", children: "Import" }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: resetLogs, style: miniButtonStyle, title: "Clear all local usage logs", children: "Reset" }), (0, jsx_runtime_1.jsxs)("span", { style: { ...sessionCountStyle, marginLeft: 'auto' }, children: [ledgerEntries.length.toLocaleString(), " entries \u00B7 ", trackedSessions.length, " chats"] }), (0, jsx_runtime_1.jsx)("input", { ref: fileInputRef, type: "file", accept: "application/json,.json", onChange: (event) => void importLedger(event), style: { display: 'none' } })] }), (0, jsx_runtime_1.jsx)("div", { style: tinyHintStyle, children: timeframe === 'custom'
                                                ? `${customDays} day${customDays === 1 ? '' : 's'} · ${elapsedDays.toFixed(1)}d elapsed · ${balanceHistory.length} API balance samples`
                                                : `${timeframeLabel} · ${balanceHistory.length} API balance samples · avg burn ${yuan(averageDailySpend)}/day` }), dataMessage !== null && (0, jsx_runtime_1.jsx)("div", { style: tinyHintStyle, children: dataMessage }), usage === null && displayedTotal === 0 && ((0, jsx_runtime_1.jsx)("p", { style: hintStyle, children: "No session data yet." }))] }))] }))] }), document.body)] }));
    }
    return module.exports;
  },
});
