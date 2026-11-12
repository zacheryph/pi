# pi-session-state

A small library (not an extension) for the session wiring that extensions with
persistent state share: a context-only card, a service in the
[session tree](../pi-session-tree/README.md), and replay of custom entries.
Import it through the workspace alias:

```ts
import { contextCard, readEntries, treeService } from "#session-state";
```

Every helper keeps its state in the closure of the call that made it, so call
them from the extension factory. Never keep their results in module scope: a
same-cwd subagent may share the module with its parent.

## Context card

```ts
const card = contextCard(pi, {
  type: "example:context",
  // After session_start, session_tree and session_compact: is there state to restore?
  restore: (ctx, event) => entries.length > 0,
  // The card for this request; undefined for none. May be async.
  build: (ctx, messages) => formatCard(state),
});

card.show(); // new state the model has not seen (an entry adopted from a subagent)
card.hide(); // the model has seen it (a list result in its context)
card.shownAt(); // when it was last shown; undefined while hidden
```

Registers the `context` handler that strips the previous request's card of
`type` and appends the current one as a `custom` message with `display: false`,
so it is never written to the transcript or shown in the TUI. The handler
returns `undefined` when nothing changed. `build` sees the messages with earlier
cards already removed, so it can check whether a visible tool result already
holds the state.

With `restore`, the helper owns whether the card is shown. After each
`session_start`, `session_tree` and `session_compact` it shows the card when
`restore` returns true and hides it otherwise; `session_shutdown` hides it. While
the card is hidden, `build` is not called. `restore` receives the event, so an
extension can tell the card why it came back (`event.type`, and
`event.reason` on start). The extension keeps its own rule for when the model has
seen the state and calls `hide()` then, from `build` or from another handler.

Without `restore`, `build` alone decides on every request (pi-todo, whose card is
due until a visible tool result already holds the state).

Async `restore` and `build` results are dropped after any newer restore event or
explicit `show()`/`hide()` call, including a hide followed by a show at the same
timestamp. Shutdown also invalidates pending work; the old card is still
stripped. Synchronous callbacks give a synchronous result. Pass `now` to control
timestamps.

`contextCard` runs `restore` from its own handlers, so register it after the
extension's handlers that rebuild the state `restore` reads.

## Tree service

```ts
const tree = treeService<ExampleService>(pi, "example:service", service);

tree.sessionId(); // current id; undefined outside a session
tree.node()?.agentId; // pi-subagent's agent id when this is a subagent
tree.parent((api) => api.adopt(record)); // CallResult; "missing" without a parent
```

Calls `trackChildren(pi)`, then provides `service` under the name on each
`session_start` and withdraws it on `session_shutdown`. `parent` calls the same
service in the parent session with pi-session-tree's synchronous `call`; use it
to hand a record up the chain, each parent passing it on to its own.

After a `/reload` the new extension instance's provide replaces the entry, and
the old instance's withdraw does nothing.

The `session_start` handler is registered when `treeService` is called. Pi runs
an extension's handlers in registration order, awaiting each, so call it after
registering a `session_start` handler that must run first.

Initialization that must happen together with registration can instead use
`treeService(pi, name, service, { start: (ctx) => initialize(ctx) })`. `start` must
be synchronous. It runs after providing the service, in the same handler, so
shutdown cannot slip between initialization and registration. This also lets
the extension read `ctx` before Pi yields between handlers. A later card restore
should check `tree.sessionId()` before reading `ctx` if shutdown may have
interrupted that start event (see pi-git).

## Entry replay

```ts
const records = readEntries(ctx, { type: LEDGER_TYPE, guard: isLedgerRecord });
const everything = readEntries(ctx, { type: LEDGER_TYPE, scope: "all" });
```

- `readEntries(ctx, { type, scope?, guard? })`: the data of `ctx`'s custom
  entries of `type`, in order. `scope: "branch"` (the default) reads
  `getBranch()`, so abandoned branches never leak in; `"all"` reads
  `getEntries()` (pi-git's ledger). `guard` drops malformed data.
- `customData(entries, type, guard?)`: the same over an entry list you already
  have, such as a transcript opened with `SessionManager.open`.
- `customEntries(entries, types)`: `{ customType, data }` for several types in
  session order, for a replay that interleaves them (pi-todo's journal, claims
  and review watermarks).

Folding the data stays with the extension.

## Checks

```bash
npm run check --workspace=pi-session-state
npm test --workspace=pi-session-state
```
