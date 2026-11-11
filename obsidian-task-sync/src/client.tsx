// obsidian-task-sync — Client half.
//
// A persistent sidebar launcher plus a floating checklist widget. The DSH
// desktop shell denies renderer pop-outs, so the widget is an in-app overlay: a
// draggable, high-z-index panel rendered into the main Harness window. The
// browser never imports fs. Every read and write still crosses the same-origin
// JSON bridge owned by the Host half.

import {
  Fragment,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'

export const name = 'obsidian-task-sync'
export const inject = ['slots', 'locale']

const NS = 'obsidian-task-sync'
const ROUTE = '/obsidian-task-sync'
const BOOTSTRAP_PATH = `${ROUTE}/bootstrap`
const TOKEN_HEADER = 'x-obsidian-task-sync-token'
const VAULT_KEY = 'obsidian-task-sync.vault.v1'
const POSITION_KEY = 'obsidian-task-sync.position.v1'
const TREE_SEED_KEY = 'obsidian-task-sync.tree-seed.v1'
const MINIMIZED_KEY = 'obsidian-task-sync.minimized.v1'
const FOCUS_KEY = 'obsidian-task-sync.focus.v1'
const WIDGET_WIDTH = 434
const TREE_WIDTH = 940
const MINIMIZED_WIDTH = 328
const WIDGET_HEIGHT = 784
const WIDGET_MARGIN = 8
const WINDOWS_TITLEBAR_FALLBACK = 40
const BOOT_GLOBAL = '__OBSIDIAN_TASK_SYNC__'
const POLL_MS = 6_000
const BRIDGE_WAIT_MS = 12_000
const BRIDGE_RETRY_MIN_MS = 250
const BRIDGE_RETRY_MAX_MS = 1_500
const DEFAULT_TREE_NAME = 'C++'
const DEFAULT_FOCUS_SECONDS = 60 * 60
const MAX_FOCUS_SECONDS = 24 * 60 * 60

const ALLOWED_OPS = new Set([
  'vault/check',
  'vault/files',
  'document',
  'task/toggle',
  'task/append',
  'task/delete',
  'task/reorder',
  'task/rollover',
  'checklist/create',
  'tree/list',
  'tree/document',
  'tree/toggle',
  'tree/create',
])

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

const en = {
  open: 'Open Obsidian checklist',
  widget: 'Obsidian checklist',
  setupTitle: 'Connect your Obsidian folder',
  setupBody:
    'Choose the folder where daily checklist markdown files live. Harness reads and writes them locally for you.',
  vaultPath: 'Absolute folder path',
  vaultExample: 'C:\\Users\\you\\Obsidian\\Checklists',
  connect: 'Connect folder',
  connecting: 'Connecting…',
  connectHint: 'The path must be absolute and already exist.',
  settings: 'Checklist settings',
  close: 'Close',
  refresh: 'Refresh now',
  changeFolder: 'Change folder',
  vaultFolder: 'Vault folder',
  fileNaming: 'File naming',
  fileNamingHint: 'Files use YYYY-MM-DD-Checklist-<Title>.md.',
  live: 'Live',
  polling: 'Polling',
  offline: 'Offline',
  syncing: 'Syncing',
  completed: 'complete',
  left: 'left',
  today: 'Today',
  previous: 'Previous checklist',
  next: 'Next checklist',
  chooseFile: 'Choose checklist',
  noChecklistToday: 'No checklist for today',
  noChecklistBody: 'Create one markdown file and start adding tasks. Notes and formatting stay untouched.',
  createToday: "Create today's checklist",
  createHint: 'The file is created inside your vault, not in Harness storage.',
  checklistTitle: 'Checklist title',
  create: 'Create',
  creating: 'Creating…',
  noTasks: 'No tasks yet. Add the first one below.',
  addPlaceholder: 'Add a task, then press Enter',
  add: 'Add task',
  deleteTask: 'Delete task',
  drag: 'Drag to reorder',
  saved: 'Saved to the markdown file',
  lastSync: 'Last sync',
  justNow: 'just now',
  missingTitle: 'This checklist is gone',
  missingBody: 'The file was removed outside Harness. Pick another checklist or create today’s.',
  goToday: 'Go to today',
  hideWidget: 'Hide the checklist widget',
  closeWidget: 'Close the checklist widget',
  dragWidget: 'Drag to move the checklist widget. Arrow keys nudge it.',
  loadError: 'The checklist could not be loaded',
  created: 'Checklist created',
  settingsIntro: 'Every write goes through the Harness Host, which rewrites only the affected line.',
  absoluteOnly: 'Only absolute paths are accepted.',
  tasks: 'tasks',
  progress: 'Progress',
  rollover: 'Rollover uncompleted',
  rollingOver: 'Rolling over…',
  rolledOver: 'Rolled over',
  tasksTo: 'task(s) to',
  noRollover: 'No uncompleted tasks to roll over',
  rolloverHint: 'Moves every unchecked task into the next day’s checklist.',
  focusTimer: 'Focus timer',
  focusStart: 'Start',
  focusPause: 'Pause',
  focusReset: 'Reset',
  focusEdit: 'Click to edit the focus duration',
  focusInvalid: 'Use minutes (90) or H:MM (1:30)',
  focusComplete: 'Focus session complete',
  minimizeWidget: 'Minimize the checklist widget',
  expandWidget: 'Expand the checklist widget',
  minimizedProgress: 'Checklist progress',
  markdownFile: 'Markdown file',
  allSaved: 'All changes are written to the markdown file.',
  renameHint: 'Rename the file in Obsidian to change the title.',
  closeToast: 'Dismiss',
  bridgePreparing: 'Connecting to the Harness bridge…',
  bridgeWaiting: 'Waiting for the secure IPC bridge before reading your checklist folder.',
  bridgeFailed: 'The checklist bridge is unavailable',
  bridgeRetry: 'Try again',
  navAria: 'Plugin views',
  navChecklist: 'Daily checklist',
  navTrees: 'Skill trees',
  treeTitle: 'Skill trees',
  currentRank: 'Current rank',
  rankNovice: 'Novice',
  rankProficient: 'Proficient',
  rankMaster: 'Master',
  rankSoftware: 'Software Engineer',
  rankSenior: 'Senior Engineer',
  rankPrincipal: 'Principal Engineer',
  points: 'points',
  pts: 'pts',
  skills: 'skills',
  pointsToNext: 'pts to next rank',
  maxRank: 'Maximum rank reached',
  treeLoading: 'Reading your skill trees…',
  treeEmptyTitle: 'No skill tree in this folder yet',
  treeEmptyBody:
    'Create the bundled modern C++ tree. It is written as SkillTrees-C++.md, so Obsidian can read and edit it too.',
  createTree: 'Create C++ skill tree',
  creatingTree: 'Creating…',
  seededTree: 'Created SkillTrees-C++.md in your vault',
  treeNoVaultTitle: 'Connect a folder first',
  treeNoVaultBody:
    'Skill trees use the same Obsidian folder as your daily checklists. Open the checklist view to connect it.',
  openChecklist: 'Open daily checklist',
  lockedNode: 'Unlock the previous skill first',
  chooseTree: 'Choose skill tree',
  treeSyncHint: 'Check a box here or in Obsidian — both stay in sync.',
  treeNoNodes: 'This tree has no skills yet. Add "- [ ] Skill · 3" under a heading.',
  treeLoadError: 'The skill tree could not be loaded',
}

const zh = {
  open: '打开 Obsidian 清单',
  widget: 'Obsidian 清单',
  setupTitle: '连接 Obsidian 文件夹',
  setupBody: '选择每日清单 Markdown 文件所在的文件夹。Harness 只会在此电脑上读写这些文件。',
  vaultPath: '文件夹绝对路径',
  vaultExample: 'C:\\Users\\you\\Obsidian\\Checklists',
  connect: '连接文件夹',
  connecting: '正在连接…',
  connectHint: '路径必须是已存在的绝对路径。',
  settings: '清单设置',
  close: '关闭',
  refresh: '立即刷新',
  changeFolder: '更换文件夹',
  vaultFolder: 'Vault 文件夹',
  fileNaming: '文件命名',
  fileNamingHint: '文件名为 YYYY-MM-DD-Checklist-<Title>.md。',
  live: '实时同步',
  polling: '轮询同步',
  offline: '离线',
  syncing: '同步中',
  completed: '已完成',
  left: '待完成',
  today: '今天',
  previous: '上一个清单',
  next: '下一个清单',
  chooseFile: '选择清单',
  noChecklistToday: '今天还没有清单',
  noChecklistBody: '创建一个 Markdown 文件并开始添加任务。其他笔记和格式保持不变。',
  createToday: '创建今日清单',
  createHint: '文件会创建在你的 Vault 中，而不是 Harness 存储中。',
  checklistTitle: '清单标题',
  create: '创建',
  creating: '创建中…',
  noTasks: '还没有任务，在下方添加第一个。',
  addPlaceholder: '输入任务，按 Enter 添加',
  add: '添加任务',
  deleteTask: '删除任务',
  drag: '拖动排序',
  saved: '已写入 Markdown 文件',
  lastSync: '上次同步',
  justNow: '刚刚',
  missingTitle: '这个清单不见了',
  missingBody: '文件已在 Harness 之外被删除。请选择其他清单或创建今日清单。',
  goToday: '回到今天',
  hideWidget: '隐藏清单小窗',
  closeWidget: '关闭清单小窗',
  dragWidget: '拖动以移动清单小窗，方向键可微调位置。',
  loadError: '无法加载清单',
  created: '清单已创建',
  settingsIntro: '所有写入都经过 Harness Host，只重写受影响的那一行。',
  absoluteOnly: '只接受绝对路径。',
  tasks: '个任务',
  progress: '进度',
  rollover: '顺延未完成任务',
  rollingOver: '正在顺延…',
  rolledOver: '已顺延',
  tasksTo: '个任务至',
  noRollover: '没有需要顺延的未完成任务',
  rolloverHint: '把所有未勾选的任务移到下一天的清单。',
  focusTimer: '专注计时',
  focusStart: '开始',
  focusPause: '暂停',
  focusReset: '重置',
  focusEdit: '点击可修改专注时长',
  focusInvalid: '请输入分钟数（90）或时:分（1:30）',
  focusComplete: '专注时间结束',
  minimizeWidget: '最小化清单小窗',
  expandWidget: '展开清单小窗',
  minimizedProgress: '清单进度',
  markdownFile: 'Markdown 文件',
  allSaved: '所有修改都会写入 Markdown 文件。',
  renameHint: '在 Obsidian 中重命名文件即可修改标题。',
  closeToast: '关闭',
  bridgePreparing: '正在连接 Harness 桥接…',
  bridgeWaiting: '正在等待安全 IPC 桥接就绪，然后再读取清单文件夹。',
  bridgeFailed: '清单桥接不可用',
  bridgeRetry: '重试',
  navAria: '插件视图',
  navChecklist: '每日清单',
  navTrees: '技能树',
  treeTitle: '技能树',
  currentRank: '当前等级',
  rankNovice: '新手',
  rankProficient: '熟练',
  rankMaster: '大师',
  rankSoftware: '软件工程师',
  rankSenior: '高级工程师',
  rankPrincipal: '首席工程师',
  points: '积分',
  pts: '分',
  skills: '项技能',
  pointsToNext: '分晋级下一等级',
  maxRank: '已达最高等级',
  treeLoading: '正在读取技能树…',
  treeEmptyTitle: '文件夹中还没有技能树',
  treeEmptyBody: '创建内置的现代 C++ 技能树。它会保存为 SkillTrees-C++.md，Obsidian 同样可以读取和编辑。',
  createTree: '创建 C++ 技能树',
  creatingTree: '创建中…',
  seededTree: '已在 Vault 中创建 SkillTrees-C++.md',
  treeNoVaultTitle: '请先连接文件夹',
  treeNoVaultBody: '技能树与每日清单使用同一个 Obsidian 文件夹。请先在每日清单视图中完成连接。',
  openChecklist: '打开每日清单',
  lockedNode: '请先解锁前置技能',
  chooseTree: '选择技能树',
  treeSyncHint: '在这里或 Obsidian 中勾选都可以，进度会保持同步。',
  treeNoNodes: '这棵技能树还没有节点。在标题下添加 "- [ ] 技能 · 3"。',
  treeLoadError: '无法加载技能树',
}

const localeFallback = (key) => key
const LocaleContext = createContext(localeFallback)

function useT() {
  return useContext(LocaleContext)
}

// ---------------------------------------------------------------------------
// Host bridge client
// ---------------------------------------------------------------------------

class BridgeError extends Error {
  constructor(message, code = 'bridge-failure', details = null) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.document = details && details.document
    this.status = details && details.status
  }
}

function asBridgeError(error) {
  if (error instanceof BridgeError) return error
  return new BridgeError(error instanceof Error ? error.message : String(error), 'local-failure')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function injectedToken() {
  const injected = window[BOOT_GLOBAL]
  return isRecord(injected) && typeof injected.token === 'string' && injected.token.length > 0
    ? injected.token
    : null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class BridgeApi {
  constructor() {
    this.sessionToken = null
    this.bootstrapPromise = null
    // Set after a 401: the page's injected global belonged to a previous Host
    // process, so the next resolution must use the bootstrap route instead.
    this.ignoreInjected = false
  }

  hasToken() {
    return this.sessionToken !== null || (!this.ignoreInjected && injectedToken() !== null)
  }

  // Resolve the token without dispatching any file-read request first. The
  // desktop page boots from a static index, so its token can arrive either
  // through the injected global or, for a page that predates the plugin
  // install, through the authenticated bootstrap route.
  async ensureToken() {
    if (this.sessionToken !== null) return this.sessionToken
    if (!this.ignoreInjected) {
      const injected = injectedToken()
      if (injected !== null) {
        this.sessionToken = injected
        return this.sessionToken
      }
    }
    return this.bootstrap()
  }

  bootstrap() {
    if (this.bootstrapPromise === null) {
      this.bootstrapPromise = this.loadBootstrapToken().finally(() => {
        this.bootstrapPromise = null
      })
    }
    return this.bootstrapPromise
  }

  async loadBootstrapToken() {
    const deadline = Date.now() + BRIDGE_WAIT_MS
    let delay = BRIDGE_RETRY_MIN_MS
    let lastFailure = null
    for (;;) {
      const injected = this.ignoreInjected ? null : injectedToken()
      if (injected !== null) {
        this.sessionToken = injected
        return injected
      }
      try {
        const response = await fetch(BOOTSTRAP_PATH, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        let data = null
        try {
          data = await response.json()
        } catch {
          // A booting Host can answer with an empty body; retry below.
        }
        if (response.ok && isRecord(data) && typeof data.token === 'string' && data.token.length > 0) {
          this.sessionToken = data.token
          return data.token
        }
        const message =
          isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string'
            ? data.error.message
            : `The checklist bridge is not ready yet (${response.status})`
        lastFailure = new BridgeError(message, response.status === 401 ? 'token-missing' : 'bridge-unavailable')
      } catch {
        lastFailure = new BridgeError('The Harness Host is not reachable', 'offline')
      }
      if (Date.now() >= deadline) break
      await sleep(delay)
      delay = Math.min(BRIDGE_RETRY_MAX_MS, Math.round(delay * 1.6))
    }
    throw (
      lastFailure ??
      new BridgeError(
        'The checklist bridge token is not loaded. Refresh the Harness page and try again.',
        'token-missing',
      )
    )
  }

  forgetToken() {
    this.sessionToken = null
    this.bootstrapPromise = null
    this.ignoreInjected = true
  }

  async request(op, payload) {
    if (!ALLOWED_OPS.has(op)) {
      throw new BridgeError(`Unknown checklist operation "${op}"`, 'invalid-operation')
    }
    const send = async () => {
      const token = await this.ensureToken()
      try {
        return await fetch(`${ROUTE}/api/${op}`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            [TOKEN_HEADER]: token,
          },
          body: JSON.stringify(payload ?? {}),
        })
      } catch {
        throw new BridgeError('The Harness Host is not reachable', 'offline')
      }
    }

    let response = await send()
    if (response.status === 401) {
      // A Host reload mints a new process token; discard the stale one and
      // bootstrap again before reporting the failure to the user.
      this.forgetToken()
      await this.ensureToken()
      response = await send()
    }
    let data = null
    try {
      data = await response.json()
    } catch {
      // An empty or truncated body is reported below by status.
    }
    if (!response.ok) {
      const failure = isRecord(data) && isRecord(data.error) ? data.error : null
      throw new BridgeError(
        failure && typeof failure.message === 'string'
          ? failure.message
          : `Checklist request failed (${response.status})`,
        failure && typeof failure.code === 'string' ? failure.code : 'request-failed',
        isRecord(data) ? data : null,
      )
    }
    if (!isRecord(data)) {
      throw new BridgeError('The checklist bridge returned an invalid response', 'bad-response')
    }
    return data
  }

  async eventUrl(root, file, refresh = false, tree = null) {
    if (refresh) this.forgetToken()
    const token = await this.ensureToken()
    const url = new URL(`${ROUTE}/events`, window.location.origin)
    url.searchParams.set('root', root)
    if (typeof file === 'string' && file !== '') url.searchParams.set('file', file)
    if (typeof tree === 'string' && tree !== '') url.searchParams.set('tree', tree)
    url.searchParams.set('token', token)
    return url.toString()
  }
}

// One direct client for the Host bridge. The widget lives in the main Harness
// window, so requests and the live watch stream go straight to the same-origin
// route; no cross-window broker or token relay is involved.
class ChecklistBridge {
  constructor() {
    this.api = new BridgeApi()
  }

  hasToken() {
    return this.api.hasToken()
  }

  // Resolves once the token is available. It never dispatches a filesystem
  // operation, so ChecklistApp can hold its loading state until this settles.
  async ready() {
    if (this.api.hasToken()) return
    await this.api.ensureToken()
  }

  request(op, payload) {
    return this.api.request(op, payload)
  }

  // Async on purpose: ChecklistApp awaits the cleanup disposer.
  async subscribe(root, file, listener) {
    return this.stream({ root, file, tree: null }, listener)
  }

  async subscribeTree(root, tree, listener) {
    return this.stream({ root, file: null, tree }, listener)
  }

  async stream({ root, file, tree }, listener) {
    let source = null
    let closed = false
    let retry
    const open = async (refreshToken = false) => {
      if (closed) return
      try {
        const url = await this.api.eventUrl(root, file, refreshToken, tree)
        if (closed) return
        source = new EventSource(url)
        for (const eventName of ['hello', 'document', 'files', 'tree', 'trees', 'watch-error']) {
          source.addEventListener(eventName, (event) => {
            try {
              listener(eventName, JSON.parse(event.data))
            } catch {
              // Ignore malformed frames; the polling fallback still converges.
            }
          })
        }
        source.onerror = () => {
          if (closed) return
          listener('stream-error', { message: 'Live watch disconnected' })
          source?.close()
          source = null
          retry = setTimeout(() => {
            if (!closed) void open(true)
          }, 1_500)
        }
      } catch (error) {
        if (closed) return
        listener('stream-error', { message: asBridgeError(error).message })
        retry = setTimeout(() => {
          if (!closed) void open(true)
        }, 2_000)
      }
    }
    void open()
    return () => {
      closed = true
      clearTimeout(retry)
      source?.close()
    }
  }

  dispose() {
    // EventSource lifetime belongs to ChecklistApp's subscription cleanup.
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, '0')
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0)
}

function longDate(value) {
  const date = parseDateKey(value)
  if (date === null) return value
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(date)
  } catch {
    return value
  }
}

function shortDate(value) {
  const date = parseDateKey(value)
  if (date === null) return value
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------
// Focus timer parsing
//
// A clock-shaped value is hours:minutes[:seconds]; a flat number is minutes.
// Both `1:30` and `90` therefore mean the same 90-minute session, which is the
// mental model the timer is meant to keep.
// ---------------------------------------------------------------------------

function formatFocusDuration(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const rest = safe % 60
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(rest)}`
}

function parseFocusDuration(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  const clock = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(text)
  if (clock !== null) {
    const total =
      Number(clock[1]) * 3600 + Number(clock[2]) * 60 + (clock[3] === undefined ? 0 : Number(clock[3]))
    return total > 0 && total <= MAX_FOCUS_SECONDS ? total : null
  }
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(text)) return null
  const total = Math.round(Number(text) * 60)
  return total > 0 && total <= MAX_FOCUS_SECONDS ? total : null
}

function readFocusSeconds() {
  try {
    const value = Number(window.localStorage.getItem(FOCUS_KEY))
    if (Number.isFinite(value) && value > 0 && value <= MAX_FOCUS_SECONDS) return Math.floor(value)
  } catch {
    // Storage is optional; the default 60-minute session still works.
  }
  return DEFAULT_FOCUS_SECONDS
}

function writeFocusSeconds(seconds) {
  try {
    window.localStorage.setItem(FOCUS_KEY, String(seconds))
  } catch {
    // The running session is unaffected by a blocked localStorage.
  }
}

// Test seams for the smart-duration parser and the inline tag renderer.
export function __parseFocusDuration(raw) {
  return parseFocusDuration(raw)
}

export function __formatFocusDuration(seconds) {
  return formatFocusDuration(seconds)
}

function relativeTime(from, now) {
  const seconds = Math.max(0, Math.round((now - from) / 1_000))
  if (seconds < 10) return null
  try {
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    if (seconds < 60) return formatter.format(-seconds, 'second')
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return formatter.format(-minutes, 'minute')
    return formatter.format(-Math.round(minutes / 60), 'hour')
  } catch {
    return null
  }
}

// Both views read the same Obsidian folder. The checklist view owns the connect
// flow; this small observable lets the skill-tree view follow it without a
// second source of truth.
function createValueStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      if (next === value) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const vaultStore = createValueStore('')

function readVault() {
  try {
    const value = window.localStorage.getItem(VAULT_KEY)
    return typeof value === 'string' && value.trim().length > 0 ? value : null
  } catch {
    return null
  }
}

function writeVault(value) {
  try {
    window.localStorage.setItem(VAULT_KEY, value)
  } catch {
    // localStorage is a convenience; the session still works without it.
  }
  vaultStore.set(value)
}

// ---------------------------------------------------------------------------
// Progression model
// ---------------------------------------------------------------------------

const RANKS = [
  { id: 'novice', key: 'rankNovice', min: 0 },
  { id: 'proficient', key: 'rankProficient', min: 10 },
  { id: 'master', key: 'rankMaster', min: 25 },
  { id: 'engineer', key: 'rankSoftware', min: 40 },
  { id: 'senior', key: 'rankSenior', min: 50 },
  { id: 'principal', key: 'rankPrincipal', min: 60 },
]

function rankFor(rawPoints) {
  const points = Number.isFinite(rawPoints) ? Math.max(0, rawPoints) : 0
  let index = 0
  for (let position = 0; position < RANKS.length; position += 1) {
    if (points >= RANKS[position].min) index = position
  }
  const rank = RANKS[index]
  const next = RANKS[index + 1] ?? null
  return {
    index,
    rank,
    next,
    toNext: next === null ? 0 : Math.max(0, next.min - points),
    progress:
      next === null
        ? 1
        : Math.min(1, Math.max(0, (points - rank.min) / (next.min - rank.min))),
  }
}

function treeSeedDone(vault) {
  try {
    return window.localStorage.getItem(TREE_SEED_KEY) === vault
  } catch {
    // A blocked localStorage means we cannot remember the seed; never write
    // into the vault uninvited, so treat it as already seeded.
    return true
  }
}

function markTreeSeeded(vault) {
  try {
    window.localStorage.setItem(TREE_SEED_KEY, vault)
  } catch {
    // The tree still works; the next empty state simply offers the button.
  }
}

// ---------------------------------------------------------------------------
// Skill tree layout
// ---------------------------------------------------------------------------

const LANE_COLORS = ['#7ee0bd', '#efc06e', '#79a8ff', '#c79bff']
const TREE_NODE_W = 178
const TREE_NODE_H = 64
const TREE_COL_STEP = 250
const TREE_ROW_STEP = 84
const TREE_LANE_HEADER = 30
const TREE_LANE_GAP = 26
const TREE_PAD = 28
const TREE_ROOT_H = 92

function treeEdgePath(fromX, fromY, toX, toY) {
  const curve = Math.max(34, (toX - fromX) * 0.46)
  return `M ${Math.round(fromX)} ${Math.round(fromY)} C ${Math.round(fromX + curve)} ${Math.round(
    fromY,
  )}, ${Math.round(toX - curve)} ${Math.round(toY)}, ${Math.round(toX)} ${Math.round(toY)}`
}

// Left-to-right tidy layout: column = nesting depth, row = leaf order. A parent
// is centred on its children, so a branch reads as one continuous path even
// when the markdown nests several nodes below it.
function layoutSkillTree(doc) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : []
  const lanes = Array.isArray(doc?.lanes) ? doc.lanes : []
  const children = new Map()
  for (const node of nodes) {
    const parentKey = node.parentId ?? ''
    const list = children.get(parentKey) ?? []
    list.push(node)
    children.set(parentKey, list)
  }
  const laneBands = []
  const placed = []
  let top = TREE_PAD
  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
    const lane = lanes[laneIndex]
    const laneNodes = nodes.filter((node) => node.lane === laneIndex)
    const roots = laneNodes.filter((node) => node.parentId === null)
    const rows = new Map()
    let cursor = 0
    const assign = (node) => {
      const kids = (children.get(node.id) ?? []).filter((kid) => kid.lane === laneIndex)
      if (kids.length === 0) {
        const row = cursor
        cursor += 1
        rows.set(node.id, row)
        return row
      }
      let min = Infinity
      let max = -Infinity
      for (const kid of kids) {
        const row = assign(kid)
        if (row < min) min = row
        if (row > max) max = row
      }
      const row = (min + max) / 2
      rows.set(node.id, row)
      return row
    }
    for (const root of roots) assign(root)
    for (const node of laneNodes) {
      if (rows.has(node.id)) continue
      rows.set(node.id, cursor)
      cursor += 1
    }
    const rowCount = Math.max(1, cursor)
    const contentHeight = rowCount * TREE_ROW_STEP - (TREE_ROW_STEP - TREE_NODE_H)
    const height = TREE_LANE_HEADER + contentHeight
    laneBands.push({ ...lane, index: laneIndex, top, height })
    for (const node of laneNodes) {
      const row = rows.get(node.id) ?? 0
      placed.push({
        ...node,
        laneIndex,
        x: TREE_PAD + (node.depth + 1) * TREE_COL_STEP,
        y: top + TREE_LANE_HEADER + row * TREE_ROW_STEP,
      })
    }
    top += height + TREE_LANE_GAP
  }
  let maxDepth = 0
  for (const node of placed) maxDepth = Math.max(maxDepth, node.depth)
  const width = TREE_PAD * 2 + (maxDepth + 1) * TREE_COL_STEP + TREE_NODE_W
  const height = Math.max(TREE_PAD * 2 + TREE_NODE_H, top - TREE_LANE_GAP + TREE_PAD)
  const lastBand = laneBands[laneBands.length - 1]
  const rootY =
    lastBand === undefined
      ? height / 2 - TREE_ROOT_H / 2
      : (laneBands[0].top + lastBand.top + lastBand.height) / 2 - TREE_ROOT_H / 2
  const root = {
    id: '__root__',
    x: TREE_PAD,
    y: rootY,
    width: TREE_NODE_W,
    height: TREE_ROOT_H,
  }
  const placedById = new Map(placed.map((node) => [node.id, node]))
  const annotated = placed.map((node) => {
    const parent = node.parentId === null ? null : placedById.get(node.parentId) ?? null
    return {
      ...node,
      width: TREE_NODE_W,
      height: TREE_NODE_H,
      unlocked: parent === null || parent.checked === true,
      locked: parent !== null && parent.checked !== true && node.checked !== true,
    }
  })
  const edges = []
  for (const node of annotated) {
    const parent = node.parentId === null ? null : placedById.get(node.parentId) ?? null
    const fromX = parent === null ? root.x + root.width : parent.x + TREE_NODE_W
    const fromY = parent === null ? root.y + root.height / 2 : parent.y + TREE_NODE_H / 2
    edges.push({
      id: `${parent === null ? '__root__' : parent.id}->${node.id}`,
      laneIndex: node.laneIndex,
      state: node.checked ? 'done' : node.locked ? 'locked' : 'open',
      path: treeEdgePath(fromX, fromY, node.x, node.y + TREE_NODE_H / 2),
    })
  }
  return { width, height, root, nodes: annotated, lanes: laneBands, edges }
}

function withToggledNode(doc, nodeId, checked) {
  if (doc === null) return null
  const nodes = doc.nodes.map((node) => (node.id === nodeId ? { ...node, checked } : node))
  const lanes = doc.lanes.map((lane) => {
    const own = nodes.filter((node) => node.lane === lane.index)
    return {
      ...lane,
      completed: own.filter((node) => node.checked).length,
      earned: own.reduce((sum, node) => sum + (node.checked ? node.points : 0), 0),
    }
  })
  return {
    ...doc,
    nodes,
    lanes,
    checkedCount: nodes.filter((node) => node.checked).length,
    earnedPoints: nodes.reduce((sum, node) => sum + (node.checked ? node.points : 0), 0),
  }
}

export function __layoutSkillTree(doc) {
  return layoutSkillTree(doc)
}

export function __rankFor(points) {
  return rankFor(points)
}

function selectTodayFile(files, date) {
  const candidates = files.filter((file) => file.date === date)
  if (candidates.length === 0) return null
  return candidates.find((file) => file.title === 'Daily') ?? candidates[0]
}

function readWidgetPosition() {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw)
    if (isRecord(value) && Number.isFinite(value.left) && Number.isFinite(value.top)) {
      return { left: value.left, top: value.top }
    }
  } catch {
    // A missing or malformed position falls back to the default corner.
  }
  return null
}

function writeWidgetPosition(position) {
  try {
    window.localStorage.setItem(POSITION_KEY, JSON.stringify(position))
  } catch {
    // Position is a convenience; the widget still works without persistence.
  }
}

function readWidgetMinimized() {
  try {
    return window.localStorage.getItem(MINIMIZED_KEY) === '1'
  } catch {
    return false
  }
}

function writeWidgetMinimized(minimized) {
  try {
    window.localStorage.setItem(MINIMIZED_KEY, minimized ? '1' : '0')
  } catch {
    // Minimize still works for this session without persistence.
  }
}

// The Windows desktop shell draws a native 40px caption strip over the page:
// it is a `-webkit-app-region: drag` area, so pointer input inside it never
// reaches the document. The Harness layout exposes its height on <html>; keep
// the widget below it (and opt the card out of the drag region in CSS).
function titlebarInset() {
  const root = document.documentElement
  if (root === null) return 0
  if (root.hasAttribute('data-fullscreen') || document.fullscreenElement !== null) return 0
  const declared = root.hasAttribute('data-windows-titlebar')
  // The desktop preload exposes `dshDesktopBoot`; reserve the caption strip even
  // if the layout has not written its attribute yet. A Windows browser page has
  // no such bridge, so it keeps the full viewport.
  const desktop = window.dshDesktopBoot !== undefined && window.dshDesktopBoot !== null
  const windows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
  if (!declared && !(desktop && windows)) return 0
  const raw = Number.parseFloat(root.style.getPropertyValue('--dsh-windows-titlebar-height'))
  return Number.isFinite(raw) && raw > 0 ? raw : WINDOWS_TITLEBAR_FALLBACK
}

function widgetTopInset() {
  return Math.max(WIDGET_MARGIN, titlebarInset() + WIDGET_MARGIN)
}

function clampWidgetPosition(left, top, width, height) {
  const minTop = widgetTopInset()
  const maxLeft = Math.max(WIDGET_MARGIN, window.innerWidth - width - WIDGET_MARGIN)
  const maxTop = Math.max(minTop, window.innerHeight - height - WIDGET_MARGIN)
  return {
    left: Math.min(Math.max(WIDGET_MARGIN, left), maxLeft),
    top: Math.min(Math.max(minTop, top), maxTop),
  }
}

function defaultWidgetPosition() {
  const width = Math.min(WIDGET_WIDTH, Math.max(0, window.innerWidth - WIDGET_MARGIN * 2))
  const height = Math.min(WIDGET_HEIGHT, Math.max(0, window.innerHeight - WIDGET_MARGIN * 2))
  const top = Math.max(72, widgetTopInset() + 24)
  return clampWidgetPosition(window.innerWidth - width - 24, top, width, height)
}

function createWidgetController() {
  let open = false
  const listeners = new Set()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => open,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    isOpen: () => open,
    setOpen(next) {
      if (next === open) return
      open = next
      notify()
    },
    toggle() {
      this.setOpen(!open)
    },
  }
}

function useWidgetOpen(controller) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

function tagTone(tag) {
  let hash = 0
  for (let index = 0; index < tag.length; index += 1) {
    hash = (hash * 31 + tag.charCodeAt(index)) >>> 0
  }
  return hash % 4
}

function inlineNodes(text) {
  // The tag branch is last and requires a non-word, non-slash boundary before
  // `#`, so URL fragments and `C#` stay ordinary text while Obsidian tags such
  // as `#urgent` and `#project/alpha` become pills.
  const tokens = String(text).split(
    /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|==[^=]+==|\[\[[^\]]+\]\]|(?<![\p{L}\p{N}_#/])#[\p{L}\p{N}_]+(?:[/-][\p{L}\p{N}_]+)*)/gu,
  )
  return tokens.map((token, index) => {
    if (token === '') return null
    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      return createElement('strong', { key: index }, token.slice(2, -2))
    }
    if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      return createElement('em', { key: index }, token.slice(1, -1))
    }
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      return createElement('code', { key: index }, token.slice(1, -1))
    }
    if (token.startsWith('==') && token.endsWith('==') && token.length > 4) {
      return createElement('mark', { key: index }, token.slice(2, -2))
    }
    if (token.startsWith('[[') && token.endsWith(']]') && token.length > 4) {
      const label = token.slice(2, -2).split('|').at(-1)
      return createElement('span', { key: index, className: 'ots-wikilink' }, label)
    }
    if (token.startsWith('#') && token.length > 1) {
      return createElement(
        'span',
        { key: index, className: 'ots-tag', 'data-tone': tagTone(token) },
        token,
      )
    }
    return createElement(Fragment, { key: index }, token)
  })
}

/** Test seam: render one task string through the inline Markdown renderer. */
export function __renderInline(text) {
  return createElement('span', { className: 'ots-inline' }, inlineNodes(text))
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function ChecklistGlyph({ size = 18 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('rect', {
      x: 3.2,
      y: 3.2,
      width: 17.6,
      height: 17.6,
      rx: 5,
      stroke: 'currentColor',
      strokeWidth: 1.6,
    }),
    createElement('path', {
      d: 'M7.2 12.2l3 3 6.4-7',
      stroke: 'currentColor',
      strokeWidth: 1.9,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function GearGlyph({ size = 16 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z',
      stroke: 'currentColor',
      strokeWidth: 1.6,
    }),
    createElement('path', {
      d: 'M19.4 13.5a7.8 7.8 0 0 0 .05-3l1.7-1.3-1.9-3.3-2 .8a7.8 7.8 0 0 0-2.6-1.5L14.3 3h-4.6l-.4 2.2A7.8 7.8 0 0 0 6.7 6.7l-2-.8-1.9 3.3 1.7 1.3a7.8 7.8 0 0 0 .05 3l-1.7 1.3 1.9 3.3 2-.8a7.8 7.8 0 0 0 2.6 1.5l.4 2.2h4.6l.4-2.2a7.8 7.8 0 0 0 2.6-1.5l2 .8 1.9-3.3-1.7-1.3Z',
      stroke: 'currentColor',
      strokeWidth: 1.35,
      strokeLinejoin: 'round',
    }),
  )
}

function RefreshGlyph({ size = 15 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M20 11a8 8 0 0 0-14.8-4M4 5v5h5M4 13a8 8 0 0 0 14.8 4M20 19v-5h-5',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function ChevronGlyph({ direction = 'left', size = 15 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block', transform: direction === 'right' ? 'rotate(180deg)' : 'none' },
    },
    createElement('path', {
      d: 'M14.5 6.5 9 12l5.5 5.5',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function PlusGlyph({ size = 17 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M12 5v14M5 12h14',
      stroke: 'currentColor',
      strokeWidth: 1.9,
      strokeLinecap: 'round',
    }),
  )
}

function TrashGlyph({ size = 14 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M5 7h14M10 4h4l.6 3H9.4L10 4ZM7.5 7l.7 12h7.6l.7-12',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function GripGlyph() {
  return createElement(
    'svg',
    {
      width: 8,
      height: 14,
      viewBox: '0 0 8 14',
      fill: 'currentColor',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    ...[2, 7, 12].flatMap((y) => [
      createElement('circle', { key: `a${y}`, cx: 2, cy: y, r: 1.05 }),
      createElement('circle', { key: `b${y}`, cx: 6, cy: y, r: 1.05 }),
    ]),
  )
}

function FolderGlyph({ size = 18 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6A2.5 2.5 0 0 1 20.5 9.5v8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-10Z',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinejoin: 'round',
    }),
  )
}

function TreeGlyph({ size = 17 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('rect', {
      x: 8.6,
      y: 3,
      width: 6.8,
      height: 5.2,
      rx: 1.8,
      stroke: 'currentColor',
      strokeWidth: 1.5,
    }),
    createElement('rect', {
      x: 2,
      y: 15.8,
      width: 6.4,
      height: 5.2,
      rx: 1.8,
      stroke: 'currentColor',
      strokeWidth: 1.5,
    }),
    createElement('rect', {
      x: 15.6,
      y: 15.8,
      width: 6.4,
      height: 5.2,
      rx: 1.8,
      stroke: 'currentColor',
      strokeWidth: 1.5,
    }),
    createElement('path', {
      d: 'M12 8.2v3.6M5.2 15.8v-1.9a2 2 0 0 1 2-2h9.6a2 2 0 0 1 2 2v1.9',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function ShieldGlyph({ size = 20 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M12 2.8 19.2 5.5v5.2c0 4.4-2.9 7.9-7.2 9.6-4.3-1.7-7.2-5.2-7.2-9.6V5.5L12 2.8Z',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinejoin: 'round',
    }),
    createElement('path', {
      d: 'M8.8 11.9l2.2 2.2 4.4-4.6',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function LockGlyph({ size = 13 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('rect', {
      x: 4.5,
      y: 10,
      width: 15,
      height: 10.5,
      rx: 2.6,
      stroke: 'currentColor',
      strokeWidth: 1.7,
    }),
    createElement('path', {
      d: 'M8 10V7.6a4 4 0 0 1 8 0V10',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
    }),
  )
}

function CheckGlyph({ size = 13 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M5 12.6l4.3 4.3L19 7',
      stroke: 'currentColor',
      strokeWidth: 2.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function ChevronDownGlyph({ size = 12 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M6 9.5 12 15.5 18 9.5',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function SparkGlyph({ size = 13 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M12 3.2l1.9 5.1 5.1 1.9-5.1 1.9L12 17.2l-1.9-5.1L5 10.2l5.1-1.9L12 3.2Z',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinejoin: 'round',
    }),
  )
}

function ClockGlyph({ size = 13 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('circle', {
      cx: 12,
      cy: 12,
      r: 8.2,
      stroke: 'currentColor',
      strokeWidth: 1.6,
    }),
    createElement('path', {
      d: 'M12 7.4V12l3.2 2',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

function PlayGlyph({ size = 11 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'currentColor',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', { d: 'M7 4.5v15l12-7.5L7 4.5Z' }),
  )
}

function PauseGlyph({ size = 11 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'currentColor',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('rect', { x: 6.5, y: 5, width: 3.6, height: 14, rx: 1 }),
    createElement('rect', { x: 13.9, y: 5, width: 3.6, height: 14, rx: 1 }),
  )
}

function MinimizeGlyph({ minimized = false, size = 12 }) {
  if (minimized) {
    return createElement(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 12 12',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
      createElement('rect', {
        x: 2.2,
        y: 2.2,
        width: 7.6,
        height: 7.6,
        rx: 1.4,
        stroke: 'currentColor',
        strokeWidth: 1.3,
      }),
    )
  }
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 12 12',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('line', {
      x1: 2.2,
      y1: 6,
      x2: 9.8,
      y2: 6,
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
    }),
  )
}

function RolloverGlyph({ size = 13 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M4 7.5h11.5a4 4 0 0 1 0 8H9',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    createElement('path', {
      d: 'M7.5 12 4 15.5 7.5 19',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

// ---------------------------------------------------------------------------
// Sidebar launcher
// ---------------------------------------------------------------------------

function SidebarButton({ wide, t, open, onToggle }) {
  const iconSize = wide ? 15 : 17
  const active = open === true
  const idleBackground = 'transparent'
  const idleColor = 'var(--dsw-alias-label-secondary, inherit)'
  const activeBackground = 'rgba(126, 224, 189, 0.14)'
  const activeColor = '#7ee0bd'
  const style = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: wide ? 'flex-start' : 'center',
    gap: 8,
    width: wide ? '100%' : 32,
    height: 32,
    flex: '0 1 auto',
    minWidth: 0,
    padding: wide ? '0 9px' : 0,
    border: 0,
    borderRadius: 8,
    background: active ? activeBackground : idleBackground,
    color: active ? activeColor : idleColor,
    font: 'inherit',
    fontSize: 12,
    lineHeight: '18px',
    cursor: 'pointer',
    textAlign: 'left',
  }
  const labelStyle = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'inherit',
  }
  return createElement(
    'button',
    {
      type: 'button',
      style,
      title: active ? t('hideWidget') : t('open'),
      'aria-label': active ? t('hideWidget') : t('open'),
      'aria-pressed': active,
      onClick: onToggle,
      onMouseEnter: (event) => {
        event.currentTarget.style.background = active
          ? activeBackground
          : 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))'
        event.currentTarget.style.color = active ? activeColor : 'var(--dsw-alias-label-primary, inherit)'
      },
      onMouseLeave: (event) => {
        event.currentTarget.style.background = active ? activeBackground : idleBackground
        event.currentTarget.style.color = active ? activeColor : idleColor
      },
    },
    createElement(ChecklistGlyph, { size: iconSize }),
    wide ? createElement('span', { style: labelStyle }, t('open')) : null,
  )
}

function SidebarLauncher({ wide, t, controller }) {
  const open = useWidgetOpen(controller)
  return createElement(SidebarButton, {
    wide,
    t,
    open,
    onToggle: () => controller.toggle(),
  })
}

// ---------------------------------------------------------------------------
// Custom select
//
// A native <select> popup is drawn by the OS and cannot follow the widget's
// palette. This listbox is an ordinary button plus a positioned panel, with the
// keyboard behaviour a select is expected to have.
// ---------------------------------------------------------------------------

function Dropdown({
  ariaLabel,
  value,
  options = [],
  onChange,
  placeholder = '',
  icon = null,
  disabled = false,
  emptyLabel = null,
  className = '',
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef(null)
  const listRef = useRef(null)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null

  const openMenu = () => {
    if (disabled) return
    setActive(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  useEffect(() => {
    if (!open) return
    const node = listRef.current?.querySelector('[data-ots-active="true"]')
    if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const choose = (index) => {
    const option = options[index]
    if (option === undefined) return
    onChange(option.value)
    setOpen(false)
  }

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        openMenu()
        return
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => (current + delta + options.length) % Math.max(1, options.length))
      return
    }
    if (event.key === 'Home' && open) {
      event.preventDefault()
      setActive(0)
      return
    }
    if (event.key === 'End' && open) {
      event.preventDefault()
      setActive(Math.max(0, options.length - 1))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) choose(active)
      else openMenu()
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key === 'Tab') setOpen(false)
  }

  return createElement(
    'div',
    { className: `ots-dd-wrap ${className}`.trim(), ref: rootRef },
    createElement(
      'button',
      {
        type: 'button',
        className: 'ots-dd',
        role: 'combobox',
        'aria-label': ariaLabel,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        disabled,
        onClick: () => (open ? setOpen(false) : openMenu()),
        onKeyDown,
      },
      icon === null ? null : createElement('span', { className: 'ots-dd-icon' }, icon),
      createElement(
        'span',
        { className: 'ots-dd-label' },
        selected === null ? placeholder : selected.label,
      ),
      createElement(
        'span',
        { className: 'ots-dd-caret' },
        createElement(ChevronDownGlyph, { size: 12 }),
      ),
    ),
    open
      ? createElement(
          'div',
          { className: 'ots-dd-menu', role: 'listbox', 'aria-label': ariaLabel, ref: listRef },
          options.length === 0 && emptyLabel !== null
            ? createElement('div', { className: 'ots-dd-empty' }, emptyLabel)
            : options.map((option, index) =>
                createElement(
                  'button',
                  {
                    key: option.value,
                    type: 'button',
                    role: 'option',
                    'aria-selected': option.value === value,
                    className: `ots-dd-item${option.value === value ? ' is-selected' : ''}`,
                    'data-ots-active': index === active ? 'true' : undefined,
                    tabIndex: -1,
                    onPointerEnter: () => setActive(index),
                    onClick: () => choose(index),
                  },
                  createElement('span', { className: 'ots-dd-item-label' }, option.label),
                  option.hint === undefined
                    ? null
                    : createElement('span', { className: 'ots-dd-item-hint' }, option.hint),
                  option.value === value
                    ? createElement(
                        'span',
                        { className: 'ots-dd-item-check' },
                        createElement(CheckGlyph, { size: 12 }),
                      )
                    : null,
                ),
              ),
        )
      : null,
  )
}

// ---------------------------------------------------------------------------
// View rail
// ---------------------------------------------------------------------------

const VIEWS = [
  { id: 'checklist', key: 'navChecklist', glyph: ChecklistGlyph },
  { id: 'trees', key: 'navTrees', glyph: TreeGlyph },
]

function WidgetRail({ t, view, onSelect }) {
  return createElement(
    'nav',
    { className: 'ots-rail', 'aria-label': t('navAria') },
    VIEWS.map((entry) =>
      createElement(
        'button',
        {
          key: entry.id,
          type: 'button',
          className: `ots-rail-button${view === entry.id ? ' is-active' : ''}`,
          title: t(entry.key),
          'aria-label': t(entry.key),
          'aria-pressed': view === entry.id,
          onClick: () => onSelect(entry.id),
        },
        createElement(entry.glyph, { size: 17 }),
      ),
    ),
    createElement('span', { className: 'ots-rail-spacer' }),
    createElement('span', { className: 'ots-rail-mark', 'aria-hidden': 'true' }),
  )
}

// ---------------------------------------------------------------------------
// Focus timer
// ---------------------------------------------------------------------------

function FocusTimer({ t, onComplete }) {
  const [duration, setDuration] = useState(readFocusSeconds)
  const [remaining, setRemaining] = useState(duration)
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [flash, setFlash] = useState(false)
  const deadlineRef = useRef(null)
  const flashTimerRef = useRef(null)
  const editingRef = useRef(false)
  const inputRef = useRef(null)

  useEffect(() => {
    writeFocusSeconds(duration)
  }, [duration])

  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    if (!running) return undefined
    const tick = () => {
      const deadline = deadlineRef.current
      if (deadline === null) return
      const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1_000))
      setRemaining(next)
      if (next === 0) {
        deadlineRef.current = null
        setRunning(false)
        setFinished(true)
        onComplete()
      }
    }
    tick()
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [onComplete, running])

  useEffect(() => {
    if (!editing) return
    const node = inputRef.current
    if (node !== null) {
      node.focus()
      node.select()
    }
  }, [editing])

  const flashInvalid = () => {
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
    setFlash(true)
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null
      setFlash(false)
    }, 950)
  }

  const start = () => {
    if (running) return
    const from = remaining > 0 ? remaining : duration
    if (remaining <= 0) setRemaining(duration)
    deadlineRef.current = Date.now() + from * 1_000
    setFinished(false)
    setRunning(true)
  }

  const pause = () => {
    if (!running) return
    const deadline = deadlineRef.current
    const next =
      deadline === null ? remaining : Math.max(0, Math.ceil((deadline - Date.now()) / 1_000))
    deadlineRef.current = null
    setRemaining(next)
    setRunning(false)
  }

  const reset = () => {
    deadlineRef.current = null
    setRunning(false)
    setRemaining(duration)
    setFinished(false)
    setFlash(false)
  }

  const beginEdit = () => {
    const deadline = deadlineRef.current
    const current =
      running && deadline !== null
        ? Math.max(0, Math.ceil((deadline - Date.now()) / 1_000))
        : remaining
    if (running) {
      deadlineRef.current = null
      setRunning(false)
      setRemaining(current)
    }
    editingRef.current = true
    setDraft(formatFocusDuration(current))
    setEditing(true)
    setFlash(false)
  }

  const commit = (raw) => {
    if (!editingRef.current) return
    editingRef.current = false
    setEditing(false)
    const seconds = parseFocusDuration(raw)
    if (seconds === null) {
      // The displayed time never moved, so the previous valid duration remains
      // visible while the brief red flash explains the rejected input.
      flashInvalid()
      return
    }
    deadlineRef.current = null
    setRunning(false)
    setDuration(seconds)
    setRemaining(seconds)
    setFinished(false)
  }

  const cancel = () => {
    editingRef.current = false
    setEditing(false)
  }

  const className = `ots-focus${running ? ' is-running' : ''}${finished ? ' is-finished' : ''}${
    flash ? ' is-invalid' : ''
  }`

  return createElement(
    'section',
    { className, 'aria-label': t('focusTimer') },
    createElement('span', { className: 'ots-focus-icon', 'aria-hidden': 'true' }, createElement(ClockGlyph, { size: 14 })),
    createElement(
      'span',
      { className: 'ots-focus-copy' },
      createElement('span', { className: 'ots-focus-label' }, t('focusTimer')),
      editing
        ? createElement('input', {
            ref: inputRef,
            className: 'ots-focus-input',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onBlur: () => commit(draft),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit(draft)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancel()
              }
            },
            'aria-label': t('focusEdit'),
            'aria-invalid': flash,
            inputMode: 'text',
            autoComplete: 'off',
            spellCheck: false,
            maxLength: 12,
          })
        : createElement(
            'button',
            {
              type: 'button',
              className: 'ots-focus-time',
              title: flash ? t('focusInvalid') : t('focusEdit'),
              'aria-label': `${t('focusTimer')}: ${formatFocusDuration(remaining)}`,
              onClick: beginEdit,
            },
            formatFocusDuration(remaining),
          ),
    ),
    createElement(
      'span',
      { className: 'ots-focus-actions' },
      createElement(
        'button',
        {
          type: 'button',
          className: `ots-focus-btn${running ? '' : ' is-primary'}`,
          title: t('focusStart'),
          'aria-label': t('focusStart'),
          disabled: running,
          onClick: start,
        },
        createElement(PlayGlyph, { size: 10 }),
        createElement('span', null, t('focusStart')),
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'ots-focus-btn',
          title: t('focusPause'),
          'aria-label': t('focusPause'),
          disabled: !running,
          onClick: pause,
        },
        createElement(PauseGlyph, { size: 10 }),
        createElement('span', null, t('focusPause')),
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'ots-focus-btn',
          title: t('focusReset'),
          'aria-label': t('focusReset'),
          onClick: reset,
        },
        createElement(RefreshGlyph, { size: 10 }),
        createElement('span', null, t('focusReset')),
      ),
    ),
    createElement(
      'span',
      { className: 'ots-sr-only', role: 'status' },
      flash ? t('focusInvalid') : '',
    ),
  )
}

/** Test seam: render the focus timer at its initial 60-minute state. */
export function __renderFocusTimer() {
  return createElement(FocusTimer, { t: (key) => key, onComplete: () => {} })
}

// ---------------------------------------------------------------------------
// Floating widget
// ---------------------------------------------------------------------------

function WidgetLayer({ t, controller }) {
  const open = useWidgetOpen(controller)
  if (!open) return null
  return createElement(FloatingWidget, { t, onClose: () => controller.setOpen(false) })
}

function FloatingWidget({ t, onClose }) {
  const [bridge] = useState(() => new ChecklistBridge())
  useEffect(() => () => bridge.dispose(), [bridge])

  const widgetRef = useRef(null)
  const dragRef = useRef(null)
  const detachDragRef = useRef(null)
  const initialPosition = useRef(null)
  if (initialPosition.current === null) {
    initialPosition.current = readWidgetPosition() ?? defaultWidgetPosition()
  }
  const [position, setPosition] = useState(initialPosition.current)
  const positionRef = useRef(initialPosition.current)
  const [dragging, setDragging] = useState(false)
  const [view, setView] = useState('checklist')
  const [treesMounted, setTreesMounted] = useState(false)
  // The entrance animation is one-shot. It must never be tied to drag state:
  // removing `is-dragging` re-adds the animation rule and replays the fall-in
  // effect the moment the pointer is released, which reads as a flicker.
  const [entering, setEntering] = useState(true)
  const [minimized, setMinimized] = useState(readWidgetMinimized)
  const [summary, setSummary] = useState({ completed: 0, total: 0, percent: 0 })
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))

  useEffect(() => {
    writeWidgetMinimized(minimized)
  }, [minimized])

  const preferredWidth = minimized ? MINIMIZED_WIDTH : view === 'trees' ? TREE_WIDTH : WIDGET_WIDTH
  const width = Math.max(280, Math.min(preferredWidth, viewport.width - WIDGET_MARGIN * 2))

  const selectView = (nextView) => {
    if (nextView === view) return
    if (nextView === 'trees') setTreesMounted(true)
    const targetWidth = Math.max(
      280,
      Math.min(nextView === 'trees' ? TREE_WIDTH : WIDGET_WIDTH, window.innerWidth - WIDGET_MARGIN * 2),
    )
    const current = positionRef.current
    const maxLeft = Math.max(WIDGET_MARGIN, window.innerWidth - targetWidth - WIDGET_MARGIN)
    if (current.left > maxLeft) {
      const next = { left: maxLeft, top: current.top }
      positionRef.current = next
      setPosition(next)
      writeWidgetPosition(next)
    }
    setView(nextView)
  }

  useEffect(() => {
    positionRef.current = position
  }, [position])

  // A stored position can predate the titlebar-aware clamp (for example
  // `top: 8` from the old pop-out layout). Repair and persist it on mount and
  // whenever the viewport changes so the card never hides under the caption.
  useEffect(() => {
    const element = widgetRef.current
    if (element === null) return undefined
    const clamp = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight })
      const rect = element.getBoundingClientRect()
      const current = positionRef.current
      // The width transition means the measured box can still be the old width.
      // Clamp against the target width so expanding at the right edge pulls the
      // card back on screen instead of letting it grow past the viewport.
      const targetWidth = Math.max(
        280,
        Math.min(
          minimized ? MINIMIZED_WIDTH : view === 'trees' ? TREE_WIDTH : WIDGET_WIDTH,
          window.innerWidth - WIDGET_MARGIN * 2,
        ),
      )
      const next = clampWidgetPosition(current.left, current.top, targetWidth, rect.height)
      if (next.left === current.left && next.top === current.top) return
      positionRef.current = next
      writeWidgetPosition(next)
      setPosition(next)
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
    // Minimizing changes the card height; expanding changes it again. Re-clamp
    // after either so the widget never grows off the bottom of the viewport.
  }, [minimized, view])

  useEffect(() => {
    if (!dragging) return undefined
    const previous = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.userSelect = previous
    }
  }, [dragging])

  useEffect(
    () => () => {
      detachDragRef.current?.()
      detachDragRef.current = null
    },
    [],
  )

  // Dragging starts only on the chrome (the header drag handle). The move and
  // up listeners live on window only for the duration of that drag, so the
  // widget body keeps normal click, focus and text-input propagation.
  const handlePointerDown = (event) => {
    if (event.button !== 0) return
    const target = event.target
    if (
      target instanceof Element &&
      target.closest('button, input, select, textarea, a, [data-ots-no-drag]')
    ) {
      return
    }
    const element = widgetRef.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    const pointerId = event.pointerId
    dragRef.current = {
      pointerId,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    }
    setDragging(true)
    event.preventDefault()

    const move = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      const drag = dragRef.current
      if (drag === null) return
      const box = widgetRef.current
      const width = box?.offsetWidth ?? WIDGET_WIDTH
      const height = box?.offsetHeight ?? WIDGET_HEIGHT
      const next = clampWidgetPosition(
        moveEvent.clientX - drag.dx,
        moveEvent.clientY - drag.dy,
        width,
        height,
      )
      positionRef.current = next
      setPosition(next)
      moveEvent.preventDefault()
    }

    const detach = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      detachDragRef.current = null
    }

    const up = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return
      detach()
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== pointerId) return
      dragRef.current = null
      setDragging(false)
      writeWidgetPosition(positionRef.current)
    }

    detachDragRef.current?.()
    detachDragRef.current = detach
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)

    try {
      event.currentTarget.focus({ preventScroll: true })
    } catch {
      // Focus is only needed for keyboard nudging after a drag.
    }
  }

  const handleKeyDown = (event) => {
    if (event.target !== event.currentTarget) return
    const step = event.shiftKey ? 64 : 16
    let dx = 0
    let dy = 0
    if (event.key === 'ArrowLeft') dx = -step
    else if (event.key === 'ArrowRight') dx = step
    else if (event.key === 'ArrowUp') dy = -step
    else if (event.key === 'ArrowDown') dy = step
    else return
    event.preventDefault()
    const element = widgetRef.current
    const width = element?.offsetWidth ?? WIDGET_WIDTH
    const height = element?.offsetHeight ?? WIDGET_HEIGHT
    const next = clampWidgetPosition(position.left + dx, position.top + dy, width, height)
    positionRef.current = next
    setPosition(next)
    writeWidgetPosition(next)
  }

  return createPortal(
    createElement(
      LocaleContext.Provider,
      { value: t },
      createElement(
        'div',
        {
          ref: widgetRef,
          className: `ots-widget${entering ? ' is-entering' : ''}${dragging ? ' is-dragging' : ''}${view === 'trees' ? ' is-wide' : ''}${minimized ? ' is-minimized' : ''}`,
          style: {
            left: `${position.left}px`,
            top: `${position.top}px`,
            width: `${width}px`,
            '--ots-top-inset': `${widgetTopInset()}px`,
          },
          role: 'dialog',
          'aria-label': view === 'trees' ? t('treeTitle') : t('widget'),
          onAnimationEnd: (event) => {
            if (event.target === event.currentTarget && event.animationName === 'ots-widget-in') {
              setEntering(false)
            }
          },
        },
        createElement('style', null, CSS),
        createElement(
          'div',
          {
            className: 'ots-widget-chrome',
            'data-ots-drag-handle': '',
            tabIndex: 0,
            title: t('dragWidget'),
            'aria-label': t('dragWidget'),
            onPointerDown: handlePointerDown,
            onKeyDown: handleKeyDown,
          },
          createElement(
            'span',
            { className: 'ots-widget-grip', 'aria-hidden': 'true' },
            createElement(GripGlyph),
          ),
          createElement(
            'span',
            { className: 'ots-widget-title' },
            view === 'trees' ? t('treeTitle') : t('widget'),
          ),
          minimized && view === 'checklist'
            ? createElement(
                'span',
                {
                  className: 'ots-widget-mini-stats',
                  title: `${t('minimizedProgress')}: ${summary.percent}%`,
                },
                createElement(ProgressRing, {
                  percent: summary.percent,
                  label: t('minimizedProgress'),
                  size: 28,
                  compact: true,
                }),
                createElement(
                  'span',
                  { className: 'ots-widget-mini-count' },
                  `${summary.completed}/${summary.total}`,
                ),
              )
            : null,
          createElement(
            'button',
            {
              type: 'button',
              className: 'ots-widget-minimize',
              title: minimized ? t('expandWidget') : t('minimizeWidget'),
              'aria-label': minimized ? t('expandWidget') : t('minimizeWidget'),
              'aria-pressed': minimized,
              onClick: () => setMinimized((value) => !value),
            },
            createElement(MinimizeGlyph, { minimized, size: 12 }),
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'ots-widget-close',
              title: t('closeWidget'),
              'aria-label': t('closeWidget'),
              onClick: onClose,
            },
            '×',
          ),
        ),
        createElement(
          'div',
          { className: 'ots-widget-main' },
          createElement(WidgetRail, { t, view, onSelect: selectView }),
          createElement(
            'div',
            { className: 'ots-widget-body' },
            createElement(
              'div',
              { className: 'ots-view', 'data-active': view === 'checklist' },
              createElement(ChecklistApp, { bridge, onSummary: setSummary }),
            ),
            treesMounted
              ? createElement(
                  'div',
                  { className: 'ots-view', 'data-active': view === 'trees' },
                  createElement(SkillTreeApp, {
                    bridge,
                    active: view === 'trees',
                    onOpenChecklist: () => selectView('checklist'),
                  }),
                )
              : null,
          ),
        ),
      ),
    ),
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function ChecklistApp({ bridge, onSummary }) {
  const t = useT()
  const [today, setToday] = useState(() => localDateKey())
  const [phase, setPhase] = useState('boot')
  const [vault, setVault] = useState('')
  const [files, setFiles] = useState([])
  const [activeFile, setActiveFile] = useState(null)
  const [doc, setDoc] = useState(null)
  const docRef = useRef(null)
  const [missing, setMissing] = useState(false)
  const [status, setStatus] = useState('connecting')
  const [lastSync, setLastSync] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [input, setInput] = useState('')
  const [createTitle, setCreateTitle] = useState('Daily')
  const [toast, setToast] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [bootError, setBootError] = useState('')
  const [bridgeReady, setBridgeReady] = useState(() => bridge.hasToken())
  const [bridgeError, setBridgeError] = useState('')
  const [bridgeAttempt, setBridgeAttempt] = useState(0)
  const [dragIndex, setDragIndex] = useState(null)
  const [dropIndex, setDropIndex] = useState(null)
  const shouldScrollRef = useRef(false)
  const previousTaskCount = useRef(0)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const todayRef = useRef(today)

  const applyDoc = useCallback((next) => {
    docRef.current = next
    setDoc(next)
    if (next !== null) {
      setMissing(false)
      setLastSync(Date.now())
      setStatus('live')
    }
  }, [])

  const showError = useCallback(
    (error) => {
      const failure = asBridgeError(error)
      if (failure.document !== undefined && failure.document !== null) applyDoc(failure.document)
      if (failure.code === 'offline' || failure.code === 'token-missing') setStatus('offline')
      setToast({ text: failure.message, tone: 'error' })
    },
    [applyDoc],
  )

  const focusComplete = useCallback(() => {
    setToast({ text: t('focusComplete'), tone: 'success' })
  }, [t])

  const refreshDocument = useCallback(
    async (silent = false) => {
      if (!vault || !activeFile) return null
      try {
        const next = await bridge.request('document', { root: vault, file: activeFile })
        applyDoc(next)
        return next
      } catch (error) {
        const failure = asBridgeError(error)
        if (failure.code === 'missing-file' || failure.code === 'not-found') {
          docRef.current = null
          setDoc(null)
          setMissing(true)
          setStatus('live')
          return null
        }
        if (!silent) showError(failure)
        else if (failure.code === 'offline') setStatus('offline')
        return null
      }
    },
    [activeFile, applyDoc, bridge, showError, vault],
  )

  const refreshFiles = useCallback(async () => {
    if (!vault) return []
    try {
      const data = await bridge.request('vault/files', { root: vault })
      const list = Array.isArray(data.files) ? data.files : []
      setFiles(list)
      return list
    } catch (error) {
      showError(error)
      return []
    }
  }, [bridge, showError, vault])

  // The Host bridge is the only path to the filesystem, so hold every read
  // until its token is ready. A live plugin install leaves the already-loaded
  // desktop page without the injected global; `ready()` then bootstraps the
  // token through the authenticated same-origin route and retries while the
  // Host finishes activating the new bridge.
  useEffect(() => {
    if (bridgeReady) return undefined
    let cancelled = false
    setBridgeError('')
    setStatus('connecting')
    void bridge
      .ready()
      .then(() => {
        if (!cancelled) setBridgeReady(true)
      })
      .catch((error) => {
        if (cancelled) return
        setBridgeError(asBridgeError(error).message)
        setStatus('offline')
      })
    return () => {
      cancelled = true
    }
  }, [bridge, bridgeAttempt, bridgeReady])

  // First load: persist the folder path, list files, and default to today.
  useEffect(() => {
    if (!bridgeReady) return undefined
    let cancelled = false
    const stored = readVault()
    if (stored === null) {
      setPhase('setup')
      return undefined
    }
    setVault(stored)
    vaultStore.set(stored)
    void (async () => {
      try {
        const checked = await bridge.request('vault/check', { root: stored })
        if (cancelled) return
        const list = Array.isArray(checked.files) ? checked.files : []
        const normalized = typeof checked.root === 'string' ? checked.root : stored
        writeVault(normalized)
        setVault(normalized)
        setFiles(list)
        const todayFile = selectTodayFile(list, localDateKey())
        setActiveFile(todayFile?.file ?? null)
        setMissing(todayFile === null)
        setPhase('ready')
        setStatus('connecting')
      } catch (error) {
        if (cancelled) return
        const failure = asBridgeError(error)
        setBootError(failure.message)
        setPhase('setup')
        setStatus('offline')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bridge, bridgeReady])

  // A new active file starts a fresh read and a fresh live subscription.
  useEffect(() => {
    if (!bridgeReady || phase !== 'ready' || vault === '' || activeFile === null) return undefined
    let disposed = false
    let unsubscribe = () => {}
    setStatus('connecting')
    setMissing(false)
    docRef.current = null
    setDoc(null)

    const consume = (eventName, data) => {
      if (disposed) return
      if (eventName === 'document' && isRecord(data)) {
        if (data.kind === 'missing') {
          docRef.current = null
          setDoc(null)
          setMissing(true)
          setStatus('live')
          return
        }
        if (isRecord(data.document) && data.document.file === activeFile) {
          applyDoc(data.document)
        }
        return
      }
      if (eventName === 'files' && isRecord(data) && Array.isArray(data.files)) {
        setFiles(data.files)
        return
      }
      if (eventName === 'watch-error' || eventName === 'stream-error') {
        setStatus('polling')
      }
    }

    void refreshDocument(true)
    void bridge
      .subscribe(vault, activeFile, consume)
      .then((dispose) => {
        if (disposed) dispose()
        else unsubscribe = dispose
      })
      .catch(() => {
        if (!disposed) setStatus('polling')
      })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [activeFile, applyDoc, bridge, bridgeReady, phase, refreshDocument, vault])

  // Polling is a safety net for a dropped SSE stream and for EventSource being
  // blocked by a host policy. The watcher still delivers the prompt update.
  useEffect(() => {
    if (!bridgeReady || phase !== 'ready' || vault === '' || activeFile === null) return undefined
    const tick = () => {
      if (busyRef.current) return
      void refreshDocument(true)
    }
    const timer = setInterval(tick, POLL_MS)
    return () => clearInterval(timer)
  }, [activeFile, bridgeReady, phase, refreshDocument, vault])

  // While today's file is absent, keep checking the folder so an external agent
  // (or Obsidian sync) creating it makes the widget pick it up without a click.
  useEffect(() => {
    if (!bridgeReady || phase !== 'ready' || vault === '' || activeFile !== null) return undefined
    let disposed = false
    const check = async () => {
      try {
        const data = await bridge.request('vault/files', { root: vault })
        if (disposed || !Array.isArray(data.files)) return
        setFiles(data.files)
        const todayFile = selectTodayFile(data.files, today)
        if (todayFile !== null) {
          setMissing(false)
          setActiveFile(todayFile.file)
        }
      } catch {
        // The setup/missing state already explains an unreachable folder.
      }
    }
    void check()
    const timer = setInterval(check, POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [activeFile, bridge, bridgeReady, phase, today, vault])

  // Keep relative timestamps honest, and roll over at local midnight.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      const key = localDateKey()
      setToday((current) => (current === key ? current : key))
    }, 15_000)
    return () => clearInterval(timer)
  }, [])

  // Daily auto-rollover: when the calendar day changes, prefer today's file.
  useEffect(() => {
    if (!bridgeReady || phase !== 'ready' || vault === '') return
    if (todayRef.current === today) return
    todayRef.current = today
    void (async () => {
      try {
        const data = await bridge.request('vault/files', { root: vault })
        const list = Array.isArray(data.files) ? data.files : []
        setFiles(list)
        const todayFile = selectTodayFile(list, today)
        setActiveFile(todayFile?.file ?? null)
        setMissing(todayFile === null)
        if (todayFile === null) {
          docRef.current = null
          setDoc(null)
        }
      } catch (error) {
        showError(error)
      }
    })()
  }, [bridge, bridgeReady, phase, showError, today, vault])

  useEffect(() => {
    const count = doc?.tasks.length ?? 0
    if (shouldScrollRef.current && count > previousTaskCount.current) {
      shouldScrollRef.current = false
      requestAnimationFrame(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
      })
    }
    previousTaskCount.current = count
  }, [doc])

  useEffect(() => {
    if (toast === null) return undefined
    const timer = setTimeout(() => setToast(null), 6_000)
    return () => clearTimeout(timer)
  }, [toast])

  // The minimized card lives in FloatingWidget while the checklist state lives
  // here. Publish the compact summary so the collapsed pill keeps showing the
  // completion ring without lifting the whole checklist store.
  useEffect(() => {
    const total = doc?.tasks.length ?? 0
    const completed = doc?.checkedCount ?? 0
    onSummary({
      completed,
      total,
      percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    })
  }, [doc, onSummary])

  useEffect(() => {
    if (!settingsOpen) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [settingsOpen])

  const connect = async (rawPath) => {
    const path = String(rawPath ?? '').trim()
    if (path === '' || !/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path)) {
      setBootError(t('absoluteOnly'))
      return
    }
    setConnecting(true)
    setBootError('')
    try {
      const checked = await bridge.request('vault/check', { root: path })
      const list = Array.isArray(checked.files) ? checked.files : []
      const normalized = typeof checked.root === 'string' ? checked.root : path
      writeVault(normalized)
      setVault(normalized)
      setFiles(list)
      const todayFile = selectTodayFile(list, localDateKey())
      setActiveFile(todayFile?.file ?? null)
      setMissing(todayFile === null)
      docRef.current = null
      setDoc(null)
      setPhase('ready')
      setStatus('connecting')
      todayRef.current = localDateKey()
    } catch (error) {
      setBootError(asBridgeError(error).message)
      setPhase('setup')
    } finally {
      setConnecting(false)
    }
  }

  const mutate = async (optimistic, work) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    if (optimistic !== null) {
      docRef.current = optimistic
      setDoc(optimistic)
    }
    try {
      const next = await work()
      applyDoc(next)
    } catch (error) {
      showError(error)
      if (asBridgeError(error).document === undefined) await refreshDocument(true)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const toggleTask = (task) => {
    const current = docRef.current
    if (current === null || busyRef.current) return
    const checked = !task.checked
    const optimistic = {
      ...current,
      tasks: current.tasks.map((candidate) =>
        candidate.line === task.line ? { ...candidate, checked } : candidate,
      ),
      checkedCount: Math.max(0, current.checkedCount + (checked ? 1 : -1)),
    }
    void mutate(optimistic, () =>
      bridge.request('task/toggle', {
        root: vault,
        file: current.file,
        line: task.line,
        raw: task.raw,
        checked,
        revision: current.revision,
      }),
    )
  }

  const appendTask = (event) => {
    event.preventDefault()
    const text = input.trim()
    const current = docRef.current
    if (text === '' || current === null || busyRef.current) return
    setInput('')
    shouldScrollRef.current = true
    void mutate(null, async () => {
      const next = await bridge.request('task/append', {
        root: vault,
        file: current.file,
        text,
        revision: current.revision,
      })
      requestAnimationFrame(() => inputRef.current?.focus())
      return next
    })
  }

  const deleteTask = (task) => {
    const current = docRef.current
    if (current === null || busyRef.current) return
    void mutate(null, () =>
      bridge.request('task/delete', {
        root: vault,
        file: current.file,
        line: task.line,
        raw: task.raw,
        revision: current.revision,
      }),
    )
  }

  const dropTask = (targetIndex) => {
    const current = docRef.current
    if (current === null || busyRef.current || dragIndex === null) {
      setDragIndex(null)
      setDropIndex(null)
      return
    }
    const from = dragIndex
    setDragIndex(null)
    setDropIndex(null)
    if (from === targetIndex) return
    const tasks = [...current.tasks]
    const [moved] = tasks.splice(from, 1)
    tasks.splice(targetIndex, 0, moved)
    const order = tasks.map((task) => task.line)
    void mutate({ ...current, tasks }, () =>
      bridge.request('task/reorder', {
        root: vault,
        file: current.file,
        order,
        revision: current.revision,
      }),
    )
  }

  const createToday = async () => {
    if (vault === '' || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const created = await bridge.request('checklist/create', {
        root: vault,
        date: localDateKey(),
        title: createTitle.trim() || 'Daily',
      })
      const data = await bridge.request('vault/files', { root: vault })
      if (Array.isArray(data.files)) setFiles(data.files)
      setActiveFile(created.file)
      setMissing(false)
      if (created.file === activeFile) applyDoc(created)
      setToast({ text: t('created'), tone: 'success' })
    } catch (error) {
      showError(error)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const rollover = async () => {
    const current = docRef.current
    if (current === null || busyRef.current) return
    if (current.checkedCount >= current.totalCount) {
      setToast({ text: t('noRollover'), tone: 'info' })
      return
    }
    const sourceFile = current.file
    busyRef.current = true
    setBusy(true)
    try {
      const result = await bridge.request('task/rollover', {
        root: vault,
        file: sourceFile,
        revision: current.revision,
      })
      // Navigating to another checklist while the request was in flight must
      // not paint the old document into the newly selected day.
      const stillViewing = docRef.current?.file === sourceFile
      if (stillViewing && isRecord(result.today) && typeof result.today.file === 'string') {
        applyDoc(result.today)
      }
      if (Array.isArray(result.files)) setFiles(result.files)
      const moved = Number(result.moved)
      if (Number.isFinite(moved) && moved > 0) {
        const targetDate =
          isRecord(result.tomorrow) && typeof result.tomorrow.date === 'string'
            ? result.tomorrow.date
            : ''
        const target = targetDate === '' ? t('today') : shortDate(targetDate)
        setToast({
          text: `${t('rolledOver')} ${moved} ${t('tasksTo')} ${target}`,
          tone: 'success',
        })
      } else {
        setToast({ text: t('noRollover'), tone: 'info' })
      }
      // The response already refreshed both documents, but a follow-up read
      // keeps the view honest if Obsidian wrote the file at the same moment.
      if (stillViewing) void refreshDocument(true)
    } catch (error) {
      showError(error)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const goToday = async () => {
    const list = await refreshFiles()
    const file = selectTodayFile(list, today)
    setActiveFile(file?.file ?? null)
    setMissing(file === null)
    if (file === null) {
      docRef.current = null
      setDoc(null)
    }
  }

  const fileIndex = files.findIndex((file) => file.file === activeFile)
  const olderFile = fileIndex >= 0 ? files[fileIndex + 1] : activeFile === null ? undefined : files[0]
  const newerFile = fileIndex > 0 ? files[fileIndex - 1] : null
  const total = doc?.tasks.length ?? 0
  const completed = doc?.checkedCount ?? 0
  const incomplete = Math.max(0, total - completed)
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100)
  const title = doc === null ? t('today') : doc.title === 'Daily' ? t('today') : doc.title
  const dateKey = doc?.date ?? today
  const synced = lastSync === 0 ? null : relativeTime(lastSync, now)
  const statusLabel =
    status === 'live'
      ? t('live')
      : status === 'polling'
        ? t('polling')
        : status === 'offline'
          ? t('offline')
          : t('syncing')

  if (!bridgeReady) {
    return createElement(BridgeState, {
      t,
      error: bridgeError,
      onRetry: () => {
        setBridgeError('')
        setBridgeAttempt((value) => value + 1)
      },
    })
  }

  if (phase === 'setup' || phase === 'boot') {
    return createElement(SetupView, {
      t,
      initialPath: vault === '' ? (readVault() ?? '') : vault,
      connecting: phase === 'boot' || connecting,
      error: bootError,
      canCancel: files.length > 0,
      onCancel: () => {
        setBootError('')
        setPhase('ready')
      },
      onConnect: connect,
    })
  }

  return createElement(
    'main',
    { className: 'ots-app' },
    createElement(
      'header',
      { className: 'ots-header' },
      createElement(
        'div',
        { className: 'ots-topbar' },
        createElement(
          'div',
          { className: 'ots-brand' },
          createElement('span', { className: 'ots-brand-mark' }, createElement(ChecklistGlyph, { size: 17 })),
          createElement(
            'span',
            { className: 'ots-brand-copy' },
            createElement('span', { className: 'ots-eyebrow' }, t('widget')),
            createElement('span', { className: `ots-status ots-status-${status}` }, createElement('span', { className: 'ots-status-dot' }), statusLabel),
          ),
        ),
        createElement(
          'div',
          { className: 'ots-toolbar' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'ots-icon-button',
              title: t('refresh'),
              'aria-label': t('refresh'),
              onClick: () => {
                void refreshFiles()
                void refreshDocument()
              },
            },
            createElement(RefreshGlyph),
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'ots-icon-button',
              title: t('settings'),
              'aria-label': t('settings'),
              onClick: () => setSettingsOpen(true),
            },
            createElement(GearGlyph),
          ),
        ),
      ),
      createElement(
        'div',
        { className: 'ots-heading' },
        createElement(
          'div',
          { className: 'ots-heading-copy' },
          createElement('div', { className: 'ots-date' }, longDate(dateKey)),
          createElement('h1', { className: 'ots-title' }, title),
          createElement(
            'p',
            { className: 'ots-subtitle' },
            total === 0
              ? `0 ${t('tasks')}`
              : `${completed} / ${total} ${t('completed')}${total - completed > 0 ? ` · ${total - completed} ${t('left')}` : ''}`,
          ),
        ),
        createElement(ProgressRing, { percent, label: t('progress') }),
      ),
      createElement(
        'div',
        { className: 'ots-progress-track', 'aria-hidden': 'true' },
        createElement('div', { className: 'ots-progress-fill', style: { width: `${percent}%` } }),
      ),
      createElement(FocusTimer, { t, onComplete: focusComplete }),
      createElement(
        'div',
        { className: 'ots-picker-row' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'ots-icon-button ots-chevron',
            title: t('previous'),
            'aria-label': t('previous'),
            disabled: olderFile === undefined,
            onClick: () => olderFile !== undefined && setActiveFile(olderFile.file),
          },
          createElement(ChevronGlyph, { direction: 'left' }),
        ),
        createElement(
          'div',
          { className: 'ots-picker-select' },
          createElement(Dropdown, {
            ariaLabel: t('chooseFile'),
            value: activeFile ?? '',
            placeholder: t('noChecklistToday'),
            icon: createElement(FolderGlyph, { size: 14 }),
            emptyLabel: t('noChecklistToday'),
            options: files.map((file) => ({
              value: file.file,
              label: `${shortDate(file.date)} · ${file.title}`,
            })),
            onChange: (value) => {
              if (value === '') {
                setActiveFile(null)
                setMissing(true)
                docRef.current = null
                setDoc(null)
                return
              }
              setActiveFile(value)
            },
          }),
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: 'ots-icon-button ots-chevron',
            title: t('next'),
            'aria-label': t('next'),
            disabled: newerFile === null,
            onClick: () => newerFile !== null && setActiveFile(newerFile.file),
          },
          createElement(ChevronGlyph, { direction: 'right' }),
        ),
      ),
    ),
    createElement(
      'section',
      { className: 'ots-body', 'aria-busy': busy },
      activeFile !== null && missing
        ? createElement(MissingState, { t, onToday: goToday, onCreate: createToday })
        : activeFile === null
          ? createElement(CreateState, {
              t,
              date: today,
              title: createTitle,
              onTitle: setCreateTitle,
              onCreate: createToday,
              busy,
            })
          : doc === null
            ? createElement(Skeleton, null)
            : createElement(
                'div',
                { className: 'ots-list', ref: listRef },
                doc.tasks.length === 0
                  ? createElement('div', { className: 'ots-empty-tasks' }, t('noTasks'))
                  : null,
                doc.tasks.map((task, index) =>
                  createElement(
                    Fragment,
                    { key: task.id },
                    task.section !== null && (index === 0 || doc.tasks[index - 1].section !== task.section)
                      ? createElement('div', { className: 'ots-section' }, task.section)
                      : null,
                    createElement(TaskRow, {
                      t,
                      task,
                      index,
                      busy,
                      dragging: dragIndex === index,
                      dropBefore: dropIndex === index && dragIndex !== null && dragIndex !== index,
                      onToggle: () => toggleTask(task),
                      onDelete: () => deleteTask(task),
                      onDragStart: (event) => {
                        if (busyRef.current) {
                          event.preventDefault()
                          return
                        }
                        setDragIndex(index)
                        try {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', String(index))
                        } catch {
                          // Some WebViews refuse custom drag data; local state still works.
                        }
                      },
                      onDragOver: (event) => {
                        event.preventDefault()
                        try {
                          event.dataTransfer.dropEffect = 'move'
                        } catch {
                          // Ignore.
                        }
                        setDropIndex(index)
                      },
                      onDrop: (event) => {
                        event.preventDefault()
                        dropTask(index)
                      },
                      onDragEnd: () => {
                        setDragIndex(null)
                        setDropIndex(null)
                      },
                    }),
                  ),
                ),
              ),
      busy ? createElement('div', { className: 'ots-busy-bar', 'aria-hidden': 'true' }) : null,
    ),
    createElement(
      'footer',
      { className: 'ots-footer' },
      createElement(
        'div',
        { className: `ots-status-line ots-status-${status}` },
        createElement('span', { className: 'ots-status-dot' }),
        createElement('span', null, synced === null ? t('justNow') : `${t('lastSync')} · ${synced}`),
        createElement('span', { className: 'ots-status-sep' }, '·'),
        createElement('span', { className: 'ots-file-name', title: doc?.file ?? activeFile ?? '' }, doc?.file ?? activeFile ?? ''),
      ),
      createElement(
        'div',
        { className: 'ots-rollover-row' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'ots-rollover',
            disabled: doc === null || busy || missing || incomplete === 0,
            title: incomplete === 0 ? t('noRollover') : t('rolloverHint'),
            'aria-label': t('rollover'),
            onClick: () => {
              void rollover()
            },
          },
          createElement(RolloverGlyph, { size: 13 }),
          createElement('span', { className: 'ots-rollover-label' }, busy ? t('rollingOver') : t('rollover')),
          incomplete > 0
            ? createElement('span', { className: 'ots-rollover-count' }, String(incomplete))
            : null,
        ),
      ),
      createElement(
        'form',
        { className: 'ots-composer', onSubmit: appendTask },
        createElement('span', { className: 'ots-composer-plus', 'aria-hidden': 'true' }, createElement(PlusGlyph, { size: 15 })),
        createElement('input', {
          ref: inputRef,
          className: 'ots-input',
          value: input,
          onChange: (event) => setInput(event.target.value),
          placeholder: t('addPlaceholder'),
          'aria-label': t('addPlaceholder'),
          disabled: doc === null || busy || missing,
          maxLength: 500,
          autoComplete: 'off',
          spellCheck: true,
        }),
        createElement(
          'button',
          {
            type: 'submit',
            className: 'ots-send',
            disabled: input.trim() === '' || doc === null || busy || missing,
            title: t('add'),
            'aria-label': t('add'),
          },
          createElement(PlusGlyph, { size: 16 }),
        ),
      ),
    ),
    toast === null
      ? null
      : createElement(
          'div',
          { className: `ots-toast ots-toast-${toast.tone}`, role: 'status' },
          createElement('span', null, toast.text),
          createElement(
            'button',
            {
              type: 'button',
              className: 'ots-toast-close',
              'aria-label': t('closeToast'),
              onClick: () => setToast(null),
            },
            '×',
          ),
        ),
    settingsOpen
      ? createElement(SettingsSheet, {
          t,
          vault,
          onClose: () => setSettingsOpen(false),
          onChangeFolder: () => {
            setSettingsOpen(false)
            setBootError('')
            setPhase('setup')
          },
          onRefresh: () => {
            setSettingsOpen(false)
            void refreshFiles()
            void refreshDocument()
          },
        })
      : null,
  )
}

function ProgressRing({ percent, label, size = 48, compact = false }) {
  const radius = compact ? 10.2 : 19
  const strokeWidth = compact ? 3 : 3.4
  const box = compact ? 28 : 48
  const center = box / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.max(0, Math.min(100, percent)) / 100)
  return createElement(
    'div',
    {
      className: `ots-ring${compact ? ' ots-ring-compact' : ''}${percent >= 100 ? ' is-complete' : ''}`,
      style: size === 48 ? undefined : { width: size, height: size },
      role: 'img',
      'aria-label': `${label}: ${percent}%`,
      title: `${label}: ${percent}%`,
    },
    createElement(
      'svg',
      { viewBox: `0 0 ${box} ${box}`, width: size, height: size, 'aria-hidden': 'true' },
      createElement('circle', {
        cx: center,
        cy: center,
        r: radius,
        className: 'ots-ring-track',
        strokeWidth,
      }),
      createElement('circle', {
        cx: center,
        cy: center,
        r: radius,
        className: 'ots-ring-fill',
        strokeWidth,
        strokeDasharray: circumference,
        strokeDashoffset: offset,
      }),
    ),
    compact
      ? null
      : createElement('span', { className: 'ots-ring-label' }, `${percent}%`),
  )
}

function TaskRow({ t, task, index, busy, dragging, dropBefore, onToggle, onDelete, onDragStart, onDragOver, onDrop, onDragEnd }) {
  return createElement(
    'div',
    {
      className: `ots-task${task.checked ? ' is-checked' : ''}${dragging ? ' is-dragging' : ''}${dropBefore ? ' is-drop-target' : ''}`,
      draggable: !busy,
      onDragStart,
      onDragOver,
      onDrop,
      onDragEnd,
      'data-index': index,
    },
    createElement(
      'span',
      { className: 'ots-grip', title: t('drag'), 'aria-hidden': 'true' },
      createElement(GripGlyph),
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: 'ots-checkbox',
        role: 'checkbox',
        'aria-checked': task.checked,
        'aria-label': task.text,
        disabled: busy,
        onClick: onToggle,
      },
      createElement(
        'svg',
        { viewBox: '0 0 20 20', width: 18, height: 18, 'aria-hidden': 'true' },
        createElement('path', { d: 'M4.8 10.4l3.1 3.1 7.2-7.3', className: 'ots-check-path' }),
      ),
    ),
    createElement('div', { className: 'ots-task-copy' }, createElement('span', { className: 'ots-task-text' }, inlineNodes(task.text))),
    createElement(
      'button',
      {
        type: 'button',
        className: 'ots-delete',
        title: t('deleteTask'),
        'aria-label': `${t('deleteTask')}: ${task.text}`,
        disabled: busy,
        onClick: onDelete,
      },
      createElement(TrashGlyph),
    ),
  )
}

function Skeleton() {
  return createElement(
    'div',
    { className: 'ots-skeleton', 'aria-hidden': 'true' },
    ...[0, 1, 2, 3, 4].map((index) =>
      createElement(
        'div',
        { className: 'ots-skeleton-row', key: index },
        createElement('span', { className: 'ots-skeleton-box' }),
        createElement('span', { className: 'ots-skeleton-line', style: { width: `${72 - index * 7}%` } }),
      ),
    ),
  )
}

function CreateState({ t, date, title, onTitle, onCreate, busy }) {
  return createElement(
    'div',
    { className: 'ots-state' },
    createElement('div', { className: 'ots-state-icon' }, createElement(ChecklistGlyph, { size: 34 })),
    createElement('div', { className: 'ots-state-date' }, longDate(date)),
    createElement('h2', { className: 'ots-state-title' }, t('noChecklistToday')),
    createElement('p', { className: 'ots-state-copy' }, t('noChecklistBody')),
    createElement(
      'div',
      { className: 'ots-create-row' },
      createElement('input', {
        className: 'ots-create-input',
        value: title,
        onChange: (event) => onTitle(event.target.value),
        'aria-label': t('checklistTitle'),
        maxLength: 60,
        spellCheck: false,
      }),
      createElement(
        'button',
        { type: 'button', className: 'ots-primary', onClick: onCreate, disabled: busy },
        busy ? t('creating') : t('createToday'),
      ),
    ),
    createElement('p', { className: 'ots-state-hint' }, `${date}-Checklist-${title.trim() || 'Daily'}.md`),
    createElement('p', { className: 'ots-state-hint' }, t('createHint')),
  )
}

function MissingState({ t, onToday, onCreate }) {
  return createElement(
    'div',
    { className: 'ots-state' },
    createElement('div', { className: 'ots-state-icon ots-state-icon-warn' }, createElement(TrashGlyph, { size: 28 })),
    createElement('h2', { className: 'ots-state-title' }, t('missingTitle')),
    createElement('p', { className: 'ots-state-copy' }, t('missingBody')),
    createElement(
      'div',
      { className: 'ots-state-actions' },
      createElement('button', { type: 'button', className: 'ots-primary', onClick: onToday }, t('goToday')),
      createElement('button', { type: 'button', className: 'ots-secondary', onClick: onCreate }, t('createToday')),
    ),
  )
}

function BridgeState({ t, error, onRetry }) {
  const failed = error !== ''
  return createElement(
    'main',
    { className: 'ots-setup' },
    createElement(
      'div',
      { className: 'ots-setup-card ots-bridge-card' },
      createElement(
        'div',
        { className: 'ots-setup-logo' },
        failed ? createElement(TrashGlyph, { size: 28 }) : createElement(ChecklistGlyph, { size: 28 }),
      ),
      createElement('div', { className: 'ots-setup-eyebrow' }, t('widget')),
      createElement('h1', { className: 'ots-setup-title' }, failed ? t('bridgeFailed') : t('bridgePreparing')),
      createElement('p', { className: 'ots-setup-copy' }, failed ? error : t('bridgeWaiting')),
      failed
        ? createElement(
            'button',
            { type: 'button', className: 'ots-primary ots-connect', onClick: onRetry },
            t('bridgeRetry'),
          )
        : createElement('span', { className: 'ots-spinner', 'aria-hidden': 'true' }),
    ),
  )
}

function SetupView({ t, initialPath, connecting, error, canCancel, onCancel, onConnect }) {
  const [path, setPath] = useState(initialPath ?? '')
  return createElement(
    'main',
    { className: 'ots-setup' },
    createElement(
      'div',
      { className: 'ots-setup-card' },
      createElement('div', { className: 'ots-setup-logo' }, createElement(ChecklistGlyph, { size: 28 })),
      createElement('div', { className: 'ots-setup-eyebrow' }, t('widget')),
      createElement('h1', { className: 'ots-setup-title' }, t('setupTitle')),
      createElement('p', { className: 'ots-setup-copy' }, t('setupBody')),
      createElement(
        'form',
        {
          className: 'ots-setup-form',
          onSubmit: (event) => {
            event.preventDefault()
            if (!connecting) onConnect(path)
          },
        },
        createElement('label', { className: 'ots-label', htmlFor: 'ots-vault-path' }, t('vaultPath')),
        createElement('input', {
          id: 'ots-vault-path',
          className: 'ots-path-input',
          value: path,
          onChange: (event) => setPath(event.target.value),
          placeholder: t('vaultExample'),
          autoFocus: true,
          spellCheck: false,
          autoComplete: 'off',
          disabled: connecting,
        }),
        error !== '' ? createElement('div', { className: 'ots-form-error', role: 'alert' }, error) : null,
        createElement(
          'button',
          { type: 'submit', className: 'ots-primary ots-connect', disabled: connecting || path.trim() === '' },
          connecting ? t('connecting') : t('connect'),
        ),
        createElement('p', { className: 'ots-state-hint' }, t('connectHint')),
        canCancel
          ? createElement(
              'button',
              { type: 'button', className: 'ots-link-button', onClick: onCancel, disabled: connecting },
              t('close'),
            )
          : null,
      ),
      createElement(
        'div',
        { className: 'ots-setup-foot' },
        createElement(FolderGlyph, { size: 14 }),
        createElement('span', null, t('fileNamingHint')),
      ),
    ),
  )
}

function SettingsSheet({ t, vault, onClose, onChangeFolder, onRefresh }) {
  return createElement(
    'div',
    {
      className: 'ots-sheet-backdrop',
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) onClose()
      },
    },
    createElement(
      'section',
      { className: 'ots-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('settings') },
      createElement(
        'header',
        { className: 'ots-sheet-header' },
        createElement('h2', null, t('settings')),
        createElement(
          'button',
          { type: 'button', className: 'ots-icon-button', onClick: onClose, 'aria-label': t('close') },
          '×',
        ),
      ),
      createElement('p', { className: 'ots-sheet-copy' }, t('settingsIntro')),
      createElement('div', { className: 'ots-field-label' }, t('vaultFolder')),
      createElement('code', { className: 'ots-path' }, vault),
      createElement(
        'div',
        { className: 'ots-field-label' },
        t('fileNaming'),
      ),
      createElement('code', { className: 'ots-path' }, 'YYYY-MM-DD-Checklist-<Title>.md'),
      createElement('p', { className: 'ots-sheet-hint' }, t('fileNamingHint')),
      createElement(
        'div',
        { className: 'ots-sheet-actions' },
        createElement('button', { type: 'button', className: 'ots-secondary', onClick: onRefresh }, t('refresh')),
        createElement('button', { type: 'button', className: 'ots-primary', onClick: onChangeFolder }, t('changeFolder')),
      ),
      createElement('p', { className: 'ots-sheet-hint' }, t('renameHint')),
    ),
  )
}

// ---------------------------------------------------------------------------
// Skill trees
// ---------------------------------------------------------------------------

function TreeState({ icon, eyebrow, title, body, actions = [] }) {
  return createElement(
    'div',
    { className: 'ots-tree-state' },
    createElement('div', { className: 'ots-state-icon' }, icon),
    createElement('div', { className: 'ots-setup-eyebrow' }, eyebrow),
    createElement('h2', { className: 'ots-state-title' }, title),
    body === '' ? null : createElement('p', { className: 'ots-state-copy' }, body),
    createElement(
      'div',
      { className: 'ots-state-actions' },
      actions.map((action, index) =>
        createElement(
          'button',
          {
            key: index,
            type: 'button',
            className: action.primary === true ? 'ots-primary' : 'ots-secondary',
            disabled: action.disabled === true,
            onClick: action.onClick,
          },
          action.label,
        ),
      ),
    ),
  )
}

function TreeNode({ node, onToggle, t }) {
  const state = node.checked ? 'checked' : node.locked ? 'locked' : 'available'
  const color = LANE_COLORS[node.laneIndex % LANE_COLORS.length]
  const hint = node.locked ? t('lockedNode') : `${node.points} ${t('pts')}`
  return createElement(
    'button',
    {
      type: 'button',
      className: 'ots-node',
      'data-state': state,
      style: {
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        '--ots-lane': color,
      },
      title: `${node.title} — ${hint}`,
      'aria-label': `${node.title} — ${hint}`,
      'aria-pressed': node.checked,
      onClick: () => onToggle(node),
    },
    createElement(
      'span',
      { className: 'ots-node-icon' },
      createElement(state === 'checked' ? CheckGlyph : state === 'locked' ? LockGlyph : SparkGlyph, {
        size: 13,
      }),
    ),
    createElement(
      'span',
      { className: 'ots-node-copy' },
      createElement('span', { className: 'ots-node-title' }, node.title),
      createElement('span', { className: 'ots-node-meta' }, `+${node.points} ${t('pts')}`),
    ),
  )
}

function TreeCanvas({ t, layout, doc, onToggle, scrollRef }) {
  return createElement(
    'div',
    { className: 'ots-canvas-scroll', ref: scrollRef },
    createElement(
      'div',
      { className: 'ots-canvas', style: { width: layout.width, height: layout.height } },
      layout.lanes.map((lane, index) =>
        createElement('span', {
          key: `band-${lane.id}`,
          className: 'ots-lane-band',
          style: {
            top: lane.top,
            height: lane.height,
            color: LANE_COLORS[index % LANE_COLORS.length],
          },
          'aria-hidden': 'true',
        }),
      ),
      createElement(
        'svg',
        {
          className: 'ots-edges',
          width: layout.width,
          height: layout.height,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        layout.edges.map((edge) => {
          const color = LANE_COLORS[edge.laneIndex % LANE_COLORS.length]
          return createElement('path', {
            key: edge.id,
            className: 'ots-edge',
            'data-state': edge.state,
            d: edge.path,
            style: { stroke: color, color },
          })
        }),
      ),
      layout.lanes.map((lane, index) =>
        createElement(
          'div',
          {
            key: `label-${lane.id}`,
            className: 'ots-lane-label',
            style: {
              top: lane.top + 4,
              left: TREE_PAD + TREE_COL_STEP,
              '--ots-lane': LANE_COLORS[index % LANE_COLORS.length],
            },
          },
          createElement('span', { className: 'ots-lane-dot' }),
          createElement('span', { className: 'ots-lane-name' }, lane.title ?? t('skills')),
          createElement(
            'span',
            { className: 'ots-lane-score' },
            `${lane.earned ?? 0}/${lane.total ?? 0}`,
          ),
        ),
      ),
      layout.nodes.map((node) =>
        createElement(TreeNode, { key: node.id, node, onToggle, t }),
      ),
      createElement(
        'div',
        {
          className: 'ots-root',
          style: {
            left: layout.root.x,
            top: layout.root.y,
            width: layout.root.width,
            height: layout.root.height,
          },
        },
        createElement(
          'span',
          { className: 'ots-root-crest' },
          createElement(ShieldGlyph, { size: 24 }),
        ),
        createElement('span', { className: 'ots-root-title' }, doc.title),
        createElement(
          'span',
          { className: 'ots-root-meta' },
          `${doc.earnedPoints} / ${doc.totalPoints} ${t('pts')}`,
        ),
      ),
      layout.nodes.length === 0
        ? createElement('div', { className: 'ots-canvas-empty' }, t('treeNoNodes'))
        : null,
    ),
  )
}

/** Test seam: render the canvas for a parsed tree document. */
export function __renderSkillTreeCanvas(doc) {
  return createElement(TreeCanvas, {
    t: (key) => key,
    layout: layoutSkillTree(doc),
    doc,
    onToggle: () => {},
    scrollRef: null,
  })
}

function SkillTreeApp({ bridge, active, onOpenChecklist }) {  const t = useT()
  const vault = useSyncExternalStore(
    vaultStore.subscribe,
    vaultStore.getSnapshot,
    vaultStore.getSnapshot,
  )
  const [phase, setPhase] = useState('idle')
  const [trees, setTrees] = useState([])
  const [activeFile, setActiveFile] = useState(null)
  const [doc, setDoc] = useState(null)
  const docRef = useRef(null)
  const [status, setStatus] = useState('connecting')
  const [lastSync, setLastSync] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [toast, setToast] = useState(null)
  const [reload, setReload] = useState(0)
  const loadedFor = useRef(null)
  const canvasRef = useRef(null)

  const applyDoc = useCallback((next) => {
    docRef.current = next
    setDoc(next)
    if (next !== null) {
      setLastSync(Date.now())
      setStatus('live')
    }
  }, [])

  const showError = useCallback(
    (error) => {
      const failure = asBridgeError(error)
      if (failure.document !== undefined && failure.document !== null) applyDoc(failure.document)
      if (failure.code === 'offline' || failure.code === 'token-missing') setStatus('offline')
      setToast({ text: failure.message, tone: 'error' })
    },
    [applyDoc],
  )

  const refreshTree = useCallback(
    async (silent = false) => {
      if (vault === '' || activeFile === null) return null
      try {
        const next = await bridge.request('tree/document', { root: vault, file: activeFile })
        applyDoc(next)
        return next
      } catch (error) {
        const failure = asBridgeError(error)
        if (!silent) showError(failure)
        else if (failure.code === 'offline') setStatus('offline')
        return null
      }
    },
    [activeFile, applyDoc, bridge, showError, vault],
  )

  const refreshTreeList = useCallback(async () => {
    if (vault === '') return []
    try {
      const data = await bridge.request('tree/list', { root: vault })
      const list = Array.isArray(data.trees) ? data.trees : []
      setTrees(list)
      return list
    } catch {
      return []
    }
  }, [bridge, vault])

  const createTree = useCallback(async () => {
    if (vault === '' || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await bridge.request('tree/create', { root: vault, name: DEFAULT_TREE_NAME })
      markTreeSeeded(vault)
      const list = await refreshTreeList()
      setPhase(list.length === 0 ? 'empty' : 'ready')
      setActiveFile(list[0]?.file ?? null)
      setToast({ text: t('seededTree'), tone: 'success' })
    } catch (error) {
      showError(error)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [bridge, refreshTreeList, showError, t, vault])

  // First activation for a folder: list trees, seed the bundled C++ tree once,
  // then open the first file. The seed is remembered per folder so deleting the
  // note on purpose is not undone on the next visit.
  useEffect(() => {
    if (!active) return undefined
    if (vault === '') {
      setPhase('novault')
      return undefined
    }
    if (loadedFor.current === vault) return undefined
    loadedFor.current = vault
    let cancelled = false
    setPhase('loading')
    setDoc(null)
    docRef.current = null
    setActiveFile(null)
    setStatus('connecting')
    setToast(null)
    void (async () => {
      try {
        let list = await bridge.request('tree/list', { root: vault })
        let files = Array.isArray(list.trees) ? list.trees : []
        let seeded = false
        if (files.length === 0 && !treeSeedDone(vault)) {
          await bridge.request('tree/create', { root: vault, name: DEFAULT_TREE_NAME })
          markTreeSeeded(vault)
          seeded = true
          list = await bridge.request('tree/list', { root: vault })
          files = Array.isArray(list.trees) ? list.trees : []
        }
        if (cancelled) return
        setTrees(files)
        setActiveFile(files[0]?.file ?? null)
        setPhase(files.length === 0 ? 'empty' : 'ready')
        if (seeded) setToast({ text: t('seededTree'), tone: 'success' })
      } catch (error) {
        if (cancelled) return
        setPhase('error')
        setStatus('error')
        showError(error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, bridge, reload, showError, t, vault])

  // The tree document stream stays connected while the view is hidden, so
  // switching back is instant and Obsidian edits keep arriving.
  useEffect(() => {
    if (phase !== 'ready' || vault === '' || activeFile === null) return undefined
    let disposed = false
    let unsubscribe = () => {}
    setStatus('connecting')
    docRef.current = null
    setDoc(null)

    const consume = (eventName, data) => {
      if (disposed) return
      if (eventName === 'tree' && isRecord(data)) {
        if (data.kind === 'missing') {
          docRef.current = null
          setDoc(null)
          setPhase('empty')
          setStatus('live')
          return
        }
        if (isRecord(data.document) && data.document.file === activeFile) applyDoc(data.document)
        return
      }
      if (eventName === 'trees' && isRecord(data) && Array.isArray(data.trees)) {
        setTrees(data.trees)
        return
      }
      if (eventName === 'watch-error' || eventName === 'stream-error') setStatus('polling')
    }

    void refreshTree(true)
    void bridge
      .subscribeTree(vault, activeFile, consume)
      .then((dispose) => {
        if (disposed) dispose()
        else unsubscribe = dispose
      })
      .catch(() => {
        if (!disposed) setStatus('polling')
      })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [activeFile, applyDoc, bridge, phase, refreshTree, vault])

  // Polling safety net when the live stream is unavailable.
  useEffect(() => {
    if (phase !== 'ready' || vault === '' || activeFile === null) return undefined
    const timer = setInterval(() => {
      if (busyRef.current) return
      void refreshTree(true)
      void refreshTreeList()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [activeFile, phase, refreshTree, refreshTreeList, vault])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (toast === null) return undefined
    const timer = setTimeout(() => setToast(null), 5_000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (canvasRef.current === null) return
    canvasRef.current.scrollTo({ left: 0, top: 0 })
  }, [activeFile])

  const mutate = async (optimistic, work) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    if (optimistic !== null) {
      docRef.current = optimistic
      setDoc(optimistic)
    }
    try {
      applyDoc(await work())
    } catch (error) {
      showError(error)
      if (asBridgeError(error).document === undefined) await refreshTree(true)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const toggleNode = (node) => {
    const current = docRef.current
    if (current === null || busyRef.current) return
    if (node.locked === true) {
      setToast({ text: t('lockedNode'), tone: 'warn' })
      return
    }
    const checked = !node.checked
    void mutate(withToggledNode(current, node.id, checked), () =>
      bridge.request('tree/toggle', {
        root: vault,
        file: current.file,
        line: node.line,
        raw: node.raw,
        checked,
        revision: current.revision,
      }),
    )
  }

  if (phase === 'novault') {
    return createElement(
      'section',
      { className: 'ots-tree-app' },
      createElement(TreeState, {
        icon: createElement(TreeGlyph, { size: 30 }),
        eyebrow: t('navTrees'),
        title: t('treeNoVaultTitle'),
        body: t('treeNoVaultBody'),
        actions: [{ label: t('openChecklist'), primary: true, onClick: onOpenChecklist }],
      }),
    )
  }

  if (phase === 'error') {
    return createElement(
      'section',
      { className: 'ots-tree-app' },
      createElement(TreeState, {
        icon: createElement(TrashGlyph, { size: 28 }),
        eyebrow: t('navTrees'),
        title: t('treeLoadError'),
        body: '',
        actions: [
          {
            label: t('bridgeRetry'),
            primary: true,
            onClick: () => {
              loadedFor.current = null
              setReload((value) => value + 1)
            },
          },
        ],
      }),
    )
  }

  if (phase === 'empty') {
    return createElement(
      'section',
      { className: 'ots-tree-app' },
      createElement(TreeState, {
        icon: createElement(TreeGlyph, { size: 30 }),
        eyebrow: t('navTrees'),
        title: t('treeEmptyTitle'),
        body: t('treeEmptyBody'),
        actions: [
          {
            label: busy ? t('creatingTree') : t('createTree'),
            primary: true,
            disabled: busy,
            onClick: () => {
              void createTree()
            },
          },
        ],
      }),
    )
  }

  if (phase === 'loading' || phase === 'idle' || doc === null) {
    return createElement(
      'section',
      { className: 'ots-tree-app' },
      createElement(
        'div',
        { className: 'ots-tree-loading' },
        createElement('span', { className: 'ots-spinner', 'aria-hidden': 'true' }),
        createElement('span', null, t('treeLoading')),
      ),
    )
  }

  const layout = layoutSkillTree(doc)
  const earned = doc.earnedPoints
  const total = doc.totalPoints
  const rank = rankFor(earned)
  const nextRank = rank.next
  const synced = lastSync === 0 ? null : relativeTime(lastSync, now)
  const statusLabel =
    status === 'live'
      ? t('live')
      : status === 'polling'
        ? t('polling')
        : status === 'offline'
          ? t('offline')
          : t('syncing')

  return createElement(
    'section',
    { className: 'ots-tree-app', 'aria-busy': busy },
    createElement(
      'header',
      { className: 'ots-tree-head' },
      createElement(
        'div',
        { className: 'ots-tree-top' },
        createElement(
          'div',
          { className: 'ots-rank-badge', 'data-rank': rank.index },
          createElement(
            'span',
            { className: 'ots-rank-medal' },
            createElement(ShieldGlyph, { size: 22 }),
          ),
          createElement(
            'span',
            { className: 'ots-rank-copy' },
            createElement('span', { className: 'ots-eyebrow' }, t('currentRank')),
            createElement('strong', { className: 'ots-rank-name' }, t(rank.rank.key)),
          ),
        ),
        createElement(
          'div',
          { className: 'ots-tree-tools' },
          createElement(Dropdown, {
            ariaLabel: t('chooseTree'),
            value: activeFile,
            placeholder: t('chooseTree'),
            icon: createElement(TreeGlyph, { size: 14 }),
            options: trees.map((tree) => ({ value: tree.file, label: tree.name })),
            onChange: (value) => setActiveFile(value),
          }),
          createElement(
            'button',
            {
              type: 'button',
              className: 'ots-icon-button',
              title: t('refresh'),
              'aria-label': t('refresh'),
              onClick: () => {
                void refreshTree()
                void refreshTreeList()
              },
            },
            createElement(RefreshGlyph),
          ),
        ),
      ),
      createElement(
        'div',
        { className: 'ots-points-row' },
        createElement(
          'span',
          { className: 'ots-points' },
          createElement('strong', null, earned),
          createElement('span', null, ` / ${total} ${t('points')}`),
        ),
        createElement(
          'span',
          { className: 'ots-next' },
          nextRank === null ? t('maxRank') : `${rank.toNext} ${t('pointsToNext')}`,
        ),
      ),
      createElement(
        'div',
        { className: 'ots-rank-track', 'aria-hidden': 'true' },
        createElement('div', {
          className: 'ots-rank-fill',
          style: { width: `${Math.round(rank.progress * 100)}%` },
        }),
      ),
      createElement(
        'div',
        { className: 'ots-legend' },
        doc.lanes.map((lane, index) =>
          createElement(
            'span',
            {
              key: lane.id,
              className: 'ots-chip',
              style: { '--ots-lane': LANE_COLORS[index % LANE_COLORS.length] },
            },
            createElement('span', { className: 'ots-chip-dot' }),
            createElement('span', null, lane.title ?? t('skills')),
            createElement('strong', null, `${lane.earned}/${lane.total}`),
          ),
        ),
      ),
    ),
    createElement(TreeCanvas, { t, layout, doc, onToggle: toggleNode, scrollRef: canvasRef }),
    createElement(
      'footer',
      { className: 'ots-tree-foot' },
      createElement(
        'span',
        { className: `ots-status ots-status-${status}` },
        createElement('span', { className: 'ots-status-dot' }),
        statusLabel,
      ),
      createElement('span', { className: 'ots-status-sep' }, '·'),
      createElement('span', null, `${doc.checkedCount}/${doc.totalCount} ${t('skills')}`),
      createElement('span', { className: 'ots-tree-hint' }, t('treeSyncHint')),
      createElement(
        'span',
        { className: 'ots-file-name', title: doc.file },
        doc.file,
      ),
      synced === null
        ? null
        : createElement('span', { className: 'ots-tree-sync' }, `${t('lastSync')} · ${synced}`),
    ),
    toast === null
      ? null
      : createElement(
          'div',
          { className: `ots-toast ots-toast-${toast.tone}`, role: 'status' },
          createElement('span', null, toast.text),
          createElement(
            'button',
            {
              type: 'button',
              className: 'ots-toast-close',
              'aria-label': t('closeToast'),
              onClick: () => setToast(null),
            },
            '×',
          ),
        ),
  )
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'obsidian-task-sync: locale')
  const t = ctx.locale.bind(NS)
  const controller = createWidgetController()

  // The overlay slot covers the whole Harness frame and accepts independent
  // children, which is exactly what a freely positioned widget needs.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'obsidian-task-sync-widget', order: 100 },
      () => createElement(WidgetLayer, { t, controller }),
    ),
  )

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'obsidian-task-sync',
        order: 1,
        label: () => t('open'),
      },
      (props) => createElement(SidebarLauncher, { wide: props.wide === true, t, controller }),
    ),
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CSS = String.raw`
.ots-widget {
  --ots-bg: #080b10;
  --ots-surface: #10151d;
  --ots-surface-2: #151c26;
  --ots-surface-3: #1a2330;
  --ots-line: rgba(160, 184, 214, 0.13);
  --ots-line-strong: rgba(160, 184, 214, 0.22);
  --ots-text: #edf2fa;
  --ots-muted: #8b99ad;
  --ots-faint: #617084;
  --ots-accent: #7ee0bd;
  --ots-accent-2: #79a8ff;
  --ots-danger: #ff7c8a;
  --ots-warn: #efc06e;
  --ots-radius: 14px;
  position: fixed;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  width: 434px;
  height: min(784px, calc(100dvh - var(--ots-top-inset, 8px) - 8px));
  min-height: min(340px, calc(100dvh - var(--ots-top-inset, 8px) - 8px));
  overflow: hidden;
  border: 0;
  border-radius: 18px;
  background: var(--ots-bg);
  color: var(--ots-text);
  font-family: Inter, "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  box-shadow: 0 30px 90px rgba(0, 0, 0, 0.66), 0 6px 18px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(160, 184, 214, 0.07);
  -webkit-font-smoothing: antialiased;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  app-region: no-drag;
  animation: none;
  transition: width 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
/* The entrance animation is a one-shot class removed on animationend. It is
   deliberately never toggled by drag state: re-adding an animation rule while
   releasing the pointer replayed the fall-in and made the card flicker. */
.ots-widget.is-entering { animation: ots-widget-in 170ms cubic-bezier(0.22, 1, 0.36, 1); }
/* The Windows shell's caption strip is a native drag region above the page:
   anything under it never receives pointer input. Opt the whole card out so a
   widget overlapping the strip still handles clicks, focus and typing. */
.ots-widget,
.ots-widget * {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.ots-widget *, .ots-widget *::before, .ots-widget *::after { box-sizing: border-box; }
.ots-widget button, .ots-widget input, .ots-widget select { font: inherit; }
.ots-widget button { -webkit-tap-highlight-color: transparent; }
.ots-widget :focus-visible { outline: 2px solid rgba(126, 224, 189, 0.55); outline-offset: 2px; }
.ots-widget ::selection { background: rgba(126, 224, 189, 0.24); }
.ots-widget-chrome {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 35px;
  padding: 0 5px 0 11px;
  border-bottom: 1px solid var(--ots-line);
  background: linear-gradient(180deg, rgba(21, 28, 38, 0.94), rgba(12, 16, 22, 0.9));
  color: var(--ots-faint);
  cursor: grab;
  touch-action: none;
  user-select: none;
  outline: none;
}
.ots-widget-chrome:focus-visible { box-shadow: inset 0 0 0 1px rgba(126, 224, 189, 0.55); }
.ots-widget.is-dragging .ots-widget-chrome { cursor: grabbing; }
.ots-widget-grip { display: inline-flex; color: var(--ots-faint); opacity: 0.8; }
.ots-widget-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--ots-faint);
}
.ots-widget-close {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--ots-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.ots-widget-close:hover { background: rgba(255, 124, 138, 0.12); color: var(--ots-danger); }
.ots-widget-minimize {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--ots-muted);
  cursor: pointer;
}
.ots-widget-minimize:hover { background: rgba(160, 184, 214, 0.1); color: var(--ots-text); }
.ots-widget-mini-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  color: var(--ots-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.ots-widget-mini-count { color: var(--ots-text); font-weight: 650; }
.ots-widget.is-minimized {
  height: auto;
  min-height: 0;
  max-height: none;
  animation: none;
}
.ots-widget.is-minimized .ots-widget-main { display: none; }
.ots-widget.is-minimized .ots-widget-chrome {
  height: 38px;
  border-bottom: 0;
  border-radius: 18px;
  padding: 0 6px 0 12px;
}
.ots-widget.is-minimized .ots-widget-title { color: var(--ots-text); font-size: 10px; }
.ots-widget.is-minimized .ots-widget-grip { opacity: 0.55; }
.ots-widget-main {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  pointer-events: auto;
}
.ots-widget-body {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  pointer-events: auto;
}
.ots-view {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ots-view[data-active="false"] { display: none; }
.ots-view > .ots-app,
.ots-view > .ots-setup,
.ots-view > .ots-tree-app {
  flex: 1 1 auto;
  width: 100%;
  max-width: none;
  height: 100%;
  margin: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
/* Slim view rail */
.ots-rail {
  flex: 0 0 46px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 10px 0 9px;
  background: linear-gradient(180deg, rgba(18, 24, 33, 0.98), rgba(9, 13, 19, 0.99));
  box-shadow: inset -1px 0 0 rgba(160, 184, 214, 0.06);
  user-select: none;
}
.ots-rail-button {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ots-faint);
  cursor: pointer;
  transition: background 130ms ease, color 130ms ease, transform 130ms ease;
}
.ots-rail-button:hover { background: rgba(160, 184, 214, 0.08); color: var(--ots-text); }
.ots-rail-button:active { transform: scale(0.94); }
.ots-rail-button.is-active {
  background: linear-gradient(145deg, rgba(126, 224, 189, 0.17), rgba(121, 168, 255, 0.07));
  color: var(--ots-accent);
  box-shadow: inset 0 0 0 1px rgba(126, 224, 189, 0.2);
}
.ots-rail-button.is-active::before {
  content: "";
  position: absolute;
  left: -4px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: var(--ots-accent);
  box-shadow: 0 0 10px rgba(126, 224, 189, 0.7);
}
.ots-rail-spacer { flex: 1 1 auto; }
.ots-rail-mark {
  width: 16px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, rgba(160, 184, 214, 0.22), transparent);
}
/* One scrollbar language for every pane, dropdown and canvas. */
.ots-widget, .ots-widget * {
  scrollbar-width: thin;
  scrollbar-color: rgba(160, 184, 214, 0.22) transparent;
}
.ots-widget ::-webkit-scrollbar { width: 8px; height: 8px; }
.ots-widget ::-webkit-scrollbar-track { background: transparent; }
.ots-widget ::-webkit-scrollbar-thumb {
  background: rgba(160, 184, 214, 0.16);
  border: 2px solid transparent;
  border-radius: 99px;
  background-clip: padding-box;
}
.ots-widget ::-webkit-scrollbar-thumb:hover {
  background: rgba(160, 184, 214, 0.3);
  border: 2px solid transparent;
  background-clip: padding-box;
}
.ots-widget ::-webkit-scrollbar-corner { background: transparent; }
.ots-app {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 520px;
  height: 100dvh;
  min-height: 0;
  background: var(--ots-bg);
  overflow: hidden;
}
.ots-header {
  flex: 0 0 auto;
  padding: 15px 16px 10px;
  border-bottom: 1px solid var(--ots-line);
  background: linear-gradient(180deg, rgba(21, 28, 38, 0.78) 0%, rgba(10, 14, 20, 0.4) 100%);
}
.ots-topbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ots-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.ots-brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 31px;
  height: 31px;
  flex: 0 0 auto;
  border: 1px solid rgba(126, 224, 189, 0.28);
  border-radius: 10px;
  color: var(--ots-accent);
  background: linear-gradient(145deg, rgba(126, 224, 189, 0.15), rgba(121, 168, 255, 0.06));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);
}
.ots-brand-copy { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.ots-eyebrow {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--ots-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ots-status { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--ots-muted); }
.ots-status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ots-muted);
  box-shadow: 0 0 0 3px rgba(139, 153, 173, 0.08);
}
.ots-status-live .ots-status-dot { background: var(--ots-accent); box-shadow: 0 0 0 3px rgba(126, 224, 189, 0.1); animation: ots-pulse 2.4s ease-in-out infinite; }
.ots-status-polling .ots-status-dot { background: var(--ots-warn); box-shadow: 0 0 0 3px rgba(239, 192, 110, 0.1); }
.ots-status-offline .ots-status-dot { background: var(--ots-danger); box-shadow: 0 0 0 3px rgba(255, 124, 138, 0.1); }
.ots-toolbar { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.ots-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ots-muted);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.ots-icon-button:hover { background: rgba(160, 184, 214, 0.1); color: var(--ots-text); }
.ots-icon-button:disabled { opacity: 0.25; cursor: default; }
.ots-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-top: 16px; }
.ots-heading-copy { min-width: 0; }
.ots-date {
  font-size: 10.5px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ots-accent);
}
.ots-title {
  margin: 3px 0 0;
  font-size: 25px;
  line-height: 1.16;
  font-weight: 700;
  letter-spacing: -0.035em;
  color: var(--ots-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ots-subtitle { margin: 5px 0 0; color: var(--ots-muted); font-size: 11.5px; }
.ots-ring { position: relative; width: 48px; height: 48px; flex: 0 0 auto; display: grid; place-items: center; }
.ots-ring svg { position: absolute; inset: 0; transform: rotate(-90deg); }
.ots-ring-track { fill: none; stroke: rgba(160, 184, 214, 0.12); stroke-width: 3.4; }
.ots-ring-fill { fill: none; stroke: var(--ots-accent); stroke-width: 3.4; stroke-linecap: round; transition: stroke-dashoffset 380ms ease; }
.ots-ring-label { font-size: 9.5px; font-weight: 700; color: var(--ots-text); font-variant-numeric: tabular-nums; }
.ots-progress-track { height: 3px; margin-top: 14px; overflow: hidden; border-radius: 999px; background: rgba(160, 184, 214, 0.1); }
.ots-progress-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--ots-accent-2), var(--ots-accent)); transition: width 380ms cubic-bezier(0.22, 1, 0.36, 1); }
.ots-ring.is-complete .ots-ring-fill { stroke: var(--ots-warn); filter: drop-shadow(0 0 5px rgba(239, 192, 110, 0.45)); }
.ots-ring-compact { width: 28px; height: 28px; }
/* Focus timer: one quiet row, editable time, three explicit controls. */
.ots-focus {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  margin-top: 10px;
  padding: 5px 7px 5px 10px;
  border-radius: 11px;
  background: var(--ots-surface-2);
  box-shadow: inset 0 0 0 1px rgba(160, 184, 214, 0.09);
  transition: box-shadow 150ms ease, background 150ms ease;
}
.ots-focus.is-running {
  background: linear-gradient(90deg, rgba(126, 224, 189, 0.08), var(--ots-surface-2) 58%);
  box-shadow: inset 0 0 0 1px rgba(126, 224, 189, 0.34);
}
.ots-focus.is-finished { box-shadow: inset 0 0 0 1px rgba(239, 192, 110, 0.34); }
.ots-focus-icon { display: flex; flex: 0 0 auto; color: var(--ots-faint); }
.ots-focus.is-running .ots-focus-icon { color: var(--ots-accent); }
.ots-focus.is-finished .ots-focus-icon { color: var(--ots-warn); }
.ots-focus-copy { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
.ots-focus-label {
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  line-height: 1.25;
  text-transform: uppercase;
  color: var(--ots-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ots-focus-time {
  width: fit-content;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ots-text);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: 0.015em;
  font-variant-numeric: tabular-nums;
  text-align: left;
  cursor: text;
  transition: color 120ms ease;
}
.ots-focus-time:hover { color: var(--ots-accent); }
.ots-focus.is-running .ots-focus-time { color: var(--ots-accent); }
.ots-focus.is-finished .ots-focus-time { color: var(--ots-warn); }
.ots-focus.is-invalid .ots-focus-time {
  color: var(--ots-danger);
  animation: ots-error-flash 900ms ease-out;
}
.ots-focus-input {
  width: 92px;
  height: 21px;
  padding: 0 4px;
  border: 0;
  border-radius: 5px;
  outline: 0;
  background: rgba(8, 11, 16, 0.65);
  color: var(--ots-text);
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  box-shadow: inset 0 0 0 1px rgba(126, 224, 189, 0.55);
}
.ots-focus-input[aria-invalid="true"] {
  color: var(--ots-danger);
  box-shadow: inset 0 0 0 1px rgba(255, 124, 138, 0.7);
}
.ots-focus-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.ots-focus-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ots-muted);
  font-size: 9.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
}
.ots-focus-btn:hover:not(:disabled) { background: rgba(160, 184, 214, 0.1); color: var(--ots-text); }
.ots-focus-btn.is-primary { background: rgba(126, 224, 189, 0.14); color: var(--ots-accent); }
.ots-focus-btn.is-primary:hover:not(:disabled) { background: rgba(126, 224, 189, 0.22); }
.ots-focus-btn:disabled { opacity: 0.3; cursor: default; }
.ots-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.ots-picker-row { display: flex; align-items: center; gap: 4px; margin-top: 11px; }
.ots-picker-select { flex: 1 1 auto; min-width: 0; }
.ots-picker-select .ots-dd { height: 32px; background: var(--ots-surface-2); }
.ots-chevron { width: 27px; height: 27px; flex: 0 0 auto; }
/* Custom listbox: the native select popup cannot follow this palette. */
.ots-dd-wrap { position: relative; min-width: 0; }
.ots-dd {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border: 0;
  border-radius: 9px;
  background: rgba(21, 28, 38, 0.9);
  color: var(--ots-text);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease, box-shadow 120ms ease;
}
.ots-dd:hover { background: var(--ots-surface-3); }
.ots-dd[aria-expanded="true"] {
  background: var(--ots-surface-3);
  box-shadow: inset 0 0 0 1px rgba(126, 224, 189, 0.45);
}
.ots-dd:disabled { opacity: 0.4; cursor: default; }
.ots-dd-icon { display: flex; flex: 0 0 auto; color: var(--ots-faint); }
.ots-dd-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ots-dd-caret { display: flex; flex: 0 0 auto; color: var(--ots-faint); transition: transform 150ms ease; }
.ots-dd[aria-expanded="true"] .ots-dd-caret { transform: rotate(180deg); }
.ots-dd-menu {
  position: absolute;
  z-index: 40;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 268px;
  overflow-y: auto;
  padding: 5px;
  border: 0;
  border-radius: 12px;
  background: #121821;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.62), inset 0 0 0 1px rgba(160, 184, 214, 0.1);
  animation: ots-menu-in 130ms ease-out;
}
.ots-dd-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 6px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ots-muted);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}
.ots-dd-item[data-ots-active="true"], .ots-dd-item:hover {
  background: rgba(160, 184, 214, 0.09);
  color: var(--ots-text);
  outline: none;
}
.ots-dd-item.is-selected { color: var(--ots-accent); }
.ots-dd-item-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ots-dd-item-hint { flex: 0 0 auto; color: var(--ots-faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.ots-dd-item-check { display: flex; flex: 0 0 auto; color: var(--ots-accent); }
.ots-dd-empty { padding: 10px; color: var(--ots-faint); font-size: 11px; text-align: center; }
.ots-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 10px 14px;
}
.ots-list { display: flex; flex-direction: column; gap: 2px; padding-top: 4px; }
.ots-section {
  margin: 12px 7px 5px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ots-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ots-task {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 7px 10px 3px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  transition: background 130ms ease, opacity 160ms ease, box-shadow 130ms ease;
}
.ots-task:hover { background: rgba(255, 255, 255, 0.035); }
.ots-task.is-checked { opacity: 0.58; }
.ots-task.is-dragging { opacity: 0.3; }
.ots-task.is-drop-target { box-shadow: inset 0 1px 0 var(--ots-accent); }
.ots-grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 24px;
  margin-top: 1px;
  flex: 0 0 auto;
  color: var(--ots-faint);
  opacity: 0;
  cursor: grab;
  transition: opacity 120ms ease;
}
.ots-task:hover .ots-grip { opacity: 0.55; }
.ots-task:active .ots-grip { cursor: grabbing; }
.ots-checkbox {
  position: relative;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin-top: 0;
  flex: 0 0 auto;
  padding: 0;
  border: 1.5px solid rgba(160, 184, 214, 0.36);
  border-radius: 7px;
  background: rgba(8, 11, 16, 0.25);
  color: transparent;
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease, transform 120ms ease;
}
.ots-checkbox:hover { border-color: var(--ots-accent); }
.ots-checkbox:active { transform: scale(0.92); }
.ots-task.is-checked .ots-checkbox { border-color: var(--ots-accent); background: var(--ots-accent); color: #07130f; }
.ots-check-path {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 22;
  stroke-dashoffset: 22;
  transition: stroke-dashoffset 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ots-task.is-checked .ots-check-path { stroke-dashoffset: 0; }
.ots-task-copy { flex: 1 1 auto; min-width: 0; padding-top: 1px; }
.ots-task-text {
  position: relative;
  display: inline;
  color: var(--ots-text);
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  transition: color 240ms ease, opacity 240ms ease;
}
.ots-task-text::after {
  content: "";
  position: absolute;
  left: 0;
  top: 54%;
  width: 0;
  height: 1px;
  background: currentColor;
  opacity: 0.75;
  transition: width 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ots-task.is-checked .ots-task-text { color: var(--ots-muted); }
.ots-task.is-checked .ots-task-text::after { width: 100%; }
.ots-task-text strong { font-weight: 700; color: #fff; }
.ots-task-text code {
  padding: 1px 4px;
  border: 1px solid var(--ots-line);
  border-radius: 5px;
  background: rgba(160, 184, 214, 0.08);
  font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  font-size: 11.5px;
}
.ots-task-text mark { padding: 0 2px; border-radius: 3px; background: rgba(239, 192, 110, 0.2); color: #ffe3a8; }
.ots-wikilink { color: var(--ots-accent-2); }
/* Obsidian tags become small pills so they are scannable without losing text. */
.ots-task-text .ots-tag,
.ots-inline .ots-tag {
  display: inline-block;
  margin: 0 1px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(121, 168, 255, 0.14);
  color: #a9c6ff;
  box-shadow: inset 0 0 0 1px rgba(121, 168, 255, 0.18);
  font-size: 10.5px;
  font-weight: 650;
  line-height: 1.45;
  letter-spacing: 0;
  vertical-align: baseline;
}
.ots-task-text .ots-tag[data-tone="1"],
.ots-inline .ots-tag[data-tone="1"] {
  background: rgba(126, 224, 189, 0.13);
  color: #9ff0d3;
  box-shadow: inset 0 0 0 1px rgba(126, 224, 189, 0.18);
}
.ots-task-text .ots-tag[data-tone="2"],
.ots-inline .ots-tag[data-tone="2"] {
  background: rgba(199, 155, 255, 0.13);
  color: #d8bdff;
  box-shadow: inset 0 0 0 1px rgba(199, 155, 255, 0.18);
}
.ots-task-text .ots-tag[data-tone="3"],
.ots-inline .ots-tag[data-tone="3"] {
  background: rgba(239, 192, 110, 0.13);
  color: #ffd99a;
  box-shadow: inset 0 0 0 1px rgba(239, 192, 110, 0.18);
}
.ots-task.is-checked .ots-tag { opacity: 0.55; }
.ots-delete {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-top: 0;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ots-faint);
  opacity: 0;
  cursor: pointer;
  transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
}
.ots-task:hover .ots-delete, .ots-delete:focus-visible { opacity: 1; }
.ots-delete:hover { color: var(--ots-danger); background: rgba(255, 124, 138, 0.1); }
.ots-delete:disabled { cursor: default; }
.ots-empty-tasks { padding: 44px 18px; text-align: center; color: var(--ots-faint); font-size: 12px; }
.ots-busy-bar {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  width: 100%;
  overflow: hidden;
  background: rgba(126, 224, 189, 0.12);
}
.ots-busy-bar::after {
  content: "";
  display: block;
  width: 40%;
  height: 100%;
  background: var(--ots-accent);
  animation: ots-slide 1.1s ease-in-out infinite;
}
.ots-footer {
  flex: 0 0 auto;
  padding: 8px 13px 12px;
  border-top: 1px solid var(--ots-line);
  background: linear-gradient(180deg, rgba(10, 14, 20, 0.55), rgba(8, 11, 16, 0.98));
}
.ots-status-line { display: flex; align-items: center; gap: 5px; min-width: 0; padding: 0 3px 7px; color: var(--ots-faint); font-size: 9.5px; }
.ots-status-line .ots-status-dot { background: var(--ots-accent); box-shadow: none; }
.ots-status-line.ots-status-polling .ots-status-dot { background: var(--ots-warn); }
.ots-status-line.ots-status-offline .ots-status-dot { background: var(--ots-danger); }
.ots-status-sep { opacity: 0.5; }
.ots-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: auto; opacity: 0.7; }
.ots-rollover-row { display: flex; padding: 0 3px 7px; }
.ots-rollover {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border: 0;
  border-radius: 8px;
  background: rgba(121, 168, 255, 0.07);
  color: var(--ots-muted);
  font-size: 10.5px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: background 130ms ease, color 130ms ease, opacity 130ms ease;
}
.ots-rollover:hover:not(:disabled) { background: rgba(121, 168, 255, 0.14); color: var(--ots-text); }
.ots-rollover:disabled { opacity: 0.35; cursor: default; }
.ots-rollover svg { flex: 0 0 auto; }
.ots-rollover-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ots-rollover-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: rgba(121, 168, 255, 0.18);
  color: #a9c6ff;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
}
.ots-composer {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 6px 0 12px;
  border: 0;
  border-radius: 13px;
  background: var(--ots-surface-2);
  box-shadow: inset 0 0 0 1px rgba(160, 184, 214, 0.1);
  transition: box-shadow 150ms ease, background 150ms ease;
}
.ots-composer:focus-within {
  background: var(--ots-surface-3);
  box-shadow: inset 0 0 0 1px rgba(126, 224, 189, 0.55), 0 0 0 3px rgba(126, 224, 189, 0.07);
}
.ots-composer-plus { color: var(--ots-faint); display: flex; }
.ots-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ots-text);
  font-size: 12.5px;
}
.ots-input::placeholder { color: var(--ots-faint); }
.ots-send {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 9px;
  background: var(--ots-accent);
  color: #07130f;
  cursor: pointer;
  transition: transform 120ms ease, opacity 120ms ease;
}
.ots-send:hover:not(:disabled) { transform: translateY(-1px); }
.ots-send:disabled { opacity: 0.2; cursor: default; }
.ots-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: 24px 18px 30px;
  text-align: center;
}
.ots-state-icon {
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  margin-bottom: 16px;
  border: 0;
  border-radius: 22px;
  color: var(--ots-accent);
  background: radial-gradient(circle at 30% 20%, rgba(126, 224, 189, 0.18), rgba(21, 28, 38, 0.5));
  box-shadow: inset 0 0 0 1px rgba(160, 184, 214, 0.16);
}
.ots-state-icon-warn { color: var(--ots-warn); background: radial-gradient(circle at 30% 20%, rgba(239, 192, 110, 0.16), rgba(21, 28, 38, 0.5)); }
.ots-state-date { font-size: 10px; font-weight: 700; letter-spacing: 0.11em; text-transform: uppercase; color: var(--ots-accent); }
.ots-state-title { margin: 6px 0 0; font-size: 19px; font-weight: 680; letter-spacing: -0.02em; }
.ots-state-copy { max-width: 310px; margin: 7px 0 18px; color: var(--ots-muted); font-size: 11.5px; line-height: 1.6; }
.ots-create-row { display: flex; align-items: center; gap: 7px; width: min(100%, 330px); }
.ots-create-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 36px;
  padding: 0 11px;
  border: 0;
  border-radius: 9px;
  outline: 0;
  background: var(--ots-surface-2);
  box-shadow: inset 0 0 0 1px rgba(160, 184, 214, 0.1);
  color: var(--ots-text);
  font-size: 12px;
}
.ots-create-input:focus {
  box-shadow: inset 0 0 0 1px rgba(126, 224, 189, 0.5), 0 0 0 3px rgba(126, 224, 189, 0.07);
}
.ots-primary, .ots-secondary {
  height: 36px;
  padding: 0 14px;
  border: 0;
  border-radius: 9px;
  font-size: 11.5px;
  font-weight: 650;
  cursor: pointer;
  white-space: nowrap;
  transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
}
.ots-primary { background: var(--ots-accent); color: #07130f; box-shadow: 0 6px 18px rgba(126, 224, 189, 0.16); }
.ots-primary:hover:not(:disabled) { transform: translateY(-1px); }
.ots-primary:disabled { opacity: 0.35; cursor: default; }
.ots-secondary { background: var(--ots-surface-2); color: var(--ots-text); box-shadow: inset 0 0 0 1px rgba(160, 184, 214, 0.1); }
.ots-secondary:hover:not(:disabled) { background: var(--ots-surface-3); }
.ots-state-hint { margin: 10px 0 0; color: var(--ots-faint); font-size: 10px; line-height: 1.5; }
.ots-state-actions { display: flex; gap: 8px; }
.ots-skeleton { display: flex; flex-direction: column; gap: 7px; padding: 12px 5px; }
.ots-skeleton-row { display: flex; align-items: center; gap: 12px; padding: 10px 6px; }
.ots-skeleton-box { width: 21px; height: 21px; flex: 0 0 auto; border-radius: 7px; background: rgba(160, 184, 214, 0.09); animation: ots-shimmer 1.3s ease-in-out infinite; }
.ots-skeleton-line { height: 9px; border-radius: 99px; background: rgba(160, 184, 214, 0.08); animation: ots-shimmer 1.3s ease-in-out infinite; }
.ots-toast {
  position: absolute;
  left: 13px;
  right: 13px;
  bottom: 84px;
  z-index: 5;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 10px 10px 13px;
  border: 0;
  border-radius: 10px;
  background: rgba(21, 28, 38, 0.97);
  color: var(--ots-text);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(160, 184, 214, 0.14);
  font-size: 11px;
  line-height: 1.45;
  animation: ots-toast-in 180ms ease-out;
}
.ots-toast span { flex: 1 1 auto; }
.ots-toast-error { box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(255, 124, 138, 0.32); }
.ots-toast-success { box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(126, 224, 189, 0.3); }
.ots-toast-close { border: 0; background: transparent; color: var(--ots-muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 2px; }
.ots-sheet-backdrop {
  position: absolute;
  inset: 0;
  z-index: 9;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 12px;
  background: rgba(2, 4, 8, 0.6);
  backdrop-filter: blur(3px);
  animation: ots-fade-in 140ms ease-out;
}
.ots-sheet {
  width: 100%;
  max-width: 420px;
  padding: 15px;
  border: 0;
  border-radius: 16px;
  background: var(--ots-surface);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(160, 184, 214, 0.12);
  animation: ots-sheet-in 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ots-sheet-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ots-sheet-header h2 { margin: 0; font-size: 15px; font-weight: 680; letter-spacing: -0.02em; }
.ots-sheet-copy { margin: 7px 0 14px; color: var(--ots-muted); font-size: 11px; line-height: 1.55; }
.ots-field-label { margin: 10px 0 4px; color: var(--ots-faint); font-size: 9.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; }
.ots-path { display: block; padding: 8px 9px; border: 1px solid var(--ots-line); border-radius: 8px; background: rgba(8, 11, 16, 0.55); color: var(--ots-muted); font-family: "Cascadia Code", Consolas, monospace; font-size: 10.5px; overflow-wrap: anywhere; }
.ots-sheet-hint { margin: 8px 0 0; color: var(--ots-faint); font-size: 10px; }
.ots-sheet-actions { display: flex; gap: 8px; margin-top: 15px; }
.ots-sheet-actions .ots-secondary, .ots-sheet-actions .ots-primary { flex: 1 1 0; }
.ots-setup {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100dvh;
  padding: 20px;
  overflow-y: auto;
}
.ots-setup-card {
  width: 100%;
  max-width: 390px;
  padding: 24px;
  border: 0;
  border-radius: 20px;
  background:
    radial-gradient(110% 90% at 15% 0%, rgba(126, 224, 189, 0.09), rgba(16, 21, 29, 0) 55%),
    var(--ots-surface);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(160, 184, 214, 0.12);
}
.ots-setup-logo {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  margin-bottom: 14px;
  border: 1px solid rgba(126, 224, 189, 0.3);
  border-radius: 16px;
  color: var(--ots-accent);
  background: rgba(126, 224, 189, 0.1);
}
.ots-setup-eyebrow { font-size: 9.5px; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase; color: var(--ots-accent); }
.ots-setup-title { margin: 5px 0 0; font-size: 22px; line-height: 1.18; font-weight: 700; letter-spacing: -0.03em; }
.ots-setup-copy { margin: 8px 0 18px; color: var(--ots-muted); font-size: 11.5px; line-height: 1.6; }
.ots-setup-form { display: flex; flex-direction: column; }
.ots-label { margin-bottom: 5px; color: var(--ots-faint); font-size: 9.5px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; }
.ots-path-input {
  height: 38px;
  padding: 0 11px;
  border: 0;
  border-radius: 9px;
  outline: 0;
  background: rgba(8, 11, 16, 0.72);
  box-shadow: inset 0 0 0 1px rgba(160, 184, 214, 0.12);
  color: var(--ots-text);
  font-family: "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  transition: box-shadow 140ms ease;
}
.ots-path-input:focus {
  box-shadow: inset 0 0 0 1px rgba(126, 224, 189, 0.55), 0 0 0 3px rgba(126, 224, 189, 0.07);
}
.ots-form-error {
  margin-top: 8px;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: rgba(255, 124, 138, 0.1);
  box-shadow: inset 0 0 0 1px rgba(255, 124, 138, 0.24);
  color: #ffb1b9;
  font-size: 10.5px;
}
.ots-connect { margin-top: 12px; height: 38px; }
.ots-bridge-card { display: flex; flex-direction: column; align-items: flex-start; }
.ots-spinner {
  width: 22px;
  height: 22px;
  margin-top: 4px;
  border: 2px solid rgba(126, 224, 189, 0.22);
  border-top-color: var(--ots-accent);
  border-radius: 50%;
  animation: ots-spin 800ms linear infinite;
}
.ots-link-button { margin-top: 12px; border: 0; background: transparent; color: var(--ots-muted); font-size: 11px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.ots-setup-foot { display: flex; align-items: flex-start; gap: 7px; margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--ots-line); color: var(--ots-faint); font-size: 10px; line-height: 1.5; }
.ots-setup-foot svg { flex: 0 0 auto; margin-top: 1px; }
/* ------------------------------------------------------------------------- */
/* Skill tree view                                                           */
/* ------------------------------------------------------------------------- */
.ots-tree-app {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background:
    radial-gradient(120% 80% at 8% 0%, rgba(121, 168, 255, 0.06), transparent 55%),
    var(--ots-bg);
  overflow: hidden;
}
.ots-tree-head {
  flex: 0 0 auto;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--ots-line);
  background: linear-gradient(180deg, rgba(21, 28, 38, 0.7), rgba(10, 14, 20, 0.2));
}
.ots-tree-top { display: flex; align-items: center; gap: 10px; }
.ots-rank-badge { display: flex; align-items: center; gap: 9px; flex: 1 1 auto; min-width: 0; }
.ots-rank-medal {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border-radius: 12px;
  color: var(--ots-accent);
  background: linear-gradient(150deg, rgba(126, 224, 189, 0.2), rgba(121, 168, 255, 0.08));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
.ots-rank-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ots-rank-name {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ots-rank-badge[data-rank="0"] .ots-rank-medal { color: #9aa7b8; background: rgba(154, 167, 184, 0.1); }
.ots-rank-badge[data-rank="1"] .ots-rank-medal { color: #7ee0bd; background: rgba(126, 224, 189, 0.12); }
.ots-rank-badge[data-rank="2"] .ots-rank-medal { color: #79a8ff; background: rgba(121, 168, 255, 0.13); }
.ots-rank-badge[data-rank="3"] .ots-rank-medal { color: #c79bff; background: rgba(199, 155, 255, 0.13); }
.ots-rank-badge[data-rank="4"] .ots-rank-medal { color: #efc06e; background: rgba(239, 192, 110, 0.13); }
.ots-rank-badge[data-rank="5"] .ots-rank-medal {
  color: #ffe3a8;
  background: linear-gradient(150deg, rgba(239, 192, 110, 0.22), rgba(255, 124, 138, 0.16));
  box-shadow: inset 0 0 0 1px rgba(239, 192, 110, 0.35), 0 0 22px -6px rgba(239, 192, 110, 0.7);
}
.ots-tree-tools { display: flex; align-items: center; gap: 6px; flex: 0 1 220px; min-width: 0; }
.ots-tree-tools .ots-dd-wrap { flex: 1 1 auto; }
.ots-points-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-top: 10px; }
.ots-points { color: var(--ots-muted); font-size: 10.5px; }
.ots-points strong {
  margin-right: 2px;
  color: var(--ots-text);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.ots-next { color: var(--ots-faint); font-size: 9.5px; text-align: right; }
.ots-rank-track { height: 4px; margin-top: 7px; overflow: hidden; border-radius: 99px; background: rgba(160, 184, 214, 0.1); }
.ots-rank-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--ots-accent-2), var(--ots-accent));
  box-shadow: 0 0 12px rgba(126, 224, 189, 0.45);
  transition: width 420ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ots-legend { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
.ots-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  border-radius: 99px;
  background: rgba(160, 184, 214, 0.055);
  color: var(--ots-muted);
  font-size: 9.5px;
  white-space: nowrap;
}
.ots-chip strong { color: var(--ots-text); font-weight: 600; font-variant-numeric: tabular-nums; }
.ots-chip-dot {
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--ots-lane, var(--ots-accent));
  box-shadow: 0 0 8px var(--ots-lane, var(--ots-accent));
}
.ots-canvas-scroll {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 10px 0 14px;
}
.ots-canvas {
  position: relative;
  min-width: 100%;
  background-image: radial-gradient(rgba(160, 184, 214, 0.11) 1px, transparent 1px);
  background-size: 22px 22px;
}
.ots-lane-band {
  position: absolute;
  left: 8px;
  right: 8px;
  z-index: 0;
  border-radius: 16px;
  background: linear-gradient(90deg, currentColor, transparent 72%);
  opacity: 0.055;
  pointer-events: none;
}
.ots-edges { position: absolute; inset: 0; z-index: 1; overflow: visible; pointer-events: none; }
.ots-edge {
  fill: none;
  stroke-width: 1.6;
  stroke-linecap: round;
  opacity: 0.32;
  transition: opacity 240ms ease, stroke-width 240ms ease;
}
.ots-edge[data-state="open"] { opacity: 0.55; stroke-dasharray: 5 7; animation: ots-dash 1.5s linear infinite; }
.ots-edge[data-state="done"] { opacity: 0.95; stroke-width: 2.2; filter: drop-shadow(0 0 6px currentColor); }
.ots-edge[data-state="locked"] { opacity: 0.14; stroke-dasharray: 3 9; }
.ots-lane-label {
  position: absolute;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 8px;
  border-radius: 99px;
  background: rgba(9, 13, 19, 0.86);
  color: var(--ots-muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  white-space: nowrap;
  box-shadow: inset 0 0 0 1px rgba(160, 184, 214, 0.07);
}
.ots-lane-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ots-lane);
  box-shadow: 0 0 8px var(--ots-lane);
}
.ots-lane-score { color: var(--ots-faint); letter-spacing: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.ots-node {
  position: absolute;
  z-index: 2;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border: 0;
  border-radius: 12px;
  overflow: hidden;
  background: linear-gradient(160deg, #161e29, #0f151e);
  color: var(--ots-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(160, 184, 214, 0.1);
  transition: transform 140ms ease, box-shadow 160ms ease, background 160ms ease, opacity 160ms ease;
}
.ots-node:hover {
  transform: translateY(-1px);
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.45), inset 0 0 0 1px var(--ots-lane);
}
.ots-node:active { transform: translateY(0) scale(0.99); }
.ots-node[data-state="checked"] {
  background: linear-gradient(160deg, rgba(126, 224, 189, 0.15), rgba(15, 21, 30, 0.94));
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.42), inset 0 0 0 1px var(--ots-lane), 0 0 26px -8px var(--ots-lane);
}
.ots-node[data-state="locked"] { opacity: 0.42; cursor: not-allowed; }
.ots-node[data-state="locked"]:hover {
  transform: none;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(160, 184, 214, 0.1);
}
.ots-node[data-state="available"]::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px var(--ots-lane);
  opacity: 0.16;
  animation: ots-node-pulse 2.8s ease-in-out infinite;
  pointer-events: none;
}
.ots-node-icon {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  border-radius: 6px;
  color: var(--ots-lane);
  background: rgba(255, 255, 255, 0.045);
}
.ots-node[data-state="checked"] .ots-node-icon { background: var(--ots-lane); color: #06120e; }
.ots-node[data-state="locked"] .ots-node-icon { color: var(--ots-faint); background: rgba(255, 255, 255, 0.03); }
.ots-node-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.ots-node-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
.ots-node-meta {
  color: var(--ots-lane);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.05em;
  opacity: 0.85;
  font-variant-numeric: tabular-nums;
}
.ots-root {
  position: absolute;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 4px;
  padding: 12px 13px;
  border-radius: 16px;
  background: radial-gradient(120% 120% at 10% 0%, rgba(126, 224, 189, 0.19), rgba(14, 20, 28, 0.97));
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(126, 224, 189, 0.34), 0 0 34px -10px rgba(126, 224, 189, 0.6);
}
.ots-root-crest { display: flex; color: var(--ots-accent); }
.ots-root-title { font-size: 13px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.2; }
.ots-root-meta { color: var(--ots-muted); font-size: 9.5px; font-variant-numeric: tabular-nums; }
.ots-canvas-empty {
  position: absolute;
  left: 28px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--ots-faint);
  font-size: 11px;
}
.ots-tree-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 14px 10px;
  border-top: 1px solid var(--ots-line);
  color: var(--ots-faint);
  font-size: 9.5px;
}
.ots-tree-hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.8; }
.ots-tree-sync { flex: 0 0 auto; }
.ots-tree-foot .ots-file-name { max-width: 190px; }
.ots-tree-loading {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--ots-muted);
  font-size: 11px;
}
.ots-tree-state {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28px 20px;
  text-align: center;
}
@media (max-width: 640px) {
  .ots-tree-tools { flex-basis: 150px; }
  .ots-tree-hint { display: none; }
}
@media (max-width: 380px) {
  .ots-focus-label { display: none; }
  .ots-focus-btn span { display: none; }
  .ots-focus-btn { width: 24px; padding: 0; }
}
@keyframes ots-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
@keyframes ots-error-flash { 0%, 100% { opacity: 1; } 25% { opacity: 0.3; } 50% { opacity: 1; } 75% { opacity: 0.4; } }
@keyframes ots-spin { to { transform: rotate(360deg); } }
@keyframes ots-slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(280%); } }
@keyframes ots-shimmer { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes ots-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ots-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes ots-sheet-in { from { opacity: 0; transform: translateY(14px) scale(0.99); } to { opacity: 1; transform: none; } }
@keyframes ots-widget-in { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: none; } }
@keyframes ots-menu-in { from { opacity: 0; transform: translateY(-4px) scale(0.99); } to { opacity: 1; transform: none; } }
@keyframes ots-dash { to { stroke-dashoffset: -24; } }
@keyframes ots-node-pulse { 0%, 100% { opacity: 0.1; } 50% { opacity: 0.32; } }
@media (prefers-reduced-motion: reduce) {
  .ots-widget, .ots-widget *, .ots-widget *::before, .ots-widget *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
`
