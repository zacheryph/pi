---
issue: 1006
issue_title: "pi-subagents: children never load Pi's built-in codemode, MCP, and tool_search extensions"
---

# Retro: #1006 — pi-subagents: children never load Pi's built-in codemode, MCP, and tool_search extensions

## Stage: Planning (2026-10-02T23:10:38Z)

### Session summary

Planned demand-driven loading of Pi's codemode, tool-search, and MCP built-ins in children, plus `mcp__<server>__*` patterns expanded at spawn against the parent's `pi.getAllTools()`.
The plan raises the Pi peer floor to `>=1.0.0` as a breaking change and folds in the #1004 fixture fix.
Filed #1017 for the pre-0.86 prompt-renderer arms the new floor makes dead.

### Observations

- The issue's premise that "`builtInExtensions` is not exported" was true but incomplete: `createCodemodeExtension`, `createToolSearchExtension`, and `createMcpExtension` have been root exports since 0.99.0 (checked in the published tarballs), so no upstream change is needed.
  The contributor's comment (rharish101) pointed at that SDK route; the plan credits him with a `Co-authored-by:` trailer on the pattern step.
- Spikes against real SDK 1.0.0 established:
  - `builtin: true` factories honor the user's `-builtin:mcp` setting.
  - A named `codemode`/`tool_search` activates in a child.
  - Loading MCP in a `tools: [read]` child still starts the configured server process.
  - That last fact decided demand-driven loading over follow-the-parent.
- The first gate offered a whole-server allow only as "needs upstream", which was wrong.
  The operator answered with a question, and the corrected answer found the parent's `pi.getAllTools()` as an in-package source for expansion.
  The operator then chose patterns in-plan, scoped to `mcp__` entries only.
- The tidy-first assessor recommended the `SubagentSessionDeps` resolver (`listParentToolNames`) over threading the parent's tools through `AssemblerContext`, plus two prep steps: the #1004 type fix and a deps-helper default.
  Both prep steps are in the TDD Order.
- No open improvement phase, so `roadmap-fit` exited at step 1 for #1017.

## Stage: Implementation — TDD (2026-10-02T23:37:37Z)

### Session summary

Implemented all eight plan steps in seven commits:

- the Pi 1.0.0 floor (breaking)
- the name-to-built-in table, then children loading the built-ins their `tools:` names
- `mcp__` pattern expansion, then its wiring through `listParentToolNames`
- the docs

The pi-subagents suite went from 1937 to 1962 tests (+25).

### Observations

- **Deviation:** plan step 1 (the #1004 `ExecuteCtx` cast) could not land ahead of the bump, because at 0.84.4 the cast is redundant and `no-unnecessary-type-assertion` rejects it.
  It was folded into the `feat(pi-subagents)!: require Pi 1.0.0 or later` commit, along with one more cast in `subagent-session.ts` that lint flagged as unnecessary under 1.0.0 types.
  A planning-time check of "type-checks on both SDKs" should also run lint on both.
- Every planned killing mutation went red as predicted.
  The first attempt at step 3's mutations was confounded: the `cp` green-copy ran in the same tool batch as the mutating `Edit`, captured the mutation, and "restored" a mutated file.
  It was caught because a restored file still failed; the rule in `/tdd-plan` (run the `cp` in its own call) is the right one.
- The `debugNote` for an unmatched pattern has no test; `unmatchedPatterns` itself is covered in `mcp-tool-patterns.test.ts`.
- Pre-completion reviewer: WARN, then PASS on the delta.
  The WARN raised three doc nits, all fixed in `docs(pi-subagents): correct the peer scope and MCP details the review flagged`:
  - `comparison-with-upstream.md` still listed the old peer scope
  - MCP starts only *enabled* servers
  - the MCP hash suffix also applies on name collisions

## Stage: Sync (worktree) (2026-10-03T00:51:10Z)

### Session summary

Pre-push checks passed (`pnpm run lint`, `pnpm fallow dead-code`).
The plan's marker is `**Release:** ship independently`; the release is a major because the `feat(pi-subagents)!: require Pi 1.0.0 or later` commit carries a `BREAKING CHANGE:` footer.
Shipping should also close #1004, whose fixture fix landed in that commit; #1017 stays open as the follow-up.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-1006--/2026-10-02T22-42-38-913Z_01a0fec8-aac0-774c-a4e0-0891f23a63f5.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

The worktree-lane rebase onto local `main` follows this note.

## Stage: Final Retrospective (2026-10-03T01:10:16Z)

### Session summary

The root fast-forward-merged the rebased branch, pushed 9a08d878, closed #1006, and released `pi-subagents-v22.0.0` (a major, for the Pi 1.0.0 floor).
The first `/ship` ran before the peer had finished `/sync-worktree` and stopped cleanly at the step 4 ancestry check; the second ran end to end.
Across stages the design held: demand-driven built-in loading plus `mcp__<server>__*` expansion against the parent's `pi.getAllTools()`.

### Observations

#### What went well

- The planning spikes against real SDK 1.0.0 (factories load as `builtin:*`, `-builtin:mcp` honored, MCP starts a server even for a `tools: [read]` child) turned a judgment call into a measured one and decided demand-driven loading.
- The `/ship` step 4 `git merge-base --is-ancestor` prediction caught the premature ship at zero cost: no merge, no push, a precise list of the 11 divergent #1010 commits.

#### What caused friction (agent side)

- `instruction-violation` (missed by everyone) — the `feat(pi-subagents)!: require Pi 1.0.0 or later` commit body said "This folds in the fix #1004 proposed".
  GitHub reads `fix #1004` as a closing keyword, so the push auto-closed #1004 via e93ec7ce with no curated comment.
  At ship time I saw #1004 already `CLOSED` and reported "nothing to do" without checking who closed it.
  Impact: #1004 has no summary comment; no rework.
- `missing-context` — the planning probe bumped the SDK and ran `check` and `test`, but not `lint`; `no-unnecessary-type-assertion` then rejected plan step 1 at 0.84.4, forcing it into the bump commit.
  Impact: one plan deviation, no rework.
- `other` — the planning gate offered whole-server MCP allow as "needs upstream"; the operator's question exposed that `pi.getAllTools()` makes it possible in-package.
  Impact: one extra gate round; the scope grew in the right direction.
- `other` — TDD step 3's first mutation round copied the green file in the same tool batch as the mutating `Edit`, so the "restore" restored a mutant.
  Self-identified; the existing `/tdd-plan` rule covers it.
- `other` — my first ship's final report hedged on the roadmap-phase check, though planning had already established no phase is open.
  Impact: none.

#### What caused friction (user side)

- `/ship 1006` was invoked before the peer's `/sync-worktree 1006` had committed its sync note; the step 2 retro read showed no `Sync (worktree)` entry, which already signalled it.
  Impact: one aborted ship, about six tool calls.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `claude-opus-5-5` (design-heavy, appropriate); sync ran on `claude-sonnet-5-5` (mechanical, appropriate).
  All three subagents (one `tidy-first-assessor`, two `pre-completion-reviewer` passes) ran on `claude-sonnet-5-5` per their transcripts.
- **Feedback-loop gap analysis** — TDD ran targeted `vitest` and `check` after every step and killing mutations per step; only the planning-time SDK probe skipped `lint`.

### Changes made

1. `.pi/skills/git-workflow/SKILL.md`: a closing keyword matches anywhere in the message, not only as a footer ("the fix #1004 proposed" closes #1004).
2. `.pi/prompts/ship.md` step 9: a co-shipped issue already `CLOSED` gets its closer checked via the events API, and a summary comment when a commit keyword closed it.
3. Posted the missing summary comment on #1004.
4. Not landed: the `code-design` rule to run `lint` in a dependency-bump probe (one occurrence, no rework).
