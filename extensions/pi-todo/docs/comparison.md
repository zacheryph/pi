# Todo extension comparison and adaptation decision

## Decision and scope

Use **@99percentpeople/pi-todo 1.2.8 as the state-model base**, not as an unchanged installation. Its keyed, pure, 479-line `state.ts` gives us atomic validation, revision checks, dependency enforcement, defensive replay, and no Pi/TUI imports. Changing its destructive snapshot default is more contained than untangling rpiv ecosystem integration, relaxing checklist policies, or turning a backend browser into a session planner.

This is a source-based fit decision for a small, independent session planner alongside parallel subagents. It is not a popularity ranking or a claim that the selected upstream has the best defaults. The local adaptation below implements those intentional differences; its regression tests and offline Pi SDK probes cover the critical contracts.

## Sources and revision pins

Versions are from the inspected source manifests, not independently verified npm artifacts. Links are immutable checkout pins. The five third-party candidates include MIT `LICENSE` files; preserve the relevant notices when copying code.

| Candidate | Inspected version | Source revision | License and provenance |
| --- | --- | --- | --- |
| [@juicesharp/rpiv-todo][rpiv] | 2.12.0 | `68d9a0014b70006d7b04b57933752338a2716db7` | MIT, juicesharp; package under `packages/rpiv-todo` |
| [@99percentpeople/pi-todo][99] | 1.2.8 | `a7ae6b89a211c35b657e886e9ceeafbf51616c22` | MIT, Zach Yuen; source manifest is `private: true`, with a separate package build process |
| [pi-checklist][checklist] | 2.3.0 | `db698ff9d34f066a1937fe4736c6510328fcd305` | MIT, Arnav Gupta |
| [@soleone/pi-tasks][tasks] | 0.5.0 | `bf7cf6654fbc8c8988d9b5e6928805a258503335` | MIT, Soleone |
| [pi-todotools][todotools] | 0.2.1 | `50b85f7e39c94a8fa8253eb3628515f188a42a1c` | MIT, Yeongyu Kim; `NOTICE` also attributes oh-my-pi at `9fd6e97113f5ed3a847e66d346970efdf8afcad9` (v17.0.5), Mario Zechner and Can Bölük |
| [Official Pi todo example][official] | Installed Pi 1.1.0 | Local distribution, no checkout commit established | Pi package metadata declares MIT; teaching example, not a separate todo package |

Research checkouts are under `/tmp/pi-todo-research/`: `rpiv-mono/packages/rpiv-todo`, `99percentpeople/extensions/todo`, `pi-checklist`, `pi-tasks`, and `pi-todotools`. Each package's `package.json` and `LICENSE` are the version/license evidence. The official file inspected in full is `/Users/context/.local/share/mise/installs/pi/1.1.0/examples/extensions/todo.ts`, 297 lines, SHA-256 `e46824d00217e25242c186d41837cc84ca81b23f978500323448502a9a424ee2`. Its upstream link is a locator, not an independently established commit pin.

## Behavioral comparison

| Candidate | Identity and mutations | Dependencies and concurrent work | Persistence and UI | Main mismatch |
| --- | --- | --- | --- | --- |
| **99percentpeople** | Stable caller-supplied keys; one authoritative snapshot; sparse fields preserve existing values, but omitted **keys delete tasks**; optional `baseRevision` | Rejects missing/self/cyclic dependencies and active/completed tasks with unfinished prerequisites; permits multiple active tasks | Current-branch replay; above-editor read-only widget; exact compaction checkpoint machinery | Next-turn completion cleanup, reminders every three model calls, snapshot deletion default, shared-settings dependency |
| **rpiv-todo** | Numeric IDs; create/update/list/get/delete/clear; tombstones; owner, metadata, and `activeForm` | Rejects missing/deleted new blockers, self-blocks and cycles; does **not** enforce prerequisite completion; one-active rule is prompt-only | Per-session store; current-branch tool-result replay; live above-editor widget, collapse shortcut, localized chrome | More integration machinery; terminal completed state; no mutation-time custom checkpoint |
| **pi-checklist** | Allocated or supplied three-character IDs; create defaults to replace, append optional; separate read/update tools; atomic update batch | DAG validation; planned-to-ongoing/done guards; done tasks frozen; preview subtasks have extra rules | Custom snapshots plus tool details; branch replay; footer/widget modes and checklist overlay | Fixed ten-task cap, three-subtask preview cap, terminal/frozen completion, stronger workflow policy |
| **pi-tasks** | Backend references; interactive list, create/edit forms, explicit work/insert actions; no registered todo tool | Capabilities and guarantees depend on backend; no uniform session-plan dependency validator | Tasks app, tq, beads, sq, or TODO.md storage; rich browser, no persistent todo widget | Project/external task manager rather than branch-local agent planner |
| **pi-todotools** | Task text is identity; phases; init/start/done/drop/rm/append/view | No dependency graph; normalizes to one active task and automatically promotes pending work | Custom snapshots plus tool details; branch replay; active-phase widget and phase-tree tool output | Implicit scheduling, text identity, larger mandatory task-management prompt |
| **Official example** | Numeric IDs; list/add/toggle/clear; two-state done flag | No dependencies, active status, revisions, or batch validator | Branch replay from tool details; `/todos` viewer, no persistent widget | Excellent teaching/browser seed, insufficient planner semantics |

### Why the 99percentpeople core wins

Evidence: [`extensions/todo/state.ts`][99-state], especially `writeTodoSnapshot`, `assertDependenciesAreConsistent`, `assertNoDependencyCycles`, `replayTodoState`, and `needsTodoContextCheckpoint`.

- Validation builds the proposed state before returning it. A rejected update does not partially mutate the input. Completing a prerequisite and starting its dependent can happen in one valid final-state snapshot.
- Existing tasks can patch subject, description, status, or dependency fields. Keys remain independent of editable text and display order. Keys are 1–40 lowercase ASCII characters; subjects cap at 160 characters and descriptions at 2,000.
- The source caps are **50 tasks and 20 dependency entries per task**. They are safety limits, not widget limits. Optional `baseRevision` rejects stale writes only when supplied; it is not a cross-process lock.
- More than one `in_progress` task is valid. Unlike an implicit single-task scheduler, this fits parallel subagent work.
- Persisted current-schema snapshots are validated for shape, limits, dependency consistency, and cycles. Replay uses `getBranch()`, not the entire session log. Legacy migration is for this upstream's schema v1, **not rpiv's schema**.
- The core has no runtime imports. The whole extension is not 479 lines: upstream `index.ts` is another 625 lines, plus config/settings files. We reuse the small state boundary and deliberately replace unsuitable integration policy.

The shortcomings are substantive. A sparse update containing only one key silently drops every unrelated key. `removeCompletedTasks` deletes completed tasks not directly needed by unfinished work; `before_agent_start` calls it automatically. Defaults in `config.ts` are three collapsed task rows, dependency display numbers enabled, and a reminder every three LLM context calls. `index.ts` also sends a hidden steering message after certain compactions. None of those defaults should be inherited accidentally.

### Why not keep rpiv-todo unchanged?

Evidence: `packages/rpiv-todo/{todo.ts,index.ts,config.ts,todo-overlay.ts}`, `state/{state-reducer.ts,invariants.ts,task-graph.ts,replay.ts,store.ts}`, and `tool/response-envelope.ts` at [the pinned package][rpiv].

Rpiv already has useful incremental operations and a polished live widget. Version 2.12.0 has a pure reducer, graph helpers, no-op detection, per-session data slots, foreground-gated rendering, stale-context handling, and lazy-overlay regression coverage. Calling it merely an old monolith would be inaccurate.

However, its reducer allows an `in_progress` or `completed` task whose blocker is still pending. `blockedBy` is not a prerequisite execution guard. The “exactly one task in_progress” requirement lives in prompt guidelines, not enforced state invariants. Completed tasks cannot reopen; deleted tasks are terminal. Deleting a prerequisite leaves existing references rather than validating the whole surviving plan.

The runtime package requires `@juicesharp/rpiv-config ^2.12.0`; `@juicesharp/rpiv-i18n` is an **optional** peer with a dynamic import and English fallback, not a hard standalone blocker. Still, configuration fallback, localization bridges, lazy overlay loading/prewarming, and shared foreground/session-store machinery add adaptation surface. Its default budget is 12 content rows plus a spacer. Completed tasks become hidden in the widget on a later agent turn; this is **display hiding, not state deletion**. `/todos` reports grouped tasks through a notification, not a full browser.

Keeping rpiv is reasonable for users wanting rpiv integration, owner/metadata fields, and its UI. Here, keyed final-state validation is a better starting point than preserving those features and adding missing guards.

### Why not pi-checklist?

Evidence: [`src/store.ts`][checklist-store], `src/{types.ts,index.ts,tools.ts,commands.ts,render.ts,prefs.ts}` and `tests/` at [the pinned checkout][checklist].

This is the strongest alternative for a small, policy-driven session checklist. It has a pure store, atomic update staging, cycle detection, ready/blocked views, explicit custom-entry persistence, an overlay, and global preferences. The cap is a hard **ten top-level tasks**, not ten visible rows. Preview subtasks are disabled by default and cap at three per parent. Those constraints and their parent/sibling dependency rules would need redesign for larger parallel plans.

Done tasks are frozen and terminal. Dependency guards apply to moves **from planned** into ongoing/done; they are not a blanket invariant preventing all ongoing/done tasks from having unfinished prerequisites. Subtask start can automatically move its parent to ongoing, and parent cancellation cascades to open subtasks. These are coherent upstream policies, but not our “only explicit status changes” contract.

Default display is a below-editor widget plus footer, with Nerd Font icons and pill statuses. Other display modes exist. `before_agent_start` appends usage guidance and an open-task summary to the system prompt each agent turn; the summary is capped at eight open tasks, not an exact full-state checkpoint. Usage guidance is captured at extension load, so changing it requires reload. Runtime imports use Pi/TypeBox peers without another production dependency; published artifacts are built `dist` files and declare Node >=20.

### Why not pi-tasks?

Evidence: `src/extension.ts`, `src/backend/{resolver.ts,api.ts}`, `src/backend/adapters/`, and `src/ui/pages/` at [the pinned checkout][tasks].

Pi-tasks is a capable task **browser/editor**, not a competing todo-tool implementation. It does not register an LLM todo tool. Backend selection honors `PI_TASKS_BACKEND`, otherwise uses detection tiers (project, default, fallback, final), with Tasks/tq/beads/sq/TODO.md tie order. Some detection probes execute installed CLI help/version commands. TODO.md is the final fallback and does not require an external task CLI.

Dependencies vary: Tasks and sq/tq expose native relationships; TODO.md rejects blocked-by dependencies but supports hierarchy; the beads adapter's editable capabilities are narrower than the backend's broader data. Backend cycle/status/concurrency guarantees cannot be inferred uniformly from this extension. TODO.md checks parent cycles, which is not a prerequisite DAG. External task changes are not undone by moving through Pi's conversation tree. Tasks uses versioned backend mutations, but a series of edits is not a single atomic session snapshot.

The browser offers richer forms, hierarchy, sorting, and explicit “work on task” dispatch through `sendUserMessage`, plus insert-to-editor. Those are useful UI references, but backend selection, subprocesses, databases/files, and backend guidance would be unnecessary planner complexity. The manifest has no production dependencies, yet source still imports the older `@mariozechner/pi-*` namespace; no-dependency metadata is not proof of compatibility with current Pi. Copy/adapt browser patterns locally rather than importing this backend stack.

### Why not pi-todotools or the official example?

Evidence: pi-todotools `src/{state.ts,operations.ts,prompt.ts,index.ts,rendering.ts}`, `src/tools/todo.ts`, and `NOTICE` at [the pinned checkout][todotools]; the [official example][official] inspected locally.

Pi-todotools is standalone and has sequential execution and mutation-time custom snapshots. Operations are rolled back on validation errors. But every successful mutation normalizes active state: extra active tasks revert to pending, and if none is active the first pending task becomes active. `done`, `drop`, and `rm` without a task/phase target apply broadly. Exact task text doubles as identity, so renaming and copied text become addressability concerns. Phases express order, not dependencies or cycle safety. Its “sidebar” is a Pi widget showing only the active phase, not a separate dock. It adds a substantial critical task-management system-prompt section each agent turn. Production dependency: `strip-ansi ^7.2.0`; declared minimums are Pi coding-agent/TUI >=0.87.0 and Node >=22.19.0.

The official example is the simplest trustworthy illustration of branch replay and a custom `/todos` viewer. It stores snapshots in tool-result details and reconstructs on session start/tree changes. No dependency model, full replay validation, explicit active status, compaction checkpoint, revision guard, settings, or live widget is provided. Its viewer is a useful seed to copy/adapt, but its state model would require implementing the features the selected core already has.

## Branch, compaction, and codemode safety

Branch-local persistence and model-visible context are separate requirements. All session-based candidates replay the current branch; that alone does not ensure the model sees exact keys, dependencies, and revisions after compaction.

| Candidate | Mutation checkpoint independent of a direct tool-result entry | Exact state/context recovery |
| --- | --- | --- |
| 99percentpeople upstream | **No** during ordinary tool execute; custom checkpoints exist for compaction/cleanup paths | Validated branch replay; explicit exact compaction/legacy context checkpoint logic |
| rpiv upstream | **No**; tool-result details are the replay source | Replays on start/tree/compact; no exact model-facing checkpoint hook found |
| pi-checklist | **Yes**, `appendEntry` on mutations | Branch replay; repeated open-task summary, not full exact model state |
| pi-todotools | **Yes**, `appendEntry` on mutations | Branch replay; no dedicated exact compaction-context hook found |
| Official example | **No** | Tool-result replay only; no compaction-context hook |
| pi-tasks | Not applicable | External/project backend state, not conversation-branch snapshots |

Pi 1.1.0's `docs/codemode.md` says scripts expose only their output to the model, tools execute real side effects, and earlier successful tool calls are not undone by a later script failure. Therefore, **do not rely on a direct `todo` tool-result entry or on the script printing the returned snapshot**. The absence of mutation-time checkpoints in the sources above is a safety gap by source inspection; this comparison does not claim an end-to-end codemode runtime test of every upstream package.

The adaptation must append a validated custom state checkpoint for every successful changed mutation, including codemode calls and local command/UI edits. Replay must use the current branch and replace stale in-memory state on session/tree restoration. Sequential mutation handling and optional revision checks prevent local lost-update surprises; they do not provide a shared task database for independently running agents.

Same-process session isolation also needs attention. Rpiv explicitly keys data slots by session identity and gates foreground rendering. The selected upstream instead has one closure-local state variable; pure replay alone does not prove isolation if a host shares one runtime across sessions. Our subagents create a fresh resource loader and extension instance per child (`pi-subagents/src/lifecycle/create-subagent-session.ts`), so closure-local state is isolated. Offline SDK tests run two independent loaders in one process and verify child commands/checkpoints do not change the parent's plan. Hosts must not reuse one extension runtime for independently active sessions.

For model context, supply a **context-only current snapshot when retained model history lacks the current plan**, including empty-state clears, keys, subjects, statuses, dependency keys, and revision; descriptions stay on-demand. Context transforms are transient, so merely remembering that a snapshot was sent once would make command/nested-call edits disappear on later requests. Supply one snapshot per request until an untruncated direct result already captures that state, replacing rather than accumulating ephemeral snapshots. This is state data, not a recurring instruction to continue working, a hidden user request, or an automatic continuation. Never use steering/dispatch just to expose stored state.

## Criteria ranking and tradeoffs

Criteria are ordered by importance here; no artificial weighted score or decimal precision is useful.

1. **Safe, explicit state semantics.** Keyed atomic final-state validation and dependency enforcement favor the adapted 99 core. Checklist is the closest alternative, with stricter lifecycle policies. Rpiv has useful explicit operations but weaker dependency semantics; todotools adds scheduling side effects.
2. **Branch/codemode durability without agent surprise.** Checklist and todotools already append mutation snapshots. The selected upstream needs that integration fix. Rpiv and the official example also need independent mutation checkpoints. No upstream is a drop-in match for the entire requested context contract.
3. **Contained adaptation and independence.** The selected pure core has the clearest boundary. Checklist's caps/subtasks/frozen completion expand redesign scope; rpiv's ecosystem/lifecycle glue expands integration scope; pi-tasks solves a different storage problem.
4. **Compact, identifiable UI.** Rpiv and 99 already supply above-editor widgets; checklist and pi-tasks supply richer browser interaction. Local adaptation can reuse those patterns without their workflow/backend policies.

Costs of the choice: we maintain a fork; incremental upsert and explicit deletion are a semantic divergence; stable keys require agent discipline; retained completions consume the 50-task limit until explicitly removed; snapshot context consumes tokens when a plan changes; browser/settings work is not supplied by the pure core. We forgo rpiv owner/metadata/localization features, checklist preview subtasks, and external backend synchronization. Multiple active tasks represent parallel work but do not launch or monitor subagents.

## Adaptation contract

These are implemented local policies, **not claims about upstream 1.2.8**:

- Default writes are incremental **upserts**. Omitted keys remain. Existing fields remain unless explicitly patched; deletion requires explicit **replace**, **remove**, or **clear**. Whole proposed state is validated atomically before committing.
- No automatic task removal, completion, activation, or dispatch. Completed tasks stay until explicitly removed. Multiple active tasks are permitted for parallel work; dependencies remain enforced. No agent continuations.
- Preserve source limits: 50 tasks, 20 dependencies per task. Default collapsed widget shows **five task rows**; heading/overflow chrome is separate. Show stable keys rather than display-only dependency numbers.
- Use namespaced `/todos:*` commands and a `/todos` browser alias. Settings use Pi's built-in select/input dialogs. Global preferences live at `<agentDir>/todos.json`; project overrides at `.pi/todos.json`. These are extension preferences, not a replacement external task store.
- Remove upstream shared-settings/rpiv dependencies. Package must load independently, with no internal sibling imports. Copy/adapt the browser and shared visual patterns into this package and retain applicable license notices.
- Match subagents' top-rule, above-editor, compact identity/status rows visually. Do not import subagents' runtime, backend, or UI internals to achieve that appearance.
- Persist changed mutations explicitly and recover branch-local state. Supply one context-only current snapshot while model history lacks that state, including after changes/restoration/compaction; periodic work reminders are **absent**. Do not inherit upstream next-turn cleanup or compaction steering behavior.

## Migration boundary

Remove or disable the installed rpiv-todo extension **before enabling this one**: both register `todo` and `/todos`, so loading both creates duplicate tool/command registrations. Other todo providers using those names also need to be excluded.

This work does **not** modify global Pi settings or automatically remove installed packages. Installation changes remain an explicit user action. There is **no automatic rpiv schema migration**: numeric IDs, tombstones, metadata, and `blockedBy` do not become keyed tasks by assumption. Old rpiv history remains available under its original implementation; recreate/import an active plan deliberately if needed. Compatibility with the selected upstream's own schema does not imply compatibility with every tool named `todo`.

## Evidence and verification limits

The behavior claims above come from inspected implementation paths, not README feature lists alone. Isolated source probes using Node's TypeScript stripping confirmed that the selected upstream permits multiple active tasks, deletes omitted keys, rejects unresolved activation and stale revisions, while rpiv accepts blocked activation and completion. Relevant upstream regression evidence includes `99percentpeople/tests/todo.test.ts`, rpiv's `state/*.test.ts` and session-isolation/overlay tests, checklist's `tests/`, and todotools' `test/`.

These probes are not a full upstream test-suite run, npm-package audit, performance benchmark, or live TUI/codemode compatibility certification. Repository stars, download counts, and community adoption were not measured and are not used to justify the decision.

Local verification additionally covers the real Pi 1.1.0 loader, standalone discovery, tool dispatch, nested codemode calls with suppressed output or subsequent script failure, metadata replay through a fresh loader, same-process independent session isolation, command additions/clears without provider dispatch, and post-compaction exact-key recovery. Provider calls use Pi's offline faux provider; no credentials or external model requests. UI checks use real Pi components and bounded render/input tests, not a manual live-terminal certification. Root `npm run check`, `npm test`, and `npm run verify:bundle` are the reproducible validation commands.

[rpiv]: https://github.com/juicesharp/rpiv-mono/tree/68d9a0014b70006d7b04b57933752338a2716db7/packages/rpiv-todo
[99]: https://github.com/99percentpeople/pi-extensions/tree/a7ae6b89a211c35b657e886e9ceeafbf51616c22/extensions/todo
[99-state]: https://github.com/99percentpeople/pi-extensions/blob/a7ae6b89a211c35b657e886e9ceeafbf51616c22/extensions/todo/state.ts
[checklist]: https://github.com/championswimmer/pi-checklist/tree/db698ff9d34f066a1937fe4736c6510328fcd305
[checklist-store]: https://github.com/championswimmer/pi-checklist/blob/db698ff9d34f066a1937fe4736c6510328fcd305/src/store.ts
[tasks]: https://github.com/Soleone/pi-tasks/tree/bf7cf6654fbc8c8988d9b5e6928805a258503335
[todotools]: https://github.com/code-yeongyu/pi-todotools/tree/50b85f7e39c94a8fa8253eb3628515f188a42a1c
[official]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/todo.ts
