# pi-work

A small library (not an extension) that defines the **work contract**, `work:v1`:
everything a Pi session can wait on (a job, a subagent it delegated to, a question
to its parent) is an _item_ in the session's **work host**. Producers open items
and complete them with a message; the host persists the items, writes the messages
into the session's transcript and wakes the session when it is idle.

pi-job and pi-subagent are producers. Each job or watch is an item, and a reload
re-adopts it. Each subagent run a session asks for is an item in that session's
host, completed by the run's completion message. Each subagent child has a managed
host of its own, provided by pi-subagent, so a child that ends its turn with work open
is waiting, not done. The roadmap in `docs/roadmaps/subagent-work-lifecycle.md` ports
pi-ask onto it.

## The contract (`src/contract.ts`)

```ts
interface WorkHost {
  open(item: { owner: string; kind: string; label: string; data?: Json }): WorkItem;
  adopt(owner: string, adopt: (item: WorkItem) => boolean): void;
  list(): readonly WorkItemView[];
}

interface WorkItem extends WorkItemView {
  notify(message: WorkMessage): void; // deliver, keep the item open (progress, a question)
  complete(message: WorkMessage): void; // deliver the result and close
  cancel(): void; // close without a message
}

type WorkMessage = { customType: string; content: string | TextPart[]; details?: Json };
```

A host is found by session id through
[pi-session-tree](../pi-session-tree/README.md): `service(sessionId, WORK_SERVICE)`
with `WORK_SERVICE = "work:v1"`.

- `open` persists the item. An open item is data, so it survives a reload and a
  restart.
- `notify` and `complete` write the message into the transcript at once. Once an
  item is closed (or its host is gone) every method on its handle does nothing, so
  a result cannot be delivered twice.
- `list` returns the open items, oldest first, for the widget and the dashboard.

## Using it from an extension

```ts
import { ensureWorkHost } from "#work";

export default function extension(pi: ExtensionAPI) {
  const work = ensureWorkHost(pi); // call from the factory, before registering session_start

  pi.on("session_start", (_event, ctx) => {
    // Take back what an earlier instance left open. Do it here, during session_start.
    work.host()?.adopt("my-extension", (item) => {
      resume(item.data); // return true when you took it over
      return true;
    });
  });

  // Later, in a tool:
  const item = work
    .host()!
    .open({ owner: "my-extension", kind: "job", label: "CI", data: { run: 7 } });
  // ... when it finishes:
  item.complete({ customType: "my-extension:done", content: "CI passed" });
}
```

`ensureWorkHost(pi)` is idempotent per `pi` and cheap to call from every producer.
It registers the session's run-boundary handlers, and at `session_start` it
provides the **root host** unless a host is already offered under the session id.
`work.host()` is `undefined` before `session_start` and after `session_shutdown`.

## Delivery

A message is a custom message in the transcript, so the transcript is the inbox.
The host sends it with `pi.sendMessage` and lets Pi's run boundaries do the rest:

| When the message arrives             | What happens                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session idle                         | The root host sends it with `triggerTurn: true`: Pi starts a run with the message as its trigger.                                                                               |
| A run is active                      | `triggerTurn: false`: Pi appends it at the end of the current turn. If no other turn follows, `agent_before_settle` returns `continue: true`: one more request in the same run. |
| Escape or abort during the run       | The message is in the transcript, no turn is forced, and the next run sees it.                                                                                                  |
| Pi busy without a run (compaction)   | `triggerTurn: false`: appended at once. The root host then owes a wake, paid when Pi is idle (below).                                                                           |
| After the run's last settle decision | Appended as the run ends. The root host owes a wake, paid when Pi is idle (below).                                                                                              |

`src/delivery.ts` holds the mechanism (`Delivery`, `continuesRun`). It was moved
here from pi-job, which now completes items and leaves delivery to the host.

### The wake the root host owes

A message can reach the transcript at a moment when nothing starts a run for it: Pi is busy
without a run (a manual `/compact`), or the run is past its last chance to continue (another
extension completed an item after the host's `agent_before_settle` handler, before
`agent_settled`). The root host then owes the session a wake and pays it once Pi is idle, with one
`work:wake` message (`WORK_WAKE`) sent with `triggerTurn: true`. The message carries no result:
the results are the work messages before it. Several messages owed together are answered by one
run.

Pi has no extension event for "idle again", and `waitForIdle()` exists only on a command context.
So the root host registers one command, `/work:wake` (`WORK_WAKE_COMMAND`), dispatches it to itself
with `pi.sendUserMessage("/work:wake", { expandPromptTemplates: true })` and waits there. Pi
resolves that wait on every path out of a compaction, a `/tree` summary or a run, however long
other extensions' handlers take, so nothing is polled and no timer guesses. The command is
registered by the extension instance that provides the root host, at `session_start`. Typed by a
user it only reports whether anything waits.

| What happened while the wake was owed                          | Result                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| The compaction succeeded                                       | One run, when Pi is idle.                                               |
| The compaction failed for a reason other than a cancel         | One run: the failure does not concern the work.                         |
| The compaction was cancelled (Escape, an extension's `cancel`) | No run. The message waits for the next prompt, as after an aborted run. |
| The run that ended was aborted, or failed                      | No run.                                                                 |
| A prompt was submitted (one queued during the compaction too)  | No wake: that prompt's run sees the message.                            |
| `/tree` moved the leaf, the session was reloaded or replaced   | The wake is dropped with the branch or instance it was owed on.         |
| `/tree` was cancelled or its summary failed                    | No run: Pi emits no event that says how it ended.                       |

Where no command context can wait (an `AgentSession` whose embedder binds no command actions), the
wake is paid only if Pi is already idle; otherwise the message waits for the next prompt, as before.
What remains Pi-side is in pi-job's `UPSTREAM-ISSUES.md`: an idle wake can still collide with a
user prompt that is being prepared (#1).

### When an item closes

A close record means the result is in the transcript. `complete` hands the message to delivery, and
the item's close record is written only once the message has landed:

- A message appended at once (the session is idle, or the host's transport writes the session file)
  closes the item right away.
- A message Pi holds until the end of the turn closes it then. Pi tells extensions nothing when it
  appends such a message, so the root host reads the newest transcript entries after a send and at
  the boundaries after a turn ends (`turn_start`, `agent_before_settle`, `agent_end`,
  `agent_settled`, and one tick after any `message_end`), only while an item waits.
- Only entries after the transcript position recorded at the send count, so an identical message
  that landed earlier is never taken for a new one, and waiting items are matched in the order they
  were sent. An item stops waiting (it stays open on disk, so the next start reports it lost) once
  the leaf has moved off the branch it was sent on, or a run has settled without its message landing.
- If the process dies in between, the item stays open on disk and the next start reports it
  lost. The same holds when delivery refuses the message: `Delivery.add` returns `false` once
  delivery is disposed (a stale context after a reload or a session replacement), and `complete`
  then leaves the item open instead of closing it as done.

`WorkHostOptions.confirmLanding` turns the wait on; the root host and a managed child's host both set
it. A transport that writes the session file itself and never holds a message may leave it off. A
transport that holds messages calls `host.messageLanded(message)` when one is in the transcript.

### The landing tracker (`src/landing.ts`)

`createLandingTracker({ branch, target })` is the reader. Whoever provides a host makes one tracker
for it, passes `tracker.mark` as the host's `landingMark`, and reports the run boundaries to
`tracker.observe(...)` (`message_end`, `turn_start`, `agent_end`, `agent_before_settle`,
`agent_settled`, `session_tree`, `session_shutdown`) and every send to `tracker.sent()`. The tracker
reads the newest transcript entries only while an item waits, hands each custom message to
`host.messageLanded` with the mark check above, and gives up on what cannot land any more.

- The root host (`ensureWorkHost`) and a managed child's host (pi-subagent's `ChildWork`) use the
  same tracker; they differ only in where the transcript and the boundaries come from. The root
  reads the session context and the extension events; the child reads its `SessionManager` and the
  session's own events.
- **One reader per host.** An extension that only finds a host that someone else provided
  (`ensureWorkHost` in a managed child) forwards `agent_start`, `agent_settled` and
  `agent_before_settle` to it and reads no landing. A second reader would poll twice and drop the
  waiting items whose marks it did not make.
- Both hosts answer a message that landed between the last `agent_before_settle` and
  `agent_settled`. A managed child asks its manager for a run; the root owes a wake (above).
- `tracker.unanswered(delivers)` answers a second transcript question: does the transcript end with a
  message of a type the host delivered (`host.delivers(customType)`) and no answer after it? A
  managed child asks it at `agent_settled` to find a message that arrived after the run's last
  chance to continue.

## Persistence

Open items are append-only records in the session file, custom entries of type
`work:item` (`WorkRecord`):

```jsonc
{ "v": 1, "op": "open",  "id": "<uuid>", "owner": "pi-job", "kind": "watch", "label": "CI", "data": {…}, "at": 1794197583040 }
{ "v": 1, "op": "close", "id": "<uuid>", "reason": "completed" | "cancelled" | "lost", "at": 1794197590000 }
```

An item is open when it has an `open` record and no `close` record on the current
branch. Messages are not stored separately.

## Startup, adoption and lost work

At `session_start` the root host reads the open records of the branch. Each owner
then calls `adopt(owner, fn)` from its own `session_start` handler and returns
`true` for the items it takes over (a reload handoff, a question it can ask again).
After every extension's `session_start` has finished (Pi's `resources_discover`
event fires then; the first `before_agent_start` is the fallback), the host closes
every item nobody adopted as **lost**:

- the close record has `reason: "lost"`, so the next start reports nothing again;
- one `work:lost` message lists the items and says that nothing was restarted;
- it is appended without starting a turn (`triggerTurn: false`, idle or not), so
  lost work never wakes anything on its own. The TUI shows it and the model sees it
  on its next run.

## Providing a host for someone else

`createWorkHost({ store, delivery, onLost, onChange })` (`src/host.ts`) is the host without
Pi: `store` persists records and `delivery` is the **wake policy**, a
`DeliveryHost`: whether the session is idle, and how a batch of messages reaches
the transcript in mode `"wake"` or `"record"`. The root session sends with
`sendMessage`. A managed child (pi-subagent's `ChildWork`, roadmap step 9) provides
its own under the child's session id before the child's extensions bind: its store is
the child's session file, it writes messages to the child's transcript (appended at once
while the child is idle, held by Pi until the end of the turn while it runs, so it
confirms landing with its own tracker) and, for `"wake"`, asks the agent's manager for a
run through the concurrency limiter. `ensureWorkHost` then
finds that host, provides nothing and only forwards the session's run boundaries
(`agent_start`, `agent_settled`, `agent_before_settle`) to it and reads no landing. The host decides when
startup ends for it: `ensureWorkHost` only settles hosts it provided itself, so the
provider calls `settleStartup()` once the session's extensions have started.

`cancelOpen()` on the runtime (not on the `WorkHost` producers see) closes every open item as
cancelled with no message: the owner of the session stopped it, so the next start loses nothing.
`cancelOpen(match)` closes only the items `match` accepts: a delegator's answer closes the
`QUESTION_KIND` items its child asked and leaves the child's jobs open.

A delegated session reaches the item its delegator holds for it through the `WORK_PARENT_SERVICE`
(`work:parent`) service the delegator offers under the session's id before the session's
extensions bind. `WorkParent.question(text)` tells the delegator a question once; the asking
session waits on an item of kind `QUESTION_KIND` in its own host (pi-ask opens it, and adopts it
again after a reload or restart).

`onChange` is called after the set of open items changed (an item opened, completed,
cancelled or lost; not for a `notify`), after any wake the change caused, so a reader sees
the state the session is in. A display redraws on it, and an agent that went idle on its
items learns that the last one is gone. A throwing listener is ignored.

## Development

```bash
npm run check
npm run test:workspace -- pi-work
```

`test/session.test.ts` runs the root host against a real `AgentSession` on the
faux model: open and complete while idle and while running, abort, and a simulated
restart from a session file.
