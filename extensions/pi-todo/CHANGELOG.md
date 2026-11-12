# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## 2026-11-11: Standardize source and test aliases

- Use `#src/*`, `#test/*` and shared workspace aliases, including the
  pi-test-helpers barrel. Resolve aliases through package manifests instead of
  duplicate TypeScript paths.

## 2026-11-12: Claims survive a reload or restart of the parent

pi-subagent keeps agents across a reload or restart and reopens those that wait on work, but every
session start released the claims it replayed ("no subagent survives one"). A worker waiting on CI
lost its tasks at a `/reload`: the parent's task read "ended (session ended)", and the worker's
later updates went to a private list, because it was reopened before the parent's broker existed.

- `src/delegation.ts`: `start(claims, keep)` keeps the replayed claims at a `startup`, `resume` or
  `reload` start. New `reconcile()`, run at `resources_discover` (the first `before_agent_start` is
  the fallback), releases the claims whose agent has no live child session by then, with the
  outcome "interrupted by a restart", and remembers them so `subagent:resuming` gives the tasks
  back. A `fork` start and `/tree` release at once, as before.
- `subagent:session:disposed` with `kept: true` (the session went with the parent's shutdown)
  releases nothing.
- A child looks its claim up again while it has none (`resolveDelegated`), instead of once at its
  own `session_start`.
- README: the release rule names the real event and a new bullet describes what a reload keeps.
- Tests: kept and released claims across a restart, the first-run fallback, a fork, the `kept`
  event; pi-subagent's `restore-sdk.test.ts` covers it on real sessions.

## 2026-11-12: Share plain-data helpers through pi-foundations

- Reuse the shared record guard and error text. Reject arrays in persisted task/state records, including arrays with task-like properties.

## 2026-11-12: Centralize browser fallback in pi-ui

- Centralize browser availability in pi-ui; preserve non-TUI review journaling and branch guards.

## 2026-11-12: Settings declared with defineSettings

Issue #128. `src/config.ts` declares `todoSettings` with pi-foundations' `defineSettings`
instead of hand-written validation.

- `TodoConfig` is now `SettingsOf<typeof todoSettings>`. `DEFAULT_CONFIG`, `CONFIG_FILE`,
  `sanitizeConfig`, `loadTodoConfig` and `saveTodoConfig` are gone; use
  `todoSettings.defaults()`, `.load(cwd, agentDir?)` and `.save(cwd, patch)`.
- Same keys, defaults, layering and save behaviour. New: invalid and unknown fields in a file
  warn once per file, naming each field, instead of being dropped silently.
- Tests load files through the definition instead of calling `sanitizeConfig`.

## 2026-11-11: Use the shared session-state helpers

Issue #127. No behaviour change.

- The `todo:context` card is registered with `contextCard` from `packages/pi-session-state`,
  which owns stripping the previous card and appending the current one; `build` keeps the
  rules for when the card is due, for a subagent's delegated view and for the session's own list.
- `createTodoDelegation` offers the broker with `treeService` instead of `trackChildren`,
  `provide` and a withdraw of its own. The broker is now provided on `session_start` only, not
  again on `/tree`, which re-provided the same broker under the same id. `start` takes only the
  replayed claims, finds the parent and agent id through the tree service, and `Delegated` no
  longer carries the parent id.
- `replayTodoSession` reads the journal, claims and review entries with `customEntries`.

## 2026-11-11: Replay only the todo journal

Issue #129. Every mutation journals a `todo:journal` snapshot, and nothing writes `todo:state`, so
replay reads the journal alone.

- `replayTodoSession` restores the last valid `todo:journal` snapshot on the branch and no longer
  falls back to `todo:state` entries or todo tool-result details. It validates journal data with
  the new `readTodoState` instead of wrapping it in a fake `getBranch()` for `replayTodoState`.
- Removed `TODO_STATE_CUSTOM_TYPE`, schema version 1 (`readLegacyState` and its migration),
  `replayTodoState` and the unused `needsTodoContextCheckpoint`.
- Tests: `readTodoState` takes over the malformed-snapshot and isolation cases; the fallback and
  version 1 cases are gone, and replay tests pin that tool results alone restore nothing.
- A session written before the journal existed resumes with an empty list.

## 2026-11-10: Parent acceptance for delegated tasks

- Delegated workers cannot set assigned or newly added tasks to `completed`.
  They leave finished work `in_progress` with an outcome message; the parent
  verifies and completes it. Local task lists without a handoff are unchanged.
- Delegated workers cannot remove unfinished tasks, so deleting an assignment
  cannot bypass parent acceptance. They may still remove or clear their own
  tasks after the parent completes them, with the existing dependency checks.
- The todo tool guidance and delegated context describe the rule. Delegation
  tests cover atomic refusal, parent completion and cleanup; the real-session
  handoff test exercises a refused child completion followed by parent acceptance.

## 2026-11-09: README names subagent_send

Roadmap step 7b (`docs/roadmaps/subagent-work-lifecycle.md`). The README's note
on releasing a handed-over claim says a later run started by `subagent_send`
(`subagent:resuming`) reclaims the agent's tasks, where it said a resume did.
pi-todo's events and code are unchanged: `subagent:resuming` and
`subagent:resumed` still carry every run a message starts, including the first
run of an agent that never had a session. No source change.

## 2026-11-08: Faux sessions from pi-test-helpers

- `test/sdk.test.ts` runs on `packages/pi-test-helpers`' `fauxSession` and
  `loadResources` and reads provider requests from `requests`; `test/harness.ts`
  reads tool text with `messageText`. No source change.

## 2026-11-08: ui.custom stub from pi-test-helpers

- `browser.test.ts` mounts the browser with `packages/pi-test-helpers`'
  `fakeCustomUi` and `fakeTui`. No source change.

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
