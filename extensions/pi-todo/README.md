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

| Action | Arguments | Behavior |
| --- | --- | --- |
| `list` | optional `key` | Read revision/plan; one key returns its full description |
| `upsert` | `tasks` | Add/patch only named keys; inherit omitted fields |
| `replace` | `tasks` | Authoritative plan; omitted keys deleted; `[]` clears |
| `remove` | `keys` | Delete named tasks; dangling live dependencies rejected |
| `clear` | optional `scope` | `all` (default) clears; `completed` removes only completed tasks not needed by open work |

Optional `baseRevision` rejects stale operations. Use it when user commands or
concurrent agents may have changed the plan. `description: ""` clears description;
`dependsOn: []` clears prerequisites. Replace may reorder tasks; upsert preserves
existing order and appends new tasks.

Dependencies must exist and be acyclic. A task cannot start or finish until every
prerequisite is completed. Reopening a prerequisite while its dependent is active
or completed is rejected unless the entire resulting plan is valid. Multiple
independent active tasks are permitted by default for parallel subagent work.

Safety limits: 50 tasks, 20 dependencies/task, 160-character subjects,
2,000-character descriptions, 40-character keys. Plan output abbreviates
descriptions and is bounded at 30,000 characters / 48 KB; `list` with `key` gives full task
details. Validation failures never mutate state.

## Commands

| Command | Purpose |
| --- | --- |
| `/todos` or `/todos:list` | Searchable task list and dependency details |
| `/todos:add Fix auth bug` | Add pending task with unique generated key; omit title for input dialog |
| `/todos:update fix-auth-bug in_progress` | Change status explicitly |
| `/todos:update fix-auth-bug {"dependsOn":["inspect"],"description":"Recheck expiry"}` | Sparse field patch |
| `/todos:remove fix-auth-bug` | Remove one or more space-separated keys |
| `/todos:clear completed` | Clear finished tasks while preserving prerequisites of open work |
| `/todos:clear` | Clear all, with confirmation by default |
| `/todos:clear all --yes` | Explicitly bypass confirmation |
| `/todos:settings` | Built-in select/input settings menu, like subagents |

Commands never submit a user prompt, schedule a continuation, start subagents,
or mark unrelated work completed. On its next model request, the agent gets a
context-only snapshot of changed state by default. Clear confirmation rejects
stale revisions if tasks changed while the dialog was open, and cancels if the
session or branch changed. Non-UI clear-all
requires `--yes` unless confirmation is disabled. Model tool `clear` is already
explicit and does not open a dialog.

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

Browser follows subagents/system-insights controls: type to filter, arrows select,
Enter details, Esc backs out/clears filter/closes, Ctrl+C closes. Fullscreen uses a
centered overlay; regular mode uses a bounded custom screen, not an overlay that
can contaminate scrollback. Task text is sanitized before terminal rendering.
Tool output is compact by default; expand it for task rows. RPC gets plain-text
widget output; task tools remain usable without terminal UI.

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
  "contextSync": "changes"
}
```

- `maxVisible`: 1–12 task rows; short terminals further limit widget height.
- `singleActive`: reject mutations resulting in multiple active tasks. No implicit demotion.
- `contextSync`: `changes` supplies one current snapshot while retained model
  history lacks an untruncated direct tool result for that state. Transient snapshots
  remain on subsequent requests so user/nested-tool edits cannot disappear again.
  `off` disables sync. No periodic work reminders or forced turns. With sync off,
  explicitly call `list` after user changes or compaction.

## Persistence and integration boundaries

Tasks live in the active session branch, never a shared project task file. Each
mutation journals an immutable snapshot with `pi.appendEntry`, covering commands
and nested codemode tool calls whose result details Pi does not persist. Direct
tool results also carry snapshots. Local journals are authoritative, so a delayed
direct result cannot overwrite a newer command edit during replay. Older upstream
results remain a fallback before the first local checkpoint. Reload, resume, tree
navigation, and compaction restore the latest valid branch snapshot. Compaction checkpoints state without
sending steering messages or running the agent.

Subagent sessions keep their own lists. No task lifecycle is inferred from child
notifications: successful child exit is not proof that parent verification passed.
No subagent spawning, event subscriptions, or process-global task store. Matching
UX and explicit model control keep extensions composable and independently loadable.

## Develop

```bash
npm run check --workspace=pi-todo
npm run test --workspace=pi-todo
npm run verify:bundle
```

MIT upstream license retained in [LICENSE](LICENSE). See [UPSTREAM.md](UPSTREAM.md)
for pinned source and local adaptations.
