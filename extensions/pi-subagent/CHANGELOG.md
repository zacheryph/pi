# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## 2026-11-12: Centralize browser fallback in pi-ui

- Prepare the definitions browser lazily behind pi-ui's TUI gate; preserve settings, navigation and passive-overlay policies.

## 2026-11-12: Share the snapshot version with dashboard consumers

- Export the version alongside the typed snapshot contract; dashboard projections now use that contract.

## 2026-11-11: Use the shared session-state helpers

Issue #127. No behaviour change.

- The `RosterCard` class is now `registerRosterCard(pi, { getLive, now, isReachable })`, built
  on `contextCard` from `packages/pi-session-state` with `restore`. The helper strips and appends
  the card, shows it after a compaction, reload, resume, fork or `/tree` when the branch has
  agents, and hides it at shutdown; the roster keeps its rule that a `subagent_get` list result
  after the card was shown turns it off. `index.ts` no longer registers the card's session,
  context and shutdown handlers itself. The card's tests drive it through a fake Pi.
- `readPersistedRecords`, the main agent profile snapshot and the work entries read by
  `transcript-work.ts` and `child-work.ts` use `customData` and `readEntries` instead of
  hand-written `type === "custom" && customType === ...` filters.

## 2026-11-11: Drop compatibility with older records and settings

Issue #129.

- `persisted-record.ts`: removed `LEGACY_STATUS` and the version 1 read path. An entry without
  `version: 2` is skipped, so a session written by an older version restores without those agents.
- `settings.ts`: removed `legacyGraceTurns` and the `graceTurns` warning; the key is now dropped
  silently like any unknown one. `warnAboutRetiredSettings` is `warnAboutAdjustedSettings` and only
  reports a clamped `defaultMaxTurns`. `docs/configuration.md` no longer mentions `graceTurns`.
- `subagent_start` no longer refuses a `resume` argument, which has not been in its schema since
  roadmap step 7b; the schema test stays.
- `get-result-renderer.ts`: `modelName` is documented as absent while an inherited model is
  unknown, not as missing from older details.
- Removed `test/legacy-records-sdk.test.ts`, the version 1 cases in `persisted-record.test.ts`,
  `records-sdk.test.ts` and `ui/session-navigator.test.ts`, and the `resume` refusal tests.

## 2026-11-10: Publish branch-scoped subagent snapshots

- Added `subagent:snapshot` version 1, built from the same saved-record/live-state roster as
  `subagent_get`. Startup restoration, tree navigation and lifecycle/progress changes publish
  complete snapshots, including empty branches. Fine-grained lifecycle events remain unchanged.
- The dashboard replaces its roster from that contract instead of reconstructing state from
  only the events seen since it loaded. Restored history, waiting labels, interrupted runs,
  live progress and branch changes are reflected without reading another extension's internals.
- Real-session coverage pins running/completed updates, reload restoration and tree removal;
  producer and dashboard tests cover live overrides, waiting, malformed snapshots and row limits.

## 2026-11-10: Align orchestration prompts and add a bounded implementation profile

- Correct the orchestrator's child lifecycle guidance: workers and delegated coordinators can wait on jobs or nested workers and wake through the limiter. A PR owner may use `babysit-pr` for CI and review follow-ups.
- Add `implement`, a non-delegating profile for one bounded code change and its verification. Model and thinking settings inherit as usual; project coordination remains with `orchestrate`.
- Keep handed-off task acceptance with the parent. Reviewers report the checked commit SHA and diff range; the parent records evidence and revalidates after code changes.

## 2026-11-10: A late session must not write to a reopened transcript; shutdown during a restore

Second repair round on roadmap step 12.

- **The hazard.** A child that hung past the restore bound kept its creation promise, and when the
  session finally arrived `createSubagentSession` ran `settleStartup` against the transcript, which
  `subagent_send` may have reopened and appended to meanwhile: a second `close:lost` and `work:lost`,
  and entries hanging from a stale parent, so the entry tree forked and the reopened branch could end
  at the late session's strays (the whole exchange missing). Its disposal also published `disposed`,
  which makes the session registry forget the id the newer session holds.
- **The fix.** `CreateSubagentSessionParams.isStale` (set by `Subagent.restore` when the bound passes,
  and by the manager's shutdown) is checked after the loader reloads, after the session is built (before
  anything is offered under the session id) and after `bindExtensions` returns; a stale creation throws
  `StaleSessionError` and discards the session with no write to the transcript and **no** `disposed`
  event (`SubagentSession.dispose(reason, publish)`). `ChildWork` takes the same check as a second layer:
  a stale host refuses every write (`open` throws, a completion is refused so its item stays open,
  `settleStartup` is skipped). The work service and `work:parent` registrations were already
  token-guarded by `provide`, so the abandoned session's withdrawal never removes a newer one's
  (now tested).
- **Shutdown during a restore.** A record being reopened is in no registry, so `dispose` did not see
  it. The manager now tracks `restoring` records: `suspend` and `dispose` mark them (their creation reads
  stale and is discarded), and once disposed `restoreOne` starts no more agents and registers, persists,
  closes and reports nothing for one that completes (a session a factory built anyway is disposed).
  The report call in `index.ts` tolerates a session that is already gone.
- **Docs.** `architecture.md` no longer says `details` carries every agent; both docs describe the stale
  check.
- **Tests.** `restore-sdk.test.ts`: a child waiting on an item nobody adopts hangs past the bound, the
  parent `subagent_send`s it, and the late session arrives before and after the new run ends (one entry
  tree leaf, exactly one `work:lost` and one lost close, the exchange on the reopened branch, the late
  session shut down once, no `disposed` event); the fixture hangs only the first reopened session.
  `create-subagent-session.test.ts` (a stale creation settles nothing, writes nothing, publishes nothing,
  leaves a newer session's registration), `child-work.test.ts` (a stale host writes nothing; a newer
  registration survives), `lifecycle/restore.test.ts` (a restore that completes after dispose registers
  and writes nothing, with and without a factory that honours staleness). With every stale guard removed
  the real-session tests fail; each layer is also pinned by its unit test.

## 2026-11-10: Bound the restore of a hung child, bound the lost report's details, escape quotes

Repair round on roadmap step 12 (same day, same change as the entry below).

- **A hung child no longer blocks the parent's startup.** `StartupRestore` awaits `manager.restore`,
  whose per-agent work awaited `createSubagentSession` (and so the child's `bindExtensions`) with no
  bound; the UI has not started, so ESC cannot interrupt it. `Subagent.restore(startReason, timeoutMs)`
  now races the creation against a timer (`RESTORE_TIMEOUT_MS`, 20 s, injectable as
  `SubagentManagerOptions.restoreTimeoutMs`; no setting) and returns `timed-out`. The agent is
  `unreachable: "timed-out"`: its saved record is left untouched (a later `subagent_send` reopens it, and
  the next start tries again), nothing is closed or claimed lost (nothing is known), and its adopted
  spawner item is cancelled. The creation promise is kept, so a session that arrives late is disposed
  (never attached: no run, no slot, no leak). A hung agent holds one of the four lanes for the bound
  at most. It appears in the one `subagent:lost` message as "could not be reopened at startup (opening its
  session took too long), so its work was not checked", with a sentence that its work may still be open
  and `subagent_send` reopens it; the header then reads "Subagent startup report" instead of claiming
  work was lost.
- **The report's `details` are bounded.** They were unbounded (500 agents x 50 items was 13.7 MB written
  into the parent's session file). They now carry at most 30 agents and 8 items of each list, every text
  clipped (200 characters, ids 40), plus `totalAgents` and per agent `lostCount` and `waitingOnCount`;
  clipping looks only at the head of a long text, so a megabyte label costs nothing.
- **Quotes in the report text.** Labels, descriptions and waiting labels are quoted with `"` and `\`
  escaped, still one line with control characters stripped.
- **Tests.** `lifecycle/restore.test.ts` (fake timers, a never-resolving creation: the others restore, the
  late session is disposed once, the record is kept and not persisted, one lane at most, the injected
  bound, no timer left behind), `restore-sdk.test.ts` (a real child that hangs in `session_start` through
  `fixtures/hang-on-reopen.ts`: the reload returns, the other child is waiting, one message names the
  hung one, its record is intact, the late session is disposed, `subagent_send` reopens it),
  `handlers/restore.test.ts`, and `observation/lost-report.test.ts` (hostile and large input, the cap
  and the counts, escaping, the timed-out wording). Removing the bound or the late disposal fails them.

## 2026-11-10: Keep agents across a parent reload and restart, and report lost work

Roadmap step 12 (`docs/roadmaps/subagent-work-lifecycle.md`): a parent shutdown no longer stops
waiting agents, and the next start gives them back. See README "Reload, restart and lost work" and
`docs/architecture/architecture.md` for the model.

- **A shutdown suspends, it does not stop.** `session_shutdown` ran `abortAll` then `dispose`, which
  cancelled the work waiting agents held and released their sessions. It now runs
  `SubagentManager.suspend()` then `dispose(reason)`. `Subagent.suspend()` cuts a queued or running
  run short (idle, outcome `interrupted`, new `SubagentState.markInterrupted`), never calls work off
  (`abandonWork`, `workChanged` and `finish` do nothing while suspended), so the unwinding run reports
  nothing and the parent's saved record keeps reading queued or running. Waiting agents stay waiting,
  their items open in their own transcripts. `abortAll` is unchanged for ESC and stops still cancel.
- **Why the session ends reaches the child.** `emitChildSessionShutdown` takes a reason (`quit` as
  before, or `reload`); `SubagentSession.dispose(reason)` and `Subagent.disposeSession(reason)` pass it.
  The parent's `reload` is told to a child that holds open work (so pi-job keeps its jobs in its
  reload handoff for the session that is reopened); `quit`, `new`, `resume`, `fork`, a done agent and
  any child of a delegated session get `quit`. A child's pi-subagent does not restore its own subagents
  (they end with the reload, and their items are reported lost to the child).
- **The saved record** gains an optional `waitingOn` (labels of an idle agent's open items), written
  with every record (the waiting announcement and each change of the items persist it), omitted when
  empty, ignored when malformed. Version 1 and earlier version 2 records read as before.
- **Startup (`handlers/restore.ts`, `StartupRestore`)**, last of the `session_start` handlers, for the
  root session and the reasons `reload`, `startup` and `resume` (`new` has no agents, `fork` is the
  source session's): adopt the spawner's items (`SubagentWork.adopt`), `SubagentManager.restore`, settle
  the items, report once. `restore` takes agents that were waiting (`waitingOn`) or queued or running (a
  transcript peek through `lifecycle/transcript-work.ts` decides whether work was left open), reopens
  them at most four at a time with `Subagent.restore`: `createSubagentSession` with `transcriptPath` and
  a new `startReason` (`reload` or `resume`) as the child's `session_start` reason, **no run, no
  `admit`**, so no slot is taken. The producers adopt (pi-job within its handoff, pi-ask always), the
  child's host closes the rest as lost with the `work:lost` message in its transcript and tells the
  agent through the new `ChildWorkPolicy.lost`. An agent that still holds items is registered waiting
  (`onSubagentWaiting`); one that holds none is released and its record saved idle; one whose
  transcript, directory or type is gone has its items closed lost in the file itself
  (`SessionManager.open`, `appendCustomEntry`, `appendCustomMessageEntry`) or is reported from its
  `waitingOn` labels. A message that arrives during the startup (a job that ended in the reload gap)
  is answered by a run through the limiter (`Subagent.wake`); messages already in a transcript from
  before a restart wake nothing. Interrupted records are corrected (saved idle, `interrupted`) so a
  second start does not report them again.
- **One message to the parent.** `observation/lost-report.ts`: a `subagent:lost` message listing every
  agent that lost work or whose run was interrupted, and what it lost and still waits on. Written with
  `triggerTurn: false`, so it wakes nothing. The spawner's items of those agents are cancelled without a
  completion message (the report is the message); items of agents it did not restore are left to the
  host's generic `work:lost`. Replaces step 8's behaviour of reporting an interrupted run as generic lost
  work.
- **Behaviour changes users notice.** After `/reload` a waiting agent is still `waiting: CI` and its
  job's completion wakes it; a question is still open after a reload and a restart. A reload or restart
  no longer stops waiting agents (the roster used to read `idle, last run completed`). A restart
  reports lost jobs and the interrupted runs in one `subagent:lost` message instead of `work:lost`. The
  parent's `session_start` waits for the agents to be reopened.
- **Tests.** New: `restore-sdk.test.ts` (real sessions with a real `job_watch`: reload with a child
  waiting on a job, a job that ends in the reload gap, a question, a nested subagent, an interrupted run
  and an interrupted run that had a job, double reload, missing transcript, six agents with
  `maxConcurrent: 2`; restart by copying the session files: lost job reported once with the question
  adopted and no model run, an interrupted run, an interrupted run with a job; `quit`, `new`, `resume`
  and `fork` shutdowns), `lifecycle/restore.test.ts` (manager level), `handlers/restore.test.ts`,
  `observation/lost-report.test.ts`, `observation/subagent-work-restore.test.ts` (against pi-work's real
  host), `lifecycle/transcript-work.test.ts` (a real session file), and cases in `persisted-record`,
  `subagent-state`, `child-shutdown`, `child-work` and `create-subagent-session`. **Rewritten:**
  `handlers/lifecycle.test.ts` ("calls cleanup in correct order" pinned `abortAll`; a shutdown now
  suspends), `work-sdk.test.ts` ("reports an agent that was still running as lost work": it is now
  an interrupted run in `subagent:lost`, not a host `work:lost`), `records-sdk.test.ts` (a question
  across a reload: the roster reads `waiting: answer`, not `idle`), `waiting-workers.test.ts` (the
  policy now has `lost`).
- **Left for step 13.** The `work:lost` wording in the host still says "when this session started" for a
  child that is reopened; `SavedAgents.find`/`rebuildFromSaved` remain the path for agents that were
  not candidates; `Subagent.abandonWork`'s release and `Run.answering` still carry the adopted-question
  paths of steps 10 and 11, which a restored question now uses; the `subagent:lost` message has no
  custom renderer (it shows as Pi's default custom message).

## 2026-11-10: One retention rule: a session is released only for a done agent, and a done agent's is released after its window

Roadmap step 11 (`docs/roadmaps/subagent-work-lifecycle.md`): the guards 9a and 10 put in the sweep and
`clearCompleted` become one explicit rule that every release asks.

- **The rule, and its one predicate.** `Subagent.isDone()` is idle with no open work. Only a done
  agent's session may be released. An agent that is running, queued or waiting (an open job, watch,
  subagent of its own or question, alone or together) keeps its session however long it waits; it
  is released only after the last item closes **and** the window then passes. Every path that frees
  a finished agent's session asks it, and none keeps a `hasOpenWork()` check of its own:
  - the retention sweep (`SubagentManager.sweep`, plus the window);
  - `SubagentManager.clearCompleted`, which also drops the record (so a waiting agent stays until
    it reports, is stopped, or the spawning session shuts down);
  - `Subagent.releaseSession` itself, which now refuses unless the agent is done, so no caller,
    present or future, can release a session that is running, queued or holds work;
  - the "assignment ended" release (`abandonWork`), which now calls the work off first (below).
    Not retention, so not asking: `disposeSession` (the spawning session shut down, via `abortAll`
    then `dispose`, which ends everything) and a stop (which cancels the items first).
- **The window starts when the agent is done.** `completedAt` is re-stamped when the last item
  closes without a run (`markFinishedWithoutRun`, since 9a), so an agent that waited for days is not
  released a minute after its work ends. A `subagent_get` of an agent that still waits no longer
  marks it consumed (`GetResultTool` asks `isDone()`), and `markFinishedWithoutRun` forgets a read
  made while it waited, so the short window cannot apply to a result nobody read.
- **No work outlives its session (the 9a "abandon" path, revised).** A failed run, a run that hit
  its turn limit and a stop used to release the session and, for a failure or the turn limit,
  leave the items open in the child's transcript, so a reopened agent was told the work was
  lost. `abandonWork` now cancels whatever is open (a stop already had, and this also closes what a
  tool finishing as the stop landed opened) and then releases the session, which stops the jobs
  and agents inside it. A released session therefore never holds an open item. Behaviour change: a
  reopened failed or turn-limited agent is no longer sent `work:lost` (it is told the work was
  called off instead, see below), and a question it had asked
  is no longer adopted on reopen (the parent's `subagent_send` is simply its next prompt). A run
  that held no work still keeps its session for the window. The same applies to a stop that lands
  while a session is being created or reopened: the session it never attached is called off
  (`cancelWork`) before it is disposed, so a question pi-ask adopted from the transcript does not
  stay open in a stopped agent. What can still be open at the end of a session is the work of a
  process that dies, or of a parent that shuts down mid-wait; pi-ask's adoption of such a question
  (and `Run.answering`) remain for that, which is step 12's.
- **A called-off agent is told (repair).** Cancelling on `abandonWork` left a reopened agent's
  context holding the old `job_start` result ("you will be woken") with nothing saying the job was
  killed, so it could end its turn waiting for a wake that never comes. Whenever items are called
  off (a failed run, the turn limit, a user stop of an agent that held work, and a stop during the
  creation or cold reopen of a session) the agent now gets ONE `work:called-off` message in its own
  transcript, listing the items (kind, label, owner, id; sanitised and clipped like `work:lost`,
  via pi-work's new `calledOffMessage` and `WorkHostRuntime.reportCalledOff`, written in `record`
  mode through `ChildWork`/`SubagentSession.reportCalledOff`): "did not finish, nothing will wake
  you for it, decide whether it is still needed". It starts no run and wakes nothing. It lands
  before the release; for a stop of a running agent it is written once the run has unwound (Pi
  would hold a mid-run message), and if the parent's message reaches the stopped agent first it is
  written as that run is requested. An agent that held no work gets none. The reopen then has no
  open items, so `settleStartup` reports nothing lost: no duplicate. The spawner's side is
  unchanged. Tests: `called-off-sdk.test.ts` (real session: a `job_watch` child whose run fails is
  told once, its job dies with the session, a later `subagent_send` reopens it with the notice
  before the parent's message and no `work:lost`; no notice for a child without work),
  `waiting-sdk` (stop), `question-sdk` (failed after asking), unit tests in `waiting-workers`
  (turn limit, failure, stop, stop then send) and `subagent`, and pi-work's `reportCalledOff` and
  `calledOffMessage` tests. The turn limit is covered at unit level only: through a real session
  the harness's turn-limit stop surfaces as a provider error (see `turn-limit-message.test.ts`).
- **Settings labels reworded, keys unchanged.** `/subagent:settings` shows "Session retention
  (result read)" and "Session retention (result not read)" (were "Consumed-session retention" and
  "Unconsumed-session retention"), with matching toasts and prompts. The keys
  (`consumedSessionRetentionMinutes`, `unconsumedSessionRetentionMinutes`), defaults and loading
  are untouched. The tests that pinned the label text (`subagents-settings`, `settings`) were
  rewritten with a comment.
- **The consumed flag: both windows are kept, on purpose.** Step 6 left `consumedAt` for retention
  alone, and results now arrive only by the completion message, so "consumed" no longer means
  delivered. It still carries one useful fact: the parent went and read the finished result in full
  with `subagent_get`, the one signal that it has what it needs from the agent. The completion
  message carries only a 500 character preview, so an agent nobody read is the one a parent is more
  likely to come back to, and keeps the long safety cap. The names and defaults are unchanged
  (`consumedSessionRetentionMinutes` 10, `unconsumedSessionRetentionMinutes` 720), both keys load
  and apply exactly as before, and `/subagent:settings` is the same. Only the meaning is now
  stated: the settings' doc comments, `RetentionPolicy`, `RetentionCandidate`, README and
  docs/configuration.md describe "done" and "read the result", not delivery.
- **Reopening, pinned end to end.** A released agent takes `subagent_send`, which reopens its
  transcript (7b); `test/retention-sdk.test.ts` pins it on real sessions with a scripted model:
  a done child is released after its window (12 hours unread, 10 minutes after `subagent_get`), a
  `subagent_send` reopens it, and the child sees its earlier transcript, then the new message; a
  child that waited on a `job_watch` survives sweeps at 13, 25 and 49 hours, is released only a
  window after the job ended and it finished, and is reopened by `subagent_send`.
- Tests: `waiting-workers.test.ts` (fake timers; each of job, watch, subagent of its own and
  question open alone: kept through 30 hours of sweeps, then released a window after its item
  closes, on the short window if read once done, kept by `clearCompleted` while it waits; two kinds
  together, whichever closes last; 25 hours of minute sweeps interleaved with `clearCompleted`),
  `subagent.test.ts` (`isDone`, `releaseSession` refusing a running, queued or waiting agent, the
  stopped creation), `subagent-state.test.ts`, `get-result-tool.test.ts`. Tests that pinned the old
  failure path were rewritten with a comment, not deleted: `waiting-workers` (turn limit, failure,
  failed question: called off instead of left open) and `question-sdk` ("is closed by the parent's
  send to a child that failed after asking, when its transcript is reopened" is now "calls off the
  question of a child that failed after asking…"). Step 1's retention characterization tests pass
  unchanged. The `releaseSession` unit tests now build idle agents, the only kind it releases.

## 2026-11-10: A child's question is an item in its work host, not a record on its run

Roadmap step 10 (`docs/roadmaps/subagent-work-lifecycle.md`): a child's `ask` goes through the work
contract. The root session's `ask` is unchanged (it asks the user in a dialog).

- **A child that asks is idle and waiting.** pi-ask opens a `question` item (owner `pi-ask`, label
  `answer`, data `{ toolCallId, questions, text }`) in the child's own host, tells the parent once,
  and returns `terminate: true`: Pi ends the child's turn after the tool batch, the run settles
  `completed` and, with the question open, parks like a run that left a job open (`waiting: answer`).
  The question holds the child's session like any other open item (the retention guard of 9a
  already skips agents with open work; a test now pins it for a question). 9a's carve-out is gone:
  a run that ended with a question used to report at once, with the question, and keep its session
  while work stayed open (`shouldPark`, and `stopWaiting`'s "already reported" case). Waiting for a
  question is just waiting; `stopWaiting` now only guards a double report.
- **The parent hears the question once.** The child reaches the item its parent holds for it through
  a new `work:parent` service (`WORK_PARENT_SERVICE`, `WorkParent.question(text)`, in pi-work),
  offered by `createSubagentSession` under the child's session id before its extensions bind, where
  `ask:route` used to be. `announceQuestion` replaces `askParent`: it calls the new
  `SubagentLifecycleObserver.onQuestionAsked`, `SubagentManagerObserver.onSubagentQuestion`, and
  `AgentWork.question`, which `notify`s the agent's item with a `subagent:question` message
  (`questionMessage`, `<subagent-question>` with the question text and the exact `subagent_send`
  call; renderer `createQuestionRenderer`, registered like the update renderer). Nothing is
  persisted for it and no event is emitted: the `subagent:waiting` that follows (`reason: answer`)
  is the lifecycle signal. It is not gated by `midRunUpdates`, which is only for `parent_notify`.
  If the spawner holds no item for the agent (its host was unreachable at the request, or was
  replaced since), `SubagentWork.question` opens one on demand, as `runEnded` does, so the child is
  never left waiting on a question nobody was told about (the observer chain swallows errors, so
  throwing could not have reported it); with no host at all it only debug-logs.
- **Rendering convention kept.** `createQuestionRenderer` draws like its siblings
  (`createUpdateRenderer`, `createNotificationRenderer`): `Text(…, 0, 0)` with the header at column
  0 and its detail rows indented by two spaces, inside Pi's custom-message box, which supplies the
  edge inset. That is an existing convention I kept rather than changed in the siblings. Unlike
  them, the question renderer also clips every row to the width (a double-width character cannot
  be split by `Text` at one column), and its tests cover `NARROW_WIDTHS` and widths 1 to 12 with
  wide characters and ANSI.
- **`subagent_send` is the answer.** `Subagent.send` closes the agent's question items (new
  `SubagentSession.answerQuestions`, `ChildWork.answerQuestions`, and pi-work's
  `cancelOpen(match)`, which closes only the items it accepts) when the message steers the running
  agent, joins its queued run, or starts its run, and the message is the run's prompt. A job the
  child also waits on stays open. A live session closes them at once, after the run was requested
  (so `workChanged` never reads the agent as finished); a session reopened from its transcript
  closes them when the run attaches it (`Run.answering`), because pi-ask adopts the question at
  `session_start` and the message that reopened the child is its answer. A wake run
  (`WORK_WAKE_PROMPT`) does not answer anything.
- **A job and a question open together.** The job's completion wakes the child (it sees the
  completion and the wake prompt, and its own `ask` still without an answer); its run ends and it
  waits again, now on the answer alone, until every item is closed. The wake does not answer or
  re-announce the question.
- **Removed.** The `ask:route` service and its `record` path (and pi-ask's `route.ts` contract on
  it), `Subagent.askParent` and `QuestionRecorder`, `Subagent.pendingQuestion`,
  `SubagentState.pendingQuestion` and `setPendingQuestion`, the question on `RetentionCandidate`
  (and `resolveRetentionWindow`'s exception for a collected outcome with a question),
  `renderQuestionAffordance` and the question parts of `OutcomeAddenda`, the completion message's
  and `subagent_get` reports' question affordance, and the roster's `waiting for your answer: "…"`
  line (a waiting agent's roster line is `waiting: <labels>`; `rosterState` lost its question
  parameter, `QUESTION_MAX_CHARS` became `REASON_MAX_CHARS`).
- **Until step 12, a parent reload still stops its waiting children.** `abortAll` stops them and a
  stop cancels their open items, so a question a child was waiting on is closed (cancelled) by the
  reload, not kept open. The adoption path is for a child session that is reopened with its question
  still open: after a crash or restart of the process (the item was never closed), and after a
  failed run that left it open.
- **Saved records.** `pendingQuestion` is no longer written. A version 2 record that carries one is
  still read: the field is ignored whatever its type, so such a record loads like any other.
- Tests: `test/question-sdk.test.ts` (real sessions, scripted model: a child asks, its turn ends, the
  parent sees the question once, `subagent_send` wakes it through the limiter with the answer as its
  prompt; waiting on `answer` and keeping its session; a watch and a question open together; the
  question across a restart from a copy of the child's file, adopted and not lost, and lost without
  pi-ask; a child that failed after asking, reopened by the parent's send), plus unit tests in `waiting-workers`, `subagent`,
  `child-work`, `subagent-work`, `notification`, `renderer` (narrow widths, wide characters, ANSI),
  `roster`, `persisted-record` and the get-result suites. Tests that pinned the old model were
  rewritten with a comment, not deleted: `ask-sdk` (the question used to arrive in the completion),
  `records-sdk` (the question used to be quoted from the saved record after a reload),
  `waiting-workers` (the carve-out), `outcome-delivery`, `get-result-*` and `roster`.

## 2026-11-10: A message that reaches a running child is answered in that run, and confirmed

Roadmap step 9b (`docs/roadmaps/subagent-work-lifecycle.md`), the second half of step 9: mid-run
delivery into a managed child.

- **Landing confirmation for children.** `ChildWork` now runs its host with `confirmLanding`: a
  completed item reads as closed for the agent at once, but its close record is written only when
  the message is in the child's transcript, so a message Pi still holds mid-run is not lost
  silently by a crash before the end of the turn (the item stays open on disk, and the next start
  reports it lost, with the result absent). pi-work's new `LandingTracker` does the reading (the
  `checkLanding` closure of `ensureWorkHost`, factored out), fed by the child session's own events
  (`message_end`, `turn_start`, `agent_end`, `agent_settled`) and the transcript of its
  `SessionManager`. `ChildWorkStore.getBranch` now returns whole entries, and
  `ChildWorkSession.subscribe` events carry `aborted`.
  - **One reader per host.** The inline extension of every child (`ensureWorkHost`) keeps
    forwarding `agent_start`, `agent_settled` and `agent_before_settle` to the host and holds no
    tracker: only the instance that provided a host reads its landing, so the transcript is read
    once per boundary. The root host deliberately gets no final-settle wake (it wakes by
    `triggerTurn: true`; a message in that window waits in the transcript for the next prompt).
- **Final-settle race, fixed.** A message recorded after the run's last chance to continue (the job
  ended between the final `agent_before_settle` and `agent_settled`) was appended to the
  transcript with nothing to answer it: the host still counted the run as active, so it recorded
  instead of waking, and the agent reported done with the message unanswered. At `agent_settled`
  `ChildWork` now reads the transcript tail and, when it is a work message the host delivered with
  no answer after it and the run was not stopped, calls `ChildWorkPolicy.wake`. The agent is still
  running then, so the existing `wakeAfterRun` parks it and the answering run goes through the
  limiter. New `WorkHostRuntime.delivers(customType)` in pi-work says which messages count.
- **Another extension's message after the work message no longer hides it.** `continuesRun` and
  the tail check (`LandingTracker.unanswered`) used to look at the newest message only, so a work
  result followed by another extension's custom message at the end of a turn got neither a
  continuation nor a wake. Both now skip custom messages of other types (and branch summaries) and
  decide at the first message or compaction from the end.
- **A wake that finds the child compacting waits.** Pi refuses `prompt()` while a manual
  compaction runs ("Cannot submit a prompt while compaction is in progress"), which ended a wake run
  in `error`. `SubagentSession` now waits for the compaction to end (`isCompacting`,
  `waitForIdle`) before it prompts; a stop during the wait never prompts. The smallest sound
  option: the condition passes by itself, and surfacing it as an error would have asked the parent
  to retry what the harness can.
- **No unmanaged run in a child, audited.** Every way a message reaches a child ends in the host
  (`sendCustomMessage` with `triggerTurn: false`, wake through the manager) or in `Subagent.send`
  (steer a running agent, join a queued run, `resume`/`relaunch` through the limiter): the work
  host; pi-job in the child (it only opens and completes items); pi-subagent in a child that is
  itself a spawner (`subagent-work.ts` uses the host's `open`/`complete`/`notify`); the parent's
  `subagent_send`; the 9a wake prompt; the turn-budget warning (`triggerTurn: false`). No source file
  of this repository sends a triggering message or a user message other than pi-work's root host,
  and that host is never provided in a managed child, because the managed host is offered before
  the child's extensions bind. Only a third-party extension the user loads into a child could
  start a run of its own; the test helper `trackChildRuns` (test/helpers/managed-runs.ts) fails a
  test if any run in a child does not begin in `SubagentSession.driveTurns`, and a test proves it
  sees one.
- Tests: `test/midrun-delivery-sdk.test.ts` (a real child with `job_watch`: a job finishing
  mid-run is answered in the same run; two completions in one run; one that arrives while the
  previous is being answered; one at the last `agent_before_settle`; one during `agent_settled`,
  which gets a run of its own; an update that leaves the item open; a parent message to a waiting
  child; a crash between `complete` and the end of the turn, restarted from a copy of the child's
  session file), `test/compaction-wake-sdk.test.ts` (a real compaction held open), the landing and
  final-settle cases of `test/lifecycle/child-work.test.ts`, the nested orchestrator answering its
  worker mid-run in `test/nested-delegation-sdk.test.ts`, and the managed-run check in
  `test/waiting-sdk.test.ts`. `child-work.test.ts` asserted that an item closes the moment its
  message is written; its fixture now writes as Pi does (appended at once when idle, held until the
  turn ends when running) and the two assertions wait for the message to land.

## 2026-11-09: A child has a managed work host, and waits instead of finishing

Roadmap step 9a (`docs/roadmaps/subagent-work-lifecycle.md`). An agent whose run ends with open
work (a job it started, an agent of its own) is idle and **waiting**, not done, and the work's
completion wakes it through the manager and the concurrency limiter. Mid-run delivery hardening is
9b; reload and restart adoption is step 12; the release-with-no-open-work rewrite is step 11.

- New `src/lifecycle/child-work.ts` (`ChildWork`): the child's `work:v1` host, built with pi-work's
  `createWorkHost` and offered under the child's session id **before its extensions bind**
  (`create-subagent-session.ts`), so `ensureWorkHost` in the child finds it, provides nothing, and
  only forwards the child's run boundaries to it.
  - Store: the child's own session file (`SessionManager.getBranch` / `appendCustomEntry`), so open
    items live in the child's transcript.
  - Delivery: a message is written into the child's transcript at once (`sendCustomMessage` with
    `triggerTurn: false`: appended now while the child is idle, held by Pi for the end of the turn
    while it runs). For an idle child the host then asks the agent for a run (`ChildWorkPolicy.wake`).
    No message ever starts a run by itself, so none escapes the limiter or the turn budget, and the
    transcript stays the inbox. The item closes once the message is written (`confirmLanding` off).
  - The session's `agent_start` / `agent_settled` events feed the host, so it knows whether a run is
    active without any extension of the child wiring that. Every managed child also loads a small
    inline extension that calls `ensureWorkHost`, so `agent_before_settle` (a message that arrived
    mid-run is answered in that run) works whichever of the operator's extensions the child loads.
  - After the child's extensions bound, `settleStartup` closes the items nobody adopted as lost, with
    one `work:lost` message recorded without waking anything: this is what a reopened transcript
    that was left with open items reports.
  - `SubagentSession.openWork()` is the host's open items; disposing the session disposes the host
    (items stay in the transcript, and are reported lost if the child is ever reopened).
- `Subagent`: a run that **completed** with open work parks: no completion is reported and the
  spawner's item stays open (`onWaiting` → `onSubagentWaiting` → `subagent:waiting`, persisted).
  Waiting is derived (`status` idle and `waitingOn`, the labels of the open items), never stored.
  - `ChildWorkPolicy.wake` → a resume through the manager's limiter (`admit`), like every run. Queued,
    it shows as queued (`subagent:queued`) and a second wake changes nothing; a message from the
    parent (`subagent_send`) joins that run's prompt; a message that reaches the agent as its run is
    ending is answered by a run of its own right after.
  - **The run starts from a fixed prompt, not the newest message as its trigger.** The turn-budget
    wrapper could drive a run started with `sendCustomMessage(..., { triggerTurn: true })`, because
    the call returns when the run is over. A fixed prompt (`WORK_WAKE_PROMPT` in `run.ts`) was
    chosen because the run waits for a slot: a trigger message would exist only in memory until the
    run starts, whereas every message is in the transcript when the host writes it, an item closes
    once its message is there, messages that arrive while the run is queued keep their order, and a
    parent's message joins the queued run's prompt with no second mechanism. The cost is one short
    user message in the child's transcript per wake.
  - The last item going away without a message (cancelled, or lost) while the agent waits makes it
    done, and reports it then (`ChildWorkPolicy.changed`, from pi-work's new `onChange`).
  - A run that does not complete (an error, the turn limit, a stop) does not wait: it ends the
    assignment, and the agent's session is released after the run was reported, which shuts the
    child's extensions down and so stops the work they run. After an error or the turn limit the
    items stay open in the child's transcript, so a reopened agent is told they were lost. After a
    **stop** they are cancelled first (`ChildWork.cancelOpen`, from pi-work's new
    `WorkHostRuntime.cancelOpen`), so the work the user deliberately stopped is never reported lost.
  - A run that ends with a question reports now, as before, whatever else is open (step 10 owns the
    question's route to the parent); its session is kept, and the work's completion still wakes it.
  - `abort()` stops a waiting agent (outcome `stopped`, items cancelled, reported, session
    released), so ESC at the spawner stops waiting agents with the running ones.
  - A record being disposed (`disposeSession`, the manager's dispose) starts no run for a wake that
    arrives meanwhile. A finish with no run (the last item cancelled or lost) re-stamps
    `completedAt`, so the completion message's duration, the retention window and the widget count
    from when the work ran out, not from when the last run settled.
- Retention: the sweep never releases the session of an agent with open work, however long it waits
  (one condition; step 11 owns the full rule). `clearCompleted` (parent session start or switch)
  leaves a waiting agent alone like a running one: disposing it would be silent, leaving the
  spawner's item open and the dashboard showing it waiting.
- Display: an idle agent with open work shows as `waiting: <labels>` in the widget (a row that
  stays until the work is done, no clock, between the running and the finished), counted as
  "waiting" in the status bar (`1 running, 2 waiting agents`), as a section of the watch overlay
  (`waiting: CI`, never expiring), in the roster (`waiting: CI`, pinned like a running agent), in the
  `subagent_get` report header (labels sanitized to one line), and in the dashboard (`subagent:waiting`, a `waiting` state whose note
  names the work). The watch overlay's body rows are now inset one space from the panel's borders
  (rows too narrow for the spaces are blank), as the spacing rule requires.
- Nested delegation needs no code of its own: the agents a child starts are items in the child's
  host, so a child orchestrator that ends its turn with a worker running waits, and the worker's
  completion wakes it.
- Tests: `child-work.test.ts` (the host on a fake session), `waiting-workers.test.ts` (parking, wake
  through the limiter in order, a joined message, stop, failures, the question, retention),
  `waiting-sdk.test.ts` (a real child with `job_watch`: waiting, woken, done; woken behind the agent
  holding the only slot; stopped), `nested-delegation-sdk.test.ts`, plus rows, narrow-width and
  ANSI/wide-Unicode tests for every changed display. `orchestrator-sdk.test.ts` pinned the old
  unmanaged child (a worker's completion started a run of its own in a bare session, whose trigger was
  the completion): it now spawns the orchestrator through a `SubagentManager`, so the run is the
  manager's and starts with the completion followed by the wake prompt.
- Behaviour changes users will notice: an agent that starts a job or an agent of its own and ends its
  turn no longer reports "done" with a run to spare; the parent hears from it once the work is done,
  and the widget shows `waiting: <label>` meanwhile. A waiting agent is also stopped by ESC at the
  parent. Each wake adds a short user message to the child's transcript.

## 2026-11-09: Subagents are work items of the session that spawned them

Roadmap step 8 (`docs/roadmaps/subagent-work-lifecycle.md`). The spawning session's work host
(`packages/pi-work`, `work:v1`) delivers what an agent reports; this extension no longer queues or
sends anything.

- New `src/observation/subagent-work.ts` (`SubagentWork`), driven by `SubagentEventsObserver`:
  - A run being asked for opens an item in the spawning session's host (`ensureWorkHost(pi)`, called
    first in the factory): at spawn (`onSubagentCreated`), and for new input to an idle agent
    (`onSubagentResumeQueued` / `onSubagentResuming`; one item per run).
    Owner `pi-subagent`, kind `subagent`, label `<description> (<type> agent <id>)`, data
    `{ agentId, type, description, toolCallId? }`.
  - The run ending completes the item with the completion message: the same text and details as the
    nudge it replaces (500-character preview, the stash/`subagent_get` pointer lines, updates the
    announcement did not deliver, the question affordance).
  - A stopped run (outcome `stopped`, including one stopped while queued) delivers the same message
    with `notify`, then cancels the item: stopped work is cancelled, not completed.
  - `parent_notify` goes through `item.notify`, only while the child is active; the message still
    marks the update as announced, so the completion message does not repeat it.
  - Session shutdown (reload, quit, switch) makes the producer inert **before** the agents are aborted,
    so a run stopped by the shutdown neither closes its item nor sends a message. The item stays
    open and the next start of the spawning session reports it lost, with a `work:lost` message that
    names the agent (`subagent "Audit parser (general-purpose agent 3f2a...)"`). Nothing restarts;
    `subagent_send` gives the agent more work. Adoption across a reload arrives with roadmap step 12.
- Removed: `NotificationManager`, `NotificationSystem` and the `agent_start` / `agent_settled`
  handlers that fed it: the queue that held announcements while the parent ran and flushed them at
  `agent_settled`, the supersession of a repeated completion, and the `deliverAs: "followUp"`
  `triggerTurn` options. `notification.ts` keeps the formatting and gains `completionMessage` and
  `updateMessage`.
- Behaviour changes for the parent:
  - A completion or update that arrives while the parent is running is appended at the end of the
    turn and answered in that same run (one more model request), not in a second run after
    `agent_settled`. An idle parent is woken as before.
  - After Escape the message is in the transcript and forces no turn if the parent's run was still
    unwinding; a child that winds down after the run settled still wakes the parent, as before.
  - An update withheld while the parent ran used to be dropped if the child finished before the
    flush; now the host appends it at the end of the turn even if the child finished meanwhile,
    ahead of the completion, which no longer repeats it.
  - Two completions of one agent in one parent turn (a resumed run) are two messages, one per item.
- A session that spawns agents from a child (nested delegation) gets pi-work's root-style host in
  that child: its wake policy starts a run in the child with `triggerTurn: true`, as the old nudge's
  `followUp` did, and it is unmanaged until roadmap step 9 provides a managed host.
- Tests: `test/work-sdk.test.ts` spawns a scripted child on a real parent session and checks
  the item (open at spawn, label and data), the idle wake, a completion during a run answered in the
  same run, `parent_notify`, a stopped agent (message and cancelled item), `subagent_send` opening a
  new item, and a restart (the running agent is lost work, named). `test/observation/subagent-work.test.ts`
  covers the producer against a fake host (`test/helpers/fake-work-host.ts`). Mechanical updates:
  the `NotificationManager` tests became `completionMessage` / `updateMessage` tests (the queueing
  tests moved with the behaviour to `packages/pi-work`); `subagent-events-observer.test.ts`,
  `subagent-manager.test.ts` and `characterization/turn-limit-message.test.ts` drive a
  `SubagentWork` over a fake host instead of a `NotificationManager` over `sendMessage`;
  `characterization/harness.ts` restores an earlier parent's `setInterval` spy so a test can start
  a second parent (a restart). Step 1's message tests pass unchanged.

## 2026-11-09: One tool, `subagent_send`, replaces steer and resume

Roadmap step 7b (`docs/roadmaps/subagent-work-lifecycle.md`). A message reaches
an agent in whatever state it is in, like typing into a main session.
`subagent_steer` and `subagent_start`'s `resume` are gone.

- Tool contract:
  - `subagent_send(agent_id, message)` steers a running agent, adds the message
    to the run a queued agent is waiting to start, and starts a run for an idle
    one with the message as its prompt (any last outcome: completed, turn limit,
    error, stopped or interrupted), reopening its transcript if the session was
    released or lost to a reload. The call returns at once; the run's outcome
    arrives as a completion message. `subagent:steered` is emitted for a
    steer and for a message that joined a queued run.
  - An idle agent that never had a session (stopped while its first run was
    queued, or its session could not be created) gets its **first run**,
    started through the limiter from its original spawn configuration (type,
    model, thinking level, turn ceiling, directory, context, handoff) with a
    prompt of its original task followed by the message. It is announced as a
    resume (`subagent:queued`, `subagent:resuming`, `subagent:resumed`), not as a
    second `subagent:started`. This works only while the live record holds the
    spawn configuration. After a reload the saved record has no task to start from,
    so the message is refused ("never started a session, and its original task was
    not saved across the reload ... Spawn a new agent with the task").
  - A message to a **queued** agent is appended to the run's prompt
    (`Run.addMessage`) rather than held as a steer, for every kind of queued run.
    The steer buffer is flushed only when a session attaches, which a queued
    resume of a live session never does. The message dies with a run stopped
    before its slot opens, and the tool result and description say so.
  - A message to a **running** agent whose session does not exist yet is held
    and delivered when the session initializes, as before; that now includes a
    run rebuilding a released transcript, which `resume` refused as
    still-running.
  - Refusals of an idle agent, all for good except the last: `session-released`
    (transcript gone), `directory-unavailable`, `agent-type-unavailable`,
    `no-session` (saved record with no transcript), and `rebuilding` (stopped
    while its session was being created or its transcript reopened; try again in
    a moment, because the stopped run still owns the session until it unwinds). An unknown id is refused as
    before. A refusal names the transcript when there is one.
  - `subagent_start` has no `resume` parameter. A call that still sends one
    starts nothing and says to use `subagent_send`: ignoring it would spawn a
    second agent that repeats the first one's work. A `null` or empty `resume`
    counts as left out. `cwd` is no longer refused
    "with resume"; a later message keeps the agent's directory.
  - The tool names changed in the delegation allowlist, the `delegate` guard,
    the main profile's required tools, `subagent_start`'s guidance and every
    launch result ("Use subagent_get ..., or subagent_send to send it messages").
- Code:
  - `Subagent.send` is the one state rule and returns a `SendOutcome` (`steered`,
    `joined`, `started`, `refused`); `Subagent.steer` and `SteerOutcome` are
    gone. `SubagentManager.send` replaces `startResume`: the same refusal policy
    and saved-record rebuild, now async, returning a `SendResult`.
    `ResumeRefusal` is `SendRefusal` and `resumeRefusal(For)` is `sendRefusal(For)`.
    `SendRefusal` drops `still-running` (a running or queued agent takes the
    message) and gains `rebuilding`.
  - A run stopped while its session is being created (a first run, a relaunch
    or a cold resume) disposes the session when it arrives instead of attaching
    it, and `Run.opening` keeps `sendRefusal` at `rebuilding` until then, so a
    message sent right after a stop cannot create a second session for the same
    agent or leak one. Steers buffered for a run that ends without a session
    (stopped, or its creation failed) are dropped rather than flushed into the
    next run's session.
  - `Run` has a third kind, `relaunch`: it creates its session like `initial`
    but is announced through the resume hooks, so a consumer counting
    `subagent:started` once per agent does not see it twice. `startRun` queues the
    record for every run after the agent's first.
  - `src/tools/send-tool.ts` replaces `steer-tool.ts`. The steered texts are
    unchanged; the launch texts of a run a message started are the old resume
    texts ("Agent resumed in background.", "Agent resume queued in background."),
    or "Agent started in background." / "Agent queued in background." with a
    note for a first run.
- What users see:
  - Roster lines (the context card and the `subagent_get` list) show an idle
    agent as `idle, last run completed 14:10`, `idle, last run failed: ...`,
    `idle, last run stopped before it finished` or `idle, last run interrupted:
    ...`, and say `(cannot take a message)` on any idle line `subagent_send`
    would refuse. They used to say `completed 14:10, resumable`, and said nothing
    about failed or stopped agents. The headers name `subagent_send`.
  - `subagent_get` reports `Send: available. Call subagent_send ...` and `Send:
    not available, because ...`; a pending question names the `subagent_send`
    call that answers it. The "cannot be resumed yet" wording for a question on a
    running child is gone: a send to a running child is a steer.
  - The widget lingers the outcome of a run a message started as done for the
    same window as the first, where the first outcome's age used to hide it.
    Its rows are otherwise unchanged: a finished agent already read `done`,
    `stopped`, `error` or `aborted`, and a re-queued one counts as queued.
  - `subagent:queued` is a new event (`id`, `type`, `description`) for an idle
    agent whose new run waits for a slot, so consumers learn it has work waiting.
    pi-dashboard shows the agent as queued until `subagent:resuming`. Other
    events and payloads are unchanged.
- Docs and skills: the README, `docs/configuration.md`, the architecture notes,
  the `orchestrate` agent, the `creating-agents` skill, the root README and
  `skills/execute-roadmap` name `subagent_send` where they named the old tools.
- Tests: `subagent_steer` and resume-via-`subagent_start` characterization tests
  now pin `subagent_send` (`steer.test.ts`, `resume.test.ts`); the two that pinned
  refusing a finished agent and refusing a running one pin the new behaviour,
  and the "cannot find an agent from before a reload" steer test pins that the
  interrupted agent now takes a run. `send.test.ts` pins a message to a queued
  agent and to an agent that never had a session (live and after a reload).
  `steer-tool.test.ts` and the resume tests of `agent-tool.test.ts` moved to
  `send-tool.test.ts`; `agent-tool.test.ts` pins the refused `resume` parameter.
  New unit cases for `Subagent.send`, `SubagentManager.send`, the widget's
  re-linger and the roster's idle lines (with wide and ANSI text).

## 2026-11-09: Agents are queued, running or idle, and every run goes through the limiter

Roadmap step 7a (`docs/roadmaps/subagent-work-lifecycle.md`). The record of an
agent now says where it stands (`queued`, `running` or `idle`) and, beside that,
how its last run ended. What the parent, the widget, the roster, the watch
overlay, the dashboard and the lifecycle events show is unchanged: they derive
today's words from the new pair. The idle/done presentation and the renamed
events belong to the later steps.

- State model (`src/lifecycle/subagent-state.ts`):
  - `SubagentStatus` is `queued | running | idle`. `RunOutcome` is
    `completed | turn-limit | error | stopped | interrupted`, stored beside the
    status with the run's result and error; it is defined exactly while the
    agent is idle, and `interrupted` marks a run a reload or restart cut short.
  - `DisplayStatus` and `displayStatus(status, outcome)` keep the six words users
    have always seen (`completed`, `aborted` for `turn-limit`, `stopped` for both
    `stopped` and `interrupted`, `error`, `queued`, `running`). Tool output, the
    widget, the watch overlay, `subagent_steer`'s refusal, the completion message
    and its `details.status`, and the `status` of `subagent:completed`,
    `subagent:failed` and `subagent:resumed` use them. Event payloads and the
    dashboard protocol are unchanged.
  - Transitions: `markAborted` is `markTurnLimit`, and `resetForResume` is
    `markQueued` (a later run asks for a slot, so the earlier run's result,
    error, question, turn budget, read time and end time clear) plus the
    ordinary `markRunning` when the slot opens. `markCompleted`, `markTurnLimit`
    and `markError` still record their result or error after a stop but leave the
    outcome `stopped`.
- Stop: ends the run and leaves the agent idle with outcome `stopped`. It cancels
  nothing else, and the idle agent takes a new run at once. A run that a later
  one has replaced (stopped, then given new input while the old turn loop was
  still winding down) now reports nothing and writes nothing: before, its late
  result could overwrite the newer run's record.
- Every run goes through the limiter:
  - `SubagentExecution.admit` is the manager's limiter; `Subagent.resume` queues
    the record, then hands the run to it. With a free slot the run begins
    synchronously, so nothing observable changes. With every slot taken the
    resume waits as a first run does: the call says "Agent resume queued in
    background." with the queue position, the saved record reads `queued`, the
    widget counts it, and `subagent:resuming` is sent when the slot opens
    (`onResumeQueued` / `onSubagentResumeQueued` is the new, optional hook).
  - A queued resume that is stopped leaves the agent idle (outcome `stopped`,
    never started, no result) and sends the same completion message as a stopped
    first run. A run only begins if it is still the agent's current run, so the
    stopped resume's place in the limiter queue, or one a newer resume replaced,
    does nothing when its slot opens.
  - `bypassQueue` is findings only: it governs a spawn's first run, which starts
    at once and takes no slot; a resume of such an agent still goes through the
    limiter. Nothing in production sets it (the RPC it served was removed in
    #49), only tests do, so it is a candidate for removal in the cleanup step.
  - Nested delegation cannot deadlock on the limiter: a run holds a slot only
    while its own turn loop runs and no call blocks on another agent, and each
    child session's extensions have a limiter of their own.
- Saved records (`src/persisted-record.ts`) are version 2: `version: 2`, `status`
  and, for an idle agent, `outcome`. `readPersistedRecords` reads both versions
  and returns the version 2 shape, so nothing past the module sees version 1.
  A version 1 `completed`, `aborted`, `error` or `stopped` reads as idle with
  outcome `completed`, `turn-limit`, `error` or `stopped`; a version 1 `queued`
  or `running` reads as idle with outcome `interrupted`. A version 2 entry that
  is still `queued` or `running` and has no live agent behind it reads as
  interrupted, as before. Entries that fail validation are skipped, including a
  version 2 entry with a version 1 status. Rolling this change back needs the
  version 2 reader to stay: the previous reader skips version 2 entries, which
  hides those agents from the roster and from resume.
- `rebuildFromSaved`, the roster, `subagent_get`'s report on a saved record and
  the `/subagent:sessions` picker read the pair. Output is unchanged, except the
  picker's label for a saved version 1 `queued` or `running` run, which reads
  `stopped` (what it is) where it used to read the stale `queued` or `running`.
- Tests: the saved-record assertions in the characterization, cold-resume and
  records tests now pin `status: "idle"` and the outcome. "Starts the resumed run
  at once even when every concurrency slot is taken" pinned the dropped
  behaviour and now pins a queued resume that runs when a slot frees. New:
  admission, queued-resume stop and stale-run cases in `subagent.test.ts` and
  `subagent-manager.test.ts`; the state model in `subagent-state.test.ts`;
  version 1 fixtures in `persisted-record.test.ts` and end to end in
  `legacy-records-sdk.test.ts`.

## 2026-11-09: Every subagent runs in the background

Roadmap step 6 (`docs/roadmaps/subagent-work-lifecycle.md`). No call blocks the
parent on a subagent any more, and the completion message is the only thing that
delivers an outcome.

- Tool contract:
  - `subagent_start` has no `foreground` parameter. A spawn and a resume always
    return at once with the agent ID. A `foreground` argument a caller still
    sends is ignored. Print and JSON mode no longer default to the foreground,
    so `pi -p` can return before background agents finish; that is accepted.
  - `subagent_get` has no `wait` parameter. It reads the agent's current state
    and result at once; a running agent is reported as running, and its
    completion message arrives when it finishes. A `wait` argument is ignored.
    The completion message's closing line still says to call `subagent_get` for
    the full result.
  - A `foreground` or `run_in_background` key in an agent file is still ignored,
    as before.
- Removed with them:
  - `foreground-runner.ts`, `SubagentManager.spawnAndWait`, and the awaiting
    `SubagentManager.resume`. `startResume` is the only resume.
  - Carrier claims (`claim`, `releaseClaims`, `claimed`, `ResumeCallOptions.claimOutcome`),
    `Subagent.waitUntilSettled` and `WaitOutcome`, the run ordinal and the
    superseded-outcome slot in `SubagentState`, `SettledOutcome`, and the
    "resumed before this wait returned" note in the `subagent_get` report.
  - `Subagent.isBackground`, `AgentSpawnConfig.background`, the
    `runInBackground` invocation field and its `foreground` tag in the widget
    tags, the widget's and watch overlay's background-only filters, and the
    `isBackground` field of the `subagent:created` event.
- Delivery: `NotificationManager` no longer skips a completion because a claim
  or a read result says it was delivered elsewhere. Every terminal transition,
  including every resume's, is announced exactly once, whatever the parent has
  read with `subagent_get` in the meantime. A mid-run update is still announced
  only while its child is running; afterwards it rides the completion message.
- Kept: the consumed flag (`consumedAt`). Reading a finished result with
  `subagent_get` still starts the short retention window
  (`consumedSessionRetentionMinutes`) for the agent's session; it no longer
  affects what is delivered.
- Prompts: `subagent_start`'s guidelines say agents always run in the
  background, that a completion message carries 500 characters of the result,
  and to ask agents to `stash_put` a large result and name the handle in their
  final answer. `explore` and `orchestrate` say the same to their own workers.
  `orchestrate` no longer tells a child orchestrator to wait for its workers with
  `subagent_get`; it says no call waits and to list each worker's agent ID in
  its final answer.
- Behaviour users will notice:
  - Every agent is admitted through the queue and the concurrency limit, which
    a foreground agent used to skip, and every agent now gets a `queued` saved
    record before its `running` one.
  - A resume of a finished agent returns "Agent resumed in background." and its
    outcome arrives as a second completion message.
  - Agents that used to run in the foreground were aborted by ESC whatever
    `abortAllOnInterrupt` said. Every agent now follows that setting.
- Tests: the foreground tests are gone, and the characterization tests that
  pinned a foreground return, `subagent_get` with `wait`, a foreground resume
  and a pulled result suppressing the completion message now pin the new
  contract. The SDK tests that relied on a print-mode parent running spawns in
  the foreground (`cold-resume-sdk`, `records-sdk`, `ask-sdk`, `cwd-sdk`,
  `handoff-sdk`, `orchestrator-sdk`, `todo-handoff-sdk`) wait for the completion
  message instead, over a provider shared by the parent and its children
  (`scriptSides` in `test/helpers/sdk.ts`).

## 2026-11-09: One run abstraction inside `Subagent`

- `src/lifecycle/run.ts`: `Run`, one execution of an agent. It owns what used to
  be spread over the record and replaced field by field when a resume began:
  the cancel `AbortController`, the listener handles, the run promise, the
  cold-resume `reopening` flag and the turn ceiling carried across resumes. Its
  `kind` (`initial` or `resume`), prompt, caller signal and live session say how
  the run differs from another.
- `Subagent.startRun` is the one place a run starts. `run()`, `start()`,
  `scheduleVia()` and `resume()` all go through it; `runResume` and
  `guardedRun` are gone, and one `execute` drives both kinds from `begin` to
  `settle`, `fail` or `finish`. An optional admission decides when the run's
  body starts: `scheduleVia` passes the limiter's, and a resume passes none, so
  it still skips the limiter.
- Statuses, observer events, messages and timing are unchanged, apart from these
  edge cases:
  - A throw from `attachSession` (for example from a spawn observer's
    `onSessionCreated`) on the first run now ends the record as `error`. It used
    to leave the record `running`; a resume already ended as `error`.
  - A run releases only its own listeners and reads only its own abort signal.
    A stale run (for example a cold rebuild started before a stop) can no longer
    detach a newer run's listeners or keep going on the newer run's signal.
  - While a resume starts synchronously, `agent.promise` is `undefined` until
    the new run is set; it used to be the previous settled promise. Nothing in
    `src` reads it there.
  - A direct `run()` on an agent that is not active is now a no-op, and a direct
    `run()` sets `promise`. Only `start()` and tests call `run()`.

## 2026-11-09: Characterization tests for what the parent sees

- `test/characterization/`: tests that run a real parent session over real
  child sessions on one faux provider, and pin what the parent can observe
  through `subagent_start`, `subagent_get`, `subagent_steer` and its own
  transcript. They cover the completion message for each outcome (completed,
  wrapped up at the turn limit, turn limit enforced, error, stopped), steering a
  running agent, resuming a finished agent (live, after retention released its
  session, and after a reload), retention release, and rebuilding saved records
  after a reload. `harness.ts` is the shared parent. Tests for behaviour the
  work-lifecycle roadmap drops (foreground, a resume returning its result,
  `subagent_get` with `wait`, the resume that skips the concurrency limiter) say
  so in a comment. No source change.

## 2026-11-09: Pi 1.5.0 active-tool order

- `test/main-agent-profile-sdk.test.ts` compares the active tools as a set. Pi
  1.5.0 keeps tools that stay active in place and appends newly activated ones,
  so the order is Pi's. No source change.

## 2026-11-08: One agent-definition builder for tests

- `test/helpers/make-agent-config.ts`: the `makeAgentConfig` builder that
  `agent-types` and `subagent-manager` tests each defined identically;
  `invocation-config`'s builder now starts from it. No source change.

## 2026-11-08: SDK tests share one child-session fixture

- `test/helpers/sdk.ts`: `offlineAgentDir` (agent directory, settings and an
  offline `ModelRuntime`, undone when the test ends), `realChildSession`
  (`createSubagentSession` wired to real factories on a faux model),
  `lifecycleLog`, `spawn`, `capture`, `lastResult` and `agentIdIn`. The
  `*-sdk.test.ts` files each built these by hand. No source change.

## 2026-11-08: Faux sessions from pi-test-helpers

- Parent sessions in `records-sdk` and `cold-resume-sdk` use `packages/pi-test-
  helpers`' `fauxSession`, and `main-agent-profile-sdk` its `fauxRuntime`,
  reading provider calls from `calls`; tool-call responses use `toolCall`. No
  source change.

## 2026-11-08: ui.custom stub from pi-test-helpers

- `ui/agents-browser.test.ts` mounts the browser with `packages/pi-test-
  helpers`' `fakeCustomUi` and `fakeTui` instead of two inline `ui.custom`
  stubs. No source change.

## 2026-11-08: One fake pi for whole-extension tests

- `test/helpers/subagent-pi.ts`: the fake `pi` with every member the composition
  root touches at load, on `packages/pi-test-helpers`' `fakePi`, replacing the
  copies in `composition-root.test.ts` and `print-mode.test.ts`. No source
  change.

## 2026-11-08: Main-profile harness on fakePi

- `main-agent-profile.test.ts` builds its fake `pi` on `packages/pi-test-
  helpers`' `fakePi` and fires events through its `emit`. No source change.

## 2026-11-08: Global test slots from pi-test-helpers

- `ui/widget-renderer.test.ts` sets the inline-window slot with `packages/pi-
  test-helpers`' `withSlot` instead of a `try`/`finally` delete. No source
  change.

## 2026-11-08: Markup theme from pi-test-helpers

- The three renderer suites that rendered styling as `[color:text]` and
  `**bold**` use `packages/pi-test-helpers`' `markupTheme`. No source change.

## 2026-11-08: Test themes from pi-test-helpers

- Identity and single-color theme stubs in the UI and tool tests are
  `packages/pi-test-helpers`' `plainTheme` and `ansiTheme`; SGR stripping is its
  `stripAnsi`. No source change.

## 2026-11-08: Test waits from pi-test-helpers

- Inline `setTimeout` promises in `subagent-manager.test.ts` use `packages/pi-
  test-helpers`' `sleep`. No source change.

## 2026-11-08: Layered settings fixture from pi-test-helpers

- `settings.test.ts` uses `packages/pi-test-helpers`' `settingsDirs` for its
  global and project settings files; `test/helpers/tmp-settings-dirs.ts`, which
  did the same, is removed. No source change.

## 2026-11-08: Test temp directories from pi-test-helpers

- Tests create temp directories with `packages/pi-test-helpers`' `tempDir`,
  which removes them when the test ends, instead of `mkdtempSync` with an
  `afterEach` or `finally` cleanup. No source change.

## 2026-11-06: Supply tools required by todo handoffs

- Add synchronous `subagent:session:prepare` with `requireTools(names)` so handoff
  owners can contribute exact tool names before SDK creation without core-specific
  knowledge of their payloads. Deduplicate contributions; reject tool selectors.
- Keep explicit profile exclusions and the delegation guard; fail initialization
  when required tools are excluded or unavailable after binding, disposing any
  created child. Agents without contributions keep their existing tool selection.
- Cover contribution collection, initialization failures, and real SDK handoffs
  to general-purpose, explore, plan, review, and tools-none workers.

## 2026-11-05: Lowercase agent names and remove twin labels

- Rename built-in types to `explore`, `plan`, `orchestrate`, and `review`;
  display `general-purpose` as `agent`. Update callers and agent-file examples.
- Remove prompt-mode labels from widgets, session headers, and tool result tags.
  Prompt inheritance and custom display names keep their existing behavior.
- Update naming and rendering coverage, including the tag-free append profile.

## 2026-11-05: Fold duplicated paths and tests

- `SubagentSession.runTurnLoop` and `resumeTurnLoop` share one turn driver;
  only the initial run emits `completed`. `TurnLoopOptions` extends
  `ResumeTurnLoopOptions` instead of restating it.
- `settings.ts`: one `Toast` type for every mutator (the settings UI reuses
  it) and one integer-range check for every numeric key in `sanitize`.
- Drop `createSubagentRuntime()`, a wrapper around `new SubagentRuntime()`,
  and the `handlers/index.ts` barrel.
- Tests: merge `runtime.test.ts`'s three set/clear describes into one, and
  the two ask-back describes in `subagent.test.ts`, dropping the case they
  both covered. Move `display`, `widget-renderer` and `agent-conversation`
  tests next to the modules they cover.

## 2026-11-05: Remove members nothing reads

- `getSessionTokens`, `formatSessionTokens`, `BUILTIN_TOOL_NAMES`,
  `AgentTypeRegistry.getAvailableTypes`, `SubagentSession.getSessionStats`
  and `messages`, `Subagent.messages` and `sessionReleased`: no production
  caller. Their tests go too; the `getAvailableTypes` hidden-agent case moves
  to `isValidType`.
- `Subagent` keeps one optional `released` snapshot of the disposed session
  instead of three captured fields and a flag.

## 2026-11-05: Drop the tests of test helpers

`test/helpers/` carried a test file per fixture (803 lines) asserting that a
stub is a stub and a default is a default. Every helper is exercised by the
tests that use it, which fail when a fixture breaks.

- Delete `test/helpers/*.test.ts`.

## 2026-11-05: Remove the typed service API and the workspace-provider seam

No extension in this repository called `getSubagentsService()`; dashboard, git,
todo and stash follow agents through the `subagent:*` events. The
`WorkspaceProvider` seam lost its only consumer when `pi-subagent-worktree`
was removed, so the core carried a prepare/dispose bracket, a held-workspace
rule, a `workspace-disposed` resume refusal and a workspace-notice message
that nothing could trigger.

- Delete `src/service/` (`SubagentsService`, its adapter and the
  `globalThis` publication registry) and the package's `exports`, including
  the `./settings` re-export of `loadLayeredSettings` nobody imported.
- Delete `WorkspaceProvider`, `WorkspaceBracket`, `Subagent.workspaceDisposed`
  and `workspaceNotice`, the `subagent:workspace-notice` message and renderer,
  and the `workspace-disposed` refusal. A child runs in the parent's cwd or a
  caller-chosen `cwd`, as before.
- `SubagentManager` loses `registerWorkspaceProvider`, `waitForAll`,
  `hasRunning` and its `baseCwd` option.
- `Subagent.cwd` is always defined: the caller's directory, else the parent's.
  Saved records now carry it for agents that never started.
- README, configuration and architecture docs no longer describe either API.

## 2026-11-05: Drop upstream's development history from docs

`docs/` carried upstream's working history: 186 plans, 189 retros, 21
per-phase architecture histories and a fallow metrics snapshot, about 70k
lines that nothing in the extension reads. They remain at the pinned commit
in [UPSTREAM.md](UPSTREAM.md).

- Delete `docs/plans/`, `docs/retro/`, `docs/architecture/history/` and
  `docs/fallow-snapshot.json`.
- `docs/architecture/architecture.md`: drop the fallow health metrics,
  boundary-zone instructions and the refactoring-history tables, and the
  links into the deleted files.

## 2026-11-04: Refuse invalid definitions when queued agents start

A queued agent without fragments reads its profile again when a slot opens.
If its file became invalid and the registry reloaded while it waited, it could
run with the broken definition's empty instructions and capability tools.

- Recheck `definitionError` during session assembly and report the original
  parse error before building a prompt or creating a session.
- Cover a queued profile whose YAML becomes invalid before its slot opens.

## 2026-11-05: Opt into delegation with `delegate: true`

A child could start agents of its own only if its `tools` named each of
`subagent_start`, `subagent_get` and `subagent_steer`, while `all` did not
count. The one capability that needs a deliberate choice was hidden in an
allowlist quirk, and the docs' own example misnamed the tools.

- Add `delegate: true` frontmatter. It adds all three delegation tools to the
  child, even under an allowlist that names none of them; an explicit
  `-subagent_*` exclusion still wins. Without it they are withheld, including
  when `tools` names them.
- The built-in orchestrator declares `delegate: true` and no longer lists the
  delegation tools in `tools`.
- `SessionConfig` carries `delegate`; `/subagent:agents` shows a Delegate
  field. A main session is unchanged: it always has the delegation tools
  unless `tools` excludes them.
- Fix the configuration docs' example, which named `todo` and `subagent`
  rather than the real tool names.

## 2026-11-05: A malformed agent file no longer breaks every agent

`parseFrontmatter` throws on invalid YAML, and nothing caught it. One bad file
in `.pi/agents/` or the global agents directory made the whole registry load
throw, and `subagent_start` reloads the registry on every call, so every spawn
failed (and extension load could too).

- Catch the parse error per file. The file still registers under its name,
  with `definitionError` naming the path and the first line of the error, so
  it keeps overriding a lower-priority agent rather than silently handing the
  name back to a global or built-in one.
- An agent with `definitionError` is not listed, not available, fails
  `isValidType`, and its spawn throws `Agent type "<name>" cannot load: …`.
  Selecting it as the main profile fails the same way.
- `/subagent:agents` badges it `[invalid]` and shows a Definition error
  section above its description.

## 2026-11-05: Agent files default to `prompt_mode: replace`

An agent file without `prompt_mode` was an `append` agent: its body wrapped in
`<agent_instructions>` beneath the caller's prompt and labelled `(twin)` in
the widget. Nearly every agent with a role of its own wants `replace`, so a
file that forgot the key quietly behaved, and looked, like a parent twin.

- An omitted or unrecognized `prompt_mode` now means `replace`. Only
  `prompt_mode: append` selects `append`; `general-purpose` already sets it.
- Update the configuration docs and the `creating-agents` skill.

## 2026-11-05: Add the `creating-agents` skill

The `subagent_start` description no longer explains where agent files live,
and that one sentence was never enough to write a good agent.

- Add `skills/creating-agents/SKILL.md`: when an agent type beats a skill,
  file locations and precedence, every frontmatter field, writing
  `description` and `guidance` for the type list, `prompt_mode`, tools,
  `visibility`, `locked`, fragments, body structure, an example, and how to
  check the result.
- Ship `skills/` in the package and declare it in `pi.skills`, so a
  standalone install loads the skill as well as the bundle.

## 2026-11-05: Built-in agents are markdown files

The five built-in agents were TypeScript object literals, in a different shape
from the `.md` files users write, with a separate `isDefault` flag.

- Move `general-purpose`, `orchestrator`, `Explore`, `Plan` and `reviewer` to
  `agents/<name>.md`, loaded by the same parser as `.pi/agents/*.md` with
  `source: "default"` and a real `sourcePath`, so a built-in can also use
  prompt fragments from `agents/fragments/`. Ship `agents/` in the package.
- `default-agents.ts` only loads that directory. Every directory now loads in
  case-insensitive name order, so the built-ins list as Explore,
  general-purpose, orchestrator, Plan, reviewer.
- Remove `AgentConfig.isDefault` and `AgentTypeRegistry.DEFAULT_AGENT_NAMES`;
  `source === "default"` identifies a built-in. `/subagent:agents` shows its
  source as `built-in` and its file path.
- The prompts are unchanged in wording; the formatter adds the blank lines
  Markdown expects after headings and around lists.

## 2026-11-05: One dense agent list in the `subagent_start` description

The description split agents under "Default agents:" and "Custom agents:",
showed a model only for built-ins, repeated each built-in's name in a separate
"Use X for …" guideline line, listed the type names a third time in the
`subagent_type` parameter, and carried instructions for writing agent files.
Whether an agent is built in or custom does not help a caller choose one.

- Add `guidance` frontmatter: when to pick the agent. It replaces the built-in
  only `toolGuideline`, so custom agents can carry it too.
- `buildTypeListText` renders one line per listed agent, built-in and custom
  alike: `- name (model): description. guidance`. Multi-line values collapse
  onto the line; the model shows for any agent that pins one.
- Remove `buildAgentGuidelines`, the registry's `getDefaultAgentNames` and
  `getUserAgentNames`, the type names in `subagent_type`'s description, and
  the agent-authoring paragraph. `AgentTool` no longer takes `agentDir`.
- Reword the built-ins so description and guidance do not repeat each other,
  and describe `general-purpose` as a copy of the caller to use only when no
  other type fits. The orchestrator now picks workers by that guidance and
  falls back to `general-purpose` last.
- The `/subagent:agents` detail view shows a Guidance section in place of
  Tool guideline.

## 2026-11-05: Replace `enabled` with `visibility`

`enabled: false` was the only way to take an agent out of the
`subagent_start` list, and it also refused every spawn. An agent meant only
for a skill or another agent to name had no way to stay unlisted yet
runnable.

- Add `visibility: visible | hidden | disabled` to agent frontmatter and
  `AgentConfig`. `hidden` leaves the agent out of the tool's type list but
  spawns it by name; `disabled` refuses it as `enabled: false` did. An
  unrecognized value is dropped and the agent stays visible.
- Remove `enabled`; a file that still sets it has the key ignored.
- `AgentTypeRegistry.getListedTypes()` returns the visible types;
  `getAvailableTypes()` and `isValidType()` accept hidden ones.
- The `/subagent:agents` browser badges each agent `[visible]`, `[hidden]`
  or `[disabled]` and shows a Visibility field in place of Enabled.

## 2026-11-05: The caller alone decides foreground or background

An agent file's `foreground` key let a profile pick how it ran whenever the
caller left `foreground` unset. How an agent runs is the caller's decision, so
the key is gone.

- Drop `foreground` from agent frontmatter, `AgentConfig`, and the lockable
  fields. A file that still sets it, or locks it, has that entry ignored.
- Collapse `BackgroundRequest`'s `explicit`/`default` union to a boolean
  `background`, and remove `resolveBackgroundMode`, which existed only to let
  the profile fill a `default` request.
- Remove the Foreground row from the `/subagent:agents` detail view and the
  main-profile "subagent-only fields skipped" notice.

## 2026-11-04: Register the agent definitions browser as `/subagent:agents`

The read-only agent profile browser was still registered, but as `/agent`
after the identifier rename, so `/agents` (and its old `/subagents:agents`
name) no longer matched any command and the browser looked gone.

- Register the browser as `/subagent:agents`, under the extension's prefix
  like its other commands.
- Pin the extension's command names in a composition-root test.

## 2026-11-04: Add a four-fifths watch-overlay width preset

- Add `four-fifths` (80%) to the overlay width selector and persisted settings.
- Extend settings and overlay tests to cover selection, persistence, and live resizing.

## 2026-11-04: Serialize cold-resume setup and preserve resolved turn limits

- Wait for a released session's shutdown before reopening its transcript, so
  its late disposal cannot unregister the new session under the same ID.
- Refuse another resume while a stopped cold rebuild is still unwinding; the
  stopped setup must dispose its session before a replacement can start.
- Keep the previous run's resolved turn ceiling, including unlimited runs,
  across release and reload rather than resolving it from changed defaults.
- Add lifecycle regressions and real SDK reload coverage for these paths.

## 2026-11-04: Cold resume a released subagent from its saved transcript

`resume` only continued an agent's live `AgentSession`, and was refused once
that was gone: after a retention window, or at once after a reload, resume,
restart or session switch. The transcript was still on disk. A resume now
reopens it and continues, automatically, inside the existing `resume` call.

- `src/lifecycle/cold-resume.ts`: `reopenRefusal`, the check of whether a
  transcript can be reopened (it still exists, the recorded directory still
  exists, the agent type is still usable), and `resolveSavedModel`.
- `src/lifecycle/subagent-manager.ts`: `resumeRefusalFor` is the one check
  `startResume`, `subagent_get` and the roster card share. An ID with no live
  record but a saved one on the branch gets a record rebuilt from it, through a
  new `savedAgents` option. A refusal for good names the transcript.
- `src/lifecycle/subagent.ts`: a resume of a released session builds a new one
  around the transcript, then runs as any resume does. A steer sent meanwhile is
  buffered; a stop sent meanwhile disposes the new session instead of running it.
  A released record whose workspace was torn down stays `workspace-disposed`.
- `src/lifecycle/create-subagent-session.ts`: `transcriptPath` reopens through a
  new `openSessionManager` dependency, and the child's `session_start` reports
  `resume`. Pi appends to the reopened file, so the transcript stays one file.
- `src/lifecycle/subagent-session.ts`: `applyTurnLimits`, so a session with no
  initial run still resumes under its recorded ceiling.
- `ResumeRefusal` gains `directory-unavailable` and `agent-type-unavailable`;
  `session-released` now means the transcript is gone too.
- `subagent_get` and the roster card report whether an agent can be resumed, and
  the README, tool guidance and orchestrator profile describe all of this.

## 2026-11-04: Keep lifecycle records on their branch and save ready-session metadata

- Off-branch start, session-ready, resume and terminal events no longer admit
  hidden agents to the current branch. Their latest saved state is deferred
  until `/tree` returns to a branch containing the agent.
- Session creation now appends the resolved model, directory and transcript
  path while the agent is still running, so interrupted runs retain a path to
  their partial work.
- Added branch-transition regressions using the real session manager and an
  SDK recovery test for a record captured before a child finishes.

## 2026-11-04: Record the whole agent lifecycle, answer `subagent_get` from it, and restore a roster card

After a reload, resume or session switch, `subagent_get` answered `Agent not
found` for every agent the parent had started, and a worker waiting on a
question lost both the question and the way to see it. After compaction the
parent kept only the worker IDs its summary happened to mention. The
`subagent:record` entry now records every lifecycle step, `subagent_get`
answers from it and lists the branch's agents, and a context-only card
restores them to the model.

- `src/persisted-record.ts`: the parent appends `subagent:record` when an
  agent is queued or starts running, when a resume starts, and at every
  terminal state, as before. Entries gain optional `pendingQuestion`, `model`
  (`provider/id`), `thinkingLevel`, `maxTurns` and `cwd`; an unknown one is
  left off rather than written as `undefined`. `readPersistedRecords` folds a
  branch's entries into the last valid record per ID; entries without the new
  fields still validate, and malformed ones are skipped. `readPersistedRuns`
  is built on it.
- `src/observation/subagent-events-observer.ts`: `onSubagentCreated`,
  `onSubagentStarted` and `onSubagentResuming` persist the record too. The
  parent session writes them, so they follow its branch through `/tree` and
  forks.
- `src/lifecycle/subagent.ts`: `maxTurns` and `cwd` getters (`cwd` is the
  caller's directory, or once the run starts the provider's workspace or the
  parent's directory).
- `src/roster.ts` (new): the branch's agents, folded from its records and
  overlaid with live state, ordered waiting on a question, running, failed,
  then completed newest first. A record still reading queued or running with
  no live agent is reported as interrupted. Formats the roster line, the card
  (20 whole lines at most; waiting and running agents never dropped; the last
  line counts what was left out) and the list. Descriptions are cut to 80
  characters and questions and errors to 160, after stripping terminal
  controls, at grapheme boundaries so wide characters and emoji stay whole.
- `src/tools/get-result-tool.ts`, `src/tools/get-result-report.ts`:
  `agent_id` is optional; without it `subagent_get` lists the branch's agents
  with `details.kind: "list"`. An ID is visible only if the current branch
  holds a record for it, so a live agent started on a branch `/tree` has left
  is hidden. When no live agent has the ID, the report comes from the saved
  record — status, result, error, question, model, directory and transcript
  path — and says the agent cannot be resumed because its live session ended.
  `Agent not found` now says the branch never started the ID.
- `src/handlers/roster-card.ts` (new), `src/index.ts`: a `context` handler,
  following pi-stash's pattern, strips its own card and appends a fresh one as
  a `custom` message with `display: false`, never written to the transcript.
  It is armed by `session_start` (reload, resume, fork), `session_tree` and
  `session_compact` when the branch already has agents, and stops once a
  successful `subagent_get` list result arrives after that event. A branch
  with no agents gets no card.
- `src/tools/agent-tool.ts`, `src/tools/steer-tool.ts`: the resume and steer
  doors no longer claim records are cleared at session start; they point at
  `subagent_get` without `agent_id`.
- `src/config/default-agents.ts`: the orchestrator profile lists its workers
  with `subagent_get` after compaction, reload or a handoff.
- `README.md`, `docs/configuration.md`: document the records, the list, the
  record-backed reports and the card, and replace the note that a reload does
  not reconnect agent IDs.

## 2026-11-04: Agents run in the background by default; `foreground` replaces `run_in_background`

`subagent_start` returns an agent ID at once and announces the result with a
completion notification unless the call passes `foreground: true`, so a parent
can end its turn and stay available while agents work. The `run_in_background`
parameter and frontmatter key are removed, with no alias.

- `src/tools/agent-tool.ts`: the `foreground` parameter replaces
  `run_in_background`. A new agent and a resume both run in the background
  unless the call sets `foreground: true`; a resume still ignores the agent
  file's default. In print and json mode, where nothing can wake the parent
  after its turn, an omitted flag runs in the foreground. The tool guidelines
  tell the model to start its agents, end its turn and let the notification
  wake it, and to use `foreground: true` only when its next step needs the
  result.
- `src/config/invocation-config.ts`, `src/tools/spawn-config.ts`: `foreground`
  is the lockable field, and the merge takes the door's default (background
  unless a one-shot mode says otherwise). `resolveBackgroundMode` reads the
  agent's `foreground` frontmatter for service spawns, whose `foreground`
  option is unchanged.
- `src/types.ts`, `src/config/custom-agents.ts`: agent files declare
  `foreground: true|false`; `AgentConfig.foreground` replaces
  `runInBackground`. A `run_in_background` key, or a `locked` entry naming it,
  is no longer read.
- `src/ui/display.ts`: a foreground run is tagged `foreground`; background runs
  carry no tag. `src/ui/agents-browser.ts` shows a `Foreground` field.
  `src/main-agent-profile.ts` reports `foreground` among the skipped
  child-only fields.
- `src/tools/get-result-tool.ts`: `subagent_get`'s `wait` warns that it blocks
  the user too and points at the completion notification.
- `src/config/default-agents.ts`: the `orchestrator` profile stays available.
  It starts workers in the background, records their IDs, ends its turn, and
  never passes `foreground: true`, waits with `subagent_get` or polls. Run as a
  subagent, it collects its workers with `subagent_get` and `wait` before it
  finishes, because its run ends with its turn. It waits for a pull request's CI
  itself with `job_watch` and hands only the fixes to a worker in the PR's
  worktree. It no longer hands the waiting to a babysit-pr worker, because a
  subagent finishes when it ends its turn and its watch would wake no one.
- `README.md`, `docs/configuration.md`, `docs/architecture/architecture.md`:
  document the new default and flag.
- Tests: `test/tools/agent-tool.test.ts` covers the background default, the
  print/json fallback and the `foreground` flag for new agents and resumes;
  `test/ui/invocation-tags.test.ts` covers the tags;
  `test/config/agent-types.test.ts` asserts the orchestrator instructions. The
  other suites use the new field names.

## 2026-11-04: Orchestrator checks pull requests with git_pr_status

`src/config/default-agents.ts`: the built-in `orchestrator` profile records the
URL of a pull request a worker opens on its task, reads its state, review and
checks with pi-git's `git_pr_status` instead of `gh` or the GitHub MCP tools,
waits for CI with `job_watch` on `git_pr_status` (or hands the PR to a worker
with the babysit-pr skill), and completes the task and removes its worktree
once the PR is merged. After compaction or a reload it calls `git_pr_list`
beside `todo_list` and `git_worktree_list`. `test/config/agent-types.test.ts`
asserts the new instructions.

## 2026-11-03: Orchestrator runs implementation tasks in worktrees

`src/config/default-agents.ts`: the built-in `orchestrator` profile gives each
implementation task its own git worktree (`git_worktree_create`, one per
repository with a shared workspace when a task spans several) unless it is a
small change verified in place, passes it as `subagent_start`'s `cwd`, sends
the reviewer and follow-up workers to the same `cwd`, and removes it with
`git_worktree_remove` once its branch is merged or pushed. After compaction or
a reload it calls `git_worktree_list` beside `todo_list`. The profile already
had every parent tool through `all`; only its instructions changed.
`test/config/agent-types.test.ts` asserts the new instructions.

## 2026-11-03: pi-subagent-worktree removed from the bundle

The vendored `pi-subagent-worktree` companion was removed from the bundle; a
caller now prepares a directory and passes it as `cwd`. The `WorkspaceProvider`
seam is unchanged.

- `README.md`, `docs/architecture/architecture.md`,
  `docs/architecture/client-server-opportunities.md`,
  `docs/comparison-with-upstream.md`: worktree isolation is described as a
  caller-chosen `cwd` or a workspace provider, not a companion package.
- `src/service/service.ts`, `test/composition-root.test.ts`: comments name a
  workspace provider in general.

## 2026-11-03: Caller-chosen working directory

`subagent_start` takes an optional `cwd`: an existing directory, absolute or
relative to the parent's, that the child runs in. It lets an orchestrator hand a
worker a git worktree it created, in any repository, instead of relying on a
workspace provider chosen per agent type.

- `src/lifecycle/spawn-cwd.ts` (new): resolves and checks the path. A missing
  directory or a non-string is refused before anything is spawned.
- `src/tools/agent-tool.ts`: the `cwd` parameter and its guidance line; refused
  together with `resume`, since a resumed agent keeps its directory.
- `src/tools/spawn-config.ts`, `background-spawner.ts`, `foreground-runner.ts`,
  `src/lifecycle/subagent-manager.ts`: thread `cwd` like `handoff`.
- `src/lifecycle/subagent.ts`: with a `cwd`, `run()` skips the workspace provider,
  so nothing is disposed when the run ends and `resumeRefusal` never reports
  `workspace-disposed` for it.
- `src/service/service.ts`, `service-adapter.ts`: `SpawnOptions.cwd`, checked
  against the session's cwd; a bad one throws.
- `src/lifecycle/child-lifecycle.ts`, `create-subagent-session.ts`:
  `subagent:session:created` carries the child's effective `cwd`.
- Tests: `test/lifecycle/spawn-cwd.test.ts` (new), `test/cwd-sdk.test.ts` (new:
  a real orchestrator session spawns a worker with a relative `cwd` and resumes
  it), and cases in `subagent.test.ts`, `agent-tool.test.ts`,
  `service-adapter.test.ts`; `handoff-sdk.test.ts` expects the new `cwd` field.

## 2026-11-01: Questions through pi-ask (#62)

The `ask_parent` tool is gone. A child asks with the bundled pi-ask's `ask`,
which the core reaches through a session-tree service: before a child's
extensions bind, `createSubagentSession` offers the run's question recorder as
the child's `ask:route`, adds `ask` to the child's tool allowlist as protocol,
and withdraws the service when the child is disposed. The question still lands
on the record as `pendingQuestion`, and every result carrier still renders it
with the resume call that answers it.

## 2026-11-01: Identifiers (#59)

Every identifier follows this bundle's `resource:name` grammar, so session data
and process globals from upstream builds are not recognised. The directory and
package moved from `extensions/pi-subagents` (`@gotgenes/pi-subagents`) to
`extensions/pi-subagent` (`pi-subagent`).

- Events: `subagents:<event>` became `subagent:<event>` (created, started,
  resuming, resumed, completed, failed, compacted, steered), and
  `subagents:update` became `subagent:notified`. Child-session events
  `subagents:child:*` became `subagent:session:*` (`session-created` is now
  `subagent:session:created`). Settings events are `subagent:settings:loaded`
  and `subagent:settings:changed`.
- Session entries: `subagents:record` became `subagent:record`, and
  `pi-subagents:main-agent-profile` became `agent:profile`.
- Message types: `subagent-notification` became `subagent:completion`,
  `subagent-update` became `subagent:update`, `subagent-workspace-notice` became
  `subagent:workspace-notice`, and `subagents:turn-budget-warning` became
  `subagent:turn-budget-warning`.
- Global symbols: the upstream `@gotgenes/pi-subagents:service` slot is removed;
  publications live under `subagent:services`.
- Tools: `subagent` became `subagent_start`, `get_subagent_result` became
  `subagent_get`, `steer_subagent` became `subagent_steer`, and `notify_parent`
  became `parent_notify`.
- Commands: `/subagents:watch|settings|sessions` became `/subagent:*`, and
  `/subagents:agents` became `/agent`, since it browses agent definitions the
  main agent also uses through `--agent`.
- UI keys: widget `agents` became `subagent:widget`, the watch host
  `subagent-watch-host` became `subagent:watch`, status `subagents` became
  `subagent:status`, and status `main-agent` became `agent:status`.
- Settings file: `subagents.json` became `subagent.json`.

## 2026-10-31: Shared pi-ui (#51)

UI primitives now come from the bundle's `packages/pi-ui` library instead of
local copies:

- `src/ui/read-only-browser.ts` (the adapted `pi-system-insights` viewer) is
  removed. `/subagents:agents` builds an `ExplorerView` and opens it with
  `showExplorer`; details are structured blocks (fields, then Description, Tool
  guideline, Body, Fragments and Composed instructions sections). The regular
  renderer fallback is gone: pi-ui supports Pi's fullscreen TUI only.
- `src/ui/widget-renderer.ts` keeps ordering, linger, queued counts, budgets and
  the elapsed/prompt-mode width thresholds, and describes rows as a `WidgetView`
  for `renderWidget` (overflow groups `running`/`finished`). Status text is
  pre-clipped to 40% of the row as before.
- `src/ui/glyphs.ts`, `src/ui/labeled-rule.ts` and `src/ui/bounded-lines.ts` are
  removed in favor of pi-ui's `ICONS`/`SPINNER`, `labeledRule` and `BoundedLines`
  (renamed glyphs: `toolCall` → `tool`, `agentsHeading` → `agents`,
  `agentsActive` → `active`, `agentsIdle` → `idle`).
- `watchText` and the main-profile notice use pi-ui's `sanitizeText`; lone CR now
  becomes a line break, tabs expand to four spaces, and an incomplete CSI keeps
  its parameter bytes as plain text.
- `src/ui/watch-overlay.ts` owns its passive overlay through `PassiveOverlay`
  (non-capturing, own handle, hide on width change). Visibility, linger and
  repaint cadence are unchanged.
- The `/subagents:sessions` navigator, `/subagents:settings` dialogs and tool/
  notification renderers keep their own presentation.

## 2026-10-31: Remove standalone declaration bundling (#43)

- Dropped the TypeScript 7 / Rolldown declaration bundles added in #42 and the
  optional `build:types` script. Public API type exports reference TypeScript
  source directly; Pi loads that source without a declaration or JavaScript
  build.
- Companion extensions import this vendored source through a relative path,
  e.g. `../pi-subagent/src/service/service.ts`, rather than assuming the
  published `@gotgenes/pi-subagents` package is installed in a Git-installed
  bundle.

## 2026-10-31: Shared Oxc and TypeScript 7 tooling (#42)

- Apply the bundle's Oxfmt formatting and Oxlint correctness checks to source,
  tests, scripts, and documentation.
- Keep terminal-control matching explicit with narrowly scoped lint comments.
- Resolve private import aliases to explicit `.ts` files so sibling workspace
  consumers can load the service through standard package import resolution.
- Generate public declarations with TypeScript 7 and bundle them with Rolldown;
  no TypeScript 6 compiler API is required.

## 2026-10-31: Orchestrator todo handoff (#40)

- The orchestrator prompt (`src/config/default-agents.ts`) tells it to hand each
  worker its tasks with `handoff: { todos: { keys } }`, which pi-todo turns into a
  claim the worker updates directly. Its note that workers' todo edits never reach
  the ledger now covers only edits outside a handoff.
- `test/todo-handoff-sdk.test.ts`: a real orchestrator (pi-subagents + pi-todo)
  hands two tasks to a worker through the tool and checks the veto, the scoped list,
  attributed updates, a new task joining the claim, and the release.

## 2026-10-31: Spawn handoff and run identity on child events (#35)

- The `subagent` tool and `SpawnOptions` take a generic `handoff` object whose
  top-level keys belong to other extensions (pi-todo reads `todos`).
  `normalizeHandoff` (`src/lifecycle/child-lifecycle.ts`) only checks it is a JSON
  object within `MAX_HANDOFF_BYTES`, copies and deep-freezes it; the core forwards
  it untouched on `subagents:child:session-created`. New handoff data needs no
  change here.
- `subagents:child:session-created`, `bound` and `disposed` also carry `agentId`
  (the record id) and `toolCallId` (the parent's tool call; absent for service
  spawns), so a parent-side extension can tie a child session to the spawn.
- Tests: `test/handoff-sdk.test.ts` (a real orchestrator session spawning through
  the tool) plus unit tests in the lifecycle, tools and service suites.

## 2026-10-31: Companion typechecking (#33)

- `package.json` `imports`: each `#src/*` and `#test/*` target gained a `types`
  condition (`./src/*.ts`) beside the unchanged `default`, so a companion
  extension that imports this source by relative path (pi-subagent-worktree)
  can typecheck it without mapping `#src` itself. This package's own
  `tsconfig.json` paths and its runtime resolution are unchanged.

## 2026-10-31: Personal reviewer profile (#36)

- `src/config/default-agents.ts`: new built-in `reviewer` (read-only tools, inherited
  model, `replace` mode). It verifies finished work against its acceptance criteria,
  may run the project's checks, never edits files or git state, and starts its report
  with `Verdict: PASS`, `FAIL`, or `BLOCKED`, followed by per-criterion evidence.
- `AgentTypeRegistry.DEFAULT_AGENT_NAMES` lists it after Plan.
- The orchestrator prompt names reviewer for verification and gains one bullet:
  review each implementation task with a reviewer that did not do the work, resume
  the implementer on `FAIL`, and stop after two failed rounds.
- Tests: `test/config/agent-types.test.ts` (profile, tools, orchestrator wording,
  user override); fixture user agent `reviewer` renamed `linter` there, and the
  agents-browser lists now include the built-in.

## 2026-10-31: Latest-model defaults (#38)

- `src/session/model-resolver.ts`: a model string ending in `@latest`
  (`[provider/]family@latest`) resolves to the newest available model whose id
  contains `family`, comparing the numbers in the id (so `claude-haiku-5-5` beats
  `claude-haiku-4-5-20251001`). No match is an error string, so config-specified
  models fall back to the parent like any other unresolved model.
- `src/main-agent-profile.ts`: a `provider/…@latest` profile model goes through the
  resolver instead of exact lookup.
- Explore's default model is `anthropic/claude-haiku@latest` instead of the pinned
  `anthropic/claude-haiku-4-5-20251001`, so it follows new Haiku releases and does not
  silently fall back to the parent's model when an old one is retired.
- Docs: built-in table and the `model` frontmatter rows here and in the README.

## 2026-10-30: Service publication per session (#29)

- Upstream kept one `globalThis` slot. Each in-process child session loads the
  extension again, replaced the parent's service at load, and deleted the slot on
  shutdown, leaving the parent with no service until its next reload.
- `src/service/service.ts` now keeps every published service under
  `Symbol.for("subagent:services")` (see Identifiers), pending from the factory
  until `session_start`. The newest pending service is the default while a load
  is in progress (so companions such as pi-subagent-worktree still register
  their provider from their factory, in children too); otherwise the outermost
  started one is. The upstream single slot is gone (see Identifiers).
- A starting session drops older pending publications, and a child whose
  creation fails discards the ones its load made, so a load that never starts
  cannot stay the default. `unpublishSubagentsService(service)` removes only its
  own publication (the argument is now required).
- `getSubagentsService(sessionId?)` can return a specific session's service.
- Tests: `test/service/service.test.ts`, and parent/child, load-only,
  companion and failed-child cases in `test/composition-root.test.ts`.

## 2026-10-29: Personal pi-stash integration (#13)

- `READ_ONLY_TOOLS` in `src/config/default-agents.ts` gains `stash_get` and
  `stash_list`, so Explore and Plan can read `stash:<name>@<hash>` handles from the
  bundled `pi-stash` extension. Both tools only read.
- Explore's `toolNames` additionally include `stash_put` (not the shared list), so it
  can return large findings as a handle. `stash_put` writes only to Pi's data
  directory, never the project. Explore's read-only prompt names it as the single
  exception to "no files" and asks for large findings to be stashed.
- Plan stays read-only: `stash_get` and `stash_list` only.
- The orchestrator prompt gains one bullet: brief workers with stash handles for
  shared material and ask for large results as handles.
- Children load the parent's extensions, so the tools exist there when the bundle
  is installed; without pi-stash the extra names simply match no tool.
- `test/stash-sdk.test.ts` covers Explore writing and reading, and Plan being
  refused `stash_put`, in real SDK child sessions.

## 2026-10-29: Shared compiler and test config (#17)

- `vitest.config.ts`: dropped the `#src`/`#test` resolve aliases. Vite resolves
  the package.json `imports` map itself; `tsconfig.json` keeps its `paths`
  because TypeScript does not add file extensions to extensionless `imports`.
- Root `tsconfig.base.json` now also enables `verbatimModuleSyntax`,
  `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noUnusedLocals`, and `noUnusedParameters`; this source needed no changes.

## 2026-10-29: Dev dependency pins (#12, #15)

- Pi dev dependencies bumped from 1.1.0 to 1.4.0 (2026-10-29).
- `typebox` dev dependency pinned to `1.3.27`, the exact version Pi 1.4.0 bundles,
  so tests exercise the schema library extensions receive at runtime.
- `engines.node` raised from `>=22` to `>=24` and `@types/node` to `^24`, matching
  the bundle's supported Node.js version.
- `vitest` dev dependency raised from `^4.1.11` to `^5.0.5`; no test changes needed.
- `test/ui/read-only-browser.test.ts` (since removed by the shared pi-ui entry): the
  `plain()` helper also stripped Pi's fake-cursor markers. pi-tui 1.4.0's `Input`
  wraps its cursor cell in zero-width APC markers that the TUI resolves to the
  same reverse video 1.1.0 emitted directly, so the rendered output is unchanged.

## 2026-10-22: Personal prompt fragments

- Added `fragments: [name, ...]` to custom agent definitions.
- Resolve names only in the winning profile's `agents/fragments/<name>.md`;
  plain Markdown fragments precede the profile body in declaration order.
- Main and child profiles share composition; selected execution retains expanded
  text across resume and background queueing.
- Discovery stays lazy, project fragment reads require trust, and invalid/missing
  references fail selected execution rather than dropping instructions.
- Read-only `/subagents:agents` details show fragment sources and composition.

## 2026-10-22: Personal profile UX

- Added `/subagents:agents`: searchable read-only definitions, disabled status,
  effective fields/source paths/locks, description, then full-width Body content.
- Adapted the `pi-system-insights` viewer locally to keep standalone installs
  independent: padded rounded frame, contextual help, bounded regular screen,
  centered fullscreen overlay, keyboard navigation and fullscreen wheel scrolling.
- Added `--agent <profile>` for the initial main session only. Applies profile
  model/thinking/tools as defaults, preserves manual choices on resume/reload,
  and restores the exact saved profile body as system instructions.
- Added main-only `--agent-model <model>` for explicit initial `--agent` selection.
  Overrides the effective snapshot's model default without mutating definitions,
  reapplying on restoration, or forwarding a child override. Launchers pair it
  with core `--model` because native `getFlag` cannot read core CLI flags.
- Main MCP wildcards expand only to non-hidden tools available at startup; empty
  matches are reported in the startup notice, not treated as missing required
  tools. MCP connects asynchronously. Literal missing/hidden tools still block.
- Main profile selection requires project trust for project definitions and keeps
  delegation tools available. Child behavior is unchanged; main profile body is
  excluded from both full and portable child prompt inheritance.

## 2026-10-22: Personal watch overlay

- Added fullscreen-only `/subagents:watch` and `Ctrl+Alt+S`, with a passive right
  overlay showing always-tailing background-agent text and compact tool activity.
- Added persisted width presets (`quarter`, `third`, `half`, `two-thirds`),
  default visibility (closed), and thinking visibility (shown). Explicit session
  visibility overrides the open/closed default.
- Feed entries retain provider-emitted thinking, with themed Think / Tool / Skill
  labels and error coloring; thinking visibility changes update live overlays.
- Agents still execute in-process. Internal session-ready observer wiring allows
  live subscription before the first child event without widening the public API.
- Output buffers and repaint cadence are bounded; no transcript scrolling or
  inherited context is shown. Session shutdown/replacement releases subscriptions,
  timers, and only the overlay this fork owns.
- Regular mode remains overlay-free: Pi 1.1.0 still exhibits the scrollback defect
  documented in ADR 0007, including with one- or two-row top margins on bursts.

## 2026-10-22: Personal widget changes

- Replaced the two-line running-agent tree with a static `── ● Subagents ──`
  header rule and one line per agent. No enclosing box or bottom border.
- Layout inspired by `maplezzk/pi-extensions/packages/pi-interactive-subagents`,
  but implemented locally using Pi themes and terminal-cell width utilities.
- Elapsed time and agent type/task on the left; activity or outcome on the right.
  Model/token/turn stats remain in tool results, not the widget.
- Queued agents have individual rows and no ticking elapsed clock. Existing
  background-only filtering, completion linger, animation cadence, and viewport
  safeguards remain unchanged. Running/queued/finished order determines priority.
- Rendering honors the width passed by Pi, rather than always using terminal width.
- Agent rows now reserve one space at each edge, before elapsed time and after
  activity/outcome; header remains full-width.
- Renderer tests cover the single-line layout, static header, ANSI/Unicode,
  edge spacing, narrow screens, queued/finished outcomes, and exact overflow counts.

## 2026-10-22: Integration

- Marked package private and removed publication configuration.
- Replaced monorepo `catalog:` dev dependency versions with normal versions.
- Aligned Pi dev dependencies with installed Pi 1.1.0; host runtime peers use `*`.
- Removed lint commands requiring upstream monorepo configuration and removed the
  published-tarball verification command from the manifest. Its original script
  remains as reference, not part of local verification.
- Kept `#src/*` and `#test/*` import aliases and the original source layout.
- Root private npm workspace supplies a single development install and commands.
- Copied upstream shared TypeScript compiler settings to root `tsconfig.base.json`.
- Added a local-install notice to the upstream README.
- Adapted tests for Pi 1.1: added `Terminal.setProgramStatus` to the terminal stub,
  fixed viewport keybindings explicitly, and disabled Git commit signing only in
  the temporary-repository fixture (no personal Git settings changed).

No upstream runtime behavior was intentionally changed during import.

## 2026-10-22: Vendored

Imported from upstream; see [UPSTREAM.md](UPSTREAM.md). Upstream's changelog was
cleared at import; for earlier history see the
[source changelog](https://github.com/gotgenes/pi-packages/blob/29bfbfe605d726c78f6120977b08666716e048f2/packages/pi-subagents/CHANGELOG.md).
