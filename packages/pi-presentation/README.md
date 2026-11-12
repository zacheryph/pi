# pi-presentation

Session presentation services shared by the terminal dashboard and remote UI adapters.
This library owns no domain state, HTTP server, process discovery or renderer.

`new PresentationService(pi.events)` subscribes to the session's todo, stash, Git,
subagent and ask events. Construct it before `session_start` producer emissions.
`snapshot()` returns detached, bounded projections; `subscribe(callback)` reports
changes. Read the initial snapshot explicitly after binding. `request()` serves
branch-local task history, owner-verified stash previews and accepted ask answers.

The consumer owns lifecycle: `reset()` on session replacement clears prior state;
`dispose()` removes producer subscriptions and listeners. Domain producers publish
fresh full snapshots on branch changes. Status/activity/usage and full session DTO
helpers are exported as subpaths for adapters that need them. `contract` contains
only data types and is safe to import from client code with `import type`.

pi-dashboard uses this service only for TUI sessions. A Paseo adapter must consume
it directly and must not start, connect to or report to the dashboard hub.
