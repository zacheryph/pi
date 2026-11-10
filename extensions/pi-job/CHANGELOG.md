# Changelog

Local changes to this vendored copy, newest first. Where it came from is
recorded in [UPSTREAM.md](UPSTREAM.md).

## 2026-11-10: A reloaded parent's own children are not an unknown handoff

Roadmap step 12 (`docs/roadmaps/subagent-work-lifecycle.md`): a parent reload now suspends the jobs
of the subagents it keeps (pi-subagent tells a child holding open work that the session is
`reload`ing, and reopens it at its own `session_start`).

- `Owner.parent`: when an owner is suspended for a reload, pi-job records the session that delegated
  it (`parentOf` in pi-session-tree). The parent's `session_start` skips the "awaiting reload handoff;
  ownership is unknown" warning for owners whose `parent` is the starting session, because its own
  pi-subagent takes them back a moment later (pi-job loads first in the bundle, so its `session_start`
  runs before pi-subagent reopens the children). Another session's pending handoff still warns.
  Without this every `/reload` of a parent with a waiting child printed that warning for the child.
- Tests: an owner whose `parent` is the starting session raises no notice and another one still does;
  a reload records the delegating session on the suspended owner.

## 2026-11-09: Reload race and work-contract gaps

- `JobItems.adopt`: a job that is already terminal and was not stopped on request
  (`killedBy !== "request"`) is completed through the adopted item, once startup is over, instead of
  being cancelled silently. At a reload pi-work's `session_shutdown` handler disposes the old host
  before pi-job's handler suspends its items, so a job that exited in between had its completion
  dropped and the next `adopt` cancelled the item with no message. Only jobs stopped by `job_kill` or
  `/job kill` are cancelled on adoption.
- Follows pi-work: the item's close record is written once its completion is in the transcript, and a
  completion the host cannot deliver leaves the item open (lost at the next start), so the README's
  "narrow gap" paragraph is gone.
- Tests: the fake `ExtensionAPI` appends sent messages to the transcript like Pi does (the host closes
  an item when it sees its message there). New: the `/job kill` command path cancels the item and
  sends nothing; the reload race above (a job exits between the host's and pi-job's shutdown
  handlers); the first-agent-start fallback releases a reload gap's completion when
  `resources_discover` never comes; `adopt` of a terminal job (unit). The adopt test for a stopped job
  now sets `killedBy: "request"`, as the manager does.

## 2026-11-09: Jobs are work items

pi-job produces on the work contract (`packages/pi-work`, `work:v1`) and delivers nothing itself.

- New `src/items.ts` (`JobItems`): `job_start` and `job_watch` open one item per job or watch in the
  session's work host (`ensureWorkHost`, owner `pi-job`, kind `job` or `watch`, label the job title,
  data `{ jobId, sessionId, logPath }`). A job's end completes its item with today's completion
  message, unchanged (`Job j1 succeeded: ...`, one block, same tail limits, same
  `details.completions`). `job_kill` and `/job kill` cancel the item; a quit leaves it open. A job
  that cannot get an item (no host, or the write fails) is stopped before the tool returns.
- Removed: the `Delivery` use and the host adapter in `extension.ts`, the `agent_start`,
  `agent_settled` and `agent_before_settle` handlers (the host's run-boundary handlers do this),
  `continuesRun`, and the `Delivery` re-export in `delivery.ts`. `delivery.ts` keeps `CUSTOM_TYPE` and
  `dedupeCompletions` for transcripts written by older versions. The tests of `Delivery` moved to
  `packages/pi-work/test/delivery.test.ts`.
- One message per completion. The batched message (`N background jobs finished:`), `formatBatch`,
  `tailBudget` and `BATCH_BYTES` are gone: several completions that arrive together are separate
  messages that one run answers, each with the full 40 lines / 4 KB tail. `dedupeCompletions` still
  handles batched messages from older versions.
- Reload: the owner registry entry is version 4 and holds the manager and its `JobItems` (a
  version 3 owner is not adopted). The host does not survive a reload, so at `session_start` pi-job
  calls `adopt` for the items it left open. An item is adopted only when its recorded session id
  equals this session's and its job id and log path match a live job of the retained manager: a fork
  that inherits the records, or a reused job id, adopts nothing. Jobs that end in the reload gap
  are completed through their adopted items on `resources_discover` (first agent start as the
  fallback), after every extension started, replacing the `setImmediate` rebind.
- Removed: `reportReloadLoss`, `historicalRunningJobs` and the `job:reload-notice` message. Items
  nobody adopts (jobs of an earlier process, or of the session a fork came from) are closed as lost
  by the host with one `work:lost` message that starts no turn and reaches the model in every
  session. The "no reload handoff" UI note is gone with it. The pi-job warning for a completion that
  was "not delivered" became the host's: the item stays open on disk and the next start reports it
  lost. The incompatible-handoff warning stays, and now names the stopped jobs and their logs.
  Jobs started by versions before this one have no item, so a restart or an upgrade by reload
  reports nothing for them.
- Tests: the fake `ExtensionAPI` persists `appendEntry` records and emits `resources_discover`;
  `test/work-session.test.ts` runs a real `session.reload()` (a watch re-adopted and completed, a job
  that ends during the reload) and a restart (one lost message, no model request) on a scripted
  model; `test/items.test.ts` covers adoption rules. The reload-loss tests were rewritten to expect
  lost items, and the reload-gap batch test now checks one message per job. The test of
  `historicalRunningJobs` went with the function. README updated.

## 2026-11-09: Delivery mechanics moved to pi-work

- `src/delivery.ts` no longer defines `Delivery`: the class (idle wake, `triggerTurn: false` during a
  run, hold while suspended for a reload, dispose) and the generic form of `continuesRun` live in
  `packages/pi-work/src/delivery.ts`, where the work contract's hosts use the same mechanism.
  `delivery.ts` re-exports `Delivery` and its types, keeps `CUSTOM_TYPE`, a `continuesRun(event)` bound
  to `job:completion`, and `dedupeCompletions`. Pure refactor: behaviour, message format and the owner
  handoff are unchanged, and the suite passes without edits. One additive accessor, `Delivery.isDisposed`.

## 2026-11-09: Completions through Pi's run boundaries

- `src/delivery.ts`: a completion is one `pi.sendMessage` call at once. Idle sends it with
  `triggerTurn: true`. While a run is active, or while Pi is busy without one (compaction, branch
  summary), it goes out with `triggerTurn: false`, so Pi appends it to the transcript at the end of
  the turn. `continuesRun` and the new `agent_before_settle` handler in `src/extension.ts` return
  `continue: true` when a completion follows the model's last answer in a completed run, so the
  model answers it in the same run. After Escape or abort the message stays in the transcript and
  no turn is forced.
- Removed: the follow-up queue (`deliverAs: "followUp"`), `confirm` and the `message_end`
  confirmation, the one-shot resend, the held batch released at `agent_end` and `agent_settled`,
  and the drains on `session_compact`, `session_compact_failed` and `session_tree`. Each completion
  is its own message now; the batched output budget still applies to a reload gap, which flushes
  held completions as one message. `dedupeCompletions` stays for transcripts written by older
  versions.
- `src/ownership.ts`: the reload handoff owner is version 3. A version 2 owner holds a Delivery
  with the old host protocol, so it is not adopted and its jobs are stopped, as for any
  incompatible handoff.
- `test/run-boundary.test.ts` pins the Pi behaviour this relies on with a real `AgentSession` and a
  scripted model. `test/agent-session.test.ts` now pins the new guarantees: in the transcript after
  Escape or abort and seen once by the next run, answered in the same run, one request for several
  completions, nothing woken by compaction or `/tree`. The `delivery.test.ts` and
  `extension.test.ts` tests of the queue, confirmation and resend now cover the run-boundary
  equivalents.
- `UPSTREAM-ISSUES.md` #3, #4 and #5 are marked as no longer affecting pi-job. README updated.

## 2026-11-09: Pi 1.5.0 argument validation

- `test/extension.test.ts`: Pi 1.5.0 validates tool arguments with pi-schema,
  which truncates a fractional integer instead of rejecting it. The bounds test
  now expects `tailLines: 2.5` to arrive as `2`. No source change: `job_read`
  already floors the value.

## 2026-11-08: Faux sessions from pi-test-helpers

- `test/toolcheck-session.test.ts` and `test/pi-execute-tool.contract.test.ts`
  build their sessions with `packages/pi-test-helpers`' `fauxSession` and read
  results with `toolResults` and `messageText`. `test/agent-session.test.ts`
  still loads the installed runtime on purpose. No source change.

## 2026-11-08: Test waits from pi-test-helpers

- `test/helpers.ts`: `waitUntil` polls through `packages/pi-test-helpers`'
  `waitFor`, and `sleep` and the new `tick` are its helpers; inline `setTimeout`
  and `setImmediate` promises in the tests use them. No source change.

## 2026-11-08: Test temp directories from pi-test-helpers

- `test/helpers.ts`: `tempDir` wraps `packages/pi-test-helpers`' `tempDir`,
  which removes the directory when the test ends. No source change.

## 2026-11-08: Tests under root and non-reaping init

- The test helper `alive()` counts a zombie as dead. Killed orphans are
  reparented to PID 1, and some container inits never reap them, so
  `kill(pid, 0)` kept succeeding and the host-exit escalation test timed out.
- Skip the unopenable-log-file test as root, which ignores directory
  permissions, so the expected EACCES never happens.
- Read every test PID with `waitForPid`. The 2026-11-04 fix covered one test;
  the rest still read a PID file as soon as it existed, and an empty read gave
  PID 0. That flaked `session_shutdown kills running jobs without notifying` in
  CI. `alive()` now throws on a non-positive PID, and the escaper cleanup no
  longer risks `kill(0, SIGKILL)` on the test runner's own process group.

## 2026-11-04: Shutdown test PID readiness

- Wait for positive PIDs in the shutdown test, rather than just PID file existence.
  Shell redirection can expose an empty file before `echo` writes; reading it as
  PID 0 made the liveness assertion probe the test's own process group.
- Add regression coverage for missing, empty, zero, and invalid PID files.

## 2026-11-01: Identifiers (#58)

Renamed to this bundle's `resource:name` grammar, so session data and process
globals from upstream builds are not recognised:

- Directory and package: `extensions/pi-jobs` (`@woksin/pi-jobs`) became
  `extensions/pi-job` (`pi-job`).
- Global symbols: `pi-jobs.liveManagers` became `job:managers`, and
  `pi-jobs.sessionOwners.v2` became `job:owners`. Owners keep their internal
  protocol `version`, so the key carries none. The `.v1` migration is removed.
- Message types: `pi-jobs` became `job:completion`, and `pi-jobs-reload` became
  `job:reload-notice`.
- Tool `job_output` became `job_read`; command `/jobs` became `/job`.
- Display prefixes in notices and logs read `pi-job:`.

## 2026-10-31: Shared Oxc tooling (#42)

- Source, tests, scripts, and Markdown are formatted with the bundle's shared Oxc
  configuration, so these files no longer claim byte-for-byte parity with
  upstream; the import commit remains the reference for comparing local changes.
- The shared base's unused-local checks now apply here too: removed the unused
  test binding, used Node's actual asynchronous cleanup-hook type, and explicitly
  discarded test-registration promises (the Node runner tracks the tests). Test
  message fixtures describe both string and text-block content.
- Shared tools and development dependencies live at the repository root.

## 2026-10-29: Tool checks for `job_watch` (#26)

`job_watch` accepts `toolCheck` instead of `check`: one Pi tool call per interval
through the kept `ctx.executeTool`, with an optional `match` on the result. Usage,
allowlist, and lifecycle are in [TOOL-CHECKS.md](TOOL-CHECKS.md).

New files, so upstream syncs do not touch them:

- `src/probe.ts`: runs an async check with the contract `runCheck` expects from a
  `SupervisedRun` (one outcome, `terminate()` wins over a late result).
- `src/toolcheck.ts`: spec validation, the allowlist, `match`, canonical JSON, and
  the consecutive-error limit.
- `test/toolcheck.test.ts` (unit) and `test/toolcheck-session.test.ts` (real
  `AgentSession`, faux provider).
- `TOOL-CHECKS.md`.

Edits to upstream files, kept small:

- `src/watch.ts`: `CheckResult.inconclusive`; `evaluateWatch` treats it like a
  timed-out check (no match, no baseline).
- `src/jobs.ts`: `WatchOptions.probe`; `runCheck` starts the probe instead of a
  shell run when one is given, logs `inconclusive` checks, and settles the watch
  `failed` on a probe's final error. `Job.run` is typed as the shared `CheckRun`
  interface; `envLimit` is exported for reuse.
- `src/extension.ts`: `toolCheck` in the `job_watch` schema (`check` is no
  longer required by the schema; exactly one of the two is enforced in
  `execute`) and the wiring to `ctx.executeTool`, `pi.getAllTools()`,
  `PI_JOBS_WATCH_TOOLS`, and `PI_JOBS_MAX_CHECK_ERRORS`.
- `src/format.ts`: "last check inconclusive" in notifications.
- Known gap: codemode script checks are not supported, because `codemode` is
  `model-only` and `executeTool` cannot run it. Planned for #9 if Pi gains a way
  for extensions to run codemode scripts.

## 2026-10-29: Pi `executeTool` contract for #9 (#26)

- `test/pi-execute-tool.contract.test.ts` (new, local): pins the Pi behaviour
  that `job_watch` tool checks will rely on. Calls through a tool's kept
  `ExtensionToolContext` after that call returned:
  - work while idle, during another streaming run, and after compaction;
  - leave no nested-call record on any saved message;
  - run `tool_call` hooks, which can block them; ids are `<caller id>/<n>`;
  - fail without running after `/tree` to a point with no assistant message;
  - throw a stale-context error after reload.

## 2026-10-29: Typecheck (#12)

Upstream never typechecks; it relies on its tests. Added `tsconfig.json`
(extending the bundle's strict `tsconfig.base.json`) and made `check` run
`tsc --noEmit`, plus `node --check` for the plain-JavaScript `e2e/*.mjs`. Added
`typescript` and `@types/node` dev dependencies like the other workspaces
(`@types/node` follows the bundle's Node.js 24 floor).

Five typing fixes; runtime behaviour is unchanged:

- `src/extension.ts`: the `message_end` handler takes `unknown` and narrows inside,
  like upstream's other handlers. Its narrower parameter type matched no `pi.on`
  overload.
- `src/ownership.ts` (`takeReloadOwner`): `source?.delete(…)`. `source` is always
  defined there because `owner` came from it, but TypeScript cannot infer that.
- `src/supervisor.ts`: casts `child.stdio` through `unknown` to the four streams it
  uses. Node types it as a five-entry tuple.
- `test/delivery.test.ts`: reads the private `Delivery.disposed` through a cast.
- `test/extension.test.ts`: `assert.throws` gets a validator that accepts any
  thrown value, instead of `undefined`, which Node's types reject when a message
  follows.

## 2026-10-29: Integration (#12)

Manifest only; this step changed no file under `src/`, `test/`, or `e2e/`.

- `package.json`: marked `private`, removed `publishConfig`.
- `package.json`: added a `check` script, since CI runs `npm run check` for each
  changed workspace and upstream has none.
- `package.json`: added `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`
  dev dependencies, matching the bundle's Pi pin (now 1.4.0), so upstream's
  `test/runtime.ts` resolves a local runtime instead of a user installation.
- Root `package.json`: added the workspace and the `pi.extensions` entry.
- `scripts/verify-bundle.mjs`: asserts the `job_*` tools and `/job` command.
- Known gap: pi-jobs registers no widgets or custom tool renderers, so the
  `AGENTS.md` spacing rules do not apply yet. Recheck when adding UI.
- Known gap: jobs survive `/reload` in the same process, not a Pi restart.

## 2026-10-29: Vendored

Imported from upstream; see [UPSTREAM.md](UPSTREAM.md). Upstream's changelog was
cleared at import; for earlier history see the
[source changelog](https://github.com/woksin/pi-jobs/blob/a1c27af538b059815beddbb4c4f2c98cfe1eb3e9/CHANGELOG.md).
