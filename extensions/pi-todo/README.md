# pi-todo

Dependency-aware, session-scoped tasks. Built on the pure atomic state engine from
[`@99percentpeople/pi-todo`](UPSTREAM.md), with explicit operations and UX matching
this bundle's subagents and system-insights extensions.

[Comparison and base-selection report](docs/comparison.md).

## Load

Included in the root bundle. For standalone development:

```bash
pi --no-extensions -e ./extensions/pi-todo/src/index.ts
```

Remove or disable `@juicesharp/rpiv-todo` before loading this extension: both own
`todo` and `/todos`. Nothing here changes your personal Pi settings automatically.
For an installed bundle, remove the old package and reload:

```bash
pi remove npm:@juicesharp/rpiv-todo
```

Old rpiv session snapshots are not imported. Finish existing work with rpiv or
recreate its plan explicitly. Valid snapshots from the selected upstream engine
remain readable; action schema differs, so update instructions referring to its
full-list writes or rpiv's numeric IDs/create/update actions.

## Agent tool

One tool, `todo`. All mutations are atomic and sequential. Every successful result
includes the revision and current plan. New keys require a subject; status defaults
to `pending`. Keys are stable lowercase ASCII identifiers, not display numbers.

```json
{
  "action": "upsert",
  "tasks": [
    { "key": "inspect", "subject": "Inspect implementation", "status": "in_progress" },
    { "key": "build", "subject": "Build change", "dependsOn": ["inspect"] },
    { "key": "verify", "subject": "Verify change", "dependsOn": ["build"] }
  ]
}
```

Sparse completion and handoff in one call:

```json
{
  "action": "upsert",
  "baseRevision": 1,
  "tasks": [
    { "key": "inspect", "status": "completed" },
    { "key": "build", "status": "in_progress" }
  ]
}
```

`verify` remains unchanged. Unlike upstream, omission during `upsert` never deletes.

Record an outcome with the status change that produced it:

```json
{
  "action": "upsert",
  "tasks": [
    {
      "key": "build",
      "status": "completed",
      "message": "Built; 2 deprecation warnings in auth/session.ts"
    },
    { "key": "verify", "status": "in_progress" }
  ]
}
```

`message` goes into the task's history, not its description. The user sees it
flagged until they review it; see [Messages and review](#messages-and-review).

| Action    | Arguments        | Behavior                                                                                 |
| --------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `list`    | optional `key`   | Read revision/plan; one key returns its full description                                 |
| `upsert`  | `tasks`          | Add/patch only named keys; inherit omitted fields                                        |
| `replace` | `tasks`          | Authoritative plan; omitted keys deleted; `[]` clears                                    |
| `remove`  | `keys`           | Delete named tasks; dangling live dependencies rejected                                  |
| `clear`   | optional `scope` | `all` (default) clears; `completed` removes only completed tasks not needed by open work |

`upsert` and `replace` tasks accept an optional `message`. A message-only patch
still advances the revision. Full-plan output shows each task's latest message as a
120-character `lastMessage`. `list` with `key` adds `createdAt` and the task's full
`updates` history.

Optional `baseRevision` rejects stale operations. Use it when user commands or
concurrent agents may have changed the plan. `description: ""` clears description;
`dependsOn: []` clears prerequisites. Replace may reorder tasks; upsert preserves
existing order and appends new tasks.

Dependencies must exist and be acyclic. A task cannot start or finish until every
prerequisite is completed. Reopening a prerequisite while its dependent is active
or completed is rejected unless the entire resulting plan is valid. Multiple
independent active tasks are permitted by default for parallel subagent work.

Safety limits: 50 tasks, 20 dependencies/task, 160-character subjects,
2,000-character descriptions and messages, 40-character keys, and the latest 10
history updates per task. Plan output abbreviates
descriptions and is bounded at 30,000 characters / 48 KB; `list` with `key` gives full task
details. Validation failures never mutate state.

## Commands

| Command                                                                               | Purpose                                                                          |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `/todos` or `/todos:list`                                                             | Searchable task list, dependency details and history                             |
| `/todos:review`                                                                       | Browser on unreviewed messages; outside TUI, prints them and marks them reviewed |
| `/todos:review all`                                                                   | Mark every unreviewed task reviewed                                              |
| `/todos:review fix-auth-bug`                                                          | Mark one or more space-separated keys reviewed                                   |
| `/todos:add Fix auth bug`                                                             | Add pending task with unique generated key; omit title for input dialog          |
| `/todos:update fix-auth-bug in_progress`                                              | Change status explicitly                                                         |
| `/todos:update fix-auth-bug completed Verified by hand`                               | Change status and record a note                                                  |
| `/todos:update fix-auth-bug {"dependsOn":["inspect"],"description":"Recheck expiry"}` | Sparse field patch; `message` also accepted                                      |
| `/todos:remove fix-auth-bug`                                                          | Remove one or more space-separated keys                                          |
| `/todos:clear completed`                                                              | Clear finished tasks while preserving prerequisites of open work                 |
| `/todos:clear`                                                                        | Clear all, with confirmation by default                                          |
| `/todos:clear all --yes`                                                              | Explicitly bypass confirmation                                                   |
| `/todos:settings`                                                                     | Built-in select/input settings menu, like subagents                              |

Commands never submit a user prompt, schedule a continuation, start subagents,
or mark unrelated work completed. On its next model request, the agent gets a
context-only snapshot of changed state by default. Clear confirmation rejects
stale revisions if tasks changed while the dialog was open, and cancels if the
session or branch changed. Non-UI clear-all
requires `--yes` unless confirmation is disabled. Model tool `clear` is already
explicit and does not open a dialog.

## Messages and review

In a long session with several tasks and subagents, an outcome reported in chat is
easy to lose: the next subagent result or tool burst scrolls it away. Messages attach
the outcome to its task, and review tracking keeps it flagged until you have seen it.

- **History:** each task keeps its latest 10 updates. An update records a status
  change, a message, or both, with its plan revision, time, and source.
  User-command updates are marked `you`.
- **Unreviewed:** a task is unreviewed when it has a model message newer than your
  last review of that task. Status changes without a message never flag a task,
  and neither do your own notes.
- **Reviewing:** opening a task's details in the browser marks it reviewed.
  Ctrl+R marks every unreviewed task in the current filtered list. `/todos:review`
  also marks tasks reviewed, with or without arguments. A review covers only the
  messages that were shown. A message that arrives while the browser is open stays
  unreviewed.
- **No model impact:** a review is a separate journal entry. It never changes the
  plan revision, model output, or context sync, so a pending model update with
  `baseRevision` stays valid. Nothing about review starts or steers a turn.

## Handing tasks to subagents

A parent can hand specific tasks to a subagent through pi-subagents' generic spawn
`handoff`, under the `todos` key that pi-todo owns:

```ts
subagent({
  subagent_type: "general-purpose",
  description: "Audit auth",
  prompt: "…",
  handoff: { todos: { keys: ["audit", "tests"], scope: "assigned" } },
});
```

- **Checked before the spawn.** pi-todo's `tool_call` handler blocks the `subagent`
  call, with a reason, when a key is unknown, already completed, or held by another
  subagent. A call that passes reserves its keys, so two spawns in one turn cannot
  take the same task. A malformed `handoff.todos` is blocked too.
- **Claimed before the child starts.** When pi-subagents reports the child session
  (`subagents:child:session-created`, with its agent id and the same tool call id), the
  parent journals a claim in `pi-personal:todo-claims`. Claims follow the branch like
  review marks; the plan state engine is unchanged.
- **The subagent works in your list.** Its `todo` tool, context snapshot and widget
  ("Assigned tasks") show only its tasks with `scope: "assigned"`, or your whole list
  with `scope: "ledger"`. Its writes go to your list through
  [`pi-session-tree`](../../packages/pi-session-tree/README.md) and are checked there:
  - It may change and message its own tasks, and remove or clear them once completed.
  - New tasks it adds join its claim.
  - With `ledger`, it may also add prerequisites (`dependsOn`, keeping the existing
    ones) to tasks it does not hold, for a blocker it found. Each addition leaves a
    flagged message on that task. Set `childPrerequisites: false` to turn this off.
  - Anything else on other tasks fails, as do `replace` and clearing everything.
  - `baseRevision` is checked against the tasks the write touches, so other
    subagents' writes elsewhere do not make it stale.
- **Attributed and flagged.** Updates record the subagent's agent id (`agent a3f2b1c4`
  in history), and its messages are flagged for review like any model message. Your
  widget and browser show `→ agent a3f2b1c4` on handed-over tasks; `pi-todo:snapshot`
  tasks carry `claimedBy`.
- **Released when the agent ends.** On `subagents:completed`, `failed`, `resumed` or
  `child:disposed`, the claim is released and tasks it left `in_progress` get a
  flagged message ("agent a3f2b1c4 ended (failed) with this task in progress"). A
  resume reclaims the agent's tasks that nobody else holds. Claims replayed at a later
  session start are released, since no subagent survives one.
- You can still edit any task yourself, handed over or not.
- A subagent working on handed-over tasks cannot hand them on to its own subagents
  yet; that `subagent` call is blocked. Without a handoff, a subagent keeps its own
  separate list as before.

## UI

Above-editor widget uses a static top rule with the Nerd Font tasks icon
(`nf-fa-tasks`, U+F0AE); use a patched Nerd Font, preferably its Mono variant.
Each task occupies one physical row, with identity left and lifecycle status
right. Body rows reserve one space on each side. Theme tokens match subagents. Active work appears
first, then ready tasks, blocked tasks, and completed tasks. Dependency keys stay
visible; overflow becomes `+N more`. Completed tasks remain in state until
explicitly cleared; hiding them affects display only.

```text
──   Todos ──────────────────────────────────────── 1/3 ──
▸ build Build change ← inspect                  in progress
○ verify Verify change ← build                     blocked
✓ inspect Inspect implementation                  completed
```

Unreviewed messages add `● N new` to the header. Their tasks move to the top, newest
first, and stay visible when completed tasks are hidden. Those rows get a `●`
marker and a dim message excerpt; other rows get a blank two-column gutter so
columns stay aligned. Narrow terminals drop the count before the progress.

```text
──   Todos ─────────────────────────────────────────── ● 1 new · 1/3 ──
 ● inspect: Inspect implementation — Auth in src/auth/token ✓ completed
   build: Build change ← inspect                          ▸ in_progress
   verify: Verify change ← build                              ○ blocked
```

Browser follows subagents/system-insights controls: type to filter, arrows select,
Enter details, Esc backs out/clears filter/closes, Ctrl+C closes. Tab and Shift+Tab
cycle three views: All (status order), Unreviewed (newest first), and Recent (all
tasks by last activity). The filter also matches message text. Details add
created, updated, and reviewed times, plus an activity timeline, newest first,
with unreviewed entries marked `●`. The note shows when you last reviewed and how
many tasks remain unreviewed. Fullscreen uses a
centered overlay; regular mode uses a bounded custom screen, not an overlay that
can contaminate scrollback. Task text is sanitized before terminal rendering.
Tool output is compact by default; expand it for task rows. Calls show how many
messages they carry, and results list each recorded message on its own row. RPC
gets plain-text widget output; task tools remain usable without terminal UI.

## Settings

Same layering as subagents: defaults → `<agentDir>/todos.json` →
`<cwd>/.pi/todos.json`. Agent directory honors `PI_CODING_AGENT_DIR` (normally
`~/.pi/agent`). `/todos:settings` writes only the changed project setting; global
settings are edited manually. Settings apply immediately. If persistence fails,
the change remains session-only with a warning. Invalid fields fall back to the
lower-priority layer; malformed files warn instead of preventing startup.

```json
{
  "widget": true,
  "maxVisible": 5,
  "showCompleted": true,
  "singleActive": false,
  "confirmClear": true,
  "contextSync": "changes",
  "childPrerequisites": true
}
```

- `maxVisible`: 1–12 task rows; short terminals further limit widget height.
- `showCompleted`: hides completed tasks in the widget, except ones with unreviewed messages.
- `singleActive`: reject mutations resulting in multiple active tasks. No implicit demotion.
- `contextSync`: `changes` supplies one current snapshot while retained model
  history lacks an untruncated direct tool result for that state. Transient snapshots
  remain on subsequent requests so user/nested-tool edits cannot disappear again.
  `off` disables sync. No periodic work reminders or forced turns. With sync off,
  explicitly call `list` after user changes or compaction.
- `childPrerequisites`: let a subagent holding a `ledger` claim add prerequisites to
  tasks it does not hold (see [Handing tasks to subagents](#handing-tasks-to-subagents)).

## Persistence and integration boundaries

Tasks live in the active session branch, never a shared project task file. Each
mutation journals an immutable snapshot, task history included, with `pi.appendEntry`, covering commands
and nested codemode tool calls whose result details Pi does not persist. Direct
tool results also carry snapshots. Local journals are authoritative, so a delayed
direct result cannot overwrite a newer command edit during replay. Older upstream
results remain a fallback before the first local checkpoint. Reload, resume, tree
navigation, and compaction restore the latest valid branch snapshot. Snapshots
journaled before history existed restore with empty history. Review marks are a
separate `pi-personal:todo-review` journal of per-task revision watermarks. Like
tasks, they follow the branch. Compaction checkpoints state without
sending steering messages or running the agent.

Subagent sessions keep their own lists unless tasks were handed to them, and then
they write only through the parent's checks. No task status is inferred from child
notifications: successful child exit is not proof that parent verification passed;
the only automatic effect of an agent ending is releasing its claim. No subagent
spawning or process-global task store. Matching
UX and explicit model control keep extensions composable and independently loadable.

Other extensions read tasks without coupling to the journal format: on session
start, branch changes, every plan change, and every review, pi-todo emits
`pi-todo:snapshot` on the session's `pi.events` bus (`src/events.ts`). The payload
is a fresh copy: `{ version: 1, revision, tasks }`, where each task adds `blocked`,
`createdAt`, its bounded `updates` history, an `unreviewed` message count, and
`claimedBy` (the subagent's agent id) when the task is handed over.
Each subagent has its own bus, so listeners see only their own session's tasks.
pi-dashboard uses it for its task counts.

## Develop

```bash
npm run check --workspace=pi-todo
npm run test --workspace=pi-todo
npm run verify:bundle
```

MIT upstream license retained in [LICENSE](LICENSE). See [UPSTREAM.md](UPSTREAM.md)
for pinned source and local adaptations.
