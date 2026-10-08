---
issue: 1015
issue_title: "pi-subagents: a get_subagent_result wait that wakes after a resume starts clears the resume's claim"
---

# Retro: #1015 — pi-subagents: a get_subagent_result wait that wakes after a resume starts clears the resume's claim

## Stage: Planning (2026-10-02T21:42:24Z)

### Session summary

Reproduced the race with a disposable Vitest spike against the real `SubagentManager`, `GetResultTool`, and `NotificationManager`, then planned a five-step fix.
The claim becomes a per-holder handle (`claim(): CarrierClaim`), and `waitUntilSettled` reports `settled`/`unsettled`/`superseded` from a run ordinal plus an outcome retained in `resetForResume`.
The waiter can then report the run it waited for.

### Observations

- The spike found a second symptom in the same window: the waiter reports the resumed run (`running`, no result), and run 1's outcome reaches the parent through no channel, because its nudge was suppressed by the waiter's claim at settle.
  The operator chose to fix both in this issue.
- The issue's stated trigger (two parallel parent tool calls) is unreachable.
  The window is pure microtasks: measured as sync through 6 hops on the background path, with 8+ hops safe.
  The reachable trigger is a cross-extension consumer resuming synchronously from a `subagents:completed` handler (Pi's `EventBus` calls handlers synchronously).
  No in-repo consumer does this.
- The operator chose a holder set over a run-generation check, because the holder set also covers an abandoned waiter clearing a concurrent foreground carrier's claim.
- The operator chose the superseded report shape: run 1's outcome, with the question affordance dropped and a closing "resumed … running again" line.
  The superseded waiter must not `markConsumed`, since consumption is record-wide and would suppress a background resume's nudge.
- The Tidy-First assessor recommended a standalone `release` → `releaseClaims` rename and a `liveOutcome(record)` seam in `get-result-tool.ts`; both are folded in as steps 1–2.

#### Deferred tidyings

- `test/lifecycle/subagent.test.ts`: the `waitUntilSettled` tests inline the "agent plus controllable run promise" setup; a fixture helper is optional if the grid grows.

## Stage: Implementation — TDD (2026-10-02T21:58:12Z)

### Session summary

All five planned TDD steps landed as five commits: two Tidy-First refactors (the `releaseClaims` rename and the `liveOutcome` seam), the per-holder claim fix, the run ordinal with the `WaitOutcome` refactor, and the superseded-wait report fix with its architecture-doc lines. pi-subagents went from 1915 to 1937 tests (+22).
Check, lint, the full test suite, and `fallow dead-code` are green.

### Observations

- No deviations from the plan's steps or file list.
  Each step's named killing mutations reddened exactly the tests the plan predicted.
  The superseded step's "drops the question" and "leaves uncollected" tests stayed green in Red (the live report already omitted both), and were confirmed as pins by their mutations.
- The test that reproduces the trigger resumes from the record's `onRunFinished` observer (tool level) or the manager's `onSubagentCompleted` (manager level), standing in for a `subagents:completed` consumer; no microtask counting is needed, because the resume is synchronous inside the terminal transition.
- `_workspaceNotice` is not cleared by `resetForResume` today, so the retained outcome copies it and the live record still carries it into the resumed run; left as is (out of scope).
- Twice an em-dash in a source comment came out as a literal `\u2014` escape; it was caught by grep and reworded before the commit.
- Pre-completion reviewer: WARN.
  Reviewer warnings: (1) the plan's repro evidence is a synthetic-trigger spike (disclosed in the plan); (2) the double-resume case (ordinal moved by two or more, record inactive) falls through to `settled`, would mark consumed, and would report a later run's outcome.
  The plan classifies it as unreachable, and no test pins it.
  The reviewer also noted, as cosmetic, that a resumed run settling before the waiter continues leaves the "running again" line stale.

## Stage: Sync (worktree) (2026-10-02T22:00:36Z)

### Session summary

Pre-push `pnpm run lint` and `pnpm fallow dead-code` passed.
The plan's marker is `**Release:** ship independently`; no follow-up issues were filed.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-1015--/2026-10-02T21-27-54-321Z_01a0fe84-3cd0-70ea-959d-641f2544117a.jsonl` — read with `read_session_file` for message-level verification at land/retro time.

### Observations

The pre-completion reviewer's WARN (the unpinned double-resume fall-through) stands as recorded in the TDD stage entry.

## Stage: Final Retrospective (2026-10-02T22:09:37Z)

### Session summary

The root `/ship` fast-forward-merged the worktree branch, passed lint, `fallow dead-code`, and CI, closed the issue, and released `pi-subagents-v21.9.4`.
The issue went from plan to release in about 40 minutes across the planning, TDD, and sync stages (peer, Opus then Sonnet) and the root ship.
No stage reported a deviation from the plan.

### Observations

#### What went well

- The planning spike against the real `SubagentManager` surfaced a second symptom: run 1's outcome reached the parent through no channel.
  It also showed the issue's stated trigger was unreachable, so the fix targeted the reachable `subagents:completed` trigger.
- Each TDD step named its killing mutations in the plan, and the peer ran every one with a `cp` backup and restore; each reddened exactly the predicted tests.
- The ship was friction-free: one ff-merge, one CI run, one release run, no retries.

#### What caused friction (agent side)

- `instruction-violation` — the peer prefixed most TDD bash calls with `cd packages/pi-subagents;` instead of `pnpm --filter`/`pnpm -C` from the root, as `AGENTS.md` directs.
  Self-identified: no. Impact: added friction but no rework.
- `other` — the em-dash-as-escape slip recurred three times (twice in TDD source comments, once in the sync retro note).
  The existing gates and `pi-autoformat` caught or decoded each one.
  Impact: in the sync stage, an `Edit` repairing it failed in the same tool batch as the dependent `git commit`, which still ran; the agent then spent two calls confirming the autoformat had already decoded it.
- `instruction-violation` — the ship's final report said it had not checked whether this was a roadmap phase's last step, rather than checking.
  Self-identified.
  Impact: none; `pi-subagents` has no open improvement phase (both phase docs under `docs/architecture/history/` are archived).

#### What caused friction (user side)

- None observed; operator involvement was the planning gates (two-symptom scope, holder set over run generation, superseded report shape), which were strategic.

### Diagnostic details

- Model-performance correlation: the TDD stage ran on `anthropic/claude-opus-5-5` and the mechanical sync stage on `anthropic/claude-sonnet-5-5` — a sensible fit.
- Feedback-loop gap analysis: the peer ran the targeted Vitest files after every Red, Green, and mutation, and the full gates only once at the end; no gap.

### Follow-ups

- The double-resume fall-through (ordinal advanced by two or more, record inactive, reports `settled`) is unpinned; it is classified unreachable, so no issue was filed.

### Changes made

1. No prompt, skill, or `AGENTS.md` changes; every friction point is already covered by an existing rule or gate.
