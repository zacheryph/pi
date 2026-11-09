# Subagents as background work

Status: chosen · Updated: 2026-11-09

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
- An agent's session is never released while it has open work: a job, a
  subagent of its own, or a question to its parent. An idle agent with no open
  work can have its session released after the retention window, or lose it to
  a reload or restart, and it is reopened from the transcript when the agent
  next gets input.
- Work lost to a reload or restart is reported to the agent's parent, never
  restarted on its own. The parent or the user decides whether to send the
  agent more.

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
| Can a session with active work be cleaned up?   | No. Any open work holds it, a question included.                       | User    |
| One input tool for steer and resume?            | Yes: `subagent_send`.                                                  | User    |
| Drop `subagent_wait`?                           | Yes. A child that needs guidance asks.                                 | User    |
| What happens to work lost on restart?           | It is reported to the parent. Nothing restarts on its own.             | User    |
| Can a stopped or done agent take input?         | Yes, like a main session resumed days later.                           | User    |
| Completion preview length?                      | Keep 500 characters.                                                   | User    |

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

**In the Pi SDK (1.4.0), to use instead of building:**

| SDK feature                                                                                                                                                                                                                   | What it replaces in this plan                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi.sendMessage(msg, { triggerTurn: false })`. Idle: the message is appended to the session file at once. Running: Pi holds it and appends it at the end of the current turn, so it never splits a tool call from its result. | A separate persisted inbox, and pi-job's follow-up queueing. The session transcript is the inbox.                                                                                                              |
| `agent_before_settle` (since 0.87). A handler can return `continue: true` for one more model request, and sees whether the run completed, aborted or failed.                                                                  | pi-job's follow-up at `agent_end`, its confirmation at `message_end` and its one resend. Nothing enters Pi's follow-up queue, so Escape and abort cannot drop a completion (pi-job's `UPSTREAM-ISSUES.md` #3). |
| `turn_end` boundary, with the same entries and `continue` result.                                                                                                                                                             | Not needed by default. Available if a completion should reach the model before the run's last turn.                                                                                                            |
| `pi.sendMessage(msg, { triggerTurn: true })` while idle starts a run with the message as its trigger (`before_agent_start` reports `messageType: "custom"`).                                                                  | The synthetic "Background work completed" prompt for a child's activation, if `SubagentSession` can drive a run started this way.                                                                              |
| Tool results with `terminate: true` end the turn after a tool batch in which every tool terminates.                                                                                                                           | Telling a child in prose to end its turn after `ask`.                                                                                                                                                          |
| `SessionManager.open(path)` and `appendCustomMessageEntry()` write to a session file without an `AgentSession`.                                                                                                               | Reopening an agent just to record lost work in its transcript after a restart.                                                                                                                                 |
| `session_start` and `session_shutdown` reasons (`startup`, `reload`, `resume`, ...).                                                                                                                                          | Guessing why a session started when deciding what to adopt.                                                                                                                                                    |

**Not in the SDK, so built here:** the concurrency limiter, the cross-session
service registry (`pi.events` is per session), a work ledger, and an atomic way
to wake an idle session. pi-job's `UPSTREAM-ISSUES.md` #1 and #2 describe the
races that the idle `triggerTurn: true` path still has; this plan does not fix
them.

**In PR #105, worth reusing:** the waiting and queued rows in the widget,
roster, watch overlay and dashboard. The `subagent:waiting` and
`subagent:queued` events. The waiting-workers tests, as a behaviour spec. The
idea of an activation service that child extensions find by session id.

**Friction**

| Friction                                                                                                                                                                                             | Where                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| One run per record; the assignment that spans runs was added beside it in about 13 private fields.                                                                                                   | `Subagent`                            |
| `queued` means "first slot" or "next run", told apart only by whether a session exists.                                                                                                              | `Subagent.isParked`                   |
| Four outcome carriers need claims, a consumed flag and a superseded-outcome slot to avoid double delivery.                                                                                           | notification, foreground, get, resume |
| A job completion arrives as a closure, not data, so it cannot survive a released session or a restart.                                                                                               | `ActivationRoute.enqueue`             |
| pi-job is the only producer. A child's own background subagents are not pending work, so the child completes and their completion messages start unmanaged runs in it.                               | pi-subagent in a child                |
| Delivery logic lives in pi-job, so pi-subagent cannot reuse it. It sends follow-ups that Escape and abort can drop, then confirms and resends to make up for it, where Pi's run boundaries would do. | `pi-job/src/delivery.ts`              |
| A child has no UI, so pi-job's "completion not delivered" warning is silent there.                                                                                                                   | `bindExtensions({})`                  |
| A question alone completes the child, so "waiting for an answer" is a special case of completed.                                                                                                     | roster, outcome rendering             |

**Noticed, not doing:** keeping the process alive in print mode until work
finishes; keeping work alive while its session is released. Open work holds
the session instead.

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
  open(item: { owner: string; kind: string; label: string; data?: Json }): WorkItem;
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

/** Plain data, written into the session's transcript as a custom message. */
type WorkMessage = { customType: string; content: string | TextPart[]; details?: Json };
```

- Open items are **data**, persisted by the host as custom entries. Messages
  are not stored separately: the host writes each one into the session's
  transcript as soon as it arrives, with `sendMessage(..., { triggerTurn: false })`.
  The transcript is the inbox, so undelivered messages survive a released
  session, a reload and a restart with nothing extra to store.
- **While the session runs**, Pi appends the message at the end of the current
  turn. The host's `agent_before_settle` handler returns `continue: true` when a
  work message landed after the last assistant message and the run was not
  aborted, so the model answers it in the same run. After an Escape the message
  stays in the transcript for the next run, and no turn is forced.
- **While the session is idle**, the message is already in the transcript, and
  the host's wake policy starts the next run:
  - Root session: start a run with the message as its trigger
    (`triggerTurn: true`), as pi-job does today.
  - Child session: ask the agent's manager for a run, which queues through the
    concurrency limiter.
- **On session start**, the host offers persisted open items to their owners
  through `adopt`. Items no owner adopts by the end of startup are closed as
  lost. Lost work never wakes anything on its own:
  - In a child, the loss is written into the child's transcript for its next
    run (through `SessionManager.open` when no session is live) and reported to
    its parent through the agent's item.
  - In the root session, it is shown without starting a turn.
- A session with any open item is never released. There is one kind of item:
  a question holds its session the same way a job does.

### Agent state

| State     | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `queued`  | A run is waiting for a concurrency slot. Same for the first run and later ones. |
| `running` | A run is active.                                                                |
| `idle`    | No run. With open work it is waiting; with none it is done.                     |

- How the last run ended (completed, turn limit, error or stopped) is recorded
  beside the state, with its result. Stopping an agent ends its run and cancels
  its open work; the agent is then idle.
- Waiting is not a stored state, but the UI still shows it. The widget, status
  bar, roster, watch overlay and dashboard derive it from the agent's open work:
  an idle agent with open items shows as **waiting**, naming what it waits on
  (`waiting: CI`, `waiting: answer`); one without shows as **done** with its
  last outcome.
- Every run, including the first, goes through one admission path and the
  limiter.
- `subagent_send(agent_id, message)` is the one input tool, like a user typing
  into a main session. A running agent is steered. Any idle agent queues a run,
  reopening its transcript if the session was released, however long ago it
  finished.

### How the producers map onto it

- **pi-job:** `job_start` and `job_watch` open an item and complete it
  with today's completion text. Reload re-adopts by id through pi-job's existing
  reload handoff. After a restart the jobs are gone, so the items come back as
  lost.
- **pi-subagent, for the session that spawned an agent:**
  - Spawning opens an item in the spawner's host.
  - The agent going idle with no open work completes that item with the
    completion message. The parent, root or child, is woken by its own host.
  - `parent_notify` updates go out through `notify`.
  - New input to a done agent opens a new item. Stopping an agent cancels it.
  - This replaces `NotificationManager`'s own queueing and delivery.
- **pi-ask, in a child:**
  - Ask opens a question item in the child's host, and notifies the parent
    through the child's agent item.
  - The ask tool returns `terminate: true`, so the child's turn ends after the
    tool batch. The child is then idle and waiting.
  - The parent's next `subagent_send` answers the question and closes the
    item. There is no `subagent_wait`: a child that needs guidance asks.
  - The question holds the child's session like any other open item. pi-ask
    adopts its question items on session start, so a question survives a
    reload or restart and is never reported lost.

## Roadmap

### Make it easy

### 1. Pin today's parent-visible subagent behaviour

**Type:** tidy (characterization)
**Eases:** 3, 6, 7a (they change the code these tests cover)
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

### 2. Deliver pi-job completions through Pi's run boundaries

**Type:** migration
**Eases:** 4 (the root host reuses this delivery), 9
**Does:**

- First, add a test with a real `AgentSession` and a scripted model that pins
  the SDK behaviour this relies on: a custom message sent with
  `triggerTurn: false` mid-run lands after the turn, `continue: true` from
  `agent_before_settle` produces one more model request that sees it, and an
  Escape leaves it in the transcript.
- Then, in pi-job, send each completion with `triggerTurn: false` while a run is
  active, and continue the run from `agent_before_settle`. Keep the idle path
  (`triggerTurn: true`).
- Remove the follow-up queue, `confirm`, the recovery batches and the
  compaction-end drains from `delivery.ts`. Keep `dedupeCompletions` for
  transcripts written by the old code.
- Mark issue #3 in `UPSTREAM-ISSUES.md` as no longer affecting pi-job.

**Done when:** Completions during a run reach the model in that run. A
completion sent before an Escape is in the transcript and not lost.
**Verification:** The SDK test above, the pi-job suite with the
follow-up-recovery tests replaced, and a manual root session: start a short
job, keep the agent busy, see the completion answered in the same run.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** none · **Size:** M

### 3. Give `Subagent` one run abstraction

**Type:** tidy
**Eases:** 7a (state model), 9 (activations)
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
**Does:** Create `packages/pi-work` (registered in the root manifest and the
bundle check) and move step 2's boundary delivery into it. Add `WorkHost`,
`WorkItem`, `WorkMessage` and the `work:v1` service. Add `ensureWorkHost(pi)`:
if no host is offered for this session id, it provides the root host, whose wake
policy starts a turn. Open items persist as custom entries; messages go straight
into the transcript. Startup runs adoption,
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
**Does:** pi-job opens an item per job or watch and completes it on exit
or match. Its own `Delivery` use goes away. Reload re-adopts items through the
existing owner registry. `reportReloadLoss` and `historicalRunningJobs` are
replaced by lost items from the host. Delivery-failure warnings become lost
messages, so they reach the model in every session, children included.
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

### 7a. Move agents to the idle state model

**Type:** the change
**Does:**

- Statuses become `queued | running | idle`. The last run's outcome
  (completed, turn limit, error or stopped) and result are stored beside them.
- Stop ends the run and leaves the agent idle.
- Every run, including resumes, goes through the limiter.
- Persisted records get a v2 shape. The reader maps v1 statuses: `completed`,
  `aborted`, `error` and `stopped` become `idle` with that outcome, and a saved
  `queued` or `running` becomes idle with an interrupted outcome.

**Done when:** An idle agent of any outcome accepts a new run. v1 records load.
**Verification:** pi-subagent suite. A persistence test reads v1 fixtures.
**Ships alone:** yes · **Rollback:** revert. v2 records written meanwhile need
the v2 reader, so keep it.
**Depends on:** 3, 6 · **Size:** M

### 7b. Replace steer and resume with `subagent_send`

**Type:** the change (tool contract)
**Does:**

- Add `subagent_send(agent_id, message)`: steers a running agent, and queues a
  run for an idle one, reopening its transcript if needed.
- Remove `subagent_steer` and `subagent_start`'s `resume`.
- The widget, roster, watch overlay, dashboard and events show idle agents as
  done with their last outcome, reusing PR #105's rows. Waiting appears in
  step 9, once agents have open work.
- Update skills and READMEs that name the old tools.

**Done when:** One tool reaches an agent in any state. The roster shows idle and
the last outcome.
**Verification:** pi-subagent and pi-dashboard suites. Narrow-width and ANSI
rendering tests for the new rows. `npm run verify:bundle`.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 7a · **Size:** M

### 8. Make pi-subagent a work producer for its spawner

**Type:** the change
**Does:**

- Spawning opens an item in the spawning session's host. Going idle with
  no open work completes it with the completion message. `parent_notify` goes
  through `notify`. Stop cancels the item, and new input opens a new one.
- `NotificationManager`'s queueing (holding while the parent runs, flushing at
  `agent_settled`) is removed. The host does that now.
- The completion message keeps its 500-character preview and names stash
  handles.

**Done when:** A root session gets the same completion and update messages as
before, through the host. Step 1's message tests pass.
**Verification:** pi-subagent suite. The integration test from step 4 is
extended to spawn a scripted child.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 4, 7b · **Size:** M

### 9. Provide a managed work host for each child

**Type:** the change
**Does:**

- `Subagent` provides `work:v1` under its child's session id before the child's
  extensions bind, so `ensureWorkHost` in the child finds it.
- When a run ends with open items, the agent goes idle and waiting instead of
  done.
- Messages go into the child's transcript through the same pi-work delivery as
  the root. For an idle child the host asks the manager for a run, which queues
  through the limiter. A running child answers them in the same run.
- The run starts from the transcript as it stands. Prefer starting it with the
  newest message as its trigger, as the root does; if `SubagentSession`'s
  turn-budget wrapper cannot drive a run started that way, use a short fixed
  prompt. Decide inside this step.
- Nested delegation now works with no extra code: a child's own subagents are
  items in its host.
- The widget, status bar, roster, watch overlay and dashboard show an idle
  agent with open items as waiting, with the items' labels, and count it under
  "waiting" in the status bar. Waiting rows stay visible and show no clock.

**Done when:**

- A child with a running job or a running subagent of its own goes idle and
  waiting.
- The completion wakes it through the limiter.
- A completion during a run is delivered into that run.
- No message ever starts an unmanaged run in a child.
- The widget shows `waiting: CI` for an idle agent with an open watch, and
  `done` once the watch completes and the agent finishes.

**Verification:** Port PR #105's waiting-workers tests to this model. Add a
nested-delegation test, and a real-session test with `job_watch`.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 5, 8 · **Size:** L. Split into 9a (host, parking, wake) and 9b
(mid-run delivery) if review needs it.

### 10. Route a child's ask through the work contract

**Type:** the change
**Does:**

- In a child, `ask` opens a question item, notifies the parent through the
  agent's item, and returns `terminate: true` so the child's turn ends.
- pi-ask adopts its open question items on session start, so questions survive
  a reload or restart.
- The parent's next `subagent_send` closes open question items and becomes the
  run's prompt.
- Remove the `ask:route` record path, `pendingQuestion` as an outcome field,
  and the roster's "waiting for your answer" special case.
- The root session's ask is unchanged.

**Done when:** A child that asks is idle and waiting, and keeps its session.
The parent sees the question once, and answering wakes the child with the
answer. An open question is still open after a reload.
**Verification:** pi-ask and pi-subagent suites. One test with a job and a
question open together.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 9 · **Size:** S

### 11. Release idle sessions with no open work

**Type:** the change
**Does:**

- Retention releases an idle agent's session after its window only when it has
  no open work. Waiting agents keep their sessions.
- Input to a released agent reopens the transcript and runs it.
- No work has to outlive its session, so nothing detaches from it.

**Done when:**

- An agent with any open item (job, subagent or question) is never released.
- A done agent is released after its window, and `subagent_send` reopens it.

**Verification:** pi-subagent tests with fake timers. A real-session test that
releases and then reopens.
**Ships alone:** yes · **Rollback:** revert. Idle sessions are then kept until
the parent shuts down.
**Depends on:** 9, 10 · **Size:** S

### 12. Keep idle agents across parent reload and restart, and report lost work

**Type:** the change
**Does:**

- On parent reload, every agent record survives. At the parent's
  `session_start`, agents that had open work get their sessions reopened
  without a model run, so producers can re-adopt: pi-job within its reload
  handoff window, pi-ask always. Their hosts are provided again under each child's
  session id.
- A child's own subagents end with the reload, so their items are lost.
- On restart, agents are rebuilt idle with their open items, and those with open
  items are reopened the same way. Messages that arrived before the restart are
  already in their transcripts. Jobs and subagents cannot be
  adopted after a restart and are lost; questions are adopted and stay open.
- Lost work is reported to the agent's parent in one message per startup that
  lists each agent and what it lost. It is also written into each agent's
  transcript with `SessionManager.open` and `appendCustomMessageEntry`, so the
  agent sees it on its next run without being reopened now.
  Nothing restarts on its own.
- A run in progress at reload or restart ends with an interrupted outcome.

**Done when:**

- After `/reload`, an agent waiting on a job is still waiting, and the job's
  completion wakes it.
- After a restart, the parent gets one message naming the agents that lost
  work. Those agents are idle and take `subagent_send`.

**Verification:** Reload and restart tests at the manager level. A manual reload
in a TUI session using the tui-screenshot skill's driver.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 11 · **Size:** M

### Clean up

### 13. Remove scaffolding and close out PR #105

**Type:** cleanup
**Does:**

- Delete leftovers: claim helpers, foreground rendering, and the old status
  strings and events that steps 7a and 7b replaced.
- Update the pi-subagent, pi-job, pi-ask and pi-session-tree READMEs, and add a
  pi-work README.
- Add CHANGELOG entries for the vendored extensions.
- Update `skills/execute-roadmap` and `skills/make-it-easy` text that mentions
  foreground, `wait: true`, `subagent_steer` or `resume`.
- Close PR #105 with a link to this roadmap.

**Done when:** A search for `foreground`, `claim(`, `wait: true` and
`subagent_steer` in the extensions and skills finds nothing stale. Docs describe
the idle model.
**Verification:** `npm run check`, `npm run verify:bundle`, full `npm test`.
**Ships alone:** yes · **Rollback:** revert
**Depends on:** 10, 12 · **Size:** S

**Start with:** steps 1 and 2. Both are safe to start today and can run in
parallel.

## Open questions

None block a step. The earlier questions are answered in the Answers table.
