import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  appendTaskLinesToContent,
  appendTaskToContent,
  defaultTreeMarkdown,
  deleteTaskFromContent,
  fileNameFor,
  listChecklists,
  listSkillTrees,
  nextCalendarDate,
  parseChecklistFileName,
  parseSkillTree,
  parseTasks,
  parseTreeFileName,
  readDocument,
  readTreeDocument,
  removeTaskLinesFromContent,
  reorderTasksInContent,
  sanitizeTitle,
  toggleSkillTreeNodeInContent,
  toggleTaskInContent,
  treeFileNameFor,
} from '../src/host.js'

const sample = `---
tags:
  - daily
---

# 2026-11-09 · Work

Intro paragraph that must survive untouched.

- [ ] First task
- [x] Second task with **bold**
  - [ ] Nested task
  * [ ] Star bullet

## Afternoon

Some notes between sections.
- [X] Final task
Trailing note without a newline.`

test('parses standard Obsidian tasks with sections and nesting', () => {
  const tasks = parseTasks(sample)
  assert.equal(tasks.length, 5)
  assert.deepEqual(
    tasks.map((task) => [task.checked, task.text, task.section]),
    [
      [false, 'First task', '2026-11-09 · Work'],
      [true, 'Second task with **bold**', '2026-11-09 · Work'],
      [false, 'Nested task', '2026-11-09 · Work'],
      [false, 'Star bullet', '2026-11-09 · Work'],
      [true, 'Final task', 'Afternoon'],
    ],
  )
  assert.equal(tasks[2].indent, '  ')
})

test('ignores task-shaped lines inside fenced code blocks', () => {
  const fenced = `${sample}\n\n\`\`\`md\n- [ ] Example only\n\`\`\`\n`
  const tasks = parseTasks(fenced)
  assert.equal(tasks.length, 5)
  assert.ok(!tasks.some((task) => task.text === 'Example only'))
})

test('toggles exactly one checkbox and preserves every other byte', () => {
  const first = parseTasks(sample)[0]
  const next = toggleTaskInContent(sample, first.line, first.raw, true)
  assert.ok(next.includes('- [x] First task'))
  assert.ok(next.includes('- [ ] Nested task'))
  assert.ok(next.includes('Trailing note without a newline.'))
  assert.equal(next.replace('- [x] First task', '- [ ] First task'), sample)
})

test('unchecks an uppercase task without touching its text', () => {
  const final = parseTasks(sample).at(-1)
  const next = toggleTaskInContent(sample, final.line, final.raw, false)
  assert.ok(next.includes('- [ ] Final task'))
  assert.ok(next.includes('- [X] Second task') === false)
})

test('refuses a stale task line instead of clobbering it', () => {
  assert.throws(
    () => toggleTaskInContent(sample, 9, '- [ ] Different', true),
    /changed on disk|no longer|stale/i,
  )
})

test('appends after the last task and keeps trailing notes after it', () => {
  const next = appendTaskToContent(sample, 'New task')
  assert.ok(next.includes('- [X] Final task\n- [ ] New task\nTrailing note'))
})

test('appends to a file without tasks and without a final newline', () => {
  const next = appendTaskToContent('# Notes', 'One')
  assert.equal(next, '# Notes\n- [ ] One\n')
})

test('rollover appends task lines verbatim after the last task', () => {
  const tomorrow = '# 2026-11-10 · Daily\n\n- [ ] Existing\n\nTrailing note\n'
  const result = appendTaskLinesToContent(tomorrow, [
    '- [ ] First unfinished',
    '  - [ ] Nested unfinished',
    '* [ ] Star bullet',
  ])
  assert.equal(result.appended, 3)
  assert.equal(result.skipped, 0)
  assert.ok(
    result.content.includes(
      '- [ ] Existing\n- [ ] First unfinished\n  - [ ] Nested unfinished\n* [ ] Star bullet\n\nTrailing note\n',
    ),
  )
  assert.equal(parseTasks(result.content).length, 4)
})

test('rollover append deduplicates exact lines already in tomorrow', () => {
  const tomorrow = '- [ ] Existing\n'
  const result = appendTaskLinesToContent(tomorrow, ['- [ ] Existing', '- [ ] New'])
  assert.equal(result.appended, 1)
  assert.equal(result.skipped, 1)
  assert.equal(parseTasks(result.content).map((task) => task.text).join('|'), 'Existing|New')
})

test('rollover append preserves CRLF and creates a checklist from an empty file', () => {
  const crlf = '## Work\r\n\r\n- [ ] Existing\r\n'
  const result = appendTaskLinesToContent(crlf, ['- [ ] Nested item'])
  assert.ok(result.content.includes('- [ ] Existing\r\n- [ ] Nested item\r\n'))
  assert.equal(result.content.replaceAll('\r\n', '').includes('\r'), false)
  const created = appendTaskLinesToContent('# 2026-11-10 · Daily\n\n', ['- [ ] One'])
  assert.equal(created.content, '# 2026-11-10 · Daily\n\n- [ ] One\n')
})

test('rollover removal deletes only the requested task lines', () => {
  const next = removeTaskLinesFromContent(sample, [parseTasks(sample)[0].line, parseTasks(sample)[2].line])
  assert.ok(!next.includes('- [ ] First task'))
  assert.ok(!next.includes('- [ ] Nested task'))
  assert.ok(next.includes('- [x] Second task with **bold**'))
  assert.ok(next.includes('Some notes between sections.'))
  assert.ok(next.includes('Trailing note without a newline.'))
  assert.equal(next.replace(/\r/g, '').split('\n').length, sample.split('\n').length - 2)
})

test('nextCalendarDate advances across months, years and leap days', () => {
  assert.equal(nextCalendarDate('2026-11-09'), '2026-11-10')
  assert.equal(nextCalendarDate('2026-12-31'), '2027-01-01')
  assert.equal(nextCalendarDate('2028-02-28'), '2028-02-29')
  assert.equal(nextCalendarDate('2028-02-29'), '2028-03-01')
  assert.throws(() => nextCalendarDate('2026-02-30'), /real calendar date/i)
})

test('preserves CRLF when toggling and appending', () => {
  const crlf = sample.replaceAll('\n', '\r\n')
  const task = parseTasks(crlf)[0]
  const next = toggleTaskInContent(crlf, task.line, task.raw, true)
  assert.ok(next.includes('- [x] First task\r\n'))
  assert.ok(next.includes('Trailing note without a newline.'))
  assert.ok(next.includes('\r\n'))
  const appended = appendTaskToContent(crlf, 'CRLF task')
  assert.ok(appended.includes('- [X] Final task\r\n- [ ] CRLF task\r\nTrailing note'))
})

test('reorders only task rows, preserving non-task lines', () => {
  const tasks = parseTasks(sample)
  const order = [tasks[3].line, tasks[0].line, tasks[1].line, tasks[2].line, tasks[4].line]
  const next = reorderTasksInContent(sample, order)
  const reordered = parseTasks(next)
  assert.deepEqual(
    reordered.map((task) => task.text),
    ['Star bullet', 'First task', 'Second task with **bold**', 'Nested task', 'Final task'],
  )
  assert.ok(next.includes('Intro paragraph that must survive untouched.'))
  assert.ok(next.includes('Some notes between sections.'))
  assert.equal(next.replace(/\r/g, '').split('\n').length, sample.split('\n').length)
})

test('deletes exactly one task line', () => {
  const task = parseTasks(sample)[1]
  const next = deleteTaskFromContent(sample, task.line, task.raw)
  assert.ok(!next.includes('- [x] Second task'))
  assert.ok(next.includes('- [ ] First task'))
  assert.ok(next.includes('Trailing note without a newline.'))
})

test('validates the strict filename convention and sanitizes titles', () => {
  assert.deepEqual(parseChecklistFileName('2026-11-09-Checklist-Work.md'), {
    file: '2026-11-09-Checklist-Work.md',
    date: '2026-11-09',
    title: 'Work',
  })
  assert.equal(parseChecklistFileName('2026-11-09-notes.md'), null)
  assert.equal(parseChecklistFileName('2026-02-30-Checklist-Nope.md'), null)
  assert.equal(sanitizeTitle('Bad:/\\?* title...'), 'Bad title')
  assert.equal(fileNameFor('2026-11-09', 'Work'), '2026-11-09-Checklist-Work.md')
})

test('lists historical checklists and reads a document', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ots-test-'))
  try {
    await writeFile(path.join(root, '2026-11-08-Checklist-Yesterday.md'), '- [ ] Old\n')
    await writeFile(path.join(root, '2026-11-09-Checklist-Today.md'), sample)
    await writeFile(path.join(root, 'ignore.md'), 'nope')
    const files = await listChecklists(root)
    assert.deepEqual(
      files.map((file) => file.file),
      ['2026-11-09-Checklist-Today.md', '2026-11-08-Checklist-Yesterday.md'],
    )
    const document = await readDocument(root, '2026-11-09-Checklist-Today.md')
    assert.equal(document.totalCount, 5)
    assert.equal(document.checkedCount, 2)
    assert.equal(document.date, '2026-11-09')
    assert.equal(document.title, 'Today')
    assert.equal((await readFile(path.join(root, document.file), 'utf8')), sample)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parses the bundled C++ tree into four progressive lanes', () => {
  const markdown = defaultTreeMarkdown()
  const tree = parseSkillTree(markdown)
  assert.equal(tree.title, 'C++ Skill Tree')
  assert.deepEqual(
    tree.lanes.map((lane) => lane.title),
    ['Core Mechanics', 'Build & Tooling', 'Web & Backend', 'Data Science & ML'],
  )
  assert.equal(tree.nodes.length, 17)
  assert.equal(tree.totalPoints, 65)
  assert.equal(tree.earnedPoints, 0)
  assert.equal(tree.totalCount, 17)
  const core = tree.nodes.filter((node) => node.lane === 0)
  assert.deepEqual(
    core.map((node) => [node.title, node.depth, node.points]),
    [
      ['Smart Pointers', 0, 2],
      ['RAII', 1, 2],
      ['Move Semantics', 2, 3],
      ['Templates & Concepts', 3, 5],
      ['Multithreading', 4, 5],
      ['C++17 / C++20 / C++23', 5, 4],
    ],
  )
  assert.equal(core[1].parentId, core[0].id)
  assert.equal(core[5].parentId, core[4].id)
  assert.deepEqual(
    tree.lanes.map((lane) => [lane.count, lane.total]),
    [[6, 21], [4, 11], [3, 12], [4, 21]],
  )
})

test('parses point suffixes, defaults missing points, and ignores non-nodes', () => {
  const tree = parseSkillTree(
    '# Test Tree\n\n```md\n- [ ] Hidden · 9\n```\n\n- not a checklist item\n\n## Lane\n\n- [ ] Alpha · 7\n  - [ ] Beta | 4 pts\n  - [ ] Gamma\n',
  )
  assert.deepEqual(
    tree.nodes.map((node) => [node.title, node.points, node.depth]),
    [['Alpha', 7, 0], ['Beta', 4, 1], ['Gamma', 1, 1]],
  )
  assert.equal(tree.totalPoints, 12)
  assert.equal(tree.lanes[0].total, 12)
  assert.equal(tree.nodes[1].parentId, tree.nodes[0].id)
})

test('toggles exactly one skill node and preserves every other byte', () => {
  const markdown = defaultTreeMarkdown()
  const node = parseSkillTree(markdown).nodes.find(
    (entry) => entry.title === 'Templates & Concepts',
  )
  const next = toggleSkillTreeNodeInContent(markdown, node.line, node.raw, true)
  assert.ok(next.includes('- [x] Templates & Concepts · 5'))
  assert.ok(next.includes('- [ ] Multithreading · 5'))
  assert.equal(next.replace('- [x] Templates & Concepts', '- [ ] Templates & Concepts'), markdown)
  assert.equal(parseSkillTree(next).earnedPoints, 5)
  assert.equal(parseSkillTree(next).checkedCount, 1)
})

test('preserves CRLF when toggling a skill node', () => {
  const crlf = defaultTreeMarkdown().replaceAll('\n', '\r\n')
  const node = parseSkillTree(crlf).nodes[0]
  const next = toggleSkillTreeNodeInContent(crlf, node.line, node.raw, true)
  assert.ok(next.includes('- [x] Smart Pointers · 2\r\n'))
  assert.equal(next.replace('- [x] Smart Pointers', '- [ ] Smart Pointers'), crlf)
})

test('validates skill tree filenames and reads/lists trees securely', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ots-tree-test-'))
  try {
    assert.equal(treeFileNameFor('C++'), 'SkillTrees-C++.md')
    assert.equal(treeFileNameFor(''), 'SkillTrees-C++.md')
    assert.deepEqual(parseTreeFileName('SkillTrees-C++.md'), {
      file: 'SkillTrees-C++.md',
      name: 'C++',
    })
    assert.equal(parseTreeFileName('SkillTrees-.md'), null)
    assert.equal(parseTreeFileName('notes.md'), null)
    await writeFile(path.join(root, 'SkillTrees-C++.md'), defaultTreeMarkdown())
    await writeFile(path.join(root, 'SkillTrees-Rust.md'), '# Rust\n\n## Lane\n- [ ] Ownership · 3\n')
    await writeFile(path.join(root, '2026-11-09-Checklist-Daily.md'), '- [ ] Task\n')
    const trees = await listSkillTrees(root)
    assert.deepEqual(
      trees.map((tree) => tree.file),
      ['SkillTrees-C++.md', 'SkillTrees-Rust.md'],
    )
    const document = await readTreeDocument(root, 'SkillTrees-C++.md')
    assert.equal(document.totalPoints, 65)
    assert.equal(document.name, 'C++')
    assert.equal(document.title, 'C++ Skill Tree')
    assert.equal(document.lanes.length, 4)
    await assert.rejects(readTreeDocument(root, '../SkillTrees-Evil.md'), /must be named/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
