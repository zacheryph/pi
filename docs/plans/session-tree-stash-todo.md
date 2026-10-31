# Session tree: stash and todo across subagents

Status: proposed · Pi SDK checked: `@earendil-works/pi-coding-agent` 1.4.0

## Goal

- A stash entry a subagent stores shows up in its ancestors' `stash_list`, `/stash`,
  context card and dashboard as soon as it is stored. The storing agent can choose how
  far the entry travels, and can widen that later.
- A parent hands specific todo items to a subagent at spawn time. The subagent sees
  and updates only what it was handed (or the whole ledger, if the parent says so).
  It may add tasks. Every change lands in the parent's ledger, widget, context and
  dashboard immediately.

## How it works today

Pi runs every subagent as a full in-process session. For each child, pi-subagents
builds a `DefaultResourceLoader`, creates an `AgentSession`, and calls
`bindExtensions()`, so every extension factory runs again for that child.

| Thing | Scope | Notes |
|---|---|---|
| Extension closure state (`index`, `state`) | per session | Each factory call creates it fresh. |
| `pi.events` bus | per session | Each `DefaultResourceLoader` creates its own `createEventBus()` unless one is passed in. pi-subagents passes none. |
| Session JSONL, `pi.appendEntry` | per session | A tree of entries with a leaf pointer. Extensions replay their custom entries from `getBranch()`. |
| Extension module scope | sometimes shared | See "Module cache" below. Never rely on it. |
| `globalThis` | process | `Symbol.for(key)` names the same slot from every module copy. |
| Stash blobs (`~/.pi/agent/stash`) | machine | Content-addressed and shared. |

So a child's `stash_put` writes the blob to the shared store and the index entry to
the child's own JSONL. The parent's `stash_list` replays only the parent's branch, so
the entry never appears there. `stash_get` with a full handle works anyway, because it
falls back to the blob store. Todo works the same way, except it has no shared store.

## Pi SDK checks (1.4.0)

| Claim | Verdict | Evidence |
|---|---|---|
| Each child has its own event bus. | Confirmed | `core/resource-loader.js:248` creates a new bus when none is given; `pi-subagents/src/index.ts:125` builds the child loader without one. |
| Module-level variables are never shared between extension copies. | **Partly wrong** | `core/extensions/loader.js:464-492` caches each extension's factory by resolved path for the current cwd. A child in the same cwd reuses the parent's imported module, so module scope is shared. A child in a different cwd (a worktree) clears the cache (`loader.js:97-104`), and `resourceLoader.reload()` clears it too (`resource-loader.js:357-360`). Whether module scope is shared depends on the situation, so use `globalThis` with explicit session keys. |
| `appendEntry` from another session's call is safe mid-turn. | Confirmed, with a caveat | `core/agent-session.js:2783` → `session-manager.js:901` appends synchronously at the current leaf and persists it (`_persist`, `session-manager.js:794`). Nothing checks turn state. Custom entries are not LLM messages. pi-stash and pi-todo already append during tool execution. Caveat: the entry lands between the parent's in-flight assistant message and its tool results. That already happens today. |
| A captured `pi`/`ctx` goes stale. | Confirmed | Reload: `agent-session.js:2998-3028` emits `session_shutdown{reason:"reload"}` → `oldRunner.invalidate()` → re-imports modules → new factories → `session_start{reason:"reload"}`. After `invalidate()`, every call on the old API throws "This extension ctx is stale…", and all its bus subscriptions are removed (`loader.js:114-163`). The same applies to `newSession`, `fork` and `switchSession`. |
| The child's header records its parent. | **Unusable** | pi-subagents writes the parent *session id* into `header.parentSession` (`create-subagent-session.ts:286`). Pi itself writes a parent *file path* there for forks (`session-manager.js:1248`, `1404`). Use the lifecycle event instead. |
| An extension can veto a tool call before it runs. | Confirmed | `tool_call` handlers may return `{ block: true, reason }` (`core/extensions/types.d.ts:1089`). |

Two facts from this repo the design relies on:

- `subagents:child:session-created { sessionId, parentSessionId, agentId, toolCallId?, handoff? }` is emitted
  synchronously on the **parent's** bus before the child binds
  (`create-subagent-session.ts:321-325`). The parent's extensions therefore record the
  link before any child `session_start` runs.
- When the parent's pi-subagents shuts down, for any reason including reload, it aborts
  and disposes every child (`handlers/lifecycle.ts:58-63`). A live child never outlives
  its parent's runtime, so every ancestor in a live chain is also live.

## Design

### Session tree registry (shared)

A process-wide registry holds one node per live session:

```ts
// globalThis[Symbol.for("pi-personal.session-tree.v1")]
interface SessionTree {
  version: 1;
  nodes: Map<string, SessionNode>;            // key: session id
}
interface SessionNode {
  id: string;
  parent?: string;                            // parent session id (from child:session-created)
  agentId?: string;                           // pi-subagents record id, stable across resume
  handoff?: Handoff;                          // what the parent handed this child at spawn
  services: Map<string, { token: object; api: unknown }>; // "pi-stash", "pi-todo", …
}
```

- **Linking:** each extension calls `trackChildren(pi, tree)` on its own session bus.
  That subscribes to `subagents:child:session-created` (create the child node and set
  `parent`, `agentId`, `handoff`) and `subagents:child:disposed` (drop the node).
  Calling it from more than one extension is harmless.
- **Services:** an extension calls `provide(sessionId, name, api)` on `session_start`
  and the returned disposer on `session_shutdown`. `service(sessionId, name)` returns
  the API only while its token is current. `call(sessionId, name, fn)` wraps `fn` in a
  try/catch so a stale runtime is skipped instead of crashing the caller.
- **Navigation:** `parentOf`, `ancestors` (nearest first), `children`, `descendants`,
  `root`.
- **Compatibility:** the key carries a version. A newly loaded module checks the shape
  of any registry it finds (the `compatibleOwner` pattern from
  `pi-jobs/src/ownership.ts`) and replaces it if the shape is wrong.

### Stash: scopes and auto-bubble

Each record carries a `scope`. The storing session always holds the record.

| Scope | Also held by |
|---|---|
| `self` | nobody else |
| `parent` | the direct parent |
| `ancestors` | every ancestor up to the root |
| `descendants` | every child and grandchild, now and later |
| `tree` | its line of descent: `ancestors` + `descendants` (never siblings or cousins) |

Reach is a set, and scopes are ordered by inclusion: `self` ⊂ `parent` ⊂ `ancestors`
⊂ `tree`, and `self` ⊂ `descendants` ⊂ `tree`. `parent` and `descendants` are not
comparable.

- Default scope: `self` in a root session, `ancestors` in a subagent. Both are
  configurable (`stash.defaultScope`, `stash.subagentScope`).
- **Up (real time):** after journaling locally, the child calls `adopt(record)` on
  its parent only. Each `adopt` journals the record and calls `adopt` on its own
  parent, up to the root (or the scope's limit); a missing or stale session ends the
  chain there. `adopt` journals `{ op: "put", record, via: "adopt" }` in
  that ancestor's session, updates its index and publishes its snapshot (which updates
  the dashboard). It also turns on that ancestor's index card. With scopes, each
  `adopt` forwards only while the next parent is still in the record's reach (for
  example `parent` stops after one hop).
- **Reach is decided by the origin, never the holder.** A record's origin is the
  session that created it (`createdBy`). Session T may hold it only when:
  - upward scopes (`parent`, `ancestors`, `tree`): T is the origin's parent
    (`parent`) or one of its ancestors (`ancestors`, `tree`);
  - downward scopes (`descendants`, `tree`): the origin is one of T's ancestors.

  An ancestor that holds an adopted copy does **not** pass it on to its own other
  children. Otherwise a `tree` entry from child A, adopted into parent P, would leak
  to A's sibling B.
- **Down:** on `session_start`, a child T looks at the records its ancestors hold
  with scope `descendants` or `tree`, and inherits only those whose origin is in
  `ancestors(T)`. It journals them locally with `via: "inherit"`, so a later resume
  still has them. This works after the origin has ended, because it checks T's own
  live chain. A put (or widening) with a downward scope is pushed to the live
  `descendants(origin)`, not to the holder's descendants.
- **Changing scope (widen only):** `stash_scope { ref, scope }`, allowed only in the
  session that created the record. The new scope must include the old one (see the
  ordering above). Widening journals `{ op: "scope", id, scope }` and propagates to
  the newly reached sessions right away. Anything else (narrowing, or moving sideways
  such as `parent` → `descendants`) is an error, and the message names the scopes that
  would be valid. Nothing is ever retracted.
- **Private entries:** when a subagent stores a `self`-scoped entry, each live
  ancestor journals a metadata-only marker `{ op: "private", id, agent, session }`
  with no name, description or handle. `stash_list` and `/stash` show one dim line per
  agent ("+3 private entries in explore#a3f2"). The context card shows a single total
  line. If the entry later widens to reach that ancestor, the adopted record replaces
  its marker (matched by `id`). Cost: one more op in replay and a count in the list
  and card renderers.
- Scope controls discoverability, not access. Any session on the machine can read
  content by full handle. The docs and the tool description must say so.
- **Names:** adopted records keep their name. The newest version wins for bare-name
  lookups, as when a session puts the same name twice. Older versions stay reachable
  by handle. `stash_list` and `/stash` show who stored each entry.
- **Schema:** stays at v1. New fields are optional: `id`, `scope`, `via`, `agent`.
  New ops are `scope` and `private`. Older code ignores unknown ops
  (`state.ts:65-66` only acts on `put` and `checkpoint`), so this is forward
  compatible.
- **Manual escape hatch:** `stash_put { name, handle }` adopts an existing blob by
  handle. It covers resumed children whose parent has gone, and handles found in old
  transcripts.

### Todo: pre-claimed handoff

- **Parent:** `subagent({ …, handoff: { todos: { keys: ["auth-audit", "auth-tests"], scope: "assigned" } } })`,
  using pi-subagents' generic `handoff` (pi-todo owns the `todos` key and documents it
  in its own tool guidance). `scope: "ledger"` lets the child read the whole ledger while writing only its
  claims. `SpawnOptions.handoff` does the same for `getSubagentsService().spawn()`.
- **Validation before spawn:** the parent's pi-todo handles `tool_call` for
  `subagent`. Unknown keys, completed keys, or keys a live sibling already holds return
  `{ block: true, reason }`, so the spawn never happens. If the call is valid, pi-todo
  remembers a pending claim under `toolCallId`.
- **Binding:** on `subagents:child:session-created` (which now carries `agentId`,
  `toolCallId` and `handoff`), the parent journals a claim in a new append-only entry,
  `pi-personal:todo-claims`: `{ op: "claim", keys, agent, session, scope }`. This
  happens before the child binds. Claims sit beside the plan state in the same way
  review watermarks do, so the upstream state engine (`state.ts`, which drops unknown
  task fields) stays unchanged.
- **Child (delegated mode):** on `session_start` the child finds its node's parent
  broker:
  - `todo list` and the context snapshot show only the claimed tasks (`assigned`), or
    the whole ledger with claims marked (`ledger`).
  - `upsert` on a claimed key goes to `broker.mutate(request, { agent })`. A new key
    is created in the parent's ledger and claimed by this child. Its `dependsOn` may
    name any ledger key.
  - Unclaimed keys: in `assigned` mode the child cannot see them, so any write fails.
    In `ledger` mode the child may **add prerequisites** to an unclaimed task: a patch
    with only `key` and `dependsOn`, where the new list contains the old one. That lets
    a child report "this parent task is blocked by something I found". Every such
    change records a flagged history message on the affected task ("explore#a3f2
    added prerequisite db-migration"). Other fields, removing edges, and status
    changes on unclaimed tasks still fail. This is an experiment; if agents abuse it,
    turn it off with config.
  - In delegated mode, `baseRevision` is checked against the child's last read of its
    own tasks, not the global revision, so concurrent siblings don't cause stale-write
    errors.
  - `replace` and whole-ledger `clear` are refused. `remove` and completed-only `clear`
    are limited to the child's claims.
- **Parent effects for free:** `broker.mutate` runs the parent's existing `mutate()`.
  That journals into the parent session, refreshes the widget, re-injects context and
  publishes to the dashboard. Child messages are recorded with `by: { agent }` and
  flagged for review like any other message.
- **Release:** on `subagents:completed`/`failed` or `child:disposed`, the parent
  journals `{ op: "release", agent }`. Tasks left `in_progress` get a flagged history
  message: "explore#a3f2 ended (failed) with this task in progress". The claim record
  stays as assignment history. The parent can always edit any task, claimed or not.
- **Fallback:** with no live parent broker (root session, resumed child after a
  restart), the child's todo works locally exactly as today.

### pi-subagents service slot

Each child loads pi-subagents too. At load it overwrites
`globalThis[Symbol.for("@gotgenes/pi-subagents:service")]`. On shutdown it deletes the
slot without checking whose service is in it. Nothing in this repo needs a child to
own that slot, so this is a defect, not a design choice. The ADR only explains why
`globalThis` is used (module copies don't share scope); it never says a child should
take over the slot.

## Pull requests

Each PR passes `npm run check`, `npm test` and `npm run verify:bundle`, and follows
AGENTS.md (UI spacing tests at narrow widths, `commit.gpgsign=false`).

### PR 1 — pi-subagents: stop children clobbering the service slot

- Publish to a per-session map. Keep the legacy single slot pointing at the
  **outermost** live service. A child never replaces the slot; it is only added to the
  map.
- Unpublish removes only this instance (identity check) and moves the slot to the next
  outermost live service.
- `getSubagentsService(sessionId?)`: with an id, that session's service; without one,
  the outermost, which matches the behavior callers already expect.
- Tests: parent publishes, child publishes then unpublishes, parent is still returned;
  reload ordering (shutdown, then a new publish).
- No dependencies. Can land first.

### PR 2 — `packages/pi-session-tree`: shared registry library

- New workspace `packages/pi-session-tree` with no `pi` manifest entry, so it never
  loads as an extension and `verify:bundle` is unaffected. Extensions import it by
  relative path (`../../../packages/pi-session-tree/src/index.ts`). jiti resolves that
  in all three load modes, and Node subpath `imports` cannot point outside a package.
- API: `sessionTree()`, `trackChildren(pi, tree?)`, `provide(id, name, api)`,
  `service<T>(id, name)`, `call(id, name, fn)`, `parentOf`, `ancestors`, `children`,
  `descendants`, `root`, plus the `Handoff` type.
- Versioned key, shape check, liveness tokens, fail-soft calls.
- Tests: link ordering (session-created before the child's session_start); dispose;
  reload gap (calls between shutdown and start return undefined); a stale API that
  throws is skipped; two module copies share one registry.
- README: the threading model from "How it works today" and the SDK checks above.
- No dependencies.

### PR 3 — pi-stash: auto-bubble to ancestors

- Depends on PR 2.
- Add `provide("pi-stash", { adopt })`, `trackChildren`, and record fields `id`,
  `via`, `agent`. A subagent's put bubbles to all ancestors (fixed `ancestors` scope;
  scope selection comes in PR 4).
- Adoption turns on the existing context-only index card in the ancestor (its model
  never saw a receipt for the entry, the same reason the card shows after
  compaction), with "from <agent>" on adopted rows. This replaces the separate
  one-request note first planned, which would have reached only one request.
- `stash_put { handle }` manual adopt.
- `/stash` and `stash_list` show the origin agent.
- Tests: child put appears in parent and grandparent indexes and snapshots; a parent
  `/tree` back to before the spawn drops it; a parent reload mid-run fails soft;
  replay of `via: "adopt"` entries; render tests for the origin column at narrow
  widths.

### PR 4 — pi-stash: scopes

- Depends on PR 3.
- `scope` parameter on `stash_put`; `stash_scope` tool (widen only, otherwise an
  error); downward inherit at child `session_start`; live push for
  `descendants`/`tree`; config defaults.
- Private markers: `private` op, "+N private entries in <agent>" rows in
  `stash_list` and `/stash`, one total line in the context card, and the marker
  replaced when the entry widens.
- Tool text states that scope controls discoverability, not access.
- Tests: each scope's reach in a three-level tree with siblings (`tree` must not
  reach siblings or cousins); an A/P/B case where child A puts a `tree` entry, it
  is adopted into P, and sibling B started afterwards does not inherit it (and a
  live B does not receive the push); widening after the fact; narrowing and sideways moves
  are errors; private counts per agent and their replacement on widening; a resumed
  child keeps inherited entries; checkpoint after compaction keeps the new fields
  and markers; render tests for the private row at narrow widths.

### PR 5 — pi-subagents: handoff channel

- Independent of PRs 2-4. Needed by PR 6.
- `subagent` tool and `SpawnOptions`: a generic `handoff` object whose top-level
  keys belong to other extensions (pi-todo will read `todos: { keys, scope }`).
  pi-subagents only checks it is a JSON object within 16 KB, copies and freezes it,
  and forwards it, so new handoff data never needs a pi-subagents change.
- `subagents:child:session-created`, `bound` and `disposed` gain `agentId` and
  `toolCallId`; `session-created` also gains `handoff`. All are optional additions to
  the payload.
- Update `docs/architecture/architecture.md` (event table) and `UPSTREAM.md` (local
  changes).
- Tests: payload contents for tool spawns and service spawns. (A resume reuses the
  live child session, so `session-created` fires once per agent.)

### PR 6 — pi-todo: delegated tasks

- Depends on PRs 2 and 5.
- Parent: `tool_call` veto for an invalid `handoff.todos`, plus a tool guideline documenting that key; claim, release and history-message
  journaling in `pi-personal:todo-claims`; broker via `provide("pi-todo", …)`.
- Child: delegated mode as described above; scoped `list`, context and widget.
  Widget title "Assigned tasks".
- Parent UI: an assignee badge in the widget and `/todos` browser (`→ explore#a3f2`);
  `TodoSnapshotTask.claimedBy` (optional, snapshot stays v1) for the dashboard.
- Orchestrator prompt (`pi-subagents/src/config/default-agents.ts`): hand off with
  `handoff.todos` instead of describing tasks in prose.
- `ledger`-mode prerequisite additions on unclaimed tasks, with flagged history
  messages and a config switch (`todos.childPrerequisites`, default on).
- Tests: the veto cases; a child sees only its claims; a child-added task appears in
  the parent; `ledger` mode adds a prerequisite to an unclaimed task but cannot change
  its other fields or remove edges; per-key stale checks; release on failure flags in-progress tasks;
  fallback with no broker; render tests for the badge at narrow widths and with
  wide/ANSI text.

### PR 7 — dashboard and polish (optional)

- Dashboard: show stash origin and scope, and todo assignee, using the new optional
  snapshot fields.
- Nested handoff: a child may pass its own claims to a grandchild. The root ledger
  stays authoritative and the claim moves to the leaf agent.

## Decisions

1. `tree` means the line of descent (ancestors + descendants), not every session
   under the root.
2. A subagent's `self`-scoped entries appear in each ancestor as a "+N private
   entries in <agent>" line (metadata-only `private` op; small cost).
3. Scope only widens. Narrowing or moving sideways is an error.
4. In `ledger` mode a child may add prerequisites to tasks it does not hold, with a
   flagged history message for each. This is an experiment behind a config switch.
