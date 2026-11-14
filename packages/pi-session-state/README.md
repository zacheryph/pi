# pi-session-state

A small library (not an extension) for the session wiring that extensions with
persistent state share: a card that restores state after a compaction, a
service in the [session tree](../pi-session-tree/README.md), and replay of
custom entries. Import it through the workspace alias:

```ts
import { readEntries, restoreCard, treeService } from "#session-state";
```

Every helper keeps its state in the closure of the call that made it, so call
them from the extension factory. Never keep their results in module scope: a
same-cwd subagent may share the module with its parent.

## Restore card

```ts
restoreCard(pi, {
  type: "example:context",
  // The card's text; undefined when there is nothing to restore. May be async.
  build: (ctx, event) => formatCard(state),
});
```

For state the model saw in tool results (handles, IDs, paths) that a compaction
summarizes away. After `session_compact` it writes the card into the transcript
once, with `pi.sendMessage({ customType: type, content, display: false },
{ triggerTurn: false })`: hidden in the TUI, sent to the model like any other
message. Pi holds a message sent while a run streams until the turn ends, so the
card never lands between a tool call and its result.

The card stays where it was written: later requests carry it in the same place,
so the model reads it once and the conversation's prompt cache keeps working.
The next compaction summarizes it with everything else and writes a fresh one.

Only a compaction loses state. After `session_start` (any reason) and
`session_tree` the card is written only when the branch's latest compaction has
no card of `type` after it, such as a session compacted before the extension
wrote cards; `cardMissing(ctx, type)` is that check. `build` is not called
otherwise.

`build` runs after the extension's own handlers for the event that were
registered before `restoreCard`, so register it after the handlers that rebuild
the state it reads. An async result is dropped after shutdown, a newer restore
event, or once a card of `type` reached the branch.

Nothing in this bundle adds a message to the end of every request: a message
there moves on each call, so the model reads it as the newest message, and on
providers with explicit cache breakpoints (Anthropic) the conversation is not
cached while it is sent. State that changes under the model is written into the
transcript when it changes instead (pi-todo's `todo:sync` note).

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
npm run check
npm run test:workspace -- pi-session-state
```
