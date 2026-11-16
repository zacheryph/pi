# RPC surfaces: one extension, terminal and app

Status: in progress · Pi SDK checked: `@earendil-works/pi-coding-agent` 1.5.2 ·
bb checked: 0.49.0 (`get-bb/bb` at `63df380`)

Packages 1 to 7 below record the initial rollout. The
[views-only sessions plan](views-only-snapshot.md) defines the next architecture:
core observation belongs to system-insights, surface collects shared views,
and both dashboard and bb consume them. It replaces the original package 8.
The [implementation sequence](views-only-implementation.md) breaks that work
into eight PRs with dependencies and completion checks.

## Goal

- An extension keeps one copy of its logic and works in Pi's terminal UI and in
  an app that runs Pi over RPC. bb is the first app.
- Each surface has one renderer for the shared view model, not one per
  extension.
- A bb thread can start with a chosen agent as its root session.

Non-goals: replacing the terminal UI, our own chat client, a fork of bb's Pi
provider (see [provider size](../bb/pi-provider-size.md)), and sharing
keyboard-driven views such as the subagent watch overlay. Those keep one
component per surface over shared state.

## How a session reaches each surface

The following diagrams show the implemented route before package 8. That
migration keeps the connections, replaces presentation with surface's collector,
and adds system-insights as the producer of the core session view.

```text
extension ── ctx.ui.*, tools, pi.events ──► pi
                                            ├─ tui mode ─► pi-tui components (pi-ui)
                                            └─ rpc mode ─► JSONL ─► bb's Pi bridge ─► bb
```

What survives RPC mode is in [provider launch](../bb/pi-provider-launch.md).
In short: dialogs and displayed custom messages arrive; widgets, status,
notifications and `ctx.ui.custom()` do not. Anything richer than a dialog
therefore needs our own channel into a bb plugin:

```text
extension ─► PresentationService ─► pi-bb (WebSocket + plugin token) ─► bb plugin server
                                                                         │ bb.realtime
React slots ◄────────────────────────────────────────────────────────────┘
React slots ─► bb.rpc ─► plugin server ─► same socket ─► pi-bb ─► action registry
```

## Layers after the views-only migration

| Layer                | Package                            | Knows about                                                                                                  |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Domain               | each extension                     | Its own state, published through shared views and actions                                                    |
| Core observation     | `pi-system-insights`               | Session identity, model/context, status, activity and usage as a session view                                |
| Views and collection | `pi-surface`                       | Portable models, session/form structures, complete view collection and action routing. No Pi runtime imports |
| Terminal renderer    | `pi-ui`                            | `pi-tui`; draws the view model                                                                               |
| Dashboard            | `pi-dashboard`                     | Shared-view renderer, hub connection and terminal Focus                                                      |
| bb adapter           | `pi-bb` (new) + `bb-plugin/` (new) | bb's plugin SDK; draws the view model in bb's slots                                                          |

Rules that hold across layers:

- A view model is JSON. Where a view needs behaviour (load a detail, clear a
  marker, remove a worktree) it carries an action reference, not a function.
- An action is registered once and called from a slash command, a terminal key
  hint or a remote request.
- Dashboard reports terminal sessions; `pi-bb` reports RPC sessions to the bb
  plugin without starting or reporting to the dashboard hub. Both use surface's
  collector and actions, with core data supplied by system-insights.
- Dashboard is supported and migrates alongside bb. Update its renderer and
  protocol to shared views; delete older section projections after both
  consumers migrate. Do not retain a compatibility layer for dashboard.
- Each delivery contains a complete set of views and replaces the previous
  received snapshot. Adapters batch notifications and deliver snapshots; they
  do not merge incremental domain updates. The bb plugin stores the latest
  received snapshot for rendering and thread restoration; the dashboard hub
  keeps its latest received session records for its page.
- Registries live on the session's `pi.events` bus, not `globalThis`: subagent
  children load the same extensions in the same process.
- Text a user must see in RPC mode goes through
  `pi.sendMessage({ display: true })`; bb drops `notify`.

## Work packages

Each is one pull request. "Base" is the branch it stacks on.

| #   | Branch                            | Base   | Scope                                                                                              |
| --- | --------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| 0   | `claude/rpc-0-docs`               | `main` | This plan and the two bb documents                                                                 |
| 1   | `claude/rpc-1-surface-model`      | `main` | `pi-surface`: view model and action registry; `pi-ui` draws it                                     |
| 2   | `claude/rpc-2-rpc-commands`       | `main` | Every command has a result without a terminal                                                      |
| 3   | `claude/rpc-3-main-agent-env`     | `main` | `PI_MAIN_AGENT` selects the root agent                                                             |
| 4   | `claude/rpc-4-agent-models`       | 3      | Agents as virtual models in the model picker                                                       |
| 5   | `claude/rpc-5-bb-surface`         | `main` | `pi-bb` adapter and the bb plugin with one example per slot                                        |
| 6   | `claude/rpc-6-presentation-views` | 1      | `pi-presentation` publishes views and dispatches actions                                           |
| 7   | `claude/eloquent-mayer-a107he`    | 5, 6   | bb plugin draws `pi-surface` views generically; actions from the app                               |
| 8   | views-only sessions               | 5, 7   | Core data in system-insights; surface collection; migrate dashboard and bb; remove pi-presentation |
| 9   | later                             | 5      | Tool rows: structured `details` and bb timeline renderers                                          |

### 1. `pi-surface`: view model and action registry

- New `packages/pi-surface`, no `pi-tui` or `pi-coding-agent` runtime import.
  A test fails the build if one appears.
- Move the semantic types out of `pi-ui`: `Tone`, `Span`, `Line`, `Badge`,
  `Block`, the widget model, the explorer model (items, tabs, notices, marker,
  hints, empty text). `pi-ui` imports and re-exports them, so extensions do
  not change.
- Add `ActionRef` (`{ action, args? }`) and accept it wherever the explorer
  and detail models take a callback today (`loadDetail`, `onClear`). `pi-ui`
  resolves a reference through the registry; callbacks keep working until
  every caller has moved.
- Action registry per session bus: define (id, title, argument check, handler),
  list, dispatch. Ids are `<extension>.<verb>` (`todo.review`,
  `git.worktree.remove`).
- Done when: `pi-ui` tests pass unchanged, a model round-trips through
  `JSON.stringify`, and one explorer (pi-stash) runs on action references.

### 2. Commands without a terminal

- Every registered command returns something useful when `ctx.mode !== "tui"`:
  a text listing as a displayed custom message, or Pi's dialogs for a choice.
  No command may silently do nothing.
- Shared helper for "show this text to the user" that picks `notify` in the
  terminal and a displayed message elsewhere.
- Covers `/todo`, `/todo:*`, `/stash`, `/stash:gc`, `/git:*`, `/job`, `/tldr`,
  `/system:*`, `/subagent:*`, `/dashboard`, `/work:wake`. `/subagent:watch` and
  other overlay-only commands say so and name the alternative.
- Done when: a scenario test drives each command in RPC mode and asserts its
  output.

### 3. `PI_MAIN_AGENT`

- `pi-subagent` reads `PI_MAIN_AGENT` when `--agent` is not given.
- From the variable, the profile applies only when the session has no saved
  profile; a restart of the same session restores it. bb restarts the Pi
  process on every resume, and each restart is a `startup`.
- From the variable, the profile's `model` and `thinking` are not applied: the
  host passes its own `--model` and `--thinking`. Instructions and tools are.
- A profile that cannot load reports through a displayed message as well as
  `notify`, so an RPC host shows why input is refused.
- Done when: unit tests cover first start, restart, unknown profile and the
  model rule; README documents the variable and
  `bb machine env set PI_MAIN_AGENT --project <id>`.

### 4. Agents as virtual models

- `pi-subagent` registers a virtual model per main-capable agent profile under
  the provider id `agent` (`agent/orchestrate`).
- Selecting one applies the profile the way `--agent` does; selecting a
  physical model afterwards leaves the profile in place until the session
  ends (same as today's `/model` after `--agent`).
- `route()` returns the profile's model, or the session's last physical model,
  or Pi's default; tool follow-ups and retries stay on the model that handled
  the turn.
- A setting turns the registration off.
- First step is a spike: confirm that `bb provider models pi` lists the
  virtual model. If it does not, stop and report; 3 still stands.

### 5. bb adapter and plugin

- `extensions/pi-bb`: active only in RPC mode with `BB_THREAD_ID` set. Builds a
  `PresentationService`, connects to the plugin, sends the session snapshot on
  change, answers requests (stash preview, task history, ask answers).
- `bb-plugin/`: server (token-authenticated socket for sessions, realtime
  publish, RPC for the app) and app (the slots below).
- One example per slot, each fed by real sections:

  | Slot                                | Example                                  |
  | ----------------------------------- | ---------------------------------------- |
  | Composer banner, stack card         | Todos; Subagents                         |
  | Thread context segment              | Agent name and task counts               |
  | Thread context card row and section | Stash count; worktrees and PRs           |
  | Composer action                     | Open the session panel                   |
  | Composer popup with shortcut        | Stash picker                             |
  | Thread tab                          | Todos, subagents, stash, git in full     |
  | Thread row metadata                 | Running-subagent and open-question badge |
  | Sidebar navigation panel            | Every connected Pi session               |

- A fixture command posts a canned snapshot for a thread, so every slot can be
  seen and screenshotted without a model run.
- Done when: the plugin builds with `bb plugin build`, its tests pass, the
  adapter has an integration test against a fake server, and
  `docs/bb/ui-slots.md` shows each slot with a screenshot or a note on why it
  could not be captured.

### 6. Views and actions in `pi-presentation`

- Extensions publish their widget model and register their explorers as view
  providers on the bus; `PresentationService.snapshot()` gains `views`.
- `request()` gains `view` (an explorer or detail model by id) and `action`
  (dispatch through the registry). `todo-history`, `stash-preview` and `answer`
  become actions; their old request names remain only until dashboard and bb
  migrate to generic action requests in package 8.
- pi-todo and pi-stash move first; pi-git and pi-subagent follow in 7.
- The snapshot carried only widget models here; 7 adds every kind.

### 7. Views in bb

- pi-git offers `git.worktrees` and `git.prs` (its two explorers); pi-subagent
  offers `subagent.widget` (one model builder for the terminal widget and the
  view) and `subagent.explorer` (the branch's roster).
- `PresentationService.snapshot().views` carries every view's model, not only
  widgets, so a client draws everything from the snapshot, a saved snapshot
  included; a model over 256 KB is sent as an error. pi-dashboard leaves views
  out of what it sends its hub.
- pi-bb protocol 2: the snapshot carries `views`, and the app's requests are
  `action { id, args? }` and `answer`. The bb plugin no longer sends
  `stash-preview` or `todo-history`; pi-presentation keeps them until the
  dashboard migration in 8.
- The plugin's `ui/surface.tsx` draws widgets, explorers and details. Widget
  views are the stack cards, from a table of view id and icon; explorer views
  are the Pi tab's sections, in a fixed order with any other after. Items open
  inline details, or run `loadDetail` on the session; `onOpen` and
  `marker.onClear` run too. The header, questions, activity and usage stay
  bespoke; the context row, context card, stash picker, row badge and sessions
  page still read sections for their counts.
- Views leave out what only a redrawing terminal keeps current: the subagent
  widget's elapsed clock, and a running agent's duration.
- Not done: actions on one item from the app, such as removing a worktree.
  That needs an item action (label, action reference, confirmation) in the
  explorer model and a key for it in the terminal's explorer.

### Later

- **8:** implement the [views-only sessions plan](views-only-snapshot.md).
  System-insights publishes core session information as a structured view;
  surface owns the generic collector and shared session/form models. Update
  both dashboard and bb to read views and send actions, preserving dashboard
  Focus. Delete `pi-presentation`, old section events/projections and fixed
  request aliases after both migrations. No separate snapshot package or
  dashboard-only section translation remains.
- **9:** tool results carry structured `details` everywhere, and the plugin
  registers timeline renderers for subagent and todo rows.

## Verification

Every package: `npm run check`, `npm test`, `npm run verify:bundle`. Extension
and package changelogs are maintained by the weekly workflow. Commits use
`git -c commit.gpgsign=false commit`.

## Open questions

- Does bb pass a typed `/todo` through to Pi unchanged? Its `/` menu lists
  skills only.
- Does bb's Pi thread title follow `pi.setSessionName` (pi-tldr)? The provider
  declares no thread rename.
- bb has no slot below the composer. If pills there matter, that is a request
  to bb.
