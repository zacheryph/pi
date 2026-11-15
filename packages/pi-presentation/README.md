# pi-presentation

Session presentation services shared by the terminal dashboard and remote UI adapters.
This library owns no domain state, HTTP server, process discovery or renderer.
It is the one place a remote surface gets a session's data sections, its views and
its actions.

`new PresentationService(pi.events)` subscribes to the session's todo, stash, Git,
subagent and ask events. Construct it before `session_start` producer emissions.
`snapshot()` returns detached, bounded projections; `subscribe(callback)` reports
changes. Read the initial snapshot explicitly after binding. `request()` serves
views, actions, branch-local task history, owner-verified stash previews and
accepted ask answers.

## Views and actions

Extensions define views and actions on the session's bus with
[pi-surface](../pi-surface/README.md); the service reads them live and keeps no
copy. `snapshot().views` lists every view, sorted by id, as `ViewSummary`:
`{ id, kind, title, model?, error? }`. `model` is the view's current model,
absent while it has nothing to show; `error` says why it is missing when the
provider failed or the model is over `MAX_VIEW_BYTES` (256 KB) as JSON. Explorers
keep heavy item details behind `loadDetail`, so a client draws every view from
the snapshot and asks for details on demand. Subscribers are notified when any
view on the bus announces a change, as they are for every section.

An explorer's behaviour is an action reference (`{ action, args? }`): to open an
item, send `action` with the reference's `action` as `id` and its `args` plus the
call's context (`{ id }` for `loadDetail` and `onOpen`, `{ ids }` for
`marker.onClear`) as `args`.

## Requests

| Request                                   | Result                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `{ command: "view", id }`                 | The view's current JSON model, or `null` while it has nothing to show. Rejects `Unknown view "<id>".`            |
| `{ command: "actions" }`                  | `{ id, title }[]` of every action on the session's bus, sorted by id                                             |
| `{ command: "action", id, args? }`        | The action's JSON result, or `null` when it returns nothing; rejects with pi-surface's dispatch errors           |
| `{ command: "todo-history", key }`        | `TodoHistory`: pi-todo's `todo.history`, bounded (latest 20 updates, clipped messages)                           |
| `{ command: "stash-preview", name }`      | `StashPreview`: pi-stash's `stash.preview`, bounded (200 lines of 2,000 characters)                              |
| `{ command: "answer", question, answer }` | Nothing once pi-ask's `ask.answer` accepts the answer; rejects with its reason, or when the question is not open |

The last three predate actions and keep their names and results: each is the
owning extension's action with the bounds and errors it always had.
`todo-history` rejects `No task "<key>" on this branch.` and `stash-preview`
`pi-stash did not answer; is it loaded?` when the extension is not loaded.

## Lifecycle

The consumer owns lifecycle: `reset()` on session replacement clears prior state;
`dispose()` removes producer subscriptions and listeners, after which
`snapshot().views` is empty and every request rejects. Views and actions are read
live, so they need no reset; a producer removes its own at `session_shutdown`.
Domain producers publish fresh full snapshots on branch changes.
`buildSnapshot` carries `views` into the `SessionSnapshot` when there are any.
Status/activity/usage and full session DTO helpers are exported as subpaths for
adapters that need them. `contract` contains only data types, including
`PresentationSnapshot`, `PresentationRequest`, `PresentationResults`,
`ViewSummary`, `ActionSummary` and pi-surface's model types, and is safe to import
from client code with `import type`.

pi-dashboard uses this service only for TUI sessions and leaves `views` out of
what it sends its hub. A remote
adapter must consume it directly and must not start, connect to or report to the
dashboard hub.
