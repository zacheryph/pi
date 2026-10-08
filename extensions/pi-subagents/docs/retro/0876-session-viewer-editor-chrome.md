---
issue: 876
issue_title: "Apply editor-style chrome to the pi-subagents session viewer"
---

# Retro: #876 — Apply editor-style chrome to the pi-subagents session viewer

## Stage: Planning (2026-09-28T03:28:49Z)

### Session summary

Planned the session viewer's labeled header and footer rules (Pi editor style, coloured by the child's thinking level via `theme.getThinkingBorderColor`) and, at the operator's direction, folded in #954 (model tag in the agents widget).
The plan surfaces the child's model and thinking level through `AgentSession` → `SubagentSession` → `Subagent` delegating getters, a `TranscriptSource.sessionModel()` accessor, and a static `EntryHeading` on each `NavigationEntry`, all in 8 steps.

### Observations

- The operator first chose "#876 alone", then asked for a rich header (name, model, thinking) and thinking-level colour; that pulled in #954's data plumbing, so the scope widened to both issues. #954 is third-party (`the-matt-moo`); its `Subagent.model` getter is credited with `Co-authored-by` on steps 3 and 7.
- #954's proposed `this.subagentSession?.session?.model` is a Law of Demeter reach-through; the plan adds `SubagentSession.model`/`thinkingLevel` getters instead, per the operator's explicit "no LoD violations" constraint.
- The issue says Pi centres the working status; Pi's `custom-editor.ts` left-anchors it (only the overflow label is centred).
  Left anchoring chosen.
- Colour gate: operator rejected `dim` after a true-colour preview script (`/tmp/pane-colors.mjs`, `/tmp/pane-thinking.mjs`), then chose thinking-level colouring like the editor.
  I first read a stale catppuccin install under `~/.pi/agent/git/`; the live theme is `~/development/pi/pi-coding-agent-catppuccin` (settings `packages` entry).
  Values were identical, but read the `settings.json` `packages` path first next time.
- The comment in `TranscriptPane.render` (from `243bdb21`) claims a full-width row wraps; contradicted by pi-tui (throws only on `> width`), Pi's editor/`DynamicBorder`, and the pane's own current footer.
  The plan corrects it and asks `/tdd-plan` to eyeball a real session after step 6.
- Measured `buildSessionContext` on a real child JSONL: returns `model: { provider, modelId }` and `thinkingLevel`, so released snapshots get the header facts for free.
- Tidy-First assessor: accepted the shared-session-mock fixture step (step 1) and the local `TranscriptTheme` narrowing (folded into step 6 rather than a standalone commit, since it has no consumer before then).
  The `WidgetAgent` `makeAgent` fixture change was not needed as its own step because `model` is optional.
  It also caught that `renderRunningLines`/`renderFinishedLine` are tested in `test/widget-renderer.test.ts`, not `test/ui/agent-widget.test.ts`.

#### Deferred tidyings

- `src/lifecycle/subagent.ts`: the long one-line getter block (lines ~150–208) could be grouped; two more getters fit the existing pattern.
- `src/ui/display.ts`: the shared `Theme` name understates that it is the narrow rendering theme.
- `test/ui/agent-widget.test.ts`: eight sibling `describe("AgentWidget — …")` blocks could nest under one `describe("AgentWidget")`.

## Stage: Implementation — TDD (2026-09-28T04:51:13Z)

### Session summary

All 8 plan steps landed as 8 commits (1 `test:`, 4 `refactor:`, 2 `feat:`, 1 `docs:`): the session viewer's labeled rules coloured by thinking level (#876), and the widget's `[provider/model]` tag (#954). pi-subagents tests went from 1831 to 1876 (+45); every planned killing mutation turned its predicted tests red.

### Observations

- Deviations: `ModelIdentity` landed in step 5 (`NavigableSubagent` needed it), not step 6.
  `fileSnapshotSource` treats a model with no `provider`/`modelId` as unknown, because Pi's `getSessionContextSettings` also reads the model off each assistant message, and a file whose messages lack those fields yields `{ provider: undefined, modelId: undefined }`.
  A test pins the realistic assistant-message path.
  The #954 commit uses `Refs #954` rather than the plan's `Closes #954` (the `git-workflow` skill forbids closing keywords; `/ship` closes both).
  The skill's UI row names "labeled rules" in prose, so the plan's step-8 grep for `labeled-rule` hits only `architecture.md`.
- Step 4's planned mutation (a), swapping the loop nesting, did not discriminate at the planned width 40, because the `"142"` + hints fallback does not fit there either.
  The test moved to width 50, where only the mutated order picks it.
- pi-tui's `truncateToWidth` brackets its ellipsis in SGR resets, so the truncation test compares ANSI-stripped text.
- The plan's real-session check ran as a disposable spike instead: `TranscriptPane` with Pi's real `dark` theme object and the Tidy-First assessor's real child JSONL, through `TuiMainScreen.renderNow()` at 80/50/30 columns.
  The renderer accepted every frame, and the rules were painted `#81a2be` (`thinkingMedium`, matching the recorded `medium`).
- Em-dash emission failed three times in edit bodies (a tab plus `er`, a literal `\u2014`, garbage replacement text).
  Glyph-heavy test and source edits went through node scripts using JS escapes.
- The full `pnpm run test` failed twice on different pi-permission-system tests (5000 ms timeouts, "Failed to start forks worker") at load average 17 with `corespotlightd` at 120% CPU.
  This branch touches no pi-permission-system file; the package passed 4832/4832 with `--maxWorkers=4`, and the reviewer's own full run passed.
- Pre-completion reviewer: PASS.
  Its decision-surface section noted 4 additive `public-api-contract` signals (`Subagent`, `display.ts`, `SubagentSession`, `mock-session.ts`); no consumer reads the new members.

## Stage: Sync (worktree) (2026-09-28T15:45:38Z)

### Session summary

`pnpm run lint` and `pnpm fallow dead-code` both pass from the worktree root with no changes needed.
The plan's `**Release:**` marker is `ship independently`, so `/ship 876` releases `pi-subagents` on its own; #954 closes alongside #876 at land time (its `Subagent.model` mechanism and widget tag both shipped on this branch, credited with `Co-authored-by` trailers).

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-876--/2026-09-28T02-49-43-262Z_01a0e5eb-125e-75a6-a3e0-bca8155a2ffb.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

No deferred work beyond the plan's own Open Question (widget tree-connector colouring, left for a future operator request).
The planning-stage retro already flagged the host-load test flakiness in `pi-permission-system`; unrelated to this branch.

## Stage: Final Retrospective (2026-09-28T16:01:22Z)

### Session summary

The root `/ship` fast-forward-merged the worktree branch (pre-merge tip `c090d185`, equal to the plan's parent), passed lint and dead-code, landed CI green, closed #876 and the folded-in #954 (crediting `@the-matt-moo`), released `pi-subagents-v21.8.0`, and tore down the worktree.
Across all four stages the work went through without rework: 8 planned steps as 8 commits, a PASS review, and no sync rebase needed because `main` had not moved.

### Observations

#### What went well

- The Tidy-First assessor (on `claude-sonnet-5`) caught three things that would have cost rework: widening the shared `Theme` would ripple into six unrelated test stubs (answered by the local `TranscriptTheme`), `renderRunningLines`/`renderFinishedLine` are tested in `test/widget-renderer.test.ts` rather than the planned file, and the SDK's `SessionContext` uses `modelId` and `| null`, not the design's `id` and optional.
- The TDD session verified the TUI change without an interactive terminal: a throwaway Vitest spike rendered `TranscriptPane` with Pi's real `dark` theme and a real child JSONL through pi-tui's `TuiMainScreen.renderNow()` at 80/50/30 columns, then was deleted.
  This is a reusable pattern for any pi-subagents UI change whose risk is the renderer rejecting a row.
- Folding #954 into #876 at planning time, with `Co-authored-by` trailers on its commits, made the ship's two close comments mechanical: the credit and the design deviation (no `subagentSession?.session?.model` reach-through) were already recorded.

#### What caused friction (agent side)

- `instruction-violation` (self-identified, in this retro) — `/ship` step 9 says to re-resolve every hex token in the **finished** draft before `issue_close`.
  I resolved three SHAs before drafting, then the #876 comment added three more (`1a0af78f`, `4db6400e`, `74c74f32`) that no check covered.
  Impact: none; each was pasted from `git log` output and resolves.
  The same gap has recurred on #704, #777, #788, #814, #861, #890, and #928; #948 already proposes making `issue_close` refuse an unresolvable SHA.
- `other` (em-dash emission) — the TDD session lost three edits to U+2014 corruption and moved glyph-heavy edits to node scripts; the Sync session spent 8 tool calls (inspect bytes, a failed tab-pattern replace, a Python byte dump, then a Python replace) on one corrupted em-dash in its own stage note.
  Impact: added friction, no rework.
  The `markdown-conventions` skill already prescribes the placeholder-and-substitute route; no new rule.
- `rabbit-hole` (host load, not the change) — the TDD session's full `pnpm run test` failed twice on different `pi-permission-system` tests (worker-startup timeouts, load average 17, `corespotlightd` at 120% CPU).
  It took 9 tool calls (one full run of 776 s, a rerun, an isolated file run, `uptime`/`ps` probes, a `--maxWorkers=4` run) to rule out a regression.
  Impact: roughly 20+ minutes of wall time; the conclusion (unrelated, and green under capped workers and in the reviewer's run) was correct.

#### What caused friction (user side)

- Nothing new.
  The planning stage's scope widening (from #876 alone to #876 plus #954, and the colour choice after a true-colour preview) came from the operator seeing rendered options, which is the cheapest point to change scope.

### Diagnostic details

- **Model-performance correlation** — Planning and TDD ran on `anthropic/claude-opus-5-5`; Sync ran on `anthropic/claude-sonnet-5` (mechanical, appropriate).
  Both subagents ran on `anthropic/claude-sonnet-5` per their transcripts: the Tidy-First assessor (judgment-heavy, but output was high quality, so no mismatch) and the pre-completion reviewer (PASS, with a thorough decision-surface section).
- **Escalation-delay tracking** — the host-load test investigation ran 9 consecutive tool calls; each changed the probe (isolate, check load, cap workers), so it was diagnosis rather than repetition, and asking the operator would not have been faster.
  The Sync session's 8 calls on one em-dash exceeded the threshold for a single character; the skill's scripted-placeholder route applied from the first failed match.
- **Feedback-loop gap analysis** — no gap: the TDD session ran the targeted Vitest files after each step and each killing mutation, `pnpm run check` after the widget step, and the full gates once at the end.

### Changes made

1. Commented on #948 (`issue_close` SHA refusal) with this ship's finished-draft re-resolve miss as further evidence; no repository files changed beyond this retro entry.
