---
issue: 1021
issue_title: 'pi-subagents: Paseo integration is confused when there is no "finished" status'
---

# Retro: #1021 — pi-subagents: Paseo integration is confused when there is no "finished" status

## Stage: Planning (2026-10-03T19:42:46Z)

### Session summary

Third-party report (@maxim): Paseo's subagent track spins forever on a finished run whose status is `steered`.
The operator opened the whole turn-limit design for reconsideration; the session split it into a two-member release batch "turn-budget" (this issue, then [#1022]) plus an independent spike ([#1023]), and planned this issue: remove `steered` from `SubagentStatus` and carry the turn-limit fact as a `turnBudget: { maxTurns, used, phase }` outcome field.
The plan is 7 steps (fixture prep, budget lift, state fact, additive exposure with a legacy predicate arm, the breaking status removal, the breaking `subagents:child:completed` payload change, docs).

### Observations

- `steered` is inherited from upstream (`tintinweb/pi-subagents` 0.1.0, still in 0.19.0); it names the mechanism (`session.steer()` delivers the wrap-up) rather than the outcome, and collides with the redirect sense of `steer_subagent`/`subagents:steered`.
  The architecture doc's lifecycle diagram misreads it as a live redirect state.
- Paseo's mapper was read from source (`getpaseo/paseo` at `0d05584d`): it maps only `completed`/`error`/`aborted`/`stopped` to finished states and has three terminal display states (completed, failed, canceled).
  The operator ruled out filing against Paseo, which became a design constraint: every terminal status must be one Paseo already maps.
- I first proposed removing the turn-limit meaning of `aborted` too; the operator corrected it — `aborted` (harness stop) versus `stopped` (external stop) is exactly the distinction worth keeping.
- Operator decisions: `maxTurns` becomes the true ceiling with a warning threshold `0 ≤ warnAt < maxTurns` and a minimum of 2 (all [#1022]); frontmatter stays snake_case; terminal event channels stay `completed`/`failed`/`resumed` for now (unification deferred, no issue filed); `turnBudget` is the budget's only home, so [#1022] removes the top-level `turnCount`/`maxTurns`.
- Pi facts read from `../pi` (not run): a steer queued at `turn_end` of turn k is seen in turn k+1; an errored response still emits `turn_end` and auto-retry starts another turn, so today a provider error spends budget; a pending steering message on a turn with no tool calls forces another turn.
  All three are recorded in [#1022].
- The plan preserves a behavior the vocabulary change could silently flip: a wrapped-up run with a pending question tears its workspace down (commit `88572eff` held only `completed`).
- Tidy-First assessor: accepted the fixture-builder prep (step 1); folded the predicate extraction into step 4 instead of a separate commit.
  Its fixture count (~35) was re-derived: 25 lines match `steered: (false|true)`; the 6 `aborted:` lines in `record-observer.test.ts` are Pi `compaction_end` events and are excluded.
- No open improvement phase, so `roadmap-fit` exited for [#1022] and [#1023]; the batch is recorded only in the plans, so `/ship` must confirm it.

## Stage: Implementation — TDD (2026-10-03T20:37:50Z)

### Session summary

All 7 plan steps landed as separate commits, plus one follow-up test pin from the pre-completion review: fixtures, the budget lift in `runTurnLoop`, the state outcome fact, additive exposure with the `wrappedUpAtTurnLimit` predicate, the breaking `steered` removal, the breaking `subagents:child:completed` payload change, and docs.
The pi-subagents suite went from 1962 to 2003 tests; `check`, root `lint`, `fallow dead-code`, and `verify:public-types` are green.

### Observations

- Deviation: in step 2, `@typescript-eslint/no-unnecessary-condition` narrowed `aborted`/`softLimitReached` to `false` (they are set inside the turn listener), so the phase is built by a private `buildTurnBudget` helper that takes the flags as parameters.
- Deviation: the notification box label for a wrapped-up run changed from "completed (steered)" to "completed (wrapped up)" in step 4 (the plan's Presentation section named it; the step text implied no visible change).
- Deviation: the presentation sites use a new `renderOutcomeIcon` in `result-renderer.ts` (and a private `renderWrappedUpIcon`), because `AgentDetails.status` includes `background` and does not fit `renderStatusIcon`'s `SubagentStatus` parameter.
- Deviation: no separate widget linger test for a wrapped-up run.
  Its status is `completed` by construction (pinned by the `completeRun` test), so the existing completed-linger test covers it; the plan's linger mutation needed the budget at a status-only site and was not expressible.
- The `steered` presentation tests were deleted rather than migrated in step 5, since step 4 had added a `completed` + `warned` sibling for each.
- Every planned killing mutation went red as predicted; step 4's predicate mutation killed exactly the 10 `completed` + `warned` tests while the legacy `steered` tests stayed green.
- Pre-completion reviewer: WARN (no test pinned `stopped` with `phase: "exhausted"`, a stop during the grace turns); fixed in `test(pi-subagents): pin that a stop during the grace turns keeps its turn budget`; the delta review returned PASS.
- Release: mid-batch for "turn-budget" — `/ship` should land without dispatching a release until [#1022] ships.

## Stage: Final Retrospective (2026-10-03T21:23:39Z)

### Session summary

One trunk session took a third-party bug report (Paseo spins forever on `steered`) through planning, TDD, ship, and retro.
Planning became an operator-driven redesign of the turn-limit vocabulary, split into a release batch (#1021 then [#1022]) plus a spike ([#1023]); #1021 landed as 8 commits, CI passed, the issue closed, and the major release is deferred to the batch tail.

### Observations

#### What went well

- Cloning `getpaseo/paseo` and reading its mapper turned the reporter's claim into a hard constraint ("every terminal status must be one Paseo maps"), which settled the ceiling question once the operator ruled out filing against Paseo.
- The step-4 lift (the `wrappedUpAtTurnLimit` predicate kept a legacy `steered` arm) produced a clean mutation split: removing the budget check killed exactly the 10 `completed` + `warned` tests while the `steered` tests stayed green, so step 5 could delete the legacy arm with the replacement already pinned.
- The Tidy-First fixture step (`test/helpers/turn-loop-result.ts`) absorbed step 6's `TurnLoopResult`/`ChildCompletedEvent` reshape in one file.

#### What caused friction (agent side)

- `premature-convergence` — I listed "the turn-limit meaning of `aborted` leaves the status" as settled and offered `completed` versus `error` for the ceiling, missing that `aborted` (harness stop) versus `stopped` (external stop) already encoded the distinction the operator wanted.
  User-caught ("Isn't it aborted?").
  Impact: one gate bounced and a settled item withdrawn; no rework.
- `missing-context` — the gate that offered `turnBudget: { maxTurns, used, phase }` did not check that `SubagentRecord`, `AgentDetails`, and `NotificationDetails` already carry `turnCount`/`maxTurns`; I found the overlap only while mapping touch points.
  Self-identified.
  Impact: one extra `ask_user` round.
- `instruction-violation` — gate options used undefined terms: `phase` (the operator asked "What is `phase`?") and a proposed `subagents:finished` channel the operator read as an existing one.
  `clarification-gates` already requires defining terms of art before the substance.
  User-caught.
  Impact: two extra explanatory turns.
- `missing-context` — the plan's Edge cases section stated the stop-during-grace behavior (`stopped` with the loop's budget) but no TDD step pinned it, and the Invariants table omitted it.
  Caught by the pre-completion reviewer (WARN).
  Impact: one follow-up `test:` commit and a delta review.
- `other` — `@typescript-eslint/no-unnecessary-condition` narrowed `aborted`/`softLimitReached` to `false` because a `session.subscribe` listener mutates them; the step ran `check` and `vitest` but not ESLint, so the pre-commit hook rejected the commit.
  `code-design`'s "Closure narrowing loop" covers only `.forEach()`, whose fix (`for...of`) does not apply to an event listener.
  Impact: one rejected commit; fixed with a parameter-taking `buildTurnBudget` helper.
- `instruction-violation` — two `Edit` calls spelled an em-dash as the escape `\u2014` in `oldText` and failed to match; one doc comment received a garbled em-dash (`\ndash;`).
  Self-identified each time.
  Impact: three extra edits.
- `other` — the plan named a step-5 widget-linger mutation at `shouldShowFinished`, a status-only site that cannot see `turnBudget`, so the mutation was not expressible.
  Impact: a recorded deviation, no rework.

#### What caused friction (user side)

- The "no issue against Paseo" constraint arrived after three design turns; stated with the first gate it would have removed the Paseo-side option immediately.
  The redirecting questions ("What is `phase`?", "Isn't it aborted?") were the efficient intervention style and caught both gate defects cheaply.

### Diagnostic details

- **Model-performance correlation** — planning, TDD, and retro ran on `anthropic/claude-opus-5-5`; `/ship` ran on `anthropic/claude-sonnet-5-5`, appropriate for its mechanical steps.
  The `tidy-first-assessor` and both `pre-completion-reviewer` dispatches ran on `anthropic/claude-sonnet-5-5` (from their transcripts); the reviewer's WARN was a real coverage gap.
- **Feedback-loop gap analysis** — every step ran its test file, the package suite, and `pnpm run check` before committing, but ESLint ran only through the pre-commit hook, which is how step 2's commit was rejected.

### Changes made

1. `.pi/skills/code-design/SKILL.md` — "Closure narrowing loop" now covers event-listener callbacks, with the fix of passing the flags as parameters to a helper.
2. `.pi/prompts/plan-issue.md` — the Design Overview bullet requires a TDD step that pins each edge case stated as behavior.

[#1022]: https://github.com/gotgenes/pi-packages/issues/1022
[#1023]: https://github.com/gotgenes/pi-packages/issues/1023
