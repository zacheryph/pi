---
issue: 913
issue_title: "pi-subagents: abort(id) does not cancel an in-flight resume"
---

# Retro: #913 — pi-subagents: abort(id) does not cancel an in-flight resume

## Stage: Planning (2026-09-18T22:07:53Z)

### Session summary

Planned Phase 22's Step 22: give a resumed run an abort lever the record can pull.
The plan is `packages/pi-subagents/docs/plans/0913-resume-abort-lever.md` — three steps (a preparatory getter conversion, the behavioral `fix:`, and a docs step), shipping independently.
A disposable Vitest spike against the real `Subagent` measured all three of the issue's claims before the design was settled, and one follow-up ([#949]) was filed and given a Phase 22 disposition.

### Observations

- The gate settled two things: the record mints a **fresh `AbortController` per run** (`run()` and `runResume()`), and a caller-supplied `signal` routes **through** `abort()` rather than composing with it.
  The `AbortSignal.any` alternative — two independent levers, preserving today's `completed` reading after a caller-signal cancel — was offered and declined: it keeps the same class of untruthful outcome Steps 17, 19, and 21 removed.
- The measured repro is worth carrying forward: with no caller signal, `abort()` returns `true`, the record reads `stopped` immediately, `resumeTurnLoop` receives `undefined`, and the late answer still lands in `result` — `markCompleted`'s status guard blocks the status write but always sets `result`.
  So the record reads `stopped` while carrying the text of a run that ran to completion.
- The Tidy-First assessor corrected the file list: a **third** test asserts the removed forwarding — `test/lifecycle/subagent-manager.test.ts` `"forwards the caller's signal to the resumed turn loop"` — which neither the issue nor my design summary named.
  It must be rewritten in the same commit as the two in `subagent.test.ts`.
- It also corrected the framing: the constructor's `new AbortController()` must **stay** (three existing tests read `abortController` or call `abort()` on a record that never ran), so "fresh per run" is a supplement, not a replacement.
- The roadmap's `Target:` line for Step 22 names `src/lifecycle/subagent-session.ts`; the settled design leaves it unchanged — only the argument handed to `resumeTurnLoop` moves.
  Recorded in the plan's Non-Goals and predicted-unchanged list.
- Filed [#949]: `RunListeners.wireSignal` and `forwardAbortSignal` both register with `addEventListener`, which never fires for an already-aborted signal (measured with a one-line `node -e`).
  Scoped out of this plan because the fix also changes `run()`'s spawn-path behavior.
  Operator disposition: deferred to a later phase, recorded in the roadmap's `#### Open-issue sweep dispositions`.

#### Deferred tidyings

- `packages/pi-subagents/src/lifecycle/subagent.ts` — a shared `beginRun(signal)` helper for the "mint controller + wire signal" sequence was considered and **rejected** by the assessor as procedure-splitting: `resetForResume()` sits between the mint and the wire in `runResume()`, so the sequence does not line up with `run()`'s and a helper would fit only one of the two call sites.

## Stage: Implementation — TDD (2026-09-18T22:25:19Z)

### Session summary

Executed all three plan steps as three commits: the preparatory getter conversion (`16f067fd`), the behavioral fix (`acd83b00`), and the README/roadmap docs (`5b942e94`).
The `pi-subagents` suite went 1792 → 1796 tests (four added: three `Subagent.resume()` cancellation classes plus one manager-door abort-by-id test; three existing assertions of the removed forwarding were rewritten rather than added).
Pre-completion reviewer: PASS.

### Observations

- No deviations from the plan.
  Every file it listed was touched, and every file in its predicted-unchanged list stayed unchanged — including `subagent-session.ts`, which the roadmap's `Target:` line named but the design did not need.
- All three killing mutations behaved as predicted, with one bonus: mutation 1 (forward the caller's `signal` to `resumeTurnLoop` instead of the record's) killed class (c) as well as class (a), because (c) asserts the loop's signal was not already spent on arrival and a `undefined` signal fails that too.
  Mutations 2 and 3 each killed exactly their own class.
- The Red step's evidence was strong on its own: two of the parked-loop tests failed by 5 s timeout (the loop is never signalled pre-fix) while the caller-signal test failed in 1 ms on the status assertion — two different failure shapes for two different claims.
- Worth remembering for a future reader: `markCompleted` blocks the status write against `stopped` but always sets `result`, so an aborted resume's record carries the text of the run it stopped.
  That is pre-existing and unchanged here.
- The reviewer independently confirmed the prose sweep (`SKILL.md`, `docs/`, `README.md`) carries no surviving claim that a resume bypasses the record's controller, and that `mmdc` parses all six Mermaid charts after the `S22` ✅ mark.

## Stage: Final Retrospective (2026-09-18T22:36:03Z)

### Session summary

Planned, implemented, and shipped Phase 22's Step 22 in one trunk-lane session: `abort(id)` now cancels an in-flight resume, released as `pi-subagents-v21.7.3`.
Three TDD commits (preparatory getter conversion, the behavioral fix, docs), suite 1792 → 1796, CI and release both green, issue closed on `acd83b00`.
This ship completed the **last** open step of Phase 22 — all 22 step headings now carry ✅.

### Observations

#### What went well

- The disposable spike before the design gate did three jobs at once: it confirmed the issue's report, produced the plan's Reproduction table, and surfaced a fact the issue never mentioned — `markCompleted` blocks the status write against `stopped` but always sets `result`, so an aborted resume's record carries the text of the run it stopped.
  Its third reading (a record aborted on its original run holds a *spent* controller) is what made the chosen option defensible rather than speculative.
- Both fresh-context reviews corrected the design by reading real files rather than endorsing the summary they were handed.
  The `tidy-first-assessor` found a third stale forwarding assertion (`test/lifecycle/subagent-manager.test.ts`) that neither the issue nor the design summary named, and corrected "fresh controller per run" to *supplement*, not replace, the constructor's.
  The `pre-completion-reviewer` independently re-ran the prose sweep and parsed all six Mermaid charts.
- Specifying one killing mutation per equivalence class at plan time made the verify step mechanical: three mutations, three distinct outcomes, all matching predictions (mutation 1 over-killed into class (c), which is extra discrimination, not a shortfall).

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — wrote `[#948]` into the plan as the follow-up issue's number **before** filing it; `gh issue create` returned `#949`.
  The same draft cited `2eea3c6f` as "relevant code as of", copied from [#913]'s body rather than resolved from HEAD (`ea71b778`).
  Both are covered by the `git-workflow` skill, which `/plan-issue`'s Load skills list does not name even though the prompt files issues and ends in a commit.
  Impact: one five-occurrence `perl` fixup across the plan file and one `gh issue edit`; no rework beyond that, and nothing wrong was published.
- `instruction-violation` (self-identified, in hindsight) — cherry-picked the ten-item Load skills list, skipping `reproduction` (explicitly named for a spike whose result becomes design input) and `delegation` (before dispatching the assessor).
  Impact: none measurable — the spike's provenance was labelled in Design Overview and the assessor's third-test claim was verified with `sed` before being trusted, so both skills' rules were followed incidentally.
  "Followed incidentally" is luck rather than process, which is why it is recorded despite costing nothing.
- `other` — one `Edit` on the plan file failed because `pi-autoformat` had reflowed the bullet just written, so the `oldText` no longer matched the emitted layout.
  `AGENTS.md` documents exactly this.
  Impact: one failed tool call, recovered with `grep` plus a scripted substitution.

#### What caused friction (user side)

- Nothing to surface.
  Both gates (lever mechanism plus signal composition; the [#949] roadmap disposition) were answered as strategic calls on measured before/after evidence, not as mechanical oversight.

### Diagnostic details

- **Model-performance correlation** — two subagents dispatched, both judgment-heavy and both on `anthropic/claude-sonnet-5` per their agent definitions: `tidy-first-assessor` (design correction against real files) and `pre-completion-reviewer` (quality gate).
  Appropriate matches; no reasoning-weak model on judgment work, and no high-cost model on mechanical work.
- **Escalation-delay tracking** — no `rabbit-hole` friction points; no sequence exceeded five consecutive tool calls on the same error.
  The longest repeated sequence was the three deliberate mutation cycles.
- **Unused-tool detection** — `colgrep` went unused, correctly: every search this session was symbol-exact (`abortController`, `resumeTurnLoop`, `wireSignal`), which is the `grep` column of the decision table.
- **Feedback-loop gap analysis** — verification ran incrementally throughout: `vitest run <file>` after each Red and Green, `pnpm run check` after the step touching public doc comments, `verify:public-types` immediately after the `service.ts` change, and the full root-level suite plus `lint` and `fallow dead-code` at the end.
  One self-caught slip: the first full-suite run was piped through `grep`, masking its exit status, and was re-run unpiped with an explicit `echo exit=$?`.

### Changes made

1. `.pi/prompts/plan-issue.md` — added a point-of-use clause to the `## File follow-up issues` step: take the issue number from `gh issue create`'s output and resolve any cited SHA with `git rev-parse`.
   Chosen over adding `git-workflow` to the Load skills list because this session demonstrated that list gets cherry-picked, and the clause sits at the exact step where both defects occurred.
2. `packages/pi-subagents/docs/retro/0913-resume-abort-lever.md` — this Final Retrospective stage entry.

[#913]: https://github.com/gotgenes/pi-packages/issues/913
[#949]: https://github.com/gotgenes/pi-packages/issues/949
