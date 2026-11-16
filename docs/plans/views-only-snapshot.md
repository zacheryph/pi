# Views-only snapshot: packages stop depending on extensions

Status: planned · follows [RPC surfaces](rpc-surfaces.md), packages 6 to 8

## Goal

- No workspace under `packages/` imports an extension. Packages are generic
  supporting libraries; extensions depend on them, never the reverse.
- Session state leaves an extension one way: as a `pi-surface` view, with
  `pi-surface` actions for anything on demand.
- The session snapshot stays one JSON object per session on the wire.

Non-goals: porting `pi-dashboard` to the view model (it is frozen and removed
in [RPC surfaces](rpc-surfaces.md) package 8), splitting the snapshot into
several wire messages, and the import cycle between `pi-foundations` and
`pi-ui` (`#ui/text` one way, `#foundations/errors` the other), which is
separate work.

## Where things stand

`pi-presentation` (1,280 lines of source) is the only package that imports
extensions: `pi-git`, `pi-stash`, `pi-todo` and `pi-subagent` through its import
map, and `pi-ask` by re-declaring its `ask:opened`, `ask:closed` and
`ask.answer` strings. It also re-declares pi-subagent's `agent:profile` entry
key.

| Part                                                               | Lines | Knows extensions     |
| ------------------------------------------------------------------ | ----- | -------------------- |
| Wire types (`contract.ts`)                                         | 324   | Yes: section types   |
| Section projections (`sections.ts`, `subagents.ts`, `ask-user.ts`) | 447   | Yes                  |
| `service.ts`: section cache, view collector, request router        | 207   | Partly               |
| Session trackers (`status`, `activity`, `usage`, `snapshot`)       | 302   | Only `agent:profile` |

The same state leaves an extension by parallel paths. For pi-todo:

1. The `todo:snapshot` bus event, projected by `pi-presentation` into the
   snapshot's `todos` section.
2. The `todo.widget` and `todo.explorer` views, collected into the snapshot's
   `views`.
3. Actions (`todo.history`, `todo.inspect`, `todo.review`), run on demand.
4. The `todo-history` request, an alias for the action in 3.

Paths 2 and 3 are generic: `pi-presentation` calls each view's `model()` when
it builds a snapshot and knows nothing about what the model holds. Paths 1 and
4 are the older design and the only reason the package imports extensions.
Nothing but `pi-presentation` subscribes to the four `*:snapshot` events.

Who still reads sections:

| Consumer       | Reads                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bb-plugin`    | Views for stack cards and the Pi tab's explorers. Sections for the context row counts, sessions page summary, row badge, stash picker, stash count, git card, questionnaires and the saved-snapshot rewrite |
| `pi-dashboard` | Sections only; it strips `views` before sending to its hub                                                                                                                                                  |

Two things follow from carrying the state twice:

- `pi-presentation`'s `request()` adds no routing of its own. `view`, `actions`
  and `action` pass straight to `pi-surface`; `todo-history`, `stash-preview`
  and `answer` are fixed aliases for actions, with clipping.
- The bb plugin's `offline()` settles a saved snapshot by rewriting the
  `subagents` section and dropping `questions`, but passes `views` through
  untouched. The stack cards draw from views, so a restored thread can show
  agents as running. Read from the code; not yet reproduced in bb.

## Design

- **One object on the wire.** Both receivers serve one object per session (the
  plugin's `snapshot` RPC, the hub's page feed), and the plugin saves one row
  per thread for restore. Per-extension messages would move the merge out of Pi
  into each receiver and remove nothing.
- **Views are the snapshot mechanism.** `defineView({ id, model })` is already
  a callback the collector runs at snapshot time. No second registry for
  sections is added.
- **Counts come from the model.** A consumer that shows a count (context row,
  sessions page, row badge) reads it from the widget model, not from a typed
  section. The subagent widget already carries its counts in `meta`.
- **A questionnaire is a view.** `pi-surface` gains a `form` kind: questions
  and options as JSON, and an action reference to submit. pi-ask defines
  `ask.questions` and tracks its own open questionnaires. The terminal keeps
  its keyboard-driven component over the same state, as the watch overlay does.
- **Saved views settle by a generic rule.** `offline()` rewrites any view model
  through the model vocabulary alone: `active`, `queued` and `waiting` icons
  become `stopped`, `since` clocks are dropped, a widget's `active` is false,
  and `form` views are removed.
- **What remains is a small generic package.** Status, activity, usage, the
  snapshot builder and the view collector, about 400 lines, renamed
  `pi-snapshot`.

## Work packages

Each is one pull request. "Base" is the branch it stacks on.

| #   | Branch                            | Base   | Scope                                                              |
| --- | --------------------------------- | ------ | ------------------------------------------------------------------ |
| 0   | `claude/views-only-0-plan`        | `main` | This plan                                                          |
| 1   | `claude/views-only-1-bb-views`    | `main` | bb plugin reads views for everything but questions                 |
| 2   | `claude/views-only-2-form-view`   | 1      | `form` view kind; pi-ask's questionnaire view; pi-bb protocol 3    |
| 3   | `claude/views-only-3-pi-snapshot` | 2      | Projections move to `pi-dashboard`; package becomes `pi-snapshot`  |
| 4   | later (RPC surfaces 8)            | 3      | Remove `pi-dashboard`, the projections and the `*:snapshot` events |

### 1. bb plugin reads views

- Context row segment, sessions page summary and row badge take task and agent
  counts from `todo.widget` and `subagent.widget`. Check that the todo widget
  carries done and total counts and the active task; add them to its model if
  it does not. If text in `meta` is not enough for the sessions page, add
  optional numeric counts to `WidgetModel` in `pi-surface`.
- Stash picker and stash count row read `stash.explorer`; its item ids are
  already the handles the picker inserts.
- Git card rows read `git.worktrees` and `git.prs` through the generic row
  renderer in `ui/surface.tsx`.
- `offline()` applies the generic settle rule to views. First reproduce the
  running-agents-after-restart case with the `bb-screenshot` skill and keep it
  as a test.
- Done when: `bb-plugin` imports no `TodoSection`, `StashSection`, `GitSection`
  or `SubagentsSection`; its tests pass; `bb-shot.mjs --expand --check` passes;
  `docs/bb/ui-slots.md` is updated.

### 2. Questionnaires as a `form` view

- `pi-surface`: `FormModel` (questions, options, multi-select, submit action
  reference), its guard, and `form` in `ViewKind`. `pi-ui` does not draw it.
- pi-ask defines `ask.questions`, announces changes when a questionnaire opens
  or closes, and bounds its own text. `ask.answer` validates as it does today.
- `bb-plugin`: `ui/questionnaire.tsx` draws the `form` model and submits
  through `action`; the server raises its interaction from the view.
- pi-bb protocol 3: the snapshot carries no sections, and the only request is
  `action { id, args? }`. pi-bb stops calling `presentation.snapshot()` for
  sections and `closeQuestion()`.
- Done when: `bb-plugin` and pi-bb import no section or questionnaire type from
  `pi-presentation`, and a scenario answers a question from bb end to end.

### 3. `pi-snapshot`

- Move `sections.ts`, `subagents.ts`, `ask-user.ts`, the section types and the
  three alias requests into `pi-dashboard`, their only remaining consumer. Its
  import map already names the four extensions. pi-subagent exports the
  main-agent name lookup so the snapshot builder takes it as input.
- Rename `packages/pi-presentation` to `packages/pi-snapshot`: session
  trackers, snapshot builder, view collector with the 256 KB bound, and the
  session-level contract types. It imports `pi-surface`, `pi-foundations` and
  `pi-session-state` only.
- Adapters call `dispatchAction` from `pi-surface` directly; `request()` and
  `PresentationService` are gone.
- `npm run verify:bundle` fails when a `packages/*/package.json` import map
  names a workspace under `extensions/`. Add the rule to `AGENTS.md`.
- Done when: the check passes with no exceptions listed, and `pi-dashboard`
  behaves as before with its tests unchanged in intent.

### 4. Remove `pi-dashboard`

This is [RPC surfaces](rpc-surfaces.md) package 8, with more to delete:

- `pi-dashboard`, including the projections moved in 3.
- The `todo:snapshot`, `stash:snapshot`, `git:snapshot` and `subagent:snapshot`
  events and their payload types, and `ask:opened` / `ask:closed` if pi-ask's
  own view no longer needs them.

## Verification

Every package: `npm run check`, `npm test`, `npm run verify:bundle`. Packages
that touch `bb-plugin/` also pass `bb-shot.mjs --expand --check`. Changelogs
are maintained by the weekly workflow. Commits use
`git -c commit.gpgsign=false commit`.

## Open questions

- Is `form` the right home for questionnaires, or should they stay the one
  typed exception, owned by pi-ask? The plan assumes `form`.
- Do the sessions page and context row need numeric counts in `WidgetModel`,
  or is the widget's `meta` text enough?
- Keep the name `pi-presentation` or rename to `pi-snapshot`? The plan assumes
  the rename.
