# pi-session-state

A small library (not an extension) for the session wiring that extensions with
persistent state share: a context-only card, a service in the
[session tree](../pi-session-tree/README.md), and replay of custom entries.
Import it by relative path, like the other packages:

```ts
import {
  contextCard,
  readEntries,
  treeService,
} from "../../../packages/pi-session-state/src/index.ts";
```

Every helper keeps its state in the closure of the call that made it, so call
them from the extension factory. Never keep their results in module scope: a
same-cwd subagent may share the module with its parent.

## Context card

```ts
contextCard(pi, {
  type: "example:context",
  // undefined for "no card now"; may be async.
  build: (ctx, messages) => (showCard ? formatCard(state) : undefined),
});
```

Registers the `context` handler that strips the previous request's card of
`type` and appends the current one as a `custom` message with `display: false`,
so it is never written to the transcript or shown in the TUI. The handler
returns `undefined` when nothing changed. `build` sees the messages with earlier
cards already removed, so it can check whether a visible tool result already
holds the state.

Whether the card is due is the extension's rule: keep its flag (set it on
`session_start`, `session_tree` or `session_compact`, clear it when the model
has seen the state) and read it in `build`.

A `build` that returns a promise is awaited; a card that resolves after
`session_shutdown` or a newer `session_start` is dropped, though the old card is
still stripped. A synchronous `build` gives a synchronous result. Pass `now` to
control the card's timestamp.

`applyCard(messages, type, build, now?)` is the same message surgery as a plain
function, for a handler that is tested on its own (pi-subagent's roster card).

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
