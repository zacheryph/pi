---
issue: 918
issue_title: "pi-subagents-worktrees: `<project_context>`'s inherited `path=\"...\"` attribute defeats worktree isolation, the same way #640's footer did"
---

# Retro: #918 — `<project_context>`'s inherited `path="..."` attribute defeats worktree isolation

## Stage: Planning (2026-09-15T04:34:14Z)

### Session summary

Verified the third-party report's mechanism against Pi's source and the pinned SDK 0.84.4, measured the prefix cost of every byte-changing treatment, and ran a four-round clarification gate that settled the direction.
The plan at `packages/pi-subagents/docs/plans/0918-child-resolved-project-context.md` cuts the inherited `<project_context>` when a `WorkspaceProvider` relocated the child, renders the child's own block in its place inside the override, covers the [ADR 0009] `portable` strategy, and ships as `fix:` with the one lossy case recorded as an accepted residual.

### Observations

- **The cost question collapsed early and reshaped the gate.**
  Every treatment that edits bytes inside the block — stripping the `path=` attribute, remapping it, cutting the block — diverges the child at the same offset (2,151 of 58,529 in this repo, measured by running the pinned SDK's `buildSystemPrompt`).
  So the option set is not "which edit is cheapest" but "annotate the false claim or remove it", and the measurement is what made that visible.
  Estimating instead of measuring would have produced an option list comparing costs that are identical.
- **An elegant-looking generalization was strictly worse.**
  Making the relocation unconditional (every child re-renders its own block, so the rule has no `if`) buys a relocated child nothing — its block cannot match its parent's whatever we do — while making every *non*-relocated child's prefix depend on our byte-replica of Pi's renderer.
  `buildSystemPrompt` is not exported from `@earendil-works/pi-coding-agent`, so no test could pin that replica against the real thing.
  Conditioning on divergence removes the replica risk entirely.
- **Re-adding a cwd condition [ADR 0006] withdrew.**
  ADR 0006 dropped [#640]'s equal-cwd exception because the footer sits *after* the catalogue cut, so the exception preserved nothing.
  `<project_context>` sits *before* the cut, so the same reasoning does not reach it — checked before planning the re-introduction rather than relying on the remembered rule.
- **Both `ask_user` bounces were substantive, not formatting.**
  The first asked which package the fix belongs in (answer: core — the `Workspace` seam is `{ cwd, dispose() }` with no prompt-side field, which also produced a fifth option nobody had named).
  The second asked what `prompt_mode: replace` is, which surfaced that the cheap variant (`noContextFiles: false`, letting Pi rebuild) moves a relocated `Explore`/`Plan` child's body off the end — and that produced the adopted `cut-inline` variant.
- **The operator flagged the lossy case as a possible breaking change.**
  Classified explicitly rather than left implicit: the two direct precedents (`449078d0` for [#640], `610a4e9a` for [#801]) both removed an inherited layer from every child under plain `fix:`, and [ADR 0006] already records this exact trade as an accepted residual.
  Blast radius narrowed by reading `loadProjectContextFiles`: it also returns the global `~/.pi/agent/AGENTS.md` and walks every ancestor, and `git worktree add` checks out tracked files, so `pi-subagents-worktrees` itself is unaffected.
  A debug note and a `docs/configuration.md` contract for provider authors were added instead of a fallback; an opt-in escape hatch was offered and declined.
- **Tidy-First assessor returned three accepted preparatory commits** (extract `renderProjectContext` to `src/session/project-context.ts`, unit-test it directly, add a project-context layer to the `parentPrompt()` fixture) and one useful rejection: do **not** reshape `buildAgentPrompt`'s parameter list ahead of the change — an optional trailing parameter costs zero call-site edits across ~30 sites, and a parameter-object shape is the design decision itself, not separable prep.
  It also caught a real tension in my design summary: `renderProjectContext`'s "two callers" are both new, because `buildPortablePrompt` loses its `contextFiles` input entirely.
- **Sharpest test hazard identified:** the expensive failure is the cut firing on an *equal-cwd* child, which silently ends the shared prefix for every child on prefix-reusing hosts and is invisible to `tsc` and to a green suite.
  The existing `shared prefix with the parent` tests cannot see it, because their fixture has no `<project_context>` layer — hence preparatory step 3.

#### Deferred tidyings

None.
The assessor's only rejection was `buildAgentPrompt`'s parameter shape, which it declined as a design decision rather than deferring it as debt.

[#640]: https://github.com/gotgenes/pi-packages/issues/640
[#801]: https://github.com/gotgenes/pi-packages/issues/801
[ADR 0006]: ../decisions/0006-inherited-prompt-is-identity-only.md
[ADR 0009]: ../decisions/0009-portable-inheritance-is-provider-scoped.md

## Stage: Implementation — TDD (2026-09-15T16:41:29Z)

### Session summary

All seven planned steps executed in order, one commit each: three preparatory (`refactor:` renderer extraction, `test:` renderer unit tests, `test:` fixture layer), three behavioral (`fix:` cut, `fix:` own-block placement, `fix:` portable), and one `docs:` carrying ADR 0010 plus the amendments.
Tests went 1764 → 1791 (+27) in `pi-subagents`; `check`, root `lint`, full `test`, and `fallow dead-code` all green at the end, as at the baseline.
Pre-completion reviewer: PASS.

### Observations

- **Two planned mutations survived, and both were real findings.**
  Step 6's mutation collapsing `strategy !== "portable" && cwd === inherited.cwd` to `cwd === inherited.cwd` left the whole suite green: every portable fixture in `prompts.test.ts` also had a diverged cwd, so the divergence arm covered for the portable arm and nothing pinned it.
  Added *resolves it even when the child shares the parent's directory*, which the mutation then killed in both prompt modes.
  The second survivor was the snapshot half — re-adding the parent's block to `buildPortablePrompt` reddened nothing, because once `contextFiles` left `ParentPromptOptions` neither the unit test nor the composition-root test supplied one any more.
  Pi passes its **whole** `systemPromptOptions` object at runtime, so the field is present whatever the declared type says; both pins now supply it (the unit test through a cast, the composition-root test through the real `before_agent_start` payload) and assert exact equality.
- **The plan's "fewer reds than predicted is a finding" rule did the work here.**
  Both survivors would have shipped as green, `tsc`-clean, lint-clean code with an unpinned arm.
- **A pre-existing test turned out to be the guard's best witness.**
  `leaves a quoted catalogue alone when the parent resolved no skills` builds an identity containing bare `<project_context>` / `</project_context>` lines for a relocated child — exactly the shape that defeats an unguarded `lastIndexOf` anchor.
  The mutation dropping the lead-in-sentence check killed it along with the new quoted-opening test, which is why `projectContextStart` requires `Project-specific instructions and guidelines:` two lines below the opening.
- **Lint constrains mutation style.**
  The first attempt at step 4's "ignore the anchor" mutation was `if (true || …)`, which `biome`'s `noConstantCondition` rejected through the autoformat hook before the suite ran.
  Passing `false`/`true` at the call site instead is lint-clean and produces the same signal — the skill's "change a compared literal, not control flow" rule, learned the hard way.
- **Deviations from the plan, all minor.**
  `src/runtime.ts` was listed as a touch point for its doc comment; it was read and left alone, because the comment describes the capture rather than its field set and stayed accurate.
  Step 1 added a small `ContextFile` interface alongside the pure move, so the new loader seam had a name to state its contract with.
  `test/composition-root.test.ts`'s existing portable-capture test was strengthened in place (exact equality, with `contextFiles` supplied) rather than replaced, which is what made it discriminating.
- **Measured claims held.**
  The plan's prediction that the equal-cwd child is untouched is structural, not statistical: `cutProjectContext` is false there, so `projectContextStart` is never called.
  The new `keeps the parent's project context inside the shared prefix` test is what makes that visible to the suite — before it, the shared-prefix pins used a fixture with no project-context layer at all.

## Stage: Sync (worktree) (2026-09-15T16:46:56Z)

### Session summary

Pre-push checks (`pnpm run lint`, `pnpm fallow dead-code`) both passed with no fixes needed.
Nothing deferred; the plan's Release Recommendation is `ship independently`, and no follow-up issues were named or filed during planning or implementation.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-918--/2026-09-15T03-40-31-258Z_01a0a326-e899-731f-8ed0-528addb4e2f8.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

Clean run — no lint or dead-code findings to fix, so no additional commits beyond the TDD stage notes already on the branch.

## Stage: Final Retrospective (2026-09-16T03:07:24Z)

### Session summary

Four stages across two sessions: planning, TDD, and sync ran in the `issue-918` peer worktree (opus-5 for planning and TDD, sonnet-5 for sync); ship and this retrospective ran at the root on `main`.
The work landed as 11 commits fast-forwarded into `main` at `362d8f81`, CI green first try, and released as `pi-subagents-v21.7.1`.
The dominant theme is that this issue's two hardest findings — an unpinned `portable` arm and a test that could not fail — were produced by the plan's killing-mutation protocol, not by any gate.

### Observations

#### What went well

- **The mutation protocol found two tests that could not fail, and one of them was a pre-existing pin.**
  Step 6's mutation collapsing `strategy !== "portable" && cwd === inherited.cwd` to `cwd === inherited.cwd` left the whole suite green, because every `portable` fixture in `prompts.test.ts` also had a diverged cwd — the divergence arm was silently covering for the portable arm.
  The second survivor was sharper still: re-adding the parent's block to `buildPortablePrompt` reddened nothing, because once `contextFiles` left `ParentPromptOptions` neither the unit test nor the composition-root test supplied one any more.
  Fixing that one required *adding* `contextFiles` back to two pins before the mutation could be detected at all.
  Both would have shipped as green, `tsc`-clean, lint-clean code with an unpinned arm — this is the strongest evidence so far for the plan-level rule that fewer reds than predicted is a finding rather than a pass.
- **Measuring instead of estimating collapsed the option space before the gate was written.**
  Planning imported the pinned SDK 0.84.4's `buildSystemPrompt` and rendered this repo's own `AGENTS.md` through it, which showed that stripping the `path=` attribute, remapping it, and cutting the block all diverge the child at the same 2,151-char offset.
  That turned "which edit is cheapest" into "annotate the false claim or remove it".
  An estimate would have produced an option list comparing costs that are identical.
- **An elegant generalization was rejected on a test-pinnability argument, not an aesthetic one.**
  Making the relocation unconditional reads better (no `if`), but `buildSystemPrompt` is not exported, so no test can pin our byte-replica against the real renderer — and conditioning on divergence removes that risk entirely while costing a relocated child nothing.
- **The ship ran clean end to end.**
  Lane detection, ff-merge prediction, pre-push gates, CI, release dispatch, release verification, and worktree teardown all succeeded first try with no recovery step.

#### What caused friction (agent side)

- `instruction-violation` (user-caught) — the planning gate took four `ask_user` rounds for one decision boundary, against the `ask-user` skill's budget of one to two.
  Round 2 was the operator asking which package owns the fix; round 3 was the operator asking what `prompt_mode: replace` even is; round 4 followed the agent's own correction that it had mis-priced the `cut-inline` option (it had claimed a "second renderer" that already existed).
  `AGENTS.md` already carries both governing rules — define a gate's terms of art before its substance, and price a candidate's cheapest viable form before rejecting it on cost (both Refs #786).
  Impact: three extra gate rounds; no rework, and each round did improve the design — round 2 produced a fifth option nobody had named, round 3 produced the adopted `cut-inline` variant.
- `instruction-violation` (user-caught) — the breaking-change classification was made only after the operator raised it.
  The operator wrote "that last choice, no project context at all, may be a breaking change", and the agent then produced a well-grounded classification (two `fix:` precedents, an existing ADR 0006 consequence, a blast radius narrowed by reading `loadProjectContextFiles`).
  `/plan-issue` already instructs classifying breaking-vs-non-breaking independently of whether the change is ambiguous.
  Impact: one extra gate round; the outcome was correct and better documented for having been asked.
- `instruction-violation` (self-identified) — two `bash` calls used a bare `echo ===` separator, which zsh's `equals` expansion aborts with `zsh:1: == not found`, discarding the rest of the `A; B; C` chain.
  `AGENTS.md` names this exact failure and prescribes `echo ---`.
  Impact: two wasted tool calls; the agent switched to `read` rather than retrying.
- `other` (user-caught) — a commit message was passed as `git commit -F - <<'EOF'`, which trips an approval prompt the operator had to clear by hand.
  The operator asked for a temp file instead, and every subsequent commit body used `Write` to `/tmp/msgN.txt` followed by `git commit -F`.
  `AGENTS.md` says a commit body with quotes or backticks belongs in a file passed with `-F`, but says nothing about how to create that file, so `-F -` with a heredoc reads as compliant.
  Impact: one interruption; no rework.
- `other` (self-identified) — an `Edit` on the retro file failed to match after `pi-autoformat` reflowed the region, costing a `cat -A` probe and a re-read before the retry succeeded.
  `AGENTS.md` documents this (re-read a region you just edited before matching against it again); the recovery followed the documented path.
  Impact: three extra tool calls.

#### What caused friction (user side)

- The breaking-change concern arrived as a statement after the gate had already closed on that option ("I think it's the right choice, but it clearly changes behavior").
  Raising it as a question one round earlier — while the option set was still open — would have folded the classification into the gate rather than appending a round to it.
  This is a small timing point, not a substantive one: the intervention was correct and the outcome improved because of it.
- Three of the four planning gate rounds were spent supplying context the agent should have led with (package ownership, `prompt_mode` semantics).
  That is the agent's failure to ground its gate, not the operator's to answer — but it did turn strategic judgment into mechanical clarification for two of those rounds.

#### Open item carried forward

The plan's `## Open Questions` records one unresolved decision: whether #918 is adopted as a Phase 22 step, with #903 → Step 21 as the precedent for a third-party bug becoming a roadmap step.
It was never answered, so #918 shipped with no entry in the roadmap's `#### Open-issue sweep dispositions` list.
The issue was filed by a third party rather than spun off by one of our sessions, so no `roadmap-fit` dispatch point covered it.
`/finish-phase` reconciles the phase window's issues against that list, so the miss will surface at phase close rather than vanishing — but the decision is still outstanding.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `anthropic/claude-opus-5`, appropriate for a change whose core difficulty was a prompt-assembly trade-off with an unpinnable replica risk.
  Sync ran on `anthropic/claude-sonnet-5`, appropriate for its mechanical checklist.
  Two subagents were dispatched, both during planning: `tidy-first-assessor` (three accepted preparatory commits, one useful rejection) and `pre-completion-reviewer` (PASS).
  No mismatch found.
- **Escalation-delay tracking** — no `rabbit-hole` friction points; no sequence exceeded five consecutive tool calls on the same error.
  The longest repeated sequence was the step-4 mutation loop (four mutations, each a save/mutate/run/restore cycle), which is the protocol working as designed rather than a stall.
- **Unused-tool detection** — nothing missed.
  Planning read Pi's source at the tracking checkout for mechanism and confirmed the pinned 0.84.4 surface separately, which is the documented split.
- **Feedback-loop gap analysis** — verification ran incrementally throughout: a green baseline before step 1 (`check`, root `lint`, `test`, `fallow dead-code`), then per-step file-scoped `vitest` runs plus `pnpm run check` at every step that touched a shared type, and the full four-gate sweep at the end.
  No gap.

### Changes made

1. `AGENTS.md` — added one sentence under the commit-message rules: create the `-F` message file with `Write`, never a shell heredoc, because a heredoc trips an approval prompt the operator must clear by hand.
   The existing rule required `-F` but said nothing about how to produce the file, so `git commit -F - <<'EOF'` read as compliant.
2. `packages/pi-subagents/docs/retro/0918-child-resolved-project-context.md` — this Final Retrospective stage entry.

#### Proposed and declined

- A `.pi/prompts/ship.md` clarification that the `PRE_MERGE` range anchor needs a **strict** ancestor test, since `git merge-base --is-ancestor` is reflexive and the condition as written fires for every cleanly rebased branch.
  Declined as a clarity-only fix; the two anchors coincide whenever the condition is vacuously true, so the range is correct either way.
- Adopting #918 as a Phase 22 roadmap step, or recording a sweep disposition for it now.
  Declined in favour of letting `/finish-phase` reconcile the phase window's issues at phase close.
