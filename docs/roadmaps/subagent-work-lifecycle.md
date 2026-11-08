# Subagents as background work

Status: draft · Updated: 2026-11-08

## Goal brief

Reimplement what PR #105 set out to do (workers that wait for jobs and wake up
again) on a simpler model:

- Every subagent runs in the background. The parent starts work, ends its turn,
  and is woken when the work is done. The completion message and stash handles
  carry everything the parent needs.
- An agent at rest is **idle**, whether it finished its task or is waiting on
  something. An idle agent with open work wakes up when that work finishes. Any
  idle agent takes new input from its parent.
- One generic **work** contract covers everything a session can wait on: jobs,
  subagents it delegated to, and questions to its parent. pi-job, pi-subagent
  and pi-ask are all producers on it, so nested delegation behaves like jobs do.
- An idle agent does not need a live session. Its session can be released after
  the retention window, or lost to a reload or restart, and is reopened from the
  transcript when the agent next runs.

Out of scope: print and JSON mode. Without foreground, `pi -p` returns before
background agents finish, and that is accepted.

## Answers

| Question                                        | Answer                                                                 | Source  |
| ----------------------------------------------- | ---------------------------------------------------------------------- | ------- |
| Merge PR #105 or reimplement?                   | Reimplement.                                                           | User    |
| Keep foreground subagents?                      | No. Drop `foreground` and every blocking path.                         | User    |
| Do print and JSON mode matter?                  | No.                                                                    | User    |
| How does the parent get large results?          | Through the completion message and stash handles.                      | User    |
| Should waiting and completed differ much?       | No. Both are an agent at rest.                                         | User    |
| Should a released or expired session come back? | Yes, on reload, restart and retention release alike.                   | User    |
| Who uses the work interface?                    | pi-job, delegated subagents, and ask.                                  | User    |
| Does ask in the root session change?            | No. It still asks the user in a dialog. Only the parent route changes. | Assumed |

## What exists

**On main (PR #105 not merged):**

- `Subagent` (`extensions/pi-subagent/src/lifecycle/subagent.ts`) models one run.
  Statuses are `queued | running | completed | aborted | stopped | error`. A
  resume of a finished agent runs at once and skips the concurrency limiter.
- Outcome delivery to the parent has several carriers: the completion message
  (`observation/notification.ts`, `NotificationManager`), the foreground call,
  a resume call with `foreground: true`, and `subagent_get` with `wait: true`.
  Claims and the consumed flag stop them from delivering twice.
- Retention releases a finished agent's session. A later resume reopens the
  transcript (`lifecycle/cold-resume.ts`), and saved records are rebuilt after
  a reload (`SubagentManager.rebuildFromSaved`).
- A parent shutdown, including reload, aborts and disposes every child.
- pi-job owns completion delivery in `extensions/pi-job/src/delivery.ts`: hold
  during a run, send a follow-up at `agent_end`, confirm it at `message_end`,
  resend unconfirmed ones once, and handle compaction. Jobs survive a reload
  through a process-wide owner registry keyed by session id
  (`ownership.ts`, `takeReloadOwner`, five-minute expiry).
- pi-ask, in a child, records the question with the parent's run
  (`ask:route` service). The child is told to end its turn, then completes
  carrying the question.
- `packages/pi-session-tree` lets one session offer a service under its id
  (`provide`) and find its ancestors.

**In PR #105, worth reusing:** the waiting and queued rows in the widget,
roster, watch overlay and dashboard. The `subagent:waiting` and
`subagent:queued` events. The waiting-workers tests, as a behaviour spec. The
idea of an activation service that child extensions find by session id.

**Friction**

| Friction                                                                                                                                                               | Where                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| One run per record; the assignment that spans runs was added beside it in about 13 private fields.                                                                     | `Subagent`                            |
| `queued` means "first slot" or "next run", told apart only by whether a session exists.                                                                                | `Subagent.isParked`                   |
| Four outcome carriers need claims, a consumed flag and a superseded-outcome slot to avoid double delivery.                                                             | notification, foreground, get, resume |
| A job completion arrives as a closure, not data, so it cannot survive a released session or a restart.                                                                 | `ActivationRoute.enqueue`             |
| pi-job is the only producer. A child's own background subagents are not pending work, so the child completes and their completion messages start unmanaged runs in it. | pi-subagent in a child                |
| Delivery logic lives in pi-job, so pi-subagent cannot reuse it.                                                                                                        | `pi-job/src/delivery.ts`              |
| A child has no UI, so pi-job's "completion not delivered" warning is silent there.                                                                                     | `bindExtensions({})`                  |
| A question alone completes the child, so "waiting for an answer" is a special case of completed.                                                                       | roster, outcome rendering             |

**Noticed, not doing:** keeping the process alive in print mode until work
finishes; detaching a child's running grandchildren from its session (step 11
keeps such a session live instead).

## Options

**A. Merge PR #105, then refactor `Subagent` in place.** Smallest diff today,
but keeps foreground, the four carriers and closure-based delivery, all of which
the new model removes.

**B. Reimplement on a work contract (chosen).** Close PR #105 and land the
feature in steps: extract delivery into a shared package, drop foreground, move
agents to an idle-based state model, then let jobs, subagents and ask all
produce work on one contract.

## Decision

Option B, chosen by the user on 2026-11-08. PR #105 is closed without merging;
its UI pieces and tests are carried into the steps below.

## Design

### The work contract (`work:v1`)

A **work host** exists for every session and is found by session id through
`pi-session-tree`. Producers never deliver messages themselves.

```ts
interface WorkHost {
  /** Something this session now waits on. Open work keeps an agent from finishing. */
  open(item: {
    owner: string;
    kind: string;
    label: string;
    detachable: boolean;
    data?: Json;
  }): WorkItem;
  /** Items left open by an earlier process or session instance, for their owner to adopt. */
  adopt(owner: string, adopt: (item: WorkItem) => boolean): void;
  list(): readonly WorkItemView[];
}

interface WorkItem {
  readonly id: string;
  /** Deliver a message without closing the item (progress, a question). Wakes the session. */
  notify(message: WorkMessage): void;
  /** Close the item and deliver its result. Wakes the session. */
  complete(message: WorkMessage): void;
  /** Close the item without a message. */
  cancel(): void;
}

/** Plain data, so it can be persisted and delivered later. */
type WorkMessage = { customType: string; content: string | TextPart[]; details?: Json };
```

- Items and undelivered messages are **data**, persisted by the host. Nothing
  depends on a closure surviving.
- **While the session runs**, a message is delivered into the current run as a
  follow-up, using the delivery state machine extracted from pi-job. This
  covers hold, follow-up at `agent_end`, confirmation and one resend.
- **While the session is idle**, the host's wake policy decides:
  - Root session: send the message and start a turn, as pi-job does today.
  - Child session: add the message to the agent's inbox and queue its next run
    through the concurrency limiter. Messages are appended before that run's
    prompt.
- **On session start**, the host offers persisted open items to their owners
  through `adopt`. Items no owner adopts by the end of startup are completed
  with a "lost" message, which wakes the session to deal with it.
- `detachable: true` means the producer keeps working without the session (pi-job
  through its owner registry). A session holding only detachable or passive
  items can be released.

### Agent state

| State     | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `queued`  | A run is waiting for a concurrency slot. Same for the first run and later ones. |
| `running` | A run is active.                                                                |
| `idle`    | No run. With open work it is waiting; with none it is done.                     |
| `stopped` | The parent stopped it. Its open work was cancelled.                             |

- How the last run ended (completed, turn limit or error) is recorded beside
  the state, with its result. It is not a state of its own.
- Every run, including the first, goes through one admission path and the
  limiter.
- Any agent that is not running takes input from the parent. A running agent is
  steered. An idle or stopped agent queues a run, reopening its transcript if
  the session was released.

### How the producers map onto it

- **pi-job:** `job_start` and `job_watch` open a detachable item and complete it
  with today's completion text. Reload re-adopts by id. After a restart the
  items are not adopted, so they come back as lost.
- **pi-subagent, for the session that spawned an agent:**
  - Spawning opens an item in the spawner's host.
  - The agent going idle with no open work completes that item with the
    completion message. The parent, root or child, is woken by its own host.
  - `parent_notify` updates go out through `notify`.
  - New input to a done agent opens a new item. Stopping an agent cancels it.
  - This replaces `NotificationManager`'s own queueing and delivery.
- **pi-ask, in a child:**
  - Ask opens a passive question item in the child's host, and notifies the
    parent through the child's agent item.
  - The child ends its turn and is idle and waiting.
  - The parent's next input to that agent answers the question and closes the
    item. `subagent_wait` is not needed: it is an ask with no question.

## Roadmap

### Make it easy

### 1. Pin today's parent-visible subagent behaviour

**Type:** tidy (characterization)
**Eases:** 3, 6, 7 (they change the code these tests cover)
**Does:** Add tests in `extensions/pi-subagent/test/characterization/` covering:
the completion message text for each outcome, steering a running agent,
resuming a finished agent (live and cold), retention release, and rebuilding
saved records after a reload. Tests go through `SubagentManager` and the tools,
not `Subagent` internals.
**Done when:** The tests pass on main and name each behaviour that later steps
keep or deliberately change.
**Verification:** `npm test` in pi-subagent. Spot-check each test by breaking
the behaviour it pins.
**Ships alone:** yes · **Rollback:** delete the folder
**Depends on:** none · **Size:** M

### 2. Move pi-job's delivery state machine into `packages/pi-work`

**Type:** tidy
**Eases:** 4 (both hosts need it), 9
**Does:** Create `packages/pi-work` with `Delivery`, `DeliveryHost` and
`dedupeCompletions` moved from `extensions/pi-job/src/delivery.ts`, and their
tests. pi-job imports from the package. Register the package in the root
manifest and the bundle check.
**Done when:** pi-job has no delivery code of its own and its tests pass
unchanged.
**Verification:** pi-job and pi-work suites, `npm run check`,
`npm run verify:bundle`.
**Ships alone:** yes · **Rollback:** revert the commit
**Depends on:** none · **Size:** S

### 3. Give `Subagent` one run abstraction

**Type:** tidy
**Eases:** 7 (state model), 9 (activations)
**Does:** Inside `Subagent`, introduce a `Run` value created by one `startRun`
path that the first run and resumes both use. Keep today's behaviour: a resume
still skips the limiter. Fold `scheduleVia`, `resume` and `runResume`
bookkeeping into it.
**Done when:** `Subagent` has one place that starts a run. Step 1's tests and
the existing suite pass unchanged.
**Verification:** pi-subagent suite.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 1 · **Size:** M

### 4. Define the work contract and the root host

**Type:** contract
**Eases:** 5, 8, 9, 10
**Does:** In `packages/pi-work`, add `WorkHost`, `WorkItem`, `WorkMessage` and
the `work:v1` service. Add `ensureWorkHost(pi)`: if no host is offered for this
session id, it provides the root host, whose wake policy starts a turn. Open
items and undelivered messages persist as custom entries. Startup runs adoption,
then completes unadopted items as lost. The host exposes a session's open items
for the widget and dashboard.
**Seam or contract:** `work:v1`. A host can be provided by someone other than
the session, which step 9 relies on.
**Done when:** A test extension can open an item, complete it while the session
is idle or running, and see it lost after a simulated restart.
**Verification:** pi-work unit tests, plus one test with a real `AgentSession`
and a scripted model (pattern from PR #105's `waiting-jobs.integration.test.ts`).
**Ships alone:** yes (nothing uses it yet) · **Rollback:** revert
**Depends on:** 2 · **Size:** M

### 5. Port pi-job to the work contract

**Type:** contract (producer retrofit)
**Eases:** 9, 11, 12
**Does:** pi-job opens a detachable item per job or watch and completes it on
exit or match. Its own `Delivery` use goes away. Reload re-adopts items through
the owner registry. `reportReloadLoss` and `historicalRunningJobs` are replaced
by lost items from the host. Delivery-failure warnings become lost messages, so
they reach the model in every session.
**Done when:** Every pi-job test passes. The reload-loss tests are rewritten to
expect lost items.
**Verification:** pi-job suite, plus a manual root session: start a watch,
`/reload`, see it re-adopted.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 4 · **Size:** M

### The change

### 6. Drop foreground and every blocking read

**Type:** the change (tool contract)
**Does:**

- `subagent_start` always runs in the background. Remove `foreground` and the
  print and JSON default.
- Remove `wait` from `subagent_get`, and the resume path that returns the
  result.
- Delete claims, the superseded-outcome slot, `spawnAndWait` and
  `foreground-runner.ts`.
- Update tool descriptions, the README, and the skills that mention foreground.
- Child prompts tell agents to `stash_put` large results and name the handle in
  their final answer.
  **Done when:** No code path blocks the parent on a subagent. The completion
  message is the only carrier of an outcome.
  **Verification:** pi-subagent suite with the foreground tests removed. Step 1's
  tests still pass for background. `npm run verify:bundle`.
  **Ships alone:** yes · **Rollback:** revert (restores foreground)
  **Depends on:** 1 · **Size:** M

### 7. Move agents to the idle state model

**Type:** the change
**Does:**

- Statuses become `queued | running | idle | stopped`, with the last run's
  outcome stored beside them.
- Every run, including resumes, goes through the limiter.
- Persisted records get a v2 shape. The reader maps v1 statuses:
  `completed`, `aborted` and `error` become `idle`, and a saved `queued` or
  `running` becomes idle with an interrupted outcome.
- The widget, roster, watch overlay, dashboard and events follow, reusing PR
  #105's rows.
- `subagent_steer` and `subagent_start resume` merge into one input tool (see
  Open questions). It steers a running agent and queues a run for any other.
  **Done when:** An idle agent of any outcome takes input. The roster shows idle
  and the last outcome. v1 records load.
  **Verification:** pi-subagent and pi-dashboard suites. A persistence test reads
  v1 fixtures. Narrow-width and ANSI rendering tests for the new rows.
  **Ships alone:** yes · **Rollback:** revert. v2 records written meanwhile need
  the v2 reader, so keep it.
  **Depends on:** 3, 6 · **Size:** L. Can split into 7a (state, persistence,
  limiter) and 7b (tools and UI).

### 8. Make pi-subagent a work producer for its spawner

**Type:** the change
**Does:**

- Spawning opens an item in the spawning session's host. Going idle with no
  open work completes it with the completion message. `parent_notify` goes
  through `notify`. Stop cancels the item, and new input opens a new one.
- `NotificationManager`'s queueing (holding while the parent runs, flushing at
  `agent_settled`) is removed. The host does that now.
- The completion message names stash handles, and the preview length is set
  for stash-first results.
  **Done when:** A root session gets the same completion and update messages as
  before, through the host. Step 1's message tests pass.
  **Verification:** pi-subagent suite. The integration test from step 4 is
  extended to spawn a scripted child.
  **Ships alone:** yes · **Rollback:** revert
  **Depends on:** 4, 7 · **Size:** M

### 9. Provide a managed work host for each child

**Type:** the change
**Does:**

- `Subagent` provides `work:v1` under its child's session id before the child's
  extensions bind, so `ensureWorkHost` in the child finds it.
- When a run ends with open items, the agent goes idle and waiting instead of
  done.
- Messages for an idle agent go to its persisted inbox and queue a run. A
  running child gets them as follow-ups through the pi-work delivery state
  machine, bound to the child session.
- Nested delegation now works with no extra code: a child's own subagents are
  items in its host.
  **Done when:**
- A child with a running job or a running grandchild goes idle-waiting.
- The completion wakes it through the limiter.
- A completion during a run is delivered into that run.
- No message ever starts an unmanaged run in a child.
  **Verification:** Port PR #105's waiting-workers tests to this model. Add a
  nested-delegation test, and a real-session test with `job_watch`.
  **Ships alone:** yes · **Rollback:** revert
  **Depends on:** 5, 8 · **Size:** L. Split into 9a (host, parking, inbox) and
  9b (mid-run delivery) if review needs it.

### 10. Route a child's ask through the work contract

**Type:** the change
**Does:**

- In a child, `ask` opens a passive question item and notifies the parent
  through the agent's item. Its tool text tells the child to end its turn.
- The parent's next input closes open question items and becomes the run's
  prompt.
- Remove the `ask:route` record path, `pendingQuestion` as an outcome field,
  and the roster's "waiting for your answer" special case.
- The root session's ask is unchanged.
  **Done when:** A child that asks is idle-waiting. The parent sees the question
  once, and answering wakes the child with the answer.
  **Verification:** pi-ask and pi-subagent suites. One test with a job and a
  question open together.
  **Ships alone:** yes · **Rollback:** revert
  **Depends on:** 9 · **Size:** S

### 11. Release idle sessions and reopen them on demand

**Type:** the change
**Does:**

- Retention releases any idle agent's session after its window, waiting ones
  included, when every open item is detachable or passive.
- A child with a running grandchild keeps its session, because agent items are
  not detachable yet.
- Job items stay with pi-job's owner registry, with no expiry while the item is
  open. Completions for a released agent land in its inbox.
- The next run reopens the transcript and re-adopts items.
  **Done when:** A waiting agent with a long CI watch has its session released.
  The watch's completion reopens it and the run sees the completion.
  **Verification:** pi-subagent tests with fake timers. A real-session test that
  releases and then reopens.
  **Ships alone:** yes · **Rollback:** revert. Idle sessions are then kept until
  the parent shuts down.
  **Depends on:** 5, 9 · **Size:** M

### 12. Keep idle agents across parent reload and restart

**Type:** the change
**Does:**

- On parent reload, idle records survive. Their hosts are provided again under
  each child's session id at `session_start`. Children's jobs stay with pi-job's
  owner registry.
- On restart, idle agents are rebuilt with their open items and inbox. Items no
  producer adopts complete as lost and wake the agent (see Open questions).
- Running agents still end on reload or restart, and their runs are recorded as
  interrupted.
  **Done when:**
- After `/reload`, a waiting agent is still listed, and its job's completion
  wakes it.
- After a restart, it wakes with a "lost" message and can be steered.
  **Verification:** Reload and restart tests at the manager level. A manual
  reload in a TUI session using the tui-screenshot skill's driver.
  **Ships alone:** yes · **Rollback:** revert
  **Depends on:** 11 · **Size:** M

### Clean up

### 13. Remove scaffolding and close out PR #105

**Type:** cleanup
**Does:**

- Delete leftovers: claim helpers, foreground rendering, and the old status
  strings and events that step 7 replaced.
- Update the pi-subagent, pi-job, pi-ask and pi-session-tree READMEs, and add a
  pi-work README.
- Add CHANGELOG entries for the vendored extensions.
- Update `skills/execute-roadmap` and `skills/make-it-easy` text that mentions
  foreground or `wait: true`.
- Close PR #105 with a link to this roadmap.
  **Done when:** A search for `foreground`, `claim(` and `wait: true` in the
  extensions finds nothing stale. Docs describe the idle model.
  **Verification:** `npm run check`, `npm run verify:bundle`, full `npm test`.
  **Ships alone:** yes · **Rollback:** revert
  **Depends on:** 10, 12 · **Size:** S

**Start with:** steps 1 and 2. Both are safe to start today and can run in
parallel.

## Open questions

1. **One input tool or two?** Recommend `subagent_send(agent_id, message)`,
   replacing `subagent_steer` and `subagent_start`'s `resume`. The alternative
   is to keep `subagent_steer` and widen it to idle agents. Blocks step 7b.
2. **Is a separate `subagent_wait` tool needed?** PR #105 added one. Recommend
   no: a child that needs guidance asks, and that is the same work item with a
   question attached. Blocks step 10.
3. **After a restart, should lost work wake the agent on its own?** Recommend
   yes, through the limiter, since a lost job is a finished job with a bad
   result. The alternative is to tell the parent and let it decide, which
   avoids spending tokens at startup. Blocks step 12.
4. **Can a stopped agent take input?** Recommend yes: input reopens it like any
   idle agent, and stop only cancels its open work. Blocks step 7.
5. **Completion preview length** once stash handles are the norm: keep 500
   characters, or shorten to a summary plus handles? Blocks step 8.
6. **Detaching grandchildren** so that a delegating child's session can be
   released (process-level ownership of child managers). Deferred. Step 11
   keeps such sessions live.
