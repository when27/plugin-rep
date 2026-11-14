# Obsidian task sync

A DeepSeek Harness plugin that turns an Obsidian checklist folder into a live,
interactive task app. A persistent sidebar button opens a floating, draggable
dark-mode widget with two views: a **daily checklist** and a video-game-style
**skill tree** canvas. Checking a box rewrites exactly that Markdown line, and
edits made in Obsidian flow back into the UI within a fraction of a second.

## What it does

- **Secure file access** — the React frontend has no `fs` access. Every read,
  write and watch request crosses a same-origin, token-authenticated Host bridge.
- **Bridge-aware startup** — the widget waits for the secure Host token before
  dispatching any filesystem read. The token arrives in the Harness boot payload
  (`webserver/index-inject`) and, for a page that loaded before the plugin was
  installed, through an authenticated same-origin bootstrap route. A short
  loading state covers Host activation instead of surfacing a token error.
- **Strict file convention** — managed checklists are
  `YYYY-MM-DD-Checklist-<Title>.md`; skill trees are `SkillTrees-<Name>.md`.
- **Exact-line Markdown writes** — toggling a task or a skill node replaces only
  the `[ ]` / `[x]` marker. Paragraphs, frontmatter, headings, indentation, CRLF
  line endings, trailing notes and unrelated formatting are preserved
  byte-for-byte.
- **Two-way live sync** — a debounced `fs.watch` stream on the active file pushes
  external edits (including agent edits) to the UI. A 6-second fallback poll
  keeps the widget converging if SSE is unavailable.
- **In-app floating widget** — the sidebar action toggles a borderless panel that
  is fixed above the Harness shell at a high z-index. Only its title bar is a
  drag handle; the body keeps normal pointer, click and focus behavior. The card
  opts out of the desktop caption drag region and its position is clamped below
  the Windows titlebar, on-screen and remembered in `localStorage`. The title
  bar also accepts arrow keys (Shift for larger steps), and the close button
  hides the widget. A **minimize** button collapses the card into a compact
  floating pill with the live completion ring and count; expanding restores the
  full checklist and skill-tree view. The collapsed state is remembered.
- **Slim view rail** — a 46px left rail switches between the daily checklist and
  the skill-tree canvas without unmounting either view, so scroll position,
  selection and live streams survive the switch. The card widens to 940px for the
  tree canvas and animates back to 434px for the checklist.
- **Modern task UI** — dark palette, progress ring, section headings, animated
  checkmarks and strike-through, drag-and-drop reordering, inline Markdown
  rendering, and a bottom task composer. Native `<select>` popups are replaced by
  a custom listbox that follows the palette, and every scrollbar, input and
  button shares one borderless visual language.
- **Skill tree canvas** — lanes are laid out left-to-right by Markdown nesting
  depth, connected by SVG bezier paths. Completed paths light up, available nodes
  pulse, locked nodes stay dim until their parent is checked. The canvas scrolls
  horizontally and vertically.
- **Points and ranks** — each node carries a point value. Earned points are
  recomputed on every change and the rank badge upgrades automatically:
  Novice → Proficient → Master → Software Engineer → Senior Engineer → Principal
  Engineer.
- **Daily rollover** — the widget defaults to today's checklist, offers a
  one-click create when it is missing, and automatically rolls over at local
  midnight. A dropdown and arrow controls navigate historical checklists. The
  **Rollover uncompleted** button moves every `- [ ]` task to the next calendar
  day in one step: it creates tomorrow's `YYYY-MM-DD-Checklist-<Title>.md` when
  needed, appends the exact task lines (indentation, bullets and inline
  markdown included), and removes them from the current file.
- **Focus timer** — a compact 60-minute session timer in the checklist header
  with Start, Pause and Reset. Click the time to edit it: `1:30` becomes one hour
  and thirty minutes, `90` becomes ninety minutes, and invalid text flashes red
  while restoring the previous duration. The last valid duration is remembered.
- **Progress ring and tag pills** — the date header carries a circular
  completion ring that fills as boxes are checked. Obsidian tags such as
  `#urgent`, `#coding` or `#project/alpha` render as tone-coded pills so long
  task lists scan quickly.
- **Conflict safety** — every mutation carries the document revision; a stale
  click receives a 409 with the fresh document instead of overwriting an
  external edit. Rollover is revision-checked too and writes tomorrow's file
  before today's, so a partial failure duplicates at worst and the retry
  de-duplicates exact lines.

## Why an in-app widget, not a pop-out window

The desktop client denies renderer-initiated windows. Its main window installs
`setWindowOpenHandler` and returns `{ action: 'deny' }` for every request (plain
`http(s)` destinations are handed to the system browser instead). The renderer
bridge exposed to plugins only covers desktop-owned features such as file save,
clipboard images, file drag, shortcuts, directory picking, updates, and locale;
there is no "create window" channel. A plugin manifest's `dsh.client` block
accepts `platform`, `immediately`, `inject`, and `external` only, so there is no
permission that could allow one either. `window.open()` therefore returns
`null`; the previous implementation showed an "Allow pop-ups" alert at that
point. It was the plugin's own alert, not a desktop dialog.

Rather than depend on a blocked primitive, the checklist renders through the
root `shell.overlay` slot into a portal on `document.body`. All file syncing,
Markdown parsing, and conflict handling still run in the main window against the
same authenticated Host bridge — no second window, `BroadcastChannel`, or token
relay is involved.

## Install

From this folder:

```sh
npm install
npm test
npm run build
npm pack
```

The last command produces `obsidian-task-sync-0.1.0.tgz`. Install that tarball as
a profile bundle with Plugin Manager, then enable **Obsidian task sync**. The
sidebar action appears beside Settings.

Requires DeepSeek Harness `^0.2.2-rc.1` for the Web GUI, React 18, and Node 20+.

## First run

Click the sidebar checklist button. The floating widget asks for the **absolute
path** of the Obsidian checklist folder, for example:

```text
C:\Users\you\Obsidian\Checklists
```

The path is validated by the Host and persisted in `localStorage`. The widget
then lists every matching checklist in that folder and opens today's file,
computing the local `YYYY-MM-DD` date at startup. If today has no checklist, the
empty state offers **Create today's checklist** with an editable title.

## Daily workflow

1. Open the widget. Today's checklist loads automatically. Use the dropdown or
   the arrow buttons for any other day.
2. Add tasks with the composer. If a task contains an Obsidian tag such as
   `#urgent`, it appears as a pill in the list.
3. Start the focus timer when you begin working. Click the clock text to change
   the session length; Start, Pause and Reset stay next to it.
4. At the end of the day press **Rollover uncompleted**. Every unchecked task is
   copied verbatim to the next calendar day's checklist and removed from today's
   file. Tomorrow's file is created if necessary, using the current checklist's
   title (an existing file for that date wins, preferring `Daily`). If no tasks
   are left, the button is disabled.

The completion ring, percentage bar and count all follow the checkbox state,
including changes made in Obsidian. Press **minimize** in the title bar to leave
the widget floating as a compact pill instead of closing it.

## Markdown format

Supported task lines:

```md
- [ ] Incomplete task
- [x] Completed task
  - [ ] Nested task
* [x] Alternative bullet
```

The parser also understands headings, so tasks are grouped under their current
section in the UI. Reordering swaps only the existing task lines and keeps every
non-task line in place.

## Skill trees

Open the second view from the left rail. On first use the plugin writes the
bundled modern C++ tree to `SkillTrees-C++.md` in the same folder (once per
folder; deleting the note on purpose is remembered). Any other
`SkillTrees-<Name>.md` file in the folder appears in the tree picker.

```md
# C++ Skill Tree

## Core Mechanics

- [ ] Smart Pointers · 2
  - [ ] RAII · 2
    - [ ] Move Semantics · 3
      - [ ] Templates & Concepts · 5
        - [ ] Multithreading · 5
          - [ ] C++17 / C++20 / C++23 · 4
```

- A level-2 heading starts a lane (branch).
- A checklist line is a node; its indentation depth becomes its column, and its
  parent is the nearest less-indented node above it.
- The number after the middle dot (`·` or `|`) is the node's point value. Without
  one, a node is worth 1 point.
- `[ ]` / `[x]` stay ordinary Obsidian checkboxes, so the note remains readable
  and editable in Obsidian. Toggling in either place updates the other.
- A node is **locked** in the UI until its parent is checked; checking a locked
  node shows a hint instead of writing a partial path. Existing markdown state
  always wins, so an out-of-order edit in Obsidian still renders and scores.

The bundled tree totals 65 points: Core Mechanics 21, Build & Tooling 11, Web &
Backend 12, Data Science & ML 21. Rank thresholds are 0 / 10 / 25 / 40 / 50 / 60
points for Novice, Proficient, Master, Software Engineer, Senior Engineer and
Principal Engineer.

## Security model

- All API routes live under `/obsidian-task-sync` on the Harness Web server.
- A per-process random token is exposed through the structured
  `webserver/index-inject` boot row, which both the HTTP index renderer and the
  desktop static boot payload consume. Every JSON call and SSE stream requires
  it.
- A page that loaded before the plugin was installed obtains the same token from
  `GET /obsidian-task-sync/bootstrap`. That route has no token of its own but
  asks the Harness Connection service to admit the request against its signed
  browser session before returning anything, so it is not a public token
  endpoint.
- The bridge uses a raw HTTP handler, because Web `resource` routes only accept
  GET/HEAD; POST is therefore accepted only by this plugin's handler.
- Cross-origin `Origin` and `Sec-Fetch-Site: cross-site` requests are refused.
- APIs accept only a vault root plus a basename matching one of the two strict
  file conventions; arbitrary path traversal is rejected.
- Writes are atomic (temp file + rename) and bounded by size limits.
- The floating widget is part of the authenticated Harness page and talks to the
  same-origin bridge directly. It never opens another browsing context, so the
  bridge token stays in the one document that already received it.

## Development

```text
src/host.js       Host bridge, checklist + skill-tree parsers, watcher, SSE
src/client.tsx    React UI, sidebar toggle, draggable overlay, tree canvas, bridge client
tests/            Node tests for parsing, exact-line writes, tree layout, and bundle loading
scripts/build.mjs TypeScript transpile + Harness client-module wrapper
```

`npm test` runs the backend test file directly with Node's test harness. The
build intentionally uses `transpileModule`: the client module has no Harness
Client package imports beyond React and React DOM. `tests/client-smoke.mjs`
server-renders the skill-tree canvas from the real bundled tree and the focus
timer at its default state, so layout and markup regressions fail without a
browser. It also exercises the focus-duration parser and the tag pill renderer.
The bridge suite performs a real HTTP rollover, including the stale-revision
409 and the append-to-existing-tomorrow path.

## Notes and limits

- The folder must already exist; the plugin never creates the vault itself.
- Drag-and-drop uses the browser's native HTML5 drag events.
- On the Windows desktop shell, the native 40px caption strip is a window-drag
  region above the page. The widget is clamped below it and sets
  `-webkit-app-region: no-drag` so it stays interactive even when it overlaps.
- File edits are reported by directory watch. On filesystems where `fs.watch`
  is unavailable, the UI labels itself **Polling** and keeps refreshing.
- Rename a file in Obsidian to change its display title; the UI does not rename
  files.
- The widget is intentionally non-modal: it does not trap focus or dim the
  Harness UI, so you can keep working while it stays open. Its last position is
  remembered; clearing site data returns it to the top-right corner.
