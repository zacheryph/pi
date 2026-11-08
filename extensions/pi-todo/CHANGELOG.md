# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## 2026-11-08: One test harness for index and delegation tests

- `test/harness.ts`: the fake-`pi` harness `index.test.ts` defined, built on
  `packages/pi-test-helpers`' `fakePi`, now also serves `delegation.test.ts`,
  which had its own copy; it takes a real event bus for the delegation tests. No
  source change.

## 2026-11-08: Widget render test uses plainTheme

- `index.test.ts` renders the inline widget with `packages/pi-test-helpers`'
  `plainTheme`, the last identity theme stub in the suite. No source change.

## 2026-11-08: Global test slots from pi-test-helpers

- `delegation.test.ts` resets pi-session-tree with `packages/pi-test-helpers`'
  `resetSessionTree`, and `index.test.ts` sets the inline-window slot with
  `withSlot`. No source change.

## 2026-11-08: Test themes from pi-test-helpers

- Theme stubs and SGR stripping in `index`, `ui` and `browser` tests come from
  `packages/pi-test-helpers` (`plainTheme`, `ansiTheme`, `stripAnsi`). No source
  change.

## 2026-11-08: Layered settings fixture from pi-test-helpers

- `test/config.test.ts` lays out its agent directory and project with
  `packages/pi-test-helpers`' `settingsDirs`. No source change.

## 2026-11-08: Test temp directories from pi-test-helpers

- `test/config.test.ts` creates its directory with `packages/pi-test-helpers`'
  `tempDir`, removed when the test ends. No source change.

## 2026-11-06: Supply tools required by todo handoffs

- `src/delegation.ts`: request only `todo_list` and `todo_upsert` through
  pi-subagent's pre-creation hook for valid `handoff.todo` payloads. Restricted
  workers can now read and update their claims without broadening repository
  capabilities or admitting destructive todo tools. No handoff adds no tools.
- Cover valid, absent, malformed, and unsupported onward handoffs; real SDK
  coverage in pi-subagent verifies restricted profiles and scoped parent writes.

## 2026-11-04: Expanded tool results list only changed tasks

- `src/index.ts`: an expanded todo tool result shows its summary and one inset
  row per task the call added, updated or removed, instead of the whole task
  list rendered as a widget. Each upsert no longer repeats the widget's heading
  and list in the transcript; the docked widget is the one full view.

## 2026-11-01: One tool per action and resource-scoped identifiers (#57)

- `src/index.ts`: one sequential tool per action (`todo_list`, `todo_upsert`,
  `todo_replace`, `todo_remove`, `todo_clear`) instead of a single
  action-dispatched `todo` tool, each with its own schema and annotations.
- `src/state.ts` (upstream file): `TODO_TOOL_NAME` became the `TODO_TOOL_NAMES`
  set, so replay and checkpoint detection read results of every todo tool, and
  the state entry type `pi-todo-state` became `todo:state`.
- `src/replay.ts`: review entries are `todo:review` (was
  `pi-personal:todo-review`); results of the todo tools remain a fallback until a
  branch has a local checkpoint.
- `src/claims.ts`, `src/delegation.ts`: the subagent handoff key is
  `handoff.todo` (was `handoff.todos`), and claims are journaled in `todo:claim`
  entries (was `pi-personal:todo-claims`). A claimed subagent's todo tool calls
  route to its claim.

## 2026-10-31: Shared pi-ui (#50)

- `src/ui/`: compact widget and browser built on this repository's shared
  `packages/pi-ui` library (`renderWidget`, `showExplorer`, sanitizers), replacing
  helpers adapted locally from the subagents/system-insights conventions. The
  extension keeps task selection/ordering, status mapping, detail content and
  review callbacks; layout, framing, input and sanitization come from pi-ui.

## 2026-10-31: Shared Oxc tooling (#42)

- Source, tests, and documentation follow the bundle's Oxc formatting and lint
  rules, including `src/state.ts`, which is no longer byte-for-byte with
  upstream.

## 2026-10-31: Task handoff to subagents (#40)

- `src/claims.ts`, `src/delegation.ts`: task handoff to subagents through
  pi-subagents' `handoff.todos`. A `tool_call` veto and reservation, claims
  journaled in `pi-personal:todo-claims` (claim/release, branch-scoped, beside the
  engine), release on agent end, and a broker offered through
  `packages/pi-session-tree`. A subagent with a claim routes its `todo` calls to
  it, scoped to its claim or the whole ledger. Updates carry an optional `agent`
  attribution in history.

## 2026-10-29: Snapshots on `pi.events` (#23)

- `src/events.ts`: read-only `todo:snapshot` emission on the session's
  `pi.events` bus after start, branch changes, plan changes, and reviews, for
  other extensions such as pi-dashboard.

## 2026-10-29: Task messages, update history, and review tracking (#7)

- `src/activity.ts`: per-task status/message history and user review watermarks,
  kept as a sidecar beside upstream snapshots so `src/state.ts` stays unchanged.
  Message-only patches advance the revision here. See
  [plan 0001](docs/plans/0001-task-messages-and-review.md).
- `src/replay.ts`: journal `activity` restores leniently, and
  `pi-personal:todo-review` entries restore review watermarks.
- `src/commands.ts`: adds the review command.

## 2026-10-22: Local extension around the upstream engine

Upstream provides stable-key snapshots, optional revision checks, immutable state,
cycle/missing-dependency validation, readiness enforcement, completed-task pruning,
and validated branch replay. We wrap that engine rather than rebuilding graph
validation. Explicit `clear completed` invokes its pruning helper; no automatic
cleanup runs.

Upstream extension entry/settings/UI are replaced locally:

- `src/actions.ts`: explicit list/upsert/replace/remove/clear operations. Upsert
  preserves omitted keys and defaults new tasks to pending. Optional single-active
  policy never demotes another task implicitly.
- `src/index.ts`: sequential tool, durable custom-entry journal for nested tools
  and user commands, branch restoration, context-only current-state sync while
  model history lacks a current full result, independent rendering lifecycle.
  No forced continuation or steering messages.
- `src/replay.ts`: validated local journal entries take precedence over
  potentially delayed direct results. Upstream snapshots remain a fallback until
  a branch has a local checkpoint; pure engine remains unchanged.
- `src/commands.ts`: browser/add/update/remove/clear/settings commands; revision
  and session/branch-generation guards around asynchronous dialogs; no prompt
  submission.
- `src/config.ts`: independent global/project layered settings, no shared-settings
  package dependency. Project writes preserve unrelated settings fields.
- `src/ui/`: compact widget and browser locally adapted from this repository's
  subagents/system-insights conventions. Helpers stay local so standalone loading
  does not depend on another extension's internal modules.
- `test/`: local regression tests for validation, additive operations, persistence,
  lifecycle/context behavior, commands/settings, and terminal rendering.

The upstream tool accepts an authoritative full list and deletes omitted keys.
Our tool requires an explicit action and only `replace` has those semantics. Agent
instructions using upstream's old schema need updating. No rpiv schema migration
or modifications to personal package installation settings are performed.

## 2026-10-08: Vendored

Imported from upstream; see [UPSTREAM.md](UPSTREAM.md).
