// Exercise the real HTTP handler: token handshake, POST routing, exact-line
// writes, traversal refusal, and the debounced SSE watch stream.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, __sessionToken } from '../src/host.js'

const root = await mkdtemp(path.join(tmpdir(), 'ots-bridge-'))
const token = __sessionToken()
let registered = null
let injectListener = null
const connection = {
  admit(request) {
    return request.headers.get('cookie') === 'ots-session'
      ? { peer: { id: 'test-peer' } }
      : { rejection: 401 }
  },
}
const ctx = {
  effect(callback) {
    callback()
    return () => {}
  },
  on(event, listener) {
    if (event === 'webserver/index-inject') injectListener = listener
    return () => {}
  },
  get(name) {
    return name === 'connection' ? connection : undefined
  },
  webServer: {
    register(route) {
      registered = route
      return () => {}
    },
  },
}

apply(ctx)
assert.equal(registered?.path, '/obsidian-task-sync')
assert.equal(registered?.kind, 'prefix')
assert.equal(typeof registered?.handler, 'function')
assert.equal(typeof injectListener, 'function')

// The desktop page loads a static index and applies collected rows; the token
// must therefore travel as a structured global row, not only as raw HTML.
const table = []
injectListener(table)
assert.equal(table.length, 1)
assert.equal(table[0].kind, 'global')
assert.equal(table[0].name, '__OBSIDIAN_TASK_SYNC__')
assert.equal(table[0].value.token, token)
assert.equal(table[0].value.apiVersion, 1)

const server = createServer((request, response) => {
  void registered.handler(request, response)
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
const origin = `http://127.0.0.1:${address.port}`

const call = async (pathname, body, bearer = token, extraHeaders = {}) => {
  const headers = { 'content-type': 'application/json', ...extraHeaders }
  if (bearer !== null) headers['x-obsidian-task-sync-token'] = bearer
  const response = await fetch(`${origin}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  return { status: response.status, data }
}

try {
  const denied = await call('/obsidian-task-sync/api/vault/check', { root }, null)
  assert.equal(denied.status, 401)

  // The bootstrap route is the runtime fallback for a page that loaded before
  // the plugin installed: it hands out the token only to an admitted session.
  const bootstrapDenied = await call('/obsidian-task-sync/bootstrap', undefined, null)
  assert.equal(bootstrapDenied.status, 401)
  assert.match(bootstrapDenied.data?.error?.message ?? '', /session|authenticated/i)

  const bootstrap = await call('/obsidian-task-sync/bootstrap', undefined, null, {
    cookie: 'ots-session',
  })
  assert.equal(bootstrap.status, 200)
  assert.equal(bootstrap.data.token, token)
  assert.equal(bootstrap.data.apiVersion, 1)

  const bootstrapWrongMethod = await call('/obsidian-task-sync/bootstrap', {}, null, {
    cookie: 'ots-session',
  })
  assert.equal(bootstrapWrongMethod.status, 405)

  const noHandshake = await call('/obsidian-task-sync/api/handshake', undefined, null)
  assert.equal(noHandshake.status, 405)

  const checked = await call('/obsidian-task-sync/api/vault/check', { root })
  assert.equal(checked.status, 200)
  assert.equal(checked.data.root, await realpath(root))
  assert.deepEqual(checked.data.files, [])
  const workspaceRoot = checked.data.root

  const created = await call('/obsidian-task-sync/api/checklist/create', {
    root,
    date: '2026-11-09',
    title: 'Work',
  })
  assert.equal(created.status, 200)
  assert.equal(created.data.file, '2026-11-09-Checklist-Work.md')
  assert.equal(created.data.totalCount, 0)

  let document = created.data
  for (const text of ['First task', 'Second task', 'Third task']) {
    const appended = await call('/obsidian-task-sync/api/task/append', {
      root,
      file: document.file,
      text,
      revision: document.revision,
    })
    assert.equal(appended.status, 200)
    document = appended.data
  }
  assert.deepEqual(document.tasks.map((item) => item.text), ['First task', 'Second task', 'Third task'])

  const toggled = await call('/obsidian-task-sync/api/task/toggle', {
    root,
    file: document.file,
    line: document.tasks[0].line,
    raw: document.tasks[0].raw,
    checked: true,
    revision: document.revision,
  })
  assert.equal(toggled.status, 200)
  assert.equal(toggled.data.tasks[0].checked, true)
  document = toggled.data

  const contentAfterToggle = await readFile(path.join(workspaceRoot, document.file), 'utf8')
  assert.match(contentAfterToggle, /- \[x\] First task\n- \[ \] Second task\n- \[ \] Third task/)
  assert.match(contentAfterToggle, /^# 2026-11-09 \u00b7 Work\n\n/m)

  const reordered = await call('/obsidian-task-sync/api/task/reorder', {
    root,
    file: document.file,
    order: [document.tasks[2].line, document.tasks[0].line, document.tasks[1].line],
    revision: document.revision,
  })
  assert.equal(reordered.status, 200)
  assert.deepEqual(reordered.data.tasks.map((item) => item.text), ['Third task', 'First task', 'Second task'])
  document = reordered.data

  const stale = await call('/obsidian-task-sync/api/task/toggle', {
    root,
    file: document.file,
    line: document.tasks[0].line,
    raw: document.tasks[0].raw,
    checked: true,
    revision: 'stale',
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.data.error.code, 'stale')
  assert.equal(stale.data.document.revision, document.revision)

  const traversal = await call('/obsidian-task-sync/api/document', {
    root,
    file: '../outside.md',
  })
  assert.equal(traversal.status, 400)

  // --- daily rollover bridge -------------------------------------------------
  const rolloverFile = '2026-11-20-Checklist-Rollover.md'
  await writeFile(
    path.join(workspaceRoot, rolloverFile),
    '# 2026-11-20 · Rollover\n\n- [x] Finished stays\n- [ ] Move one\n  - [ ] Move nested\n* [ ] Move star\n\nA note that stays.\n',
    'utf8',
  )
  const rolloverDoc = await call('/obsidian-task-sync/api/document', { root, file: rolloverFile })
  assert.equal(rolloverDoc.status, 200)
  assert.equal(rolloverDoc.data.totalCount, 4)

  const staleRollover = await call('/obsidian-task-sync/api/task/rollover', {
    root,
    file: rolloverFile,
    revision: 'stale',
  })
  assert.equal(staleRollover.status, 409)
  assert.equal(staleRollover.data.error.code, 'stale')
  assert.equal(staleRollover.data.document.revision, rolloverDoc.data.revision)

  const rolled = await call('/obsidian-task-sync/api/task/rollover', {
    root,
    file: rolloverFile,
    revision: rolloverDoc.data.revision,
  })
  assert.equal(rolled.status, 200)
  assert.equal(rolled.data.moved, 3)
  assert.equal(rolled.data.appended, 3)
  assert.equal(rolled.data.skipped, 0)
  assert.equal(rolled.data.created, true)
  assert.equal(rolled.data.tomorrow.file, '2026-11-21-Checklist-Rollover.md')
  assert.equal(rolled.data.tomorrow.date, '2026-11-21')
  assert.equal(rolled.data.today.totalCount, 1)
  assert.equal(rolled.data.today.checkedCount, 1)
  assert.ok(rolled.data.files.some((entry) => entry.file === rolled.data.tomorrow.file))
  assert.equal(
    await readFile(path.join(workspaceRoot, rolled.data.tomorrow.file), 'utf8'),
    '# 2026-11-21 · Rollover\n\n- [ ] Move one\n  - [ ] Move nested\n* [ ] Move star\n',
  )
  const rolledToday = await readFile(path.join(workspaceRoot, rolloverFile), 'utf8')
  assert.match(rolledToday, /- \[x\] Finished stays/)
  assert.equal(rolledToday.includes('- [ ] Move one'), false)
  assert.match(rolledToday, /A note that stays\./)

  const emptyRollover = await call('/obsidian-task-sync/api/task/rollover', {
    root,
    file: rolloverFile,
    revision: rolled.data.today.revision,
  })
  assert.equal(emptyRollover.status, 200)
  assert.equal(emptyRollover.data.moved, 0)
  assert.equal(emptyRollover.data.tomorrow, null)

  const rolloverAppended = await call('/obsidian-task-sync/api/task/append', {
    root,
    file: rolloverFile,
    text: 'Another task',
    revision: emptyRollover.data.today.revision,
  })
  assert.equal(rolloverAppended.status, 200)
  const rolledAgain = await call('/obsidian-task-sync/api/task/rollover', {
    root,
    file: rolloverFile,
    revision: rolloverAppended.data.revision,
  })
  assert.equal(rolledAgain.status, 200)
  assert.equal(rolledAgain.data.moved, 1)
  assert.equal(rolledAgain.data.appended, 1)
  assert.equal(rolledAgain.data.created, false)
  assert.match(
    await readFile(path.join(workspaceRoot, rolledAgain.data.tomorrow.file), 'utf8'),
    /\* \[ \] Move star\n- \[ \] Another task\n$/,
  )

  const rolloverTraversal = await call('/obsidian-task-sync/api/task/rollover', {
    root,
    file: '../outside.md',
    revision: 'x',
  })
  assert.equal(rolloverTraversal.status, 400)

  // --- skill tree bridge -----------------------------------------------------
  const treeCreated = await call('/obsidian-task-sync/api/tree/create', {
    root,
    name: 'C++',
  })
  assert.equal(treeCreated.status, 200)
  assert.equal(treeCreated.data.file, 'SkillTrees-C++.md')
  assert.equal(treeCreated.data.totalPoints, 65)
  assert.equal(treeCreated.data.nodes.length, 17)
  assert.equal(treeCreated.data.lanes.length, 4)

  const treeCreatedAgain = await call('/obsidian-task-sync/api/tree/create', {
    root,
    name: 'C++',
  })
  assert.equal(treeCreatedAgain.status, 200)
  assert.equal(treeCreatedAgain.data.revision, treeCreated.data.revision)

  const treeListed = await call('/obsidian-task-sync/api/tree/list', { root })
  assert.deepEqual(treeListed.data.trees.map((tree) => tree.file), ['SkillTrees-C++.md'])

  const firstNode = treeCreated.data.nodes[0]
  const treeToggled = await call('/obsidian-task-sync/api/tree/toggle', {
    root,
    file: treeCreated.data.file,
    line: firstNode.line,
    raw: firstNode.raw,
    checked: true,
    revision: treeCreated.data.revision,
  })
  assert.equal(treeToggled.status, 200)
  assert.equal(treeToggled.data.earnedPoints, firstNode.points)
  assert.equal(treeToggled.data.nodes[0].checked, true)
  const treeContent = await readFile(path.join(workspaceRoot, treeToggled.data.file), 'utf8')
  assert.match(treeContent, /- \[x\] Smart Pointers · 2\n  - \[ \] RAII · 2/)
  assert.match(treeContent, /^# C\+\+ Skill Tree$/m)

  const treeStale = await call('/obsidian-task-sync/api/tree/toggle', {
    root,
    file: treeToggled.data.file,
    line: firstNode.line,
    raw: firstNode.raw,
    checked: false,
    revision: 'stale',
  })
  assert.equal(treeStale.status, 409)
  assert.equal(treeStale.data.error.code, 'stale')
  assert.equal(treeStale.data.document.revision, treeToggled.data.revision)

  const treeTraversal = await call('/obsidian-task-sync/api/tree/document', {
    root,
    file: '../SkillTrees-Evil.md',
  })
  assert.equal(treeTraversal.status, 400)

  const eventUrl = `${origin}/obsidian-task-sync/events?root=${encodeURIComponent(root)}&file=${encodeURIComponent(document.file)}&token=${encodeURIComponent(token)}`
  const streamResponse = await fetch(eventUrl)
  assert.equal(streamResponse.status, 200)
  const reader = streamResponse.body.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const readUntil = async (needle, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs
    while (!received.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; received ${received}`)
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('read timeout')), Math.max(50, deadline - Date.now()))),
      ])
      if (next.done) throw new Error('stream ended early')
      received += decoder.decode(next.value, { stream: true })
    }
  }
  await readUntil('event: document')
  assert.match(received, /event: hello/)
  received = ''
  await new Promise((resolve) => setTimeout(resolve, 300))

  await writeFile(path.join(workspaceRoot, document.file), '- [ ] External edit\n- [x] Another\n', 'utf8')
  await readUntil('"kind":"document"', 4_000)
  assert.match(received, /External edit/)

  await reader.cancel()
  await new Promise((resolve) => setTimeout(resolve, 200))

  // The same authenticated stream carries a skill tree document and reports
  // external markdown edits within the debounce window.
  const treeEventUrl = `${origin}/obsidian-task-sync/events?root=${encodeURIComponent(root)}&tree=${encodeURIComponent(treeToggled.data.file)}&token=${encodeURIComponent(token)}`
  const treeStream = await fetch(treeEventUrl)
  assert.equal(treeStream.status, 200)
  const treeReader = treeStream.body.getReader()
  let treeReceived = ''
  const readTreeUntil = async (needle, timeoutMs = 4_000) => {
    const deadline = Date.now() + timeoutMs
    while (!treeReceived.includes(needle)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${needle}; received ${treeReceived}`)
      }
      const next = await Promise.race([
        treeReader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('read timeout')), Math.max(50, deadline - Date.now())),
        ),
      ])
      if (next.done) throw new Error('tree stream ended early')
      treeReceived += decoder.decode(next.value, { stream: true })
    }
  }
  await readTreeUntil('event: tree')
  assert.match(treeReceived, /"kind":"tree"/)
  assert.match(treeReceived, /"totalPoints":65/)
  treeReceived = ''
  await new Promise((resolve) => setTimeout(resolve, 300))

  const treePath = path.join(workspaceRoot, treeToggled.data.file)
  const beforeExternal = await readFile(treePath, 'utf8')
  await writeFile(treePath, beforeExternal.replace('- [ ] RAII · 2', '- [x] RAII · 2'), 'utf8')
  await readTreeUntil('"earnedPoints":4')
  assert.match(treeReceived, /"checkedCount":2/)
  await treeReader.cancel()
  await new Promise((resolve) => setTimeout(resolve, 200))

  const badOrigin = await fetch(`${origin}/obsidian-task-sync/api/vault/check`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example',
      'x-obsidian-task-sync-token': token,
    },
    body: JSON.stringify({ root }),
  })
  assert.equal(badOrigin.status, 403)

  console.log('bridge integration test passed')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
