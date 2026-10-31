# Task messages and review tracking

## Problem

Long sessions run several tasks at once, often with subagents. When a task finishes,
the agent reports the outcome in chat, and the next event (another subagent
finishing, a tool burst, a compaction) pushes that report out of view. The plan only
records `completed`. Nothing marks that an outcome exists or that nobody has read it.
The user has to scroll back or ask again.

## Goals

- The model can attach a message to any task update. A completion summary,
  finding, failure, or handoff note goes in the same atomic `upsert`
  (or `replace`) that changes the status.
- Every task keeps a bounded history: status transitions and messages, each with
  its revision, time, and source.
- The extension records when the user reviewed each task. A model message stays
  flagged as unreviewed until the user views it or marks it reviewed.
- The widget stays above the editor, so it shows that unreviewed messages exist,
  plus the latest excerpt, until they are reviewed.
- A browser lists tasks with filtered views (unreviewed, recent activity) and full
  task details. Viewing a task marks it reviewed.

## Non-goals

- No change to the vendored upstream engine (`src/state.ts`). Its pure
  validation and replay stay byte-for-byte.
- No automatic task updates from subagent notifications. Outcomes are still
  recorded only by explicit model or user updates.
- No agent turn, steering message, or reminder triggered by unreviewed state.
- No new global keyboard shortcut. Common candidates collide with terminal and
  desktop bindings, and `/todos:review` covers the need.
- No project-wide or cross-session inbox. Review state follows the session branch,
  like tasks.

## Design

### Activity sidecar (`src/activity.ts`)

History lives beside the upstream snapshot, keyed by task key:

```ts
interface TodoUpdate {
  revision: number; // plan revision that recorded it; also the review watermark
  at: number; // epoch ms, display only
  status: TodoStatus; // status after the update
  from?: TodoStatus; // present when status changed
  message?: string; // trimmed; at most 2,000 characters
  by?: "user"; // user command; absent for model tool calls
}
interface TodoTaskActivity {
  createdAt?: number;
  updates: TodoUpdate[];
} // last 10 updates
```

`recordTodoActivity` runs after `applyTodoRequest` succeeds. It is pure, and it
adds an update when a task's status changes (or a new task starts non-pending) or
when its patch has a message. Removed tasks lose their history. A message-only
patch leaves the upstream snapshot unchanged, so the wrapper bumps the revision
itself and lists the key under `change.updated`. Without that bump, journaling
and optimistic concurrency would miss the change. Validation failures throw
before anything is journaled.

### Persistence

- The `pi-personal:todo-state` journal snapshot gains an `activity` object. The
  compaction checkpoint writes it too. Replay validates each entry and drops
  invalid parts: an entry for a missing task, a malformed update, or an oversized
  message. Journals written before this change replay with empty history.
- Review marks are a separate append-only journal,
  `pi-personal:todo-review`: `{ at, tasks: { [key]: revision } }`. Replay keeps
  the highest watermark per key and the latest review time. Watermarks are plan
  revisions, not clock times, so a message recorded in the same millisecond as a
  review can't be mistaken for reviewed. Revisions are branch-local, like the
  journal entries that hold them.
- Marking a task reviewed never changes plan revision or model context. The
  model's `baseRevision` stays valid while the user reads.

### Unreviewed rule

A task is unreviewed when it has a model-sourced update with a message whose
revision is above the task's review watermark. Status changes without a message,
and every user-sourced update, are never flagged. Routine completions stay quiet.
The model flags an outcome by writing a message.

### Model surface

- `tasks[].message` on `upsert` and `replace`, max 2,000 characters. Empty or
  whitespace-only messages are ignored.
- Full-plan output adds a `lastMessage` excerpt of 120 characters.
  `list(key)` adds `createdAt` and the full `updates` history with ISO times.
- Context sync snapshots remain key/status/dependency-only. Review state never
  reaches the model.
- Prompt guidance: attach a message when the user should see an outcome. Routine
  status changes need none.

### UI

- **Widget:** the header shows `● N new` before the progress count. Unreviewed
  tasks sort first, newest first, and stay visible when `showCompleted` is off.
  Their rows get a `●` gutter marker and a dim `— excerpt` after the identity.
  Other rows get a matching blank gutter so columns stay aligned. Body rows keep
  the one-space inset. Narrow widths drop the count before the progress.
- **Browser:** Tab/Shift+Tab cycles views: All (status order), Unreviewed (newest
  first), Recent (all tasks by last activity). Typed filters also search message
  text. Enter opens details and marks that task reviewed. Ctrl+R marks every
  unreviewed task in the current filtered list reviewed. Details add created,
  updated, and reviewed times, plus an activity timeline, newest first, with new
  entries marked. Review callbacks are ignored if the session or branch changed
  while the browser was open.
- **Tool rendering:** calls show the message count. Results list the messages
  recorded by that call, one inset row each.

### Commands

- `/todos:review`: opens the browser on Unreviewed in TUI. In other modes it
  prints the unreviewed messages and marks them reviewed.
- `/todos:review all` and `/todos:review <key>...` mark tasks reviewed without UI.
- `/todos:update <key> <status> [message…]` and a `message` field in JSON patches
  record user notes. User notes are never flagged unreviewed.

## Testing

- Activity unit tests: transitions, messages, revision bump, validation,
  trimming, pruning, removal, user source, unreviewed rule.
- Replay tests: activity and review restore, legacy journals, invalid parts,
  branch isolation.
- Extension tests: tool messages journaled, compaction checkpoint keeps history,
  review commands in every mode, context sync unaffected by review, revision
  guard unaffected by review.
- Rendering tests: header count and fallback, ordering, gutter alignment,
  completed-but-unreviewed visibility, widths 1–30 with ANSI, wide and combining
  Unicode, and hostile control sequences in messages.
- Browser tests: view cycling, marker column, Enter and Ctrl+R review callbacks,
  timeline details, bounded widths.
