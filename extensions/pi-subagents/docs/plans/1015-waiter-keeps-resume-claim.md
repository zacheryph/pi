---
issue: 1015
issue_title: "pi-subagents: a get_subagent_result wait that wakes after a resume starts clears the resume's claim"
---

# Keep a resume's claim, and the waited-for outcome, when a wait wakes after a resume starts

## Release Recommendation

**Release:** ship independently

No roadmap step in `docs/architecture/architecture.md` references #1015, and pi-subagents has no open improvement phase.

## Problem Statement

`get_subagent_result` with `wait: true` claims the record, waits for the run to settle, and then decides by reading `record.isActive()`.
If the record is still active it assumes the wait was abandoned and calls `release()`, which clears the claim unconditionally.

A resume can start between the run settling and the waiter's continuation running.
`resetForResume` runs synchronously inside the resume, so the record reads `running` again by the time the waiter looks.
The waiter then misreads the new run as its own abandoned wait, and two things go wrong at once:

1. It clears the claim a foreground (claimed) resume took, so the resumed outcome is both returned to the resumer and announced to the parent as a completion nudge.
2. It reports the *resumed* run (`Status: running`, no result) instead of the run it waited for.
   The waiter's own claim already suppressed run 1's nudge at settle time, so run 1's outcome reaches the parent through no channel.

The issue names the first symptom; planning found the second in the same window.

## Goals

- A waiter releases only the claim it took, never a claim another carrier holds (a claimed resume, or a concurrent foreground carrier).
- A waiter whose run was superseded by a resume reports the outcome of the run it waited for, plus a closing line saying the agent is running again.
- A superseded waiter does not mark the record consumed: consumption is record-wide, and setting it would suppress a background resume's nudge.
- Non-breaking.
  `SubagentRecord`, the service contract, and every report outside the superseded window are unchanged.

## Non-Goals

- Retaining more than one superseded outcome.
  A second resume during one wait would need the first resume to settle inside the same microtask window, which no real turn loop does; that case degrades to the live classification (see Design Overview).
- Changing who carries a resumed run's outcome: `startResume`'s claim/clear decision (#987) is untouched.
- Exposing claims or run ordinals on the public `SubagentsService` or `SubagentRecord`.
- The TUI renderer (`get-result-renderer.ts`): it renders from `GetResultDetails` and the report text, both of which the change feeds.

## Background

- `src/tools/get-result-tool.ts` `GetResultTool.execute`: `record.claim()`, `await record.waitUntilSettled(signal)`, then `!isActive()` → `markConsumed()`, else-if waited → `release()`.
- `src/lifecycle/subagent-state.ts` `SubagentState`: `_claimed` is a boolean; `claim()`/`release()` set and clear it; `resetForResume` clears the outcome fields and keeps the claim.
- `src/lifecycle/subagent.ts`: `Subagent.claim`/`release` delegate; `waitUntilSettled(signal): Promise<void>` races the current run handle against the signal (`settleOrAbort`).
  `completeRun`/`completeResume` mark the record terminal and notify the observer **before** the run promise resolves.
- `src/lifecycle/subagent-manager.ts`: `spawnAndWait` claims; `startResume` claims when `claimOutcome` is set, else calls `release()` to drop a stale claim (#987).
- `src/observation/notification.ts` gates nudges and updates on `record.claimed` (re-read at emit).
- Pi's `EventBus` (`../pi/packages/coding-agent/src/core/event-bus.ts`) calls `on()` handlers synchronously through Node's `EventEmitter`, so a `subagents:completed` handler runs inside `completeRun`.

### Trigger

The window is pure microtasks: from the record's terminal transition to the waiter's continuation.
Two parallel parent tool calls cannot land in it.
A resume issued while the run is live is refused (`still-running`), and one issued after the run settles arrives on a later macrotask, after the waiter has already continued.

The reachable trigger is a cross-extension consumer that resumes synchronously, or within a few microtasks, from a `subagents:completed` handler via `SubagentsService.resume(id, prompt, { claimOutcome })`.
No such consumer exists in this monorepo today.

## Design Overview

### How the repro was produced

A disposable Vitest spike (since deleted) wired a real `SubagentManager`, `ConcurrencyLimiter`, `GetResultTool`, and `NotificationManager`.
The child session was the shared `createSessionFactory` stub, with `resumeTurnLoop` held open by a gate.
The synthetic part was the trigger: an `onSubagentCompleted` observer that called `manager.resume(id, …)` after N microtask hops (`sync`, 0–6, 8, 12), standing in for a `subagents:completed` consumer.
The path is deterministic, so there was one run per condition.
The control was the 8- and 12-hop rows, where the resume starts after the waiter continued.

| Resume starts | `claimOutcome` | Waiter reports            | `claimed` after wait | Nudges                |
| ------------- | -------------- | ------------------------- | -------------------- | --------------------- |
| sync … 6 hops | true           | `running`, no result      | false                | 1 (duplicate)         |
| sync … 6 hops | false          | `running`, no result      | false                | 1 (resume's, correct) |
| 8+ hops       | true           | `completed`, run-1 result | true                 | 0                     |
| 8+ hops       | false          | `completed`, run-1 result | true                 | 1 (resume's, correct) |

All values were measured on the background (limiter) path; the hop boundary is specific to that path and stub.

### Claim handles (holder set)

```typescript
/** One carrier's commitment to deliver an outcome; releasing it drops only this commitment. */
export interface CarrierClaim {
  release(): void;
}

// SubagentState
private readonly _claims = new Set<CarrierClaim>();
get claimed(): boolean { return this._claims.size > 0; }
claim(): CarrierClaim;    // adds and returns a fresh handle
releaseClaims(): void;    // clears every holder (startResume's stale-claim drop)
```

`claimed` keeps its boolean meaning for every reader (`NotificationManager`, `canAnnounceUpdate`), so the notification side does not change.
The holders survive `resetForResume`, as the single boolean does today.
`spawnAndWait` and a claimed `startResume` ignore the returned handle: their claims are never revoked, only cleared by a later unclaimed resume.

### Run ordinal and the superseded outcome

`SubagentState` gains a run ordinal (`run`, 1 at construction, incremented in `resetForResume`).
`resetForResume` first captures the outgoing run's outcome into a single retained slot, tagged with its ordinal, and then clears the fields as today.

```typescript
/** What a settled run ended with: the fields an outcome carrier renders. */
export interface SettledOutcome {
  status: SubagentStatus;
  result: string | undefined;
  error: string | undefined;
  startedAt: number;
  completedAt: number | undefined;
  pendingQuestion: string | undefined;
  workspaceNotice: string | undefined;
  runUpdates: readonly string[]; // the owed updates, copied
}

// SubagentState
get run(): number;
supersededOutcome(run: number): SettledOutcome | undefined; // the retained outcome iff its ordinal matches
```

### `waitUntilSettled` reports what happened to the run it waited for

```typescript
export type WaitOutcome =
  | { kind: "settled" }                                  // the waited run is the current run, and it settled
  | { kind: "unsettled" }                                // the waited run is still active (interrupt, or no run handle)
  | { kind: "superseded"; outcome: SettledOutcome };     // a resume replaced the waited run after it settled
```

`Subagent.waitUntilSettled` captures `state.run` before waiting.
After the wait it returns `superseded` when the ordinal moved **and** `supersededOutcome(run)` is defined.
Otherwise it returns `unsettled` while the record is active and `settled` when it is not.
The ordinal-moved-but-no-retained-outcome case is the unreachable double resume (see Non-Goals), and it falls through to the live classification.

`unsettled` replaces "abandoned" because a queued record with no run handle returns at once and is not an abandoned wait.

### The waiter's call site

```typescript
if (params.wait === true) {
  const claim = record.claim();
  const wait = await record.waitUntilSettled(signal);
  if (wait.kind === "settled") record.markConsumed();   // claim kept, as today
  else claim.release();                                  // only this call's claim
  if (wait.kind === "superseded") superseded = wait.outcome;
} else if (!record.isActive()) {
  record.markConsumed();
}
```

The report and details builders read their outcome fields from one `SettledOutcome`: the live record's (via a `liveOutcome(record)` seam) or the superseded one.
Stats (tool uses, tokens, context, compactions), model, transcript path, and the verbose conversation stay live.
In the superseded case `pendingQuestion` is dropped (the resumer is answering it, and the live `resumeRefusal` is `still-running`, which would render the wrong affordance).
`AgentReport` gains `resumedWhileWaiting?: boolean`, and `formatAgentReport` appends this line after the addenda, before the conversation and transcript pointer:

```text
This agent was resumed before this wait returned and is running again — call get_subagent_result for that run's outcome.
```

### Design-review checklist

- Dependency width: `SettledOutcome` carries exactly the outcome fields the two builders read; `GetResultToolManager` is unchanged.
- Tell-Don't-Ask: the waiter no longer infers ownership from `isActive()`; the record answers what happened to the waited run, and the handle owns its own release.
- No new import edge: `get-result-tool.ts` already imports from `#src/lifecycle/subagent` and `#src/types`; `SettledOutcome`/`WaitOutcome`/`CarrierClaim` live in the lifecycle zone.

## Module-Level Changes

- `src/lifecycle/subagent-state.ts`: `CarrierClaim`, holder set, `claim(): CarrierClaim`, `release()` → `releaseClaims()`; `SettledOutcome`; run ordinal; retained superseded outcome captured in `resetForResume`; comments on `_claimed` and `resetForResume` reworded.
- `src/lifecycle/subagent.ts`: `claim()` returns the handle; `release()` → `releaseClaims()` (JSDoc rewritten: it now names only `startResume`); `WaitOutcome`; `waitUntilSettled` returns it.
- `src/lifecycle/subagent-manager.ts`: `startResume` calls `releaseClaims()`.
  `spawnAndWait` is predicted unchanged (a bare `record.claim()` statement still compiles).
- `src/tools/get-result-tool.ts`: `liveOutcome` seam; handle-based release; superseded branch; `resumedWhileWaiting`.
- `src/tools/get-result-report.ts`: `AgentReport.resumedWhileWaiting`; `formatAgentReport` renders the closing line.
- `test/lifecycle/subagent-state.test.ts`: carrier-claim block migrates `release()` → `releaseClaims()`, plus new holder-set, ordinal, and retention tests.
- `test/observation/notification.test.ts`: one `record.release()` (line ~676) → `releaseClaims()`.
- `test/lifecycle/subagent.test.ts`: `waitUntilSettled` tests change from `resolves.toBeUndefined()` to the `WaitOutcome` kinds, plus a superseded test.
- `test/lifecycle/subagent-manager.test.ts`: a manager-level test for the duplicate nudge.
- `test/tools/get-result-tool.test.ts`, `test/tools/get-result-report.test.ts`: new carrier-claim and superseded-report tests.
- `docs/architecture/architecture.md`: the module-tree lines for `subagent-state.ts` (per-holder claim, run ordinal, retained superseded outcome), `subagent.ts` (wait-until-settled reports settled/unsettled/superseded), and `get-result-tool.ts`.
- Predicted unchanged: `src/observation/notification.ts` (it reads only `claimed`, whose meaning holds), `src/service/*` (no claim or wait surface), `.pi/skills/package-pi-subagents/SKILL.md` (its domain table says "revocable carrier claim", which stays true; verified by grep for `claim` at planning time).

## Test Impact Analysis

1. Newly enabled tests: per-holder release (two holders, release one, still claimed); the run ordinal and the retained superseded outcome as pure `SubagentState` facts; `waitUntilSettled`'s three kinds without a tool in the way.
2. Redundant tests: none.
   The existing "release hands responsibility back" and "release without a prior claim" tests move to `releaseClaims` and keep pinning the clear-all path #987 depends on.
3. Tests that stay as-is: the `get-result-tool` "releases the claim when the parent turn is interrupted mid-wait" test (now pins the handle release) and the `subagent-manager` "announcement after an outcome a carrier already delivered" block (pins `startResume`'s clear-all).

## Invariants at risk

- #987: a resume nobody claims clears every stale claim, so it is announced.
  This is pinned by `subagent-manager.test.ts` "announces an unclaimed resume of an agent a foreground spawn delivered" / "… a claimed resume delivered" (real `NotificationManager`, real manager).
  It serves the parent, which must hear a background resume.
- #872/#903: a mid-run update is announced only while nothing claims the outcome.
  This is pinned by `notification.test.ts`'s claim tests, which read `record.claimed`; the boolean meaning is unchanged.
- A claim survives `resetForResume`: pinned by `subagent-state.test.ts` "survives resetForResume".
  The holder-set version must keep it.
- A completed wait marks consumed and keeps its claim: pinned by `get-result-tool.test.ts` "claims the outcome for the duration of a wait".

## TDD Order

1. `refactor(pi-subagents): rename the claim-clearing release to releaseClaims`
   - Tidy-First: makes the later holder-set step a pure semantic change.
   - `SubagentState.release`/`Subagent.release` → `releaseClaims`; callers `subagent-manager.ts` `startResume` and `get-result-tool.ts`; tests `subagent-state.test.ts` (3 sites) and `notification.test.ts` (1 site).
   - No new tests; the suite stays green.
2. `refactor(pi-subagents): read get_subagent_result's outcome fields from one source`
   - Tidy-First: gives the superseded branch one place to swap the source, instead of a `snapshot ?? record` ladder in each builder.
   - Adds `SettledOutcome` to `subagent-state.ts` and a module-level `liveOutcome(record)` in `get-result-tool.ts`; `buildReport` and `buildGetResultDetails` take the outcome.
   - No new tests; the existing `get-result-tool.test.ts` suite pins the report and the details.
3. `fix(pi-subagents): keep a resume's claim when a get_subagent_result wait wakes after it starts`
   - Red: `subagent-state.test.ts` "claim handles": two holders, releasing one leaves `claimed` true; releasing a handle twice is a no-op; `releaseClaims` clears every holder; a handle released after `releaseClaims` is a no-op.
   - Red: `get-result-tool.test.ts` "carrier claim": a waiter whose wait is interrupted while another carrier holds a claim leaves `claimed` true; a waiter woken after a claimed resume starts (the resume is started from `onRunFinished` on the record's execution observer) leaves `claimed` true.
   - Red: `subagent-manager.test.ts`: with a real `NotificationManager`, a claimed `manager.resume` started synchronously from `onSubagentCompleted` while a `GetResultTool` wait is pending sends no nudge once the resume settles (pre-fix: one).
   - Green: holder set and `CarrierClaim`; the waiter keeps its handle and releases it in place of `record.release()`.
   - Killing mutation: make the handle's `release` call `this._claims.clear()`; this kills both "another carrier holds a claim" tests and the manager nudge test.
     A second mutation: make `claimed` return `this._claims.has(<first holder>)`, which kills the two-holder state test.
4. `refactor(pi-subagents): tell a waiter what happened to the run it waited for`
   - Run ordinal, `resetForResume` captures the superseded outcome, `supersededOutcome(run)`, `WaitOutcome`, and `waitUntilSettled` returns it.
     The whole lifecycle of the retained slot is set in `resetForResume`, overwritten by the next `resetForResume`, and read only through `supersededOutcome(run)`; it is never cleared otherwise.
   - `GetResultTool.execute` switches to `wait.kind`, treating `superseded` like `unsettled` (release own claim, report live), so behavior is unchanged and the new exports have a consumer.
   - Tests: `subagent-state.test.ts` (ordinal starts at 1 and increments per `resetForResume`; the retained outcome equals the pre-reset fields, with owed updates only; `supersededOutcome` of another ordinal is undefined); `subagent.test.ts` `waitUntilSettled` (existing four migrate to `unsettled`/`settled`; new superseded test resumes from `onRunFinished` and asserts the run-1 result).
   - Killing mutation: drop the `this._run++` from `resetForResume`; this kills the ordinal test and the superseded `waitUntilSettled` test (which then reads `unsettled`).
     A second mutation: capture the outcome after the fields are cleared, which kills the retained-outcome test.
5. `fix(pi-subagents): report the run a get_subagent_result wait waited for when a resume starts first`
   - Red: `get-result-tool.test.ts` "superseded wait": the report carries run 1's status and result and the closing line; it omits run 1's question affordance; `consumed` stays false; the details' `status`/`preview` are run 1's.
   - Red: `get-result-report.test.ts`: `resumedWhileWaiting: true` appends the line after the addenda and before the transcript pointer; absent, the report is byte-identical to today's (`toBe` on the full text).
   - Green: the superseded branch feeds `wait.outcome` to both builders, drops `pendingQuestion`, and sets `resumedWhileWaiting`.
   - Docs: the architecture.md module-tree lines listed above, in this commit.
   - Killing mutation: feed `liveOutcome(record)` instead of `wait.outcome` in the superseded branch, which kills the run-1 status/result assertions.
     A second mutation: call `record.markConsumed()` for `superseded`, which kills the `consumed` assertion.
     A third: drop the `resumedWhileWaiting` render in `formatAgentReport`, which kills the line assertions.

No `Co-authored-by:` trailer: the mechanism comes from the operator's own issue.

## Risks and Mitigations

- Holder-set leaks: claims taken by `spawnAndWait` and a claimed resume are never released, so the set grows by one per claimed resume until an unclaimed resume clears it.
  This is bounded by resumes of one record and is harmless to `claimed`'s meaning; `releaseClaims` keeps the #987 behavior.
- The retained outcome pins the previous run's result string in memory until the next resume.
  That is one string per record, and the record already held it until the reset.
- The hop-count boundary in the repro is path-specific, and the fix does not depend on it: the ordinal check is exact, not timing-based.
- The trigger needs a cross-extension consumer; no in-repo consumer exercises it.
  The tests drive it through the same observer seam the events bus uses, so the fix is pinned without one.

## Open Questions

None.
