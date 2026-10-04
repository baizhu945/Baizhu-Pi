# @tintinweb/pi-tasks

A [pi](https://pi.dev) extension that brings **Claude Code-style task tracking and coordination** to pi. Track multi-step work with structured tasks, dependency management, and a persistent visual widget.

> **Status:** Early release.

<img width="600" alt="pi-tasks screenshot" src="https://github.com/tintinweb/pi-tasks/raw/master/media/screenshot.png" />

https://github.com/user-attachments/assets/1d0ee87a-e0a5-4bfa-a9b9-2f9144cb905b



## Features

- **4 LLM-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate` — for task tracking and coordination
- **Persistent widget** — live task list above the editor with `✔`/`◼`/`◻` status marks, task numbers (`#1`, `#2`, …), strikethrough for completed tasks, star spinner (`✳✽`) for active tasks with elapsed time and token counts. Every glyph is [configurable](CUSTOMIZING.md#task-glyphs)
- **System-reminder injection** — periodic `<system-reminder>` nudges injected into the upcoming LLM request (via the `context` hook, transient and never persisted) when task tools haven't been used recently, or when a task is left stuck `in_progress` after a text-only turn. Shaped after Claude Code's todo reminders — an empty-list nudge or a JSON echo of the current list (capped at 10 tasks)
- **Prompt guidelines** — workflow contract encoded in tool descriptions, nudging the LLM at the point of tool use
- **Dependency management** — bidirectional `blocks`/`blockedBy` relationships with warnings for cycles, self-deps, and dangling references
- **Shared task lists** — multiple pi sessions can share a file-backed task list for agent team coordination
- **File locking** — concurrent access is safe when multiple sessions share a task list

The local build tracks work only. The main agent or another extension performs the work and updates task status explicitly. Existing task data and metadata are preserved.

## Install

```bash
pi install npm:@tintinweb/pi-tasks
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## Widget

The extension renders a persistent widget above the editor:

```
● 4 tasks (1 done, 1 in progress, 2 open)
  ✔ #1 Design the flux capacitor
  ✳ #2 Acquiring plutonium… (2m 49s · ↑ 4.1k ↓ 1.2k)
  ◻ #3 Install flux capacitor in DeLorean › blocked by #1
  ◻ #4 Test time travel at 88 mph › blocked by #2, #3
```

| Glyph | Meaning |
|------|---------|
| `✔` | Completed (strikethrough + dim) |
| `◼` | In-progress (not actively executing) |
| `◻` | Pending |
| `✳`/`✽` | Animated star spinner — actively executing task (shows `activeForm` text, elapsed time, token counts) |

### Widget display settings

How tasks are sorted and how many are shown can be configured via `/tasks` → Settings (saved as project overrides in `.pi/tasks-config.json`), except `glyphs`, which is set in the config file directly. All defaults preserve the original behaviour.

> **[→ Customizing the task widget](CUSTOMIZING.md)** — the full guide: global vs. project config, sort presets, writing your own sort order, and recipes.

| Setting | Values | Default | Behaviour |
|---------|--------|---------|-----------|
| `sortOrder` | `id` / `status` / `active` / `recent` / `oldest`, or a [sort spec](CUSTOMIZING.md#writing-your-own-sort-order) | `id` | `id` = creation order; `status` groups completed → in-progress → pending; `active` is the reverse grouping (in-progress → pending → completed); `recent`/`oldest` = by last-updated time |
| `collapseCompleted` | `true` / `false` | `false` | When `true`, completed tasks are replaced by a single `✔ N completed` line at the bottom |
| `maxVisible` | `5`–`100` | `10` | Caps how many task lines the widget shows (ignored when `showAll` is on) |
| `showAll` | `true` / `false` | `false` | When `true`, every listed task is shown regardless of `maxVisible` |
| `hiddenAt` | `bottom` / `top` | `bottom` | When the list overflows `maxVisible`, where the `… and N more` collapse happens. `top` pairs well with `sortOrder: status` to keep active work visible and fold completed tasks away |
| `glyphs` | a [glyph set](CUSTOMIZING.md#task-glyphs) | `✔` / `◼` / `◻` + star spinner | Every character the widget is drawn with — status marks, spinner frames, header bullet, overflow and truncation markers, token arrows. Config file only |

> Note: the widget's `status` order is completed-first (so finished work collapses at the top with `hiddenAt: top`), which is the reverse of the `TaskList` tool's pending-first order. Use `active` for pending-first.

`collapseCompleted` and the visible limit are independent: collapsing decides what goes in the list, and `maxVisible` / `showAll` / `hiddenAt` then apply to whatever remains.

For an order the presets don't cover, `sortOrder` also accepts a **sort spec** — an ordered list of comparison keys, written into `tasks-config.json`:

```json
{
  "sortOrder": [
    { "field": "status", "rank": ["in_progress", "pending", "completed"] },
    { "field": "id" }
  ]
}
```

See [Writing your own sort order](CUSTOMIZING.md#writing-your-own-sort-order) for the full key reference and recipes.

> Configuration is data, never code. There is deliberately no executable config file, so nothing in a cloned repository's `.pi/` can run on your machine.

## Tools

### `TaskCreate`

Create a structured task. Used proactively for complex multi-step work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | string | yes | Brief imperative title |
| `description` | string | yes | Detailed context and acceptance criteria |
| `activeForm` | string | no | Present continuous form for spinner (e.g., "Running tests") |
| `metadata` | object | no | Arbitrary key-value pairs |

```
→ Task #1 created successfully: Fix authentication bug
```

### `TaskList`

List all tasks with status, owner, and blocked-by info.

```
#1 [pending] Fix authentication bug
#2 [in_progress] Write unit tests (agent-1)
#3 [pending] Update docs [blocked by #1, #2]
```

Sort order: pending first, then in-progress, then completed (each group by ID).

### `TaskGet`

Get full details for a specific task.

```
Task #2: Write unit tests
Status: in_progress
Owner: agent-1
Description: Add tests for the auth module
Blocked by: #1
Blocks: #3
```

Shows owner (if set) and open (non-completed) dependency edges. Non-empty metadata is displayed as JSON.

### `TaskUpdate`

Update task fields, status, metadata, and dependencies.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task ID (required) |
| `status` | `pending` / `in_progress` / `completed` / `deleted` | New status |
| `subject` | string | New title |
| `description` | string | New description |
| `activeForm` | string | Spinner text |
| `owner` | string | Agent name |
| `metadata` | object | Shallow merge (null values delete keys) |
| `addBlocks` | string[] | Task IDs this task blocks |
| `addBlockedBy` | string[] | Task IDs that block this task |

```
→ Updated task #1 status
→ Updated task #2 owner, status
→ Updated task #3 blocks
→ Updated task #3 blocks (warning: cycle: #3 and #1 block each other)
→ Updated task #1 deleted
```

Setting `status: "deleted"` permanently removes the task.

Dependencies are bidirectional: `addBlocks: ["3"]` on task 1 also adds `blockedBy: ["1"]` to task 3.

## Task Lifecycle

```
pending → in_progress → completed
                      → deleted (permanently removed)
```

Tasks are created as `pending`. Mark `in_progress` before starting work, `completed` when done. `deleted` removes entirely — IDs never reset.

## Dependency Management

- **Bidirectional edges:** `addBlocks`/`addBlockedBy` maintain both sides automatically
- **Dependency warnings:** cycles, self-dependencies, and references to non-existent tasks are stored but produce warnings in the tool response
- **Display-time filtering:** `TaskList` only shows non-completed blockers in `[blocked by ...]`
- **Raw data preserved:** `TaskGet` shows ALL edges, including completed blockers
- **Cleanup on deletion:** removing a task cleans up all edges pointing to it

## Task Storage

Task storage is controlled by the `taskScope` setting (`/tasks` → Settings → Task storage):

| Mode | File | Behaviour |
|------|------|-----------|
| `memory` | *(none)* | In-memory only — tasks lost when session ends |
| `session` **(default)** | `<workspace>/.pi/tasks/tasks-<sessionId>.json` | Per-session file — isolated between sessions, survives resume |
| `session-global` | `<agent-dir>/tasks/sessions/<project-key>/tasks-<sessionId>.json` | The same, kept outside the workspace so repositories stay clean |
| `project` | `<workspace>/.pi/tasks/tasks.json` | Shared across all sessions in the project |

`<workspace>` is the directory pi reports for the session — the same one its file tools operate in. That is normally where you started pi; it differs only when a session is opened by an explicit path from another project, or when a host serves sessions from elsewhere.

`session-global` exists because a per-session file keyed by a session ID is runtime state, not project content: it means nothing to anyone else who clones the repository, and it costs a `.gitignore` rule per project. `<agent-dir>` is `~/.pi/agent` unless pi is configured otherwise, the same directory the [global settings](#global-defaults) live in. `<project-key>` encodes the workspace path the way pi encodes it for its own session logs (`/Users/me/work/repo` → `--Users-me-work-repo--`), so a project's task files sit under the same name as its transcripts and same-ID sessions in different workspaces cannot collide.

Under either session scope, tasks stay in memory whenever pi is not persisting the session (`pi --no-session`) — there is no session for the file to belong to, so none is written. `project` scope still writes its shared list, since that belongs to the project rather than the session.

Switching to `session-global` never moves or deletes anything. It changes where *new* session files are created; a session that already has a file in `<workspace>/.pi/tasks/` keeps using it, so resuming that session still finds its tasks and switching back to `session` strands nothing. To empty an existing `.pi/tasks/`, clear those sessions' tasks as usual — the file is removed once its list is empty.

Picking `session-global` from `/tasks` → Settings saves it as a *project* override in `<workspace>/.pi/tasks-config.json`, so that repository still gets a `.pi/` — holding config rather than task data. To apply it everywhere and leave repositories alone, set it once as a [global default](#global-defaults) instead:

```json
{
  "taskScope": "session-global"
}
```

On new session start, if all persisted tasks are completed they are auto-cleared for a clean slate. On session resume, all tasks (including completed) are shown so the user can review progress. Empty session files are automatically deleted when all tasks are cleared.

### Auto-clear completed tasks

The `autoClearCompleted` setting controls automatic cleanup of completed tasks:

| Mode | Behaviour |
|------|-----------|
| `never` | Completed tasks stay visible until manually cleared via `/tasks` → Clear completed |
| `on_list_complete` **(default)** | Cleared once all tasks are done and a few idle turns pass |
| `on_task_complete` | Each completed task cleared individually after a few turns |

Both auto-clear modes use a turn-based delay for non-jarring UX — tasks linger briefly so you see the completion before they disappear.

In either mode, a list with nothing left to do is also retired when a *later* batch of work begins, however long it has been sitting there. The turn delay only runs while the conversation does, so a list completed just before the agent stopped would otherwise still be on screen when the next task arrived, and that task would join it. The finished list stays visible while you read it and through any follow-up question, and goes when the agent starts new work. Tasks the agent adds to a list it is still working through are unaffected, and task IDs stay monotonic and are never reused.

Settings (`taskScope`, `autoClearCompleted`, plus the [widget display settings](#widget-display-settings) `sortOrder` / `collapseCompleted` / `maxVisible` / `showAll` / `hiddenAt`) changed through `/tasks` are saved as project overrides in `<workspace>/.pi/tasks-config.json`. `glyphs` is config-file only — see [CUSTOMIZING.md](CUSTOMIZING.md#task-glyphs).

### Global defaults

Put settings that should apply across projects in `<agent-dir>/tasks-config.json` (`~/.pi/agent/tasks-config.json` by default). The agent directory follows pi's configured agent path. Project settings in `<workspace>/.pi/tasks-config.json` take precedence key by key.

For example, collapse completed tasks by default for every project:

```json
{
  "collapseCompleted": true
}
```

The `/tasks` settings menu writes only project overrides. Changing another setting in a project does not copy global defaults into that project's config.

See [Customizing the task widget](CUSTOMIZING.md#where-config-lives) for worked examples of how the two files merge.

### Override via environment variables

| Variable | Value | Behaviour |
|----------|-------|-----------|
| `PI_TASKS` | `off` | In-memory only (CI/automation) |
| `PI_TASKS` | `sprint-1` | Named shared list at `~/.pi/tasks/sprint-1.json` |
| `PI_TASKS` | `/abs/path/tasks.json` | Explicit absolute file path |
| `PI_TASKS` | `./tasks.json` | Relative path resolved from the session workspace |
| *(unset)* | | Uses `taskScope` setting (default: `session`) |

Named and explicit paths use a file-locked store with stale-lock detection — safe for multiple pi sessions coordinating on the same task list.

**CI example** (`.envrc`):
```bash
export PI_TASKS=off
```

**Shared team list** (`.envrc`):
```bash
export PI_TASKS=my-project
```

## `/tasks` Command

Interactive menu:

```
Tasks
├─ View all tasks (4)
├─ Create task
├─ Clear completed (1)
├─ Clear all (4)
└─ Settings
```

- **View all tasks** — select a task to see details and take actions (start, complete, delete)
- **Create task** — input prompts for subject and description
- **Clear completed** — remove all completed tasks
- **Clear all** — remove all tasks regardless of status
- **Settings** — configure project overrides for task storage, auto-clear completed tasks, and [widget display](#widget-display-settings) (sort order, max visible, show all, hidden position)

## Architecture

```
src/
├── index.ts            # Extension entry: 4 task tools + /tasks command + widget
├── types.ts            # Task and TaskStatus types
├── task-store.ts       # File-backed store with CRUD, dependencies, locking
├── auto-clear.ts       # Turn-based auto-clearing of completed tasks (AutoClearManager)
├── tasks-config.ts     # Global defaults and project override persistence
├── task-paths.ts       # Where session task files live, per taskScope
├── task-glyphs.ts      # Glyph defaults and config validation
├── task-sort.ts        # Widget ordering: sort presets and sort specs
├── reminder-cadence.ts # Pure cadence logic for system-reminder injection
└── ui/
    ├── task-widget.ts  # Persistent widget with status glyphs and spinner
    └── settings-menu.ts  # /tasks → Settings panel (SettingsList TUI component)
```

## Development

```bash
npm install
npm run typecheck   # TypeScript validation
npm test            # Run unit tests
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
