// obsidian-task-sync — Host half.
//
// The browser never touches the filesystem. It talks to this module through a
// same-origin JSON bridge registered on the Harness Web server, and this module
// owns every read, write and watch of the Obsidian checklist folder.
//
// The route is deliberately small: every request names one managed operation,
// a vault root and (where relevant) a filename from the strict
// `YYYY-MM-DD-Checklist-<Title>.md` convention. No endpoint accepts an arbitrary
// path, so the public surface cannot be turned into a general file browser.

import { createHash, randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const name = 'obsidian-task-sync'
export const inject = ['webServer']

const ROUTE = '/obsidian-task-sync'
const SESSION_TOKEN = randomUUID()
const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})-Checklist-(.+)\.md$/
const TREE_FILE_RE = /^SkillTrees(?:-(.+))?\.md$/i
const TASK_RE = /^(\s*)([-*+])\s+\[([ xX])\](?:\s(.*))?$/
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/
// Skill-tree nodes carry their point value after a middle dot: `- [ ] RAII · 3`.
// The separator is deliberately explicit so ordinary task text never loses
// characters to the point parser.
const TREE_POINTS_RE = /^(.*)\s*(?:\u00b7|\|)\s*(\d{1,3})(?:\s*(?:pts?|points?))?\s*$/i
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TREE_NODES = 2000
const MAX_BODY_BYTES = 1024 * 1024
const MAX_TASK_TEXT = 500
const MAX_TITLE = 60

const BOOT_GLOBAL = '__OBSIDIAN_TASK_SYNC__'
const API_VERSION = 1

function bootPayload() {
  return { token: SESSION_TOKEN, apiVersion: API_VERSION }
}

export function apply(ctx) {
  // Resolve the Connection service lazily: a composition may activate the
  // bridge before Connection, and a browser-less composition may omit it.
  const resolveConnection = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    } catch {
      return undefined
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (request, response) => handleHttp(request, response, resolveConnection),
      }),
    'obsidian-task-sync: IPC bridge',
  )

  // The shipped Web shell renders the index through `renderIndex`, while the
  // desktop shell loads a static index and applies the collected rows to the
  // page itself. `tapIndex` reaches only the former, so the token must travel
  // as a structured global row — the one hook both boot paths consume.
  ctx.effect(
    () =>
      ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: BOOT_GLOBAL, value: bootPayload() })
      }),
    'obsidian-task-sync: boot token injection',
  )
}

/** Test seam: the per-process bridge token. Not exposed over HTTP. */
export function __sessionToken() {
  return SESSION_TOKEN
}

// The browser's JSON bridge uses POST, while the Web server's `resource` route
// deliberately serves only GET/HEAD. This raw HTTP handler adapts the request to
// a Fetch Request so the bridge can accept both methods, then writes the Fetch
// Response back to the Node socket (including a streaming SSE body).
export async function handleHttp(req, res, resolveConnection = () => undefined) {
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  try {
    const host = typeof req.headers.host === 'string' ? req.headers.host : '127.0.0.1'
    const protocol = req.socket?.encrypted === true ? 'https' : 'http'
    const url = `${protocol}://${host}${req.url ?? '/'}`
    const method = req.method ?? 'GET'
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(req)
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
    const request = new Request(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    })
    const response = await handleRoute(request, resolveConnection)
    await writeNodeResponse(req, res, response)
  } catch (error) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const status = error instanceof HttpError ? error.status : 500
    const code = error instanceof HttpError ? error.code : 'bridge-failure'
    const message =
      error instanceof Error ? error.message : 'Unexpected checklist bridge failure'
    sendNodeJson(res, status, { error: { code, message } })
  }
}

async function readNodeBody(req) {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_BODY_BYTES) {
    req.resume()
    throw new HttpError(413, 'body-too-large', 'Request body is too large')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      throw new HttpError(413, 'body-too-large', 'Request body is too large')
    }
    chunks.push(chunk)
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks)
}

async function writeNodeResponse(req, res, response) {
  const headers = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.startsWith('text/event-stream')) {
    res.writeHead(response.status, headers)
    res.flushHeaders?.()
    if (response.body === null) {
      res.end()
      return
    }
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once('drain', resolve))
        }
      }
    } catch {
      // A client disconnect aborts the request signal and closes this stream.
    } finally {
      try {
        await reader.cancel()
      } catch {
        // Already cancelled.
      }
      res.end()
    }
    return
  }

  const body = response.body === null ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer())
  headers['content-length'] = String(body.length)
  res.writeHead(response.status, headers)
  if (req.method === 'HEAD') res.end()
  else res.end(body)
}

function sendNodeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

// ---------------------------------------------------------------------------
// HTTP bridge
// ---------------------------------------------------------------------------

async function handleRoute(request, resolveConnection = () => undefined) {
  const url = new URL(request.url)
  try {
    assertSameOrigin(request, url)
    if (url.pathname === `${ROUTE}/bootstrap`) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'method-not-allowed', 'The checklist bridge bootstrap accepts GET')
      }
      await authorizeBootstrap(request, resolveConnection)
      return json(bootPayload())
    }
    if (url.pathname === `${ROUTE}/events`) {
      if (request.method !== 'GET') {
        throw new HttpError(405, 'method-not-allowed', 'The live checklist stream accepts GET')
      }
      return watchEvents(request, url)
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
    }
    if (request.method !== 'POST') {
      throw new HttpError(405, 'method-not-allowed', 'The checklist bridge accepts POST requests')
    }
    const supplied = request.headers.get('x-obsidian-task-sync-token')
    if (supplied !== SESSION_TOKEN) {
      throw new HttpError(401, 'unauthorized', 'The checklist bridge token is missing or expired')
    }

    const body = await readJson(request)
    switch (url.pathname) {
      case `${ROUTE}/api/vault/check`:
        return json(await checkVault(body.root))
      case `${ROUTE}/api/vault/files`:
        return json({ files: await listChecklists(await requireRoot(body.root)) })
      case `${ROUTE}/api/document`:
        return json(await requireDocument(body.root, body.file))
      case `${ROUTE}/api/task/toggle`:
        return json(await toggleTask(body))
      case `${ROUTE}/api/task/append`:
        return json(await appendTask(body))
      case `${ROUTE}/api/task/delete`:
        return json(await deleteTask(body))
      case `${ROUTE}/api/task/reorder`:
        return json(await reorderTasks(body))
      case `${ROUTE}/api/task/rollover`:
        return json(await rolloverTasks(body))
      case `${ROUTE}/api/checklist/create`:
        return json(await createChecklist(body))
      case `${ROUTE}/api/tree/list`:
        return json({ trees: await listSkillTrees(await requireRoot(body.root)) })
      case `${ROUTE}/api/tree/document`:
        return json(await requireTreeDocument(body.root, body.file))
      case `${ROUTE}/api/tree/toggle`:
        return json(await toggleSkillTreeNode(body))
      case `${ROUTE}/api/tree/create`:
        return json(await createSkillTree(body))
      default:
        throw new HttpError(404, 'not-found', 'Unknown checklist bridge operation')
    }
  } catch (error) {
    if (error instanceof HttpError) {
      const payload = { error: { code: error.code, message: error.message } }
      if (error.details !== undefined) Object.assign(payload, error.details)
      return json(payload, error.status)
    }
    return json(
      {
        error: {
          code: 'bridge-failure',
          message: error instanceof Error ? error.message : 'Unexpected checklist bridge failure',
        },
      },
      500,
    )
  }
}

function assertSameOrigin(request, url) {
  const origin = request.headers.get('origin')
  if (origin !== null) {
    let authority = null
    try {
      authority = new URL(origin).host
    } catch {
      throw new HttpError(403, 'origin-refused', 'The request Origin is invalid')
    }
    if (authority !== url.host) {
      throw new HttpError(403, 'origin-refused', 'Cross-origin checklist access is not allowed')
    }
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'origin-refused', 'Cross-site checklist access is not allowed')
  }
}

// A page that loaded before this plugin was installed (or before the desktop
// boot payload was collected) has no injected token yet. The bootstrap route
// hands the token to the page only after the Harness Connection service admits
// the request against its signed browser session — there is no unauthenticated
// token endpoint. `dsh-app://app` requests reach this route through the desktop
// forwarder, which preserves that same authenticated cookie.
async function authorizeBootstrap(request, resolveConnection) {
  const connection = typeof resolveConnection === 'function' ? resolveConnection() : undefined
  if (connection === null || connection === undefined || typeof connection.admit !== 'function') {
    throw new HttpError(
      401,
      'unauthorized',
      'The checklist bridge token is available only inside the authenticated Harness page',
    )
  }
  let admission
  try {
    admission = await connection.admit(request)
  } catch {
    throw new HttpError(401, 'unauthorized', 'The Harness session could not be verified')
  }
  if (
    admission === null ||
    typeof admission !== 'object' ||
    admission.peer === undefined ||
    admission.rejection !== undefined
  ) {
    const status = admission !== null && typeof admission === 'object' && admission.rejection === 403 ? 403 : 401
    throw new HttpError(status, 'unauthorized', 'The Harness session could not be verified')
  }
}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'body-too-large', 'Request body is too large')
  }
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError(413, 'body-too-large', 'Request body is too large')
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid-json', 'Request body must be JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid-json', 'Request body must be a JSON object')
  }
  return value
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// Live watch stream (Server-Sent Events)
// ---------------------------------------------------------------------------

function watchEvents(request, url) {
  if (url.searchParams.get('token') !== SESSION_TOKEN) {
    return json(
      { error: { code: 'unauthorized', message: 'The checklist bridge token is missing or expired' } },
      401,
    )
  }
  const root = url.searchParams.get('root') ?? ''
  const file = url.searchParams.get('file') ?? ''
  const tree = url.searchParams.get('tree') ?? ''
  const encoder = new TextEncoder()
  let watcher
  let heartbeat
  let timer
  let closed = false
  let lastRevision = null
  let lastTreeRevision = null
  let watchRoot = null

  const stream = new ReadableStream({
    async start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        if (timer !== undefined) clearTimeout(timer)
        if (heartbeat !== undefined) clearInterval(heartbeat)
        try {
          watcher?.close()
        } catch {
          // A watcher that already failed needs no second close.
        }
        try {
          controller.close()
        } catch {
          // The browser may already have cancelled the stream.
        }
      }
      const send = (event, data) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          close()
        }
      }
      const publish = async (force = false) => {
        if (closed) return
        if (file !== '') {
          try {
            const normalizedRoot = watchRoot ?? (await requireRoot(root))
            const document = await readDocument(normalizedRoot, file)
            if (force || document.revision !== lastRevision) {
              lastRevision = document.revision
              send('document', { kind: 'document', document, at: Date.now() })
            }
          } catch (error) {
            if (error instanceof HttpError && (error.code === 'missing-file' || error.code === 'not-found')) {
              lastRevision = null
              send('document', { kind: 'missing', file, at: Date.now() })
            } else {
              send('watch-error', {
                kind: 'error',
                message: error instanceof Error ? error.message : 'Checklist watch failed',
                at: Date.now(),
              })
            }
          }
        }
        if (tree !== '') {
          try {
            const normalizedRoot = watchRoot ?? (await requireRoot(root))
            const document = await readTreeDocument(normalizedRoot, tree)
            if (force || document.revision !== lastTreeRevision) {
              lastTreeRevision = document.revision
              send('tree', { kind: 'tree', document, at: Date.now() })
            }
          } catch (error) {
            if (error instanceof HttpError && (error.code === 'missing-file' || error.code === 'not-found')) {
              lastTreeRevision = null
              send('tree', { kind: 'missing', file: tree, at: Date.now() })
            } else {
              send('watch-error', {
                kind: 'error',
                message: error instanceof Error ? error.message : 'Skill tree watch failed',
                at: Date.now(),
              })
            }
          }
        }
      }
      const schedule = () => {
        if (closed) return
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          void publish()
          void publishFiles()
          void publishTrees()
        }, 180)
      }
      const publishFiles = async () => {
        if (closed) return
        try {
          const normalizedRoot = watchRoot ?? (await requireRoot(root))
          const files = await listChecklists(normalizedRoot)
          send('files', { kind: 'files', files, at: Date.now() })
        } catch {
          // The document stream still reports the actionable failure.
        }
      }
      const publishTrees = async () => {
        if (closed || tree === '') return
        try {
          const normalizedRoot = watchRoot ?? (await requireRoot(root))
          const trees = await listSkillTrees(normalizedRoot)
          send('trees', { kind: 'trees', trees, at: Date.now() })
        } catch {
          // The tree document stream still reports the actionable failure.
        }
      }

      try {
        watchRoot = await requireRoot(root)
      } catch (error) {
        send('watch-error', {
          kind: 'error',
          message: error instanceof Error ? error.message : 'The Obsidian folder cannot be watched',
          at: Date.now(),
        })
        close()
        return
      }

      if (tree !== '') {
        try {
          requireTreeFile(tree)
        } catch (error) {
          send('watch-error', {
            kind: 'error',
            message:
              error instanceof Error ? error.message : 'The skill tree file cannot be watched',
            at: Date.now(),
          })
          close()
          return
        }
      }

      send('hello', { kind: 'hello', root: watchRoot, file, tree, at: Date.now() })
      await publish(true)
      await publishFiles()
      await publishTrees()

      try {
        watcher = watch(watchRoot, { persistent: true }, (_eventType, filename) => {
          if (filename === null || filename === undefined) {
            schedule()
            return
          }
          const changed = String(filename)
          if (changed === file || changed.toLowerCase().endsWith('.md')) schedule()
        })
        watcher.on('error', () => {
          send('watch-error', {
            kind: 'error',
            message: 'The filesystem watcher stopped; the UI is polling instead',
            at: Date.now(),
          })
          close()
        })
      } catch (error) {
        send('watch-error', {
          kind: 'error',
          message: error instanceof Error ? error.message : 'The filesystem watcher could not start',
          at: Date.now(),
        })
      }

      heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`))
        } catch {
          close()
        }
      }, 20_000)

      request.signal?.addEventListener('abort', close, { once: true })
      if (request.signal?.aborted === true) close()
    },
    cancel() {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      if (heartbeat !== undefined) clearInterval(heartbeat)
      try {
        watcher?.close()
      } catch {
        // Already closed.
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    },
  })
}

// ---------------------------------------------------------------------------
// Vault and checklist files
// ---------------------------------------------------------------------------

async function checkVault(rawRoot) {
  const root = await requireRoot(rawRoot)
  const files = await listChecklists(root)
  return { root, files, writable: true }
}

async function requireRoot(rawRoot) {
  if (typeof rawRoot !== 'string') {
    throw new HttpError(400, 'invalid-root', 'Choose the absolute path of an Obsidian folder')
  }
  const trimmed = rawRoot.trim()
  if (trimmed.length === 0 || trimmed.length > 4096 || trimmed.includes('\0')) {
    throw new HttpError(400, 'invalid-root', 'The folder path is empty or invalid')
  }
  if (!path.isAbsolute(trimmed)) {
    throw new HttpError(400, 'invalid-root', 'The Obsidian folder path must be absolute')
  }
  const resolved = path.resolve(trimmed)
  let root = resolved
  try {
    // Normalize Windows 8.3 segments to their long form. libuv's fs.watch
    // asserts when a watched directory and the event filename use different
    // short/long spellings; realpath prevents that class of crash.
    root = await realpath(resolved)
    const info = await stat(root)
    if (!info.isDirectory()) {
      throw new HttpError(400, 'vault-not-directory', 'That path is a file, not a folder')
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(404, 'vault-missing', 'That folder does not exist')
  }
  return root
}

async function requireDocument(rawRoot, rawFile) {
  const root = await requireRoot(rawRoot)
  return readDocument(root, rawFile)
}

function requireChecklistFile(rawFile) {
  if (typeof rawFile !== 'string') {
    throw new HttpError(400, 'invalid-file', 'Choose a checklist file')
  }
  const file = rawFile.trim()
  if (
    file.length === 0 ||
    path.basename(file) !== file ||
    file.includes('/') ||
    file.includes('\\') ||
    !FILE_RE.test(file)
  ) {
    throw new HttpError(
      400,
      'invalid-file',
      'Checklist files must be named YYYY-MM-DD-Checklist-<Title>.md',
    )
  }
  return file
}

function checklistPath(root, rawFile) {
  const file = requireChecklistFile(rawFile)
  const full = path.resolve(root, file)
  const relative = path.relative(root, full)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, 'invalid-file', 'The checklist file must live inside the Obsidian folder')
  }
  return { file, full }
}

export function parseChecklistFileName(file) {
  const match = FILE_RE.exec(file)
  if (match === null) return null
  const date = `${match[1]}-${match[2]}-${match[3]}`
  if (!isCalendarDate(date)) return null
  return { file, date, title: match[4] }
}

export function fileNameFor(date, title) {
  if (!isCalendarDate(date)) {
    throw new HttpError(400, 'invalid-date', 'Date must be a real calendar date in YYYY-MM-DD form')
  }
  return `${date}-Checklist-${sanitizeTitle(title)}.md`
}

export function sanitizeTitle(rawTitle) {
  const title = String(rawTitle ?? 'Daily')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_TITLE)
    .trim()
  return title.length > 0 ? title : 'Daily'
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

// Calendar arithmetic in UTC avoids DST gaps: the local date key is a plain
// calendar day, not an instant, so adding one day must always advance the label.
export function nextCalendarDate(value) {
  if (!isCalendarDate(value)) {
    throw new HttpError(400, 'invalid-date', 'Date must be a real calendar date in YYYY-MM-DD form')
  }
  const [year, month, day] = value.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  const key = next.toISOString().slice(0, 10)
  if (!isCalendarDate(key)) {
    throw new HttpError(400, 'invalid-date', 'There is no representable date after that checklist')
  }
  return key
}

export async function listChecklists(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    throw new HttpError(404, 'vault-missing', 'The Obsidian folder cannot be read')
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const parsed = parseChecklistFileName(entry.name)
    if (parsed === null) continue
    try {
      const info = await stat(path.join(root, entry.name))
      files.push({
        ...parsed,
        bytes: info.size,
        updatedAt: info.mtimeMs,
      })
    } catch {
      // A file removed during the scan simply drops out of this listing.
    }
  }
  files.sort((left, right) => {
    if (left.date !== right.date) return right.date.localeCompare(left.date)
    return right.updatedAt - left.updatedAt
  })
  return files
}

// ---------------------------------------------------------------------------
// Markdown parsing and exact-line mutations
// ---------------------------------------------------------------------------

export function parseTasks(content) {
  const lines = content.split('\n')
  const tasks = []
  let section = null
  let fence = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index]
    const fenceMarker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMarker !== null) {
      if (fence === null) fence = fenceMarker[1][0]
      else if (fenceMarker[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = HEADING_RE.exec(line)
    if (heading !== null) {
      section = heading[1].trim()
      continue
    }
    const match = TASK_RE.exec(line)
    if (match === null) continue
    const text = match[4] ?? ''
    tasks.push({
      id: taskId(index, match, text),
      line: index + 1,
      indent: match[1],
      bullet: match[2],
      checked: match[3].toLowerCase() === 'x',
      text,
      section,
      raw: line,
    })
  }
  return tasks
}

function taskId(index, match, text) {
  // The checkbox marker is deliberately excluded: checking a box must keep the
  // same React key so the strike-through transition plays instead of remounting.
  return createHash('sha1')
    .update(`${index + 1}\0${match[1]}\0${match[2]}\0${text}`)
    .digest('hex')
    .slice(0, 12)
}

function stripCarriage(value) {
  return value.endsWith('\r') ? value.slice(0, -1) : value
}

export function toggleTaskInContent(content, lineNumber, raw, checked) {
  const lines = content.split('\n')
  const index = Number(lineNumber) - 1
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new HttpError(409, 'stale', 'That task line no longer exists')
  }
  const line = stripCarriage(lines[index])
  const match = TASK_RE.exec(line)
  if (match === null) {
    throw new HttpError(409, 'stale', 'That line is no longer an Obsidian task')
  }
  if (typeof raw === 'string' && stripCarriage(raw) !== line) {
    throw new HttpError(409, 'stale', 'That task changed on disk before the toggle arrived')
  }
  const target = checked === true ? '[x]' : '[ ]'
  lines[index] = lines[index].replace(/\[[ xX]\]/, target)
  return lines.join('\n')
}

export function appendTaskToContent(content, rawText) {
  const text = normalizeTaskText(rawText)
  const tasks = parseTasks(content)
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  if (tasks.length === 0) {
    let next = content
    if (next.length > 0 && !next.endsWith('\n')) next += eol
    return `${next}- [ ] ${text}${eol}`
  }

  const lines = content.split('\n')
  const afterLastTask = tasks[tasks.length - 1].line
  if (afterLastTask === lines.length && !content.endsWith('\n')) {
    lines[lines.length - 1] += eol === '\r\n' ? '\r' : ''
  }
  const carry = eol === '\r\n' && afterLastTask < lines.length ? '\r' : ''
  lines.splice(afterLastTask, 0, `- [ ] ${text}${carry}`)
  return lines.join('\n')
}

// Rollover moves existing task lines verbatim. Unlike a typed composer entry,
// the indentation, bullet character and inline markdown of a migrated task must
// survive, so this helper never re-renders the line.
export function appendTaskLinesToContent(content, rawLines) {
  if (!Array.isArray(rawLines)) {
    throw new HttpError(400, 'invalid-task', 'Rollover tasks must be a list of task lines')
  }
  const additions = []
  const skipped = []
  const existing = new Set(parseTasks(content).map((task) => stripCarriage(task.raw)))
  for (const candidate of rawLines) {
    if (typeof candidate !== 'string') {
      throw new HttpError(400, 'invalid-task', 'Rollover tasks must be task lines')
    }
    const raw = stripCarriage(candidate)
    if (TASK_RE.exec(raw) === null) {
      throw new HttpError(400, 'invalid-task', 'Rollover tasks must be Obsidian checklist lines')
    }
    // Re-running a rollover after a partial failure must not duplicate a task
    // that already reached tomorrow's file. Identical raw lines only; two
    // genuinely different tasks with the same title still migrate separately.
    if (existing.has(raw)) {
      skipped.push(raw)
      continue
    }
    additions.push(raw)
  }
  if (additions.length === 0) {
    return { content, appended: 0, skipped: skipped.length }
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const tasks = parseTasks(content)
  // Insert by character offset instead of rebuilding every line: headings,
  // frontmatter and mixed line endings in tomorrow's note stay byte-identical.
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1)
  }
  let next
  if (tasks.length > 0) {
    const lastLine = tasks[tasks.length - 1].line
    const atEnd = lastLine >= starts.length
    const insertAt = atEnd ? content.length : starts[lastLine]
    const prefix = atEnd && content.length > 0 && !content.endsWith('\n') ? eol : ''
    next =
      content.slice(0, insertAt) +
      prefix +
      additions.map((raw) => `${raw}${eol}`).join('') +
      content.slice(insertAt)
  } else {
    const prefix = content.length > 0 && !content.endsWith('\n') ? eol : ''
    next = `${content}${prefix}${additions.map((raw) => `${raw}${eol}`).join('')}`
  }
  return { content: next, appended: additions.length, skipped: skipped.length }
}

export function removeTaskLinesFromContent(content, lineNumbers) {
  if (!Array.isArray(lineNumbers)) {
    throw new HttpError(400, 'invalid-order', 'Task line numbers must be a list')
  }
  const lines = content.split('\n')
  const drop = new Set()
  for (const candidate of lineNumbers) {
    const index = Number(candidate) - 1
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
      throw new HttpError(409, 'stale', 'A task line that should roll over no longer exists')
    }
    if (TASK_RE.exec(stripCarriage(lines[index])) === null) {
      throw new HttpError(409, 'stale', 'A task line that should roll over is no longer a task')
    }
    drop.add(index)
  }
  if (drop.size === 0) return content
  return lines.filter((_line, index) => !drop.has(index)).join('\n')
}

export function deleteTaskFromContent(content, lineNumber, raw) {
  const lines = content.split('\n')
  const index = Number(lineNumber) - 1
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new HttpError(409, 'stale', 'That task line no longer exists')
  }
  const line = stripCarriage(lines[index])
  if (TASK_RE.exec(line) === null) {
    throw new HttpError(409, 'stale', 'That line is no longer an Obsidian task')
  }
  if (typeof raw === 'string' && stripCarriage(raw) !== line) {
    throw new HttpError(409, 'stale', 'That task changed on disk before the delete arrived')
  }
  lines.splice(index, 1)
  return lines.join('\n')
}

export function reorderTasksInContent(content, order) {
  const tasks = parseTasks(content)
  if (!Array.isArray(order) || order.some((entry) => !Number.isInteger(entry))) {
    throw new HttpError(400, 'invalid-order', 'Task order must be a list of line numbers')
  }
  const byLine = new Map(tasks.map((task) => [task.line, task]))
  if (order.length !== tasks.length) {
    throw new HttpError(409, 'stale', 'The task list changed on disk before the reorder arrived')
  }
  const seen = new Set()
  for (const line of order) {
    if (!byLine.has(line) || seen.has(line)) {
      throw new HttpError(409, 'stale', 'The task list changed on disk before the reorder arrived')
    }
    seen.add(line)
  }
  if (tasks.every((task, index) => task.line === order[index])) return content

  const lines = content.split('\n')
  const replacement = order.map((line) => byLine.get(line).raw)
  const targetIndices = tasks.map((task) => task.line - 1)
  for (let index = 0; index < targetIndices.length; index += 1) {
    const at = targetIndices[index]
    const carriage = lines[at].endsWith('\r') ? '\r' : ''
    lines[at] = `${replacement[index]}${carriage}`
  }
  return lines.join('\n')
}

function normalizeTaskText(rawText) {
  if (typeof rawText !== 'string') {
    throw new HttpError(400, 'invalid-task', 'Task text is required')
  }
  const text = rawText
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TASK_TEXT)
  if (text.length === 0) throw new HttpError(400, 'invalid-task', 'Task text cannot be empty')
  return text
}

export async function readDocument(root, rawFile) {
  const { file, full } = checklistPath(root, rawFile)
  const parsed = parseChecklistFileName(file)
  if (parsed === null) {
    throw new HttpError(400, 'invalid-file', 'Checklist filenames must start with YYYY-MM-DD')
  }
  let info
  try {
    info = await stat(full)
  } catch {
    throw new HttpError(404, 'missing-file', 'That checklist does not exist yet')
  }
  if (!info.isFile()) throw new HttpError(400, 'invalid-file', 'The checklist is not a regular file')
  if (info.size > MAX_FILE_BYTES) {
    throw new HttpError(413, 'file-too-large', 'The checklist is larger than 2 MB')
  }
  let content
  try {
    content = await readFile(full, 'utf8')
  } catch {
    throw new HttpError(500, 'read-failed', 'The checklist could not be read')
  }
  const tasks = parseTasks(content)
  return {
    root,
    file,
    date: parsed.date,
    title: parsed.title,
    revision: createHash('sha1').update(content).digest('hex').slice(0, 20),
    tasks,
    lineCount: content.split('\n').length,
    bytes: Buffer.byteLength(content, 'utf8'),
    checkedCount: tasks.filter((task) => task.checked).length,
    totalCount: tasks.length,
    updatedAt: info.mtimeMs,
    watchedAt: Date.now(),
  }
}

async function toggleTask(body) {
  return mutateDocument(body, (content) =>
    toggleTaskInContent(content, body.line, body.raw, body.checked),
  )
}

async function appendTask(body) {
  return mutateDocument(body, (content) => appendTaskToContent(content, body.text))
}

async function deleteTask(body) {
  return mutateDocument(body, (content) =>
    deleteTaskFromContent(content, body.line, body.raw),
  )
}

async function reorderTasks(body) {
  return mutateDocument(body, (content) => reorderTasksInContent(content, body.order))
}

function checklistForDate(files, date) {
  const candidates = files.filter((entry) => entry.date === date)
  if (candidates.length === 0) return null
  return candidates.find((entry) => entry.title === 'Daily') ?? candidates[0]
}

async function readChecklistContent(root, rawFile) {
  const { file, full } = checklistPath(root, rawFile)
  let info
  try {
    info = await stat(full)
  } catch {
    throw new HttpError(404, 'missing-file', 'That checklist does not exist yet')
  }
  if (!info.isFile()) throw new HttpError(400, 'invalid-file', 'The checklist is not a regular file')
  if (info.size > MAX_FILE_BYTES) {
    throw new HttpError(413, 'file-too-large', 'The checklist is larger than 2 MB')
  }
  try {
    return { file, full, content: await readFile(full, 'utf8') }
  } catch {
    throw new HttpError(500, 'read-failed', 'The checklist could not be read')
  }
}

// Move every unchecked task from the active day to the next calendar day. The
// operation is revision-checked against the same document the client rendered,
// writes tomorrow first and today second, and returns fresh documents plus the
// refreshed folder listing so the live UI can update without waiting for SSE.
async function rolloverTasks(body) {
  const root = await requireRoot(body.root)
  const current = await readDocument(root, body.file)
  if (typeof body.revision === 'string' && body.revision !== current.revision) {
    throw new HttpError(409, 'stale', 'The checklist changed on disk. Refreshing the live view.', {
      document: current,
    })
  }
  const source = await readChecklistContent(root, current.file)
  if (createHash('sha1').update(source.content).digest('hex').slice(0, 20) !== current.revision) {
    const fresh = await readDocument(root, current.file)
    throw new HttpError(409, 'stale', 'The checklist changed on disk. Refreshing the live view.', {
      document: fresh,
    })
  }

  const incomplete = parseTasks(source.content).filter((task) => task.checked !== true)
  const files = await listChecklists(root)
  if (incomplete.length === 0) {
    return {
      moved: 0,
      appended: 0,
      skipped: 0,
      created: false,
      today: current,
      tomorrow: null,
      files,
    }
  }

  const tomorrowDate = nextCalendarDate(current.date)
  const existing = checklistForDate(files, tomorrowDate)
  const tomorrowFile = existing?.file ?? fileNameFor(tomorrowDate, current.title)
  const tomorrowFull = path.join(root, tomorrowFile)
  let tomorrowContent
  let created = false
  if (existing === null) {
    tomorrowContent = `# ${tomorrowDate} · ${sanitizeTitle(current.title)}\n\n`
    created = true
  } else {
    tomorrowContent = (await readChecklistContent(root, existing.file)).content
  }

  const appended = appendTaskLinesToContent(
    tomorrowContent,
    incomplete.map((task) => task.raw),
  )
  const nextToday = removeTaskLinesFromContent(
    source.content,
    incomplete.map((task) => task.line),
  )

  // Tomorrow first: if today's write then fails, the next click deduplicates
  // against tomorrow's existing lines instead of losing the migrated tasks.
  if (appended.content !== tomorrowContent) {
    await atomicWrite(tomorrowFull, appended.content, "Tomorrow's checklist could not be written")
  }
  if (nextToday !== source.content) {
    await atomicWrite(source.full, nextToday)
  }

  const today = await readDocument(root, current.file)
  const tomorrow = await readDocument(root, tomorrowFile)
  return {
    moved: incomplete.length,
    appended: appended.appended,
    skipped: appended.skipped,
    created,
    today,
    tomorrow,
    files: await listChecklists(root),
  }
}

async function mutateDocument(body, mutate) {
  const root = await requireRoot(body.root)
  const { file, full } = checklistPath(root, body.file)
  const current = await readDocument(root, file)
  if (typeof body.revision === 'string' && body.revision !== current.revision) {
    throw new HttpError(409, 'stale', 'The checklist changed on disk. Refreshing the live view.', {
      document: current,
    })
  }
  const content = await readFile(full, 'utf8')
  if (createHash('sha1').update(content).digest('hex').slice(0, 20) !== current.revision) {
    const fresh = await readDocument(root, file)
    throw new HttpError(409, 'stale', 'The checklist changed on disk. Refreshing the live view.', {
      document: fresh,
    })
  }
  const next = mutate(content)
  if (next === content) return current
  await atomicWrite(full, next)
  return readDocument(root, file)
}

async function createChecklist(body) {
  const root = await requireRoot(body.root)
  const date = typeof body.date === 'string' ? body.date : ''
  const file = fileNameFor(date, body.title)
  const full = path.join(root, file)
  try {
    const existing = await stat(full)
    if (existing.isFile()) return readDocument(root, file)
    throw new HttpError(409, 'file-exists', 'A non-file entry already uses that checklist name')
  } catch (error) {
    if (!(error instanceof HttpError)) {
      if (error?.code !== 'ENOENT') {
        throw new HttpError(500, 'create-failed', 'The checklist path could not be inspected')
      }
    } else {
      throw error
    }
  }
  const title = sanitizeTitle(body.title)
  const content = `# ${date} · ${title}\n\n`
  await atomicWrite(full, content)
  return readDocument(root, file)
}

async function atomicWrite(full, content, failureMessage = 'The checklist could not be written') {
  const directory = path.dirname(full)
  const temporary = path.join(directory, `.obsidian-task-sync-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, full)
  } catch {
    try {
      await unlink(temporary)
    } catch {
      // Nothing to clean up.
    }
    throw new HttpError(500, 'write-failed', failureMessage)
  }
}

// ---------------------------------------------------------------------------
// Skill trees
//
// A skill tree is an ordinary Markdown note in the same vault folder. Headings
// describe branches (lanes) and nested checklists describe the left-to-right
// progression; the point value of a node follows a middle dot. Nothing here
// touches the daily-checklist convention, so both formats coexist in one folder.
// ---------------------------------------------------------------------------

export const DEFAULT_TREE_NAME = 'C++'

const CPP_TREE_TEMPLATE = `# C++ Skill Tree

> Check a box here or in Harness. Progress is stored in this note.
> The number after the middle dot is the skill's point value.

## Core Mechanics

- [ ] Smart Pointers · 2
  - [ ] RAII · 2
    - [ ] Move Semantics · 3
      - [ ] Templates & Concepts · 5
        - [ ] Multithreading · 5
          - [ ] C++17 / C++20 / C++23 · 4

## Build & Tooling

- [ ] CMake · 2
  - [ ] Ninja · 2
    - [ ] GDB / LLDB · 3
      - [ ] Profiling (Valgrind / Perf) · 4

## Web & Backend

- [ ] Boost.Asio · 3
  - [ ] Crow · 4
    - [ ] Drogon · 5

## Data Science & ML

- [ ] SIMD Intrinsics · 4
  - [ ] CUDA Programming · 6
    - [ ] LibTorch (PyTorch C++) · 6
      - [ ] ONNX Runtime · 5
`

export function defaultTreeMarkdown(rawName = DEFAULT_TREE_NAME) {
  const name = sanitizeTreeName(rawName)
  if (name.toLowerCase() === DEFAULT_TREE_NAME.toLowerCase()) return CPP_TREE_TEMPLATE
  return `# ${name} Skill Tree

> Check a box here or in Harness. Progress is stored in this note.
> The number after the middle dot is the skill's point value.

## Fundamentals

- [ ] First skill · 1
`
}

export function sanitizeTreeName(rawName) {
  const name = String(rawName ?? DEFAULT_TREE_NAME)
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_TITLE)
    .trim()
  return name.length > 0 ? name : DEFAULT_TREE_NAME
}

export function treeFileNameFor(name) {
  return `SkillTrees-${sanitizeTreeName(name)}.md`
}

export function parseTreeFileName(file) {
  const match = TREE_FILE_RE.exec(String(file ?? ''))
  if (match === null) return null
  return { file: match[0], name: match[1] ?? 'Skill Trees' }
}

function splitNodeText(rawText) {
  const text = String(rawText ?? '').trim()
  const match = TREE_POINTS_RE.exec(text)
  if (match !== null && match[1].trim().length > 0) {
    const points = Number.parseInt(match[2], 10)
    return {
      title: match[1].trim(),
      points: Number.isInteger(points) ? Math.max(0, Math.min(99, points)) : 1,
    }
  }
  return { title: text, points: 1 }
}

export function parseSkillTree(content) {
  const lines = String(content ?? '').split('\n')
  const lanes = []
  const nodes = []
  const stack = []
  let title = null
  let lane = null
  let fence = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripCarriage(lines[index])
    const fenceMarker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMarker !== null) {
      if (fence === null) fence = fenceMarker[1][0]
      else if (fenceMarker[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      const text = heading[2].trim()
      if (level === 1 && title === null && lanes.length === 0 && nodes.length === 0) {
        title = text
      } else if (level >= 2) {
        lane = { id: `lane-${lanes.length}`, index: lanes.length, title: text }
        lanes.push(lane)
        stack.length = 0
      }
      continue
    }
    const match = TASK_RE.exec(line)
    if (match === null) continue
    if (lane === null) {
      lane = { id: `lane-${lanes.length}`, index: lanes.length, title: null }
      lanes.push(lane)
    }
    const indent = (match[1] ?? '').replace(/\t/g, '    ').length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack.length > 0 ? stack[stack.length - 1].node : null
    const parsed = splitNodeText(match[4] ?? '')
    const node = {
      // Line numbers are unique inside one revision and survive a checkbox
      // toggle, so React can animate a check instead of remounting the node.
      id: `n${index + 1}`,
      lane: lane.index,
      depth: parent === null ? 0 : parent.depth + 1,
      parentId: parent === null ? null : parent.id,
      line: index + 1,
      checked: match[3].toLowerCase() === 'x',
      points: parsed.points,
      title: parsed.title,
      raw: line,
    }
    nodes.push(node)
    stack.push({ indent, node })
  }
  const decoratedLanes = lanes.map((entry) => {
    const own = nodes.filter((node) => node.lane === entry.index)
    return {
      ...entry,
      count: own.length,
      completed: own.filter((node) => node.checked).length,
      total: own.reduce((sum, node) => sum + node.points, 0),
      earned: own.reduce((sum, node) => sum + (node.checked ? node.points : 0), 0),
    }
  })
  return {
    title,
    lanes: decoratedLanes,
    nodes,
    totalCount: nodes.length,
    checkedCount: nodes.filter((node) => node.checked).length,
    totalPoints: nodes.reduce((sum, node) => sum + node.points, 0),
    earnedPoints: nodes.reduce((sum, node) => sum + (node.checked ? node.points : 0), 0),
  }
}

export async function listSkillTrees(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    throw new HttpError(404, 'vault-missing', 'The Obsidian folder cannot be read')
  }
  const trees = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const parsed = parseTreeFileName(entry.name)
    if (parsed === null) continue
    try {
      const info = await stat(path.join(root, entry.name))
      trees.push({ ...parsed, bytes: info.size, updatedAt: info.mtimeMs })
    } catch {
      // A file removed during the scan simply drops out of this listing.
    }
  }
  trees.sort((left, right) => left.name.localeCompare(right.name))
  return trees
}

function requireTreeFile(rawFile) {
  if (typeof rawFile !== 'string') {
    throw new HttpError(400, 'invalid-file', 'Choose a skill tree file')
  }
  const file = rawFile.trim()
  if (
    file.length === 0 ||
    path.basename(file) !== file ||
    file.includes('/') ||
    file.includes('\\') ||
    !TREE_FILE_RE.test(file)
  ) {
    throw new HttpError(400, 'invalid-file', 'Skill tree files must be named SkillTrees-<Name>.md')
  }
  return file
}

function treePath(root, rawFile) {
  const file = requireTreeFile(rawFile)
  const full = path.resolve(root, file)
  const relative = path.relative(root, full)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, 'invalid-file', 'The skill tree file must live inside the Obsidian folder')
  }
  return { file, full }
}

export async function readTreeDocument(root, rawFile) {
  const { file, full } = treePath(root, rawFile)
  const parsedName = parseTreeFileName(file)
  if (parsedName === null) {
    throw new HttpError(400, 'invalid-file', 'Skill tree files must be named SkillTrees-<Name>.md')
  }
  let info
  try {
    info = await stat(full)
  } catch {
    throw new HttpError(404, 'missing-file', 'That skill tree does not exist yet')
  }
  if (!info.isFile()) throw new HttpError(400, 'invalid-file', 'The skill tree is not a regular file')
  if (info.size > MAX_FILE_BYTES) {
    throw new HttpError(413, 'file-too-large', 'The skill tree is larger than 2 MB')
  }
  let content
  try {
    content = await readFile(full, 'utf8')
  } catch {
    throw new HttpError(500, 'read-failed', 'The skill tree could not be read')
  }
  const parsed = parseSkillTree(content)
  if (parsed.nodes.length > MAX_TREE_NODES) {
    throw new HttpError(413, 'tree-too-large', 'This skill tree has more than 2000 nodes')
  }
  return {
    root,
    file,
    name: parsedName.name,
    title: parsed.title ?? `${parsedName.name} Skill Tree`,
    revision: createHash('sha1').update(content).digest('hex').slice(0, 20),
    lanes: parsed.lanes,
    nodes: parsed.nodes,
    checkedCount: parsed.checkedCount,
    totalCount: parsed.totalCount,
    earnedPoints: parsed.earnedPoints,
    totalPoints: parsed.totalPoints,
    lineCount: content.split('\n').length,
    bytes: Buffer.byteLength(content, 'utf8'),
    updatedAt: info.mtimeMs,
    watchedAt: Date.now(),
  }
}

export async function requireTreeDocument(rawRoot, rawFile) {
  const root = await requireRoot(rawRoot)
  return readTreeDocument(root, rawFile)
}

export function toggleSkillTreeNodeInContent(content, lineNumber, raw, checked) {
  return toggleTaskInContent(content, lineNumber, raw, checked)
}

async function toggleSkillTreeNode(body) {
  return mutateTree(body, (content) =>
    toggleSkillTreeNodeInContent(content, body.line, body.raw, body.checked),
  )
}

async function mutateTree(body, mutate) {
  const root = await requireRoot(body.root)
  const { file, full } = treePath(root, body.file)
  const current = await readTreeDocument(root, file)
  if (typeof body.revision === 'string' && body.revision !== current.revision) {
    throw new HttpError(409, 'stale', 'The skill tree changed on disk. Refreshing the live view.', {
      document: current,
    })
  }
  const content = await readFile(full, 'utf8')
  if (createHash('sha1').update(content).digest('hex').slice(0, 20) !== current.revision) {
    const fresh = await readTreeDocument(root, file)
    throw new HttpError(409, 'stale', 'The skill tree changed on disk. Refreshing the live view.', {
      document: fresh,
    })
  }
  const next = mutate(content)
  if (next === content) return current
  await atomicWrite(full, next, 'The skill tree could not be written')
  return readTreeDocument(root, file)
}

async function createSkillTree(body) {
  const root = await requireRoot(body.root)
  const name = sanitizeTreeName(body.name ?? DEFAULT_TREE_NAME)
  const file = treeFileNameFor(name)
  const full = path.join(root, file)
  try {
    const existing = await stat(full)
    if (existing.isFile()) return readTreeDocument(root, file)
    throw new HttpError(409, 'file-exists', 'A non-file entry already uses that skill tree name')
  } catch (error) {
    if (!(error instanceof HttpError)) {
      if (error?.code !== 'ENOENT') {
        throw new HttpError(500, 'create-failed', 'The skill tree path could not be inspected')
      }
    } else {
      throw error
    }
  }
  await atomicWrite(full, defaultTreeMarkdown(name), 'The skill tree could not be written')
  return readTreeDocument(root, file)
}
