# pi-session-tree

A small library (not an extension) that lets extensions in different Pi
sessions in one process find each other. A parent session can reach the
services its subagents' extensions offer, and a subagent can reach its
ancestors'.

pi-stash (auto-bubbling entries to ancestors) and pi-todo (delegated tasks) will
build on it.

## Why `globalThis`

pi-subagents runs every subagent as a full in-process Pi session:

| | Scope |
|---|---|
| Extension closure state | per session (each factory call) |
| `pi.events` bus | per session (each resource loader creates its own) |
| Session JSONL, `pi.appendEntry` | per session |
| Extension module scope | sometimes shared: Pi 1.4.0 caches an extension's module per cwd until a reload, so a same-cwd child may reuse the parent's module and a worktree child does not |
| `globalThis` | the whole process |

So the registry lives at `globalThis[Symbol.for("pi-personal.session-tree.v1")]`.
A value of another shape under that key is replaced, not trusted.

## Links

pi-subagents emits `subagents:child:session-created { sessionId, parentSessionId,
agentId, toolCallId?, handoff? }` synchronously on the **parent's** bus, before the
child binds its extensions, and `subagents:child:disposed { sessionId, ... }` after
the child shut down.
`trackChildren(pi)` follows both, so a child's `session_start` handlers always
find their parent link. Call it from the extension factory, so the subscription
exists before any spawn. Calling it from several extensions is harmless.

Do not use the child's `header.parentSession` instead: pi-subagents writes a
session id there, but Pi writes a file path there for forks.

## Services

```ts
import {
  ancestors, call, callAsync, provide, trackChildren,
} from "../../../packages/pi-session-tree/src/index.ts";

export default function extension(pi: ExtensionAPI) {
  trackChildren(pi);
  let withdraw: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    withdraw = provide(ctx.sessionManager.getSessionId(), "pi-example", {
      notify: (text: string) => { /* runs in this session, with this session's pi */ },
    });
  });
  pi.on("session_shutdown", () => withdraw?.());
}

// Elsewhere, in a child session:
for (const id of ancestors(childSessionId)) {
  const result = call<{ notify(text: string): void }, void>(id, "pi-example", (api) => api.notify("hi"));
  if (!result.ok) { /* "missing", or "error" with the thrown error */ }
}
```

- `provide(id, name, api)` returns a disposer. A later `provide` for the same
  name (a new extension instance after `/reload`) replaces the entry, and the
  old disposer then does nothing.
- Between `session_shutdown` and the next `session_start` a session offers
  nothing. `service()` returns `undefined` and `call()` returns
  `{ ok: false, reason: "missing" }`.
- After a reload, every call on a captured `pi` or `ctx` throws. `call()`
  catches that and returns `{ ok: false, reason: "error" }`, so one stale
  session cannot break its relatives.
- `call()` is for synchronous services. Use `callAsync()` for a service that
  returns a promise: it awaits inside its guard, so a rejection (including a
  stale context throwing inside an async function) becomes
  `{ ok: false, reason: "error" }`. `call()` refuses a returned promise with an
  error result, because it cannot check it synchronously.
- A top-level session's node is removed when its last service is withdrawn,
  because no child-disposed event will ever arrive for it. A linked child's node
  stays until `subagents:child:disposed`, so its parent link and handoff survive
  the gap between the child's `session_shutdown` and its disposal.
- `appendEntry` on the receiving session's own `pi` is safe even while that
  session is mid-turn. It appends at the current leaf, which pi-stash and
  pi-todo already do during tool execution.

Navigation: `parentOf`, `ancestors` (nearest first), `root`, `children`,
`descendants` (breadth first), `node` (with the child's `agentId` and `handoff`).

When pi-subagents' parent session shuts down for any reason, including
`/reload`, it aborts and disposes every child. So every ancestor of a live
session is itself live.

## Importing

Extensions import the source by relative path, as they do for pi-subagents'
vendored service. Node subpath `imports` cannot point outside a package, and a
Git-installed bundle does not link workspaces. `test/sdk.test.ts` loads two
fixture extensions through Pi's real loader to check that the relative import
resolves, and that two module copies share one registry.

## Development

```bash
npm run check --workspace=pi-session-tree
npm test --workspace=pi-session-tree
```
