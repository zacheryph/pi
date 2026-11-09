# pi-work

A small library (not an extension) that defines the **work contract**, `work:v1`:
everything a Pi session can wait on (a job, a subagent it delegated to, a question
to its parent) is an _item_ in the session's **work host**. Producers open items
and complete them with a message; the host persists the items, writes the messages
into the session's transcript and wakes the session when it is idle.

pi-job is the first producer: each job or watch is an item, and a reload re-adopts
them. The roadmap in `docs/roadmaps/subagent-work-lifecycle.md` ports pi-subagent
and pi-ask onto it.

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
import { ensureWorkHost } from "../../../packages/pi-work/src/index.ts";

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

| When the message arrives           | What happens                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session idle                       | The root host sends it with `triggerTurn: true`: Pi starts a run with the message as its trigger.                                                                               |
| A run is active                    | `triggerTurn: false`: Pi appends it at the end of the current turn. If no other turn follows, `agent_before_settle` returns `continue: true`: one more request in the same run. |
| Escape or abort during the run     | The message is in the transcript, no turn is forced, and the next run sees it.                                                                                                  |
| Pi busy without a run (compaction) | `triggerTurn: false`: appended at once, answered by the next run.                                                                                                               |

`src/delivery.ts` holds the mechanism (`Delivery`, `continuesRun`). It was moved
here from pi-job, which now completes items and leaves delivery to the host.

`complete` closes the item as soon as it hands the message over, while a message sent mid-run is
appended by Pi at the end of the turn. If the process dies in between, the message is not in the
transcript and the item is closed, so nothing reports it lost. The window is the rest of one turn;
it matters little for jobs, which die with the process, but producers whose work survives a restart
should know it.

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

`createWorkHost({ store, delivery, onLost })` (`src/host.ts`) is the host without
Pi: `store` persists records and `delivery` is the **wake policy**, a
`DeliveryHost`: whether the session is idle, and how a batch of messages reaches
the transcript in mode `"wake"` or `"record"`. The root session sends with
`sendMessage`. A managed child (roadmap step 9) provides its own under the child's
session id before the child's extensions bind: it writes messages to the child's
session and, for `"wake"`, asks the agent's manager for a run through the
concurrency limiter. `ensureWorkHost` then finds that host, provides nothing and
only forwards the session's run boundaries (`agent_start`, `agent_settled`,
`agent_before_settle`) to it. The host decides when startup ends for it:
`ensureWorkHost` only settles hosts it provided itself.

## Development

```bash
npm run check --workspace=pi-work
npm test --workspace=pi-work
```

`test/session.test.ts` runs the root host against a real `AgentSession` on the
faux model: open and complete while idle and while running, abort, and a simulated
restart from a session file.
