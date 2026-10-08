---
issue: 755
issue_title: "pi-subagents: always display model name in subagent stats bar and get_subagent_result report"
---

# Retro: #755 — pi-subagents: always display model name in subagent stats bar and get_subagent_result report

## Stage: Planning (2026-09-30T19:08:54Z)

### Session summary

Planned #755 (third-party, beilo) with #998 (operator's own) folded in at the operator's request, since both rewrite the same `modelName` expression in `resolveSpawnConfig`.
The plan is four steps: a `refactor:` removing dead `modelName` copies, then three `feat:` steps (spawn-time `provider/id` label always shown, live `record.model` stamped in `buildDetails`/`streamUpdate`, and a `Model:` line plus collapsed-row model in `get_subagent_result`).

### Observations

- Operator decisions at the gate: build both issues; source the label from the live `record.model` (matches the #954 widget, reflects failover) with the spawn-resolved model as fallback; put `Model: <provider/id>` on its own line after the `Type: … | Status: …` line.
- Classified non-breaking (display-only `feat:`); no config, default, or `SubagentRecord` change.
- The tidy-first assessor found `presentation.modelName` is also unread (the design summary had named only `AgentInvocation.modelName`), and that `get-result-renderer.ts` has its own private `renderStats`, distinct from `result-renderer.ts`'s.
  Both corrections are in the plan.
- `Co-authored-by: beilo <19225489+beilo@users.noreply.github.com>` is recorded for the `feat:` steps; ship should close both #755 and #998.
- `modelLabel` lands in step 2 with its first caller rather than as a caller-less refactor.

#### Deferred tidyings

- `src/tools/get-result-tool.ts`: `buildReport` and `buildGetResultDetails` duplicate about 8 record-to-stats field mappings; the change widens it by one line each; the shapes diverge deliberately, so it was left alone.

## Stage: Implementation — TDD (2026-09-30T22:12:10Z)

### Session summary

All four plan steps landed as separate commits: the `refactor:` dropping the unread `modelName` copies, then three `feat:` steps (spawn-time `provider/id` label, live `record.model` in `buildDetails`/`streamUpdate`, and the `get_subagent_result` `Model:` line plus collapsed-row model).
The pi-subagents suite went from 1876 to 1889 tests.

### Observations

- Every killing mutation the plan named turned its tests red, with the predicted counts.
- Two tests stayed green during Red, as pins of existing behavior: `buildDetails`' spawn-label fallback and `get_subagent_result`'s "names no model while unknown".
  Each was confirmed against its own class mutation: dropping the `?? base.modelName` fallback, and rendering the `Model:` line unconditionally.
- A minor deviation from the plan: `test/tools/result-renderer.test.ts`'s `"haiku"` fixtures were updated to `anthropic/claude-haiku-4-5`, which the plan listed as optional.
- The pre-commit Biome hook reformatted `test/tools/foreground-runner.test.ts` on the step 3 commit; re-staged and committed with the same message.
- The streaming test uses `objectContaining` on `onUpdate`'s details, with a comment explaining why: the details also carry a spinner frame and a wall-clock duration.
- Pre-completion reviewer: PASS.
  It noted that it did not load the `testing` skill, so the `test/` mock-convention spot-check was not done.

## Stage: Sync (worktree) (2026-10-01T04:05:44Z)

### Session summary

`pnpm run lint` and `pnpm fallow dead-code` both passed on the branch before the rebase.
The plan's marker is `**Release:** ship independently`; `/ship 755` should close both #755 and #998.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-755--/2026-09-30T19-04-04-691Z_01a0f3b3-d752-70b3-863e-d02012a364de.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

- No deferred work or follow-up issues; the `feat:` commits carry the `Co-authored-by: beilo` trailer.

## Stage: Final Retrospective (2026-10-01T04:24:46Z)

### Session summary

The root session began as a question about why the Agent tool showed `sonnet 5.5`.
It traced the label to an upstream expression in `resolveSpawnConfig` (tintinweb's `d0cb5119`, carried through the fork unchanged) and filed #998 to replace it with `formatModel`.
The operator folded #998 into third-party #755 at planning, the peer worktree implemented both in four commits, and `/ship 755` landed them, closed both issues, and released `pi-subagents` 21.9.0.

### Observations

#### What went well

- Tracing provenance with `git log -S'replace(/^Claude'` across the subtree import took one call to separate "we chose this" from "upstream did", which reframed the fix from a cosmetic tweak to removing inherited manipulation.
- The two-issue handoff held across three sessions with no restating: the planning note's "ship should close both #755 and #998" reached `/ship` through its step 2 retro read, and both closed with distinct comments.
- The TDD stage named a killing mutation for every new test, and confirmed the two Red-stage pins against their own class mutations rather than accepting them as green.

#### What caused friction (agent side)

- `instruction-violation` (unnoticed until this retro) — the sync stage appended its breadcrumb with `cat >> … <<'EOF'`, where `/sync-worktree` step 3 says to anchor an `Edit` on the last line and `markdown-conventions` says not to author markdown with heredocs.
  The same turn loaded only `worktrees`, skipping the `git-workflow` load the template's line 16 requires.
  Impact: none; `rumdl` passed and the content was correct.
- `other` — the TDD stage's final commit carried a fallback `|| { …; git commit -q -F- <<<"" ; }`, which would have attempted an empty-message commit had the first one failed.
  It never ran; the deny rule's pattern is `git commit -F`, and this command spelled it `git commit -q -F-`.
  Impact: none.
- `missing-context` — the pre-completion reviewer did not load the `testing` skill its definition requires for changed `test/` files, and said so in its report.
  Impact: the mock-convention spot-check on the new tests never ran; nothing has checked them since.
- `premature-convergence` — when filing #998, the root session found #755 rewriting the same line and filed separately with a cross-link instead of asking whether to fold the two.
  The operator made that call at planning instead ("I would like to also fold in issue #998").
  Impact: #998's body says to leave the only-when-different condition to #755, which the fold made moot; no rework.

#### What caused friction (user side)

- The opening question said "the widget" for what was the Agent tool's stats line, so the first answer had to cover both surfaces.
  Naming where the label appeared (or pasting the line) would have pointed straight at `renderStats`; it cost one hedged paragraph.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `claude-opus-5-5` and the sync stage on `claude-sonnet-5-5`; both `tidy-first-assessor` and `pre-completion-reviewer` ran on `claude-sonnet-5-5` (from their own transcripts).
  The sync stage's two skipped instructions and the reviewer's skipped skill load are both Sonnet turns, but each is one occurrence with no impact, so no reassignment is warranted.
- **Feedback-loop gap analysis** — the TDD stage ran the targeted Vitest files and `run check` after every Red, Green, and mutation, and the full suite plus lint and `fallow` before the reviewer; no gap.

### Changes made

None; every candidate change failed the admission test or rested on a single no-impact occurrence.
