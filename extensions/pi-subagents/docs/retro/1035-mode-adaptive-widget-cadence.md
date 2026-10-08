---
issue: 1035
issue_title: "pi-subagents: measure the agents widget's render cost to settle its spinner cadence"
---

# Retro: #1035 — pi-subagents: measure the agents widget's render cost to settle its spinner cadence

## Stage: Planning (2026-10-06T05:11:02Z)

### Session summary

Ran the measurement the issue asks for at planning time, with a throwaway Vitest probe (deleted, not committed) that drove Pi's real `TuiAltScreen` and `TuiMainScreen` with the real `AgentWidget` over real session JSONLs mapped onto Pi's per-entry components.
Fullscreen frames cost 0.06–0.80 ms across transcripts up to 17,998 lines; regular-mode frames cost up to ~8.7 ms and scale with document length.
The operator chose a mode-adaptive cadence (80 ms fullscreen, 250 ms regular/unknown) and to implement it here crediting ReStranger, closing PR #1024 at ship.

### Observations

- The issue's synthetic probe was right that the whole-tree walk persists in fullscreen, but its cost is negligible: Pi's components cache their own lines and the alt-screen diff touches only visible rows.
  The decisive fact is the ~10× fullscreen/regular ratio, which is structural (visible-row diff versus whole-document diff), not machine-dependent.
- `tui.mode` is readable at tick time and follows `/fullscreen` switches because Pi hands widget factories `this.ui`, a renderer-following proxy (`createInteractiveTuiReference`); `session-navigator.ts` already reads `tui.mode`, so the precedent exists.
- Mechanism: `setInterval` fixes its period at arm time, so the plan switches to a self-rescheduling `setTimeout` chain that re-reads the mode on each arm, and moves widget registration ahead of `setTimerRunning` so the first arm sees the captured `tui`.
- Rejected options: flat 80 ms (PR #1024 as-is; ~11% of a core in regular mode on a long transcript, measured), flat 125 ms, keep 250 ms, and a user-facing setting.
- Probe limits recorded in the plan: no custom messages, extension-tool renderers, or images; editor/footer stubbed.
- Tidy-first assessor recommended the timer-chain refactor (already step 1) and a `stubTui` mode tweak (step 2); it verified that every `vi.getTimerCount()` assertion survives the `setInterval` → `setTimeout` switch, and that exactly two tui literals need `mode`.
  Counts re-verified by grep.

#### Deferred tidyings

- `packages/pi-subagents/test/ui/widget-viewport.test.ts`: extracting `fakeTerminal` to `test/helpers` was declined; the real-renderer cadence test lives in the same file, so there is no second consumer.

## Stage: Implementation — TDD (2026-10-06T05:22:37Z)

### Session summary

Executed all four planned steps as four commits: the one-shot timer-chain refactor, the `stubTui` mode tweak, the `perf:` mode-adaptive cadence (with the `Co-authored-by: ReStranger` trailer), and the architecture-doc update. pi-subagents tests went from 2044 to 2050 (+6); `check`, root `lint`, the full suite, and `fallow dead-code` are all green.

### Observations

- Every planned killing mutation went red as predicted.
  The first-arm-ordering mutation (arming before registration) also killed the real `TuiAltScreen` test, one more than the plan named and consistent with it.
  A mutation deleting the relocated `setTimerRunning(...)` at its new site killed 8 timer-lifetime tests, so the move is pinned.
- Self-inflicted slip: in step 1 the `cp` to `/tmp/green.ts` ran in the same tool batch as the mutating `Edit` and captured the mutation, which is exactly the hazard `/tdd-plan` warns about.
  It was caught because the post-restore run stayed red, and fixed by restoring the line by hand; later mutations used a separate `cp` call.
- Small deviations: step 1's continued-ticking test added a third inline tui literal, which step 2 routed through `stubTui` along with the two the plan counted.
  The upstream-assumption row in `.pi/skills/package-pi-subagents/SKILL.md` landed in the `perf:` commit, as Module-Level Changes placed it.
- The "follows a switch to fullscreen" test pins the per-arm semantics: the tick already armed at 250 ms fires first, and the arm after it uses 80 ms.
- Pre-completion reviewer: WARN, no blockers.
  - Evidence provenance: the probe is not in the tree and the plan's table shows one representative run of five.
  - Robustness: `setTimerRunning` now runs last in `update()`, so a throw from `setWidget`/`requestRender`/`setStatus` during a tick ends the chain until the next lifecycle event (`setInterval` kept firing through a throw); judged theoretical.
  The reviewer re-derived the #864 timer-iff-running and #849 dispose-is-final invariants over every `update()` entry path and found them held.

## Stage: Sync (worktree) (2026-10-06T05:27:46Z)

### Session summary

Pre-push checks (`pnpm run lint`, `pnpm fallow dead-code`) both passed clean.
The plan's `**Release:** ship independently` marker applies; at ship time close PR #1024 with a pointer to the measurement rather than merging it.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-1035--/2026-10-06T04-59-13-628Z_01a10f94-835b-73fe-82ed-b02ef3c8ff72.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

The operator accepted both pre-completion reviewer WARN notes as non-blocking (the tick's throw-robustness and the deleted probe's single-run table); no code or doc change followed.

## Stage: Final Retrospective (2026-10-06T05:36:04Z)

### Session summary

The issue ran across four stages: PR Review of #1024 at the root, then planning, TDD, and sync in a worktree peer, then ship and retro at the root.
The planning-time measurement replaced a flat-cadence argument with a mode-adaptive cadence (80 ms fullscreen, 250 ms regular), shipped in `cda4a5ce` and released as `pi-subagents` 23.1.1.
PR #1024 was closed with credit to @ReStranger, who is co-author on the `perf:` commit.

### Observations

#### What went well

- Running the measurement during planning, not handing it off as a TDD step, settled the design before the operator gate.
  The probe drove Pi's real `TuiAltScreen`/`TuiMainScreen` over real session JSONLs, and the operator picked an option backed by a measured table, not an estimate.
- The killing-mutation discipline caught its own tooling slip: a `cp` backup taken in the same batch as the mutating `Edit` captured the mutation, and the restore that stayed red exposed it.
- The `markdown-conventions` em-dash rule worked as written: the peer suspected a lost dash in the TDD stage heading, confirmed it with `od -c`, and fixed it before committing.

#### What caused friction (agent side)

- `missing-context` — The PR Review stage was committed on root `main` (`64ace937`, 04:56Z) but not pushed, and `scripts/worktree-new.sh` bases the peer on `origin/main`.
  The peer started at 04:59Z without the PR Review note, so it re-derived the attribution from `gh pr view 1024 --json commits` and created a second retro file, `1035-mode-adaptive-widget-cadence.md`, beside the PR Review stage's `1035-measure-widget-render-cost-spinner-cadence.md`.
  Impact: no rework, because the peer re-derived the same attribution and direction independently; but the issue's stage notes are split across two files, and the ship's push carried two root commits it did not author (`64ace937` and the PR #917 triage `c8f0b001`).
  The `pr-review` template says to commit the triage note and stop; it does not say to push.
- `instruction-violation` (self-identified) — The `/ship` final report said it had not checked whether this was the last step of a roadmap phase, when the check was one grep.
  Impact: none; `pi-subagents` has no open phase, which this retro confirmed.

#### What caused friction (user side)

- Nothing material.
  Running `/pr-review` and then `/worktree` back to back, with no push in between, was the trigger for the split retro, and nothing in either command warned about it.

### Diagnostic details

- **Model-performance correlation** — Planning and TDD ran on `claude-opus-5-5`, which suited the probe design and the mutation work; the sync stage and both subagents (`tidy-first-assessor`, `pre-completion-reviewer`) ran on `claude-sonnet-5-5`, attributed from their own transcripts.
  No mismatch.
- **Feedback-loop gap analysis** — TDD ran `vitest` and `check` after every step and full gates at baseline and at the end; no gap.

### Changes made

1. `.pi/prompts/pr-review.md`: the triage note is committed **and pushed** before stopping (direction 1 and the closing commit step), so a `/worktree` peer branched from `origin/main` sees it.
