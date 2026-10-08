---
issue: 1032
issue_title: "pi-subagents: PgUp/PgDn scroll the parent instead of the session viewer in fullscreen mode"
---

# Retro: #1032 — pi-subagents: PgUp/PgDn scroll the parent instead of the session viewer in fullscreen mode

## Stage: Planning (2026-10-06T03:48:31Z)

### Session summary

Verified the issue's root cause against the compiled `pi-tui@1.0.0` and `pi-coding-agent@1.0.0`, and planned the operator's chosen direction.
In fullscreen the viewer mounts as a bottom-anchored overlay, so Pi's focused-overlay deferral delivers PgUp/PgDn/Home/End to it; regular mode stays docked per ADR 0007.
The plan has 8 steps: three Tidy-First preparations, keybinding-driven keys and footer hint, wheel scrolling, the probe-and-mount fix, and ADR 0012.

### Observations

- The issue said Home/End reach the pane in fullscreen; they do not, because `tui.altScreen.top`/`bottom` default to `home`/`end` and are consumed by the same listener.
- Upstream posture: [earendil-works/pi#7574] made bare PgUp/Home/End belong to the fullscreen transcript (Ctrl+ variants to the editor), and [earendil-works/pi#7894] added the focused-overlay deferral.
  This retired the issue's "ask upstream" option.
- `TUI.mode` is public, but `showExtensionCustom` reads `options.overlay` before calling the factory.
  Mode detection is therefore a probe `ui.custom` whose factory calls `done(tui.mode)` synchronously.
  Reading the `tuiMode` setting was rejected because it misses `--tui-mode`.
- The operator ran a live subagent to experiment.
  They observed that the footer hint is wrong in fullscreen, and that today's docked pane covers the editor but leaves Pi's footer visible.
  The second point led to the fixed 3-row bottom margin (Pi's footer is 2 rows, plus 1 when an extension status is set).
- Rejected: temporarily rebinding `tui.altScreen.*` on the global `KeybindingsManager`, and the docked Ctrl+PgUp convention (no native bare keys).
- Chose `tui.altScreen.*` over the issue's `tui.select.pageUp` as the pane's binding ids, because they are the viewport-scroll concept and include top/bottom.
- The tidy-first assessor recommended three preparations, all folded in as Steps 2–4: one scroll clamp, one mounted-pane test helper, and a named `footerHint()`.
  It confirmed `src/index.ts` is unchanged.
- The overlay placement and wheel routing come from reading code, not live observation; Step 8 carries a manual check.

## Stage: Implementation — TDD (2026-10-06T04:06:05Z)

### Session summary

All 8 TDD Order steps landed as separate commits: three Tidy-First preparations, characterization pins, keybinding-driven keys and footer hint, wheel scrolling, the fullscreen overlay mount with the mode probe, and ADR 0012.
The `pi-subagents` suite went from 2030 to 2044 tests (+14, all in `test/ui/session-navigator.test.ts`, which went from 32 to 46).

### Observations

- Step 1 found that a pane receiving a key before its first render scrolls from offset 0, not from the bottom: `scrollOffset` is only snapped to `maxScroll` inside `render`.
  The host always paints first, so the pins render once before sending keys; this is not a defect a user can reach.
- Step 1's plan wording ("PgUp moves the last visible row up a viewport") was off by one because the transcript ends in a padding line; the pin asserts the first visible row shifts by exactly one viewport instead.
- Step 2's `scrollTo` takes an explicit `follow: false` for PgUp and Home, preserving the old behavior on a transcript that fits (where the at-bottom rule would otherwise keep following).
- Step 3: `ui.custom.mock.calls[0]` is typed non-optional, so the guard tripped `no-unnecessary-condition`; `.at(0)` (later `.at(-1)`) fixed it.
- Step 6: the return-to-bottom wheel test survived the plan's `Math.abs` mutation, as it should, since it pins a different class; its own mutation (wheel never follows) killed it.
- Step 7: the "docks when the UI reports no mode" test was green at Red (current behavior), and the `mode === "regular" ? "regular" : "fullscreen"` mutation confirmed it discriminates.
  The plan's separate "probe calls `done` before returning" test was not written as its own case: the fake UI resolves with `done`'s value only when it is called synchronously, so the fullscreen-options test already dies under a `queueMicrotask(() => done(...))` mutation (verified).
  A "mounts once, after a probe that mounts nothing" test pins that the probe passes no mount options instead.
- Three edits failed because `\u` escapes were emitted in `oldText`, and one literal `\u2014` landed in a doc comment and was fixed before commit; anchor non-ASCII edits on ASCII lines.
- Pre-completion reviewer: WARN.
  The finding is that the Step 8 manual check (fullscreen and regular mode against a long transcript) was not run or recorded.
  It needs a fresh Pi session (this session runs the pre-change extension), so it is pending operator verification before `/ship`.
  Check that PgUp/PgDn/Home/End and the wheel move the pane in fullscreen, Pi's footer stays visible, and regular mode is unchanged with no chrome in scrollback.

[earendil-works/pi#7574]: https://github.com/earendil-works/pi/issues/7574
[earendil-works/pi#7894]: https://github.com/earendil-works/pi/issues/7894

## Stage: Sync (worktree) (2026-10-06T04:15:52Z)

### Session summary

`pnpm run lint` and `pnpm fallow dead-code` pass.
The plan's marker is `**Release:** ship independently`, and no follow-up issues were filed.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-1032--/2026-10-06T03-15-36-708Z_01a10f35-a683-72e3-9ad4-9992944ade80.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

- The TDD stage's open reviewer WARN (no live fullscreen check) was acted on: the operator ran the viewer in a fresh Pi session and re-ran this sync.
  The operator did not report per-key results to the session, so the retro does not claim them.
- The live run changed one value: the fullscreen overlay's bottom margin went from 3 rows to 2, because the editor stays mounted under the overlay and a third row showed its bottom border.
  The change was folded into the fix and ADR commits before landing, so the branch carries one changelog entry for the fullscreen change.
- Known cost, recorded in ADR 0012: the pane covers an extension status row (Pi's optional third footer row) and any custom footer taller than two rows while open.
- `/subagents:sessions` lists nothing after `/reload`, because the reloaded extension builds a new manager with no earlier subagents.
  This predates the change and no issue is filed for it.

## Stage: Final Retrospective (2026-10-06T04:26:48Z)

### Session summary

The issue ran in one peer session (planning, TDD, sync) and one root session (ship, retro).
The root fast-forward-merged the branch, CI passed on the first try, #1032 closed with a curated comment, and `pi-subagents-v23.1.0` released.
The fix mounts the viewer as a bottom-anchored overlay in fullscreen and keeps it docked in regular mode.

### Observations

#### What went well

- Live checks during planning shaped the design.
  The agent dispatched a background Explore subagent (Haiku) to produce a long transcript, and the operator used it to test the viewer.
  That run gave two inputs that reading the compiled code had not: the footer hint is wrong in fullscreen, and Pi's footer rows stay visible below the docked pane.
  The same method was used twice more at sync, and it caught the bottom-margin error before the change landed.
- The planning stage checked upstream before committing to a direction.
  [earendil-works/pi#7574] and [earendil-works/pi#7894] removed "ask upstream" as an option, and the plan used the focused-overlay deferral those issues settled.
- Mutation testing was applied to every behavior step and included two mutations the plan did not list.
  A synchronous-`done` mutation showed that a planned test was redundant, and an options-on-probe mutation pinned the probe's no-mount contract.
- The margin fix at sync was folded into the `fix:` and `docs:` commits with an autosquash.
  A tag recorded the state before the squash, and a `git diff` against it confirmed the tree was unchanged.
  The branch kept a single changelog entry for the fullscreen change.
- The ship ran cleanly: fast-forward predicted and merged, both gates passed on the merged tree, CI passed first time, and the release succeeded first time.

#### What caused friction (agent side)

- `missing-context` — In planning, the agent said "the editor is hidden while the viewer is open either way" and sized the overlay's bottom margin from `footer.js` alone (2 rows + 1 status row = 3).
  The editor actually stays mounted under the overlay, so the third row showed the editor's bottom border.
  Impact: one fixup to the `fix:` and `docs:` commits plus an autosquash at sync, about 6 tool calls.
  The plan's Step 8 manual check was what caught it.
- `instruction-violation` (self-identified) — In TDD Step 1, `cp` backed up `session-navigator.ts` in the same batch as the mutation edit, so the backup may have captured the mutated file.
  The agent noticed this and restored from `git checkout`, which was safe because `src/` matched HEAD in that step; later steps took the backup first, in a separate call.
  Impact: one extra tool call, no rework.
- `instruction-violation` (not caught by the agent) — The pre-completion dispatch passed `Base ref: 7e5a9c4c`, a SHA that resolves to nothing.
  The `pre-completion` skill says to resolve the base ref with `git rev-parse`, and the agent knew enough to hedge ("resolve with `git rev-parse 5d22f266^` if this differs").
  The reviewer followed the hedge and used `185cb233`.
  Impact: none, because the reviewer recovered; without the hedge, the decision-surface check (2k) would have run against a bad ref.
  This is the first occurrence across retros, and the rule already exists in the skill and in `AGENTS.md` Principle 4.
- `other` — Three `Edit` calls failed because `\u` escapes were emitted in `oldText`, and one literal `\u2014` landed in a doc comment and was fixed before commit.
  Impact: about 4 retried calls.
  The `markdown-conventions` skill already covers this class.
- `other` (ship) — The close comment thanked `@gotgenes` "for the report" even though the reporter is the operator, whose voice the comment is written in.
  Impact: cosmetic.

#### What caused friction (user side)

- The operator's first answer at the direction gate was a question ("are you saying … Ctrl+PgUp is supposed to scroll up?").
  The gate assumed familiarity with Pi's editor-vs-transcript key convention, which the operator did not have.
  The clarification and the live experiment that followed were worth it, because they produced the footer and margin inputs.
- The live check at sync was run, but the operator did not report per-key results, so neither the sync note nor the close comment could claim them.
  A one-line "PgUp/PgDn/Home/End/wheel all OK" would have turned the reviewer's WARN into a recorded PASS.

### Diagnostic details

- **Model-performance correlation** — The main peer session ran on `claude-opus-5-5` for planning and TDD and on `claude-sonnet-5-5` for both sync passes, which were mechanical, so the switch fit.
  The three transcript-fodder Explore subagents ran on `claude-haiku-4-5`, which suits purely mechanical work.
  The `tidy-first-assessor` and `pre-completion-reviewer` ran on `claude-sonnet-5-5`, which suits judgment work.
  No mismatches.
- **Feedback-loop gap analysis** — Every TDD step ran the focused test file after each edit and `pnpm --filter @gotgenes/pi-subagents run check` before committing.
  The full suite ran at Steps 5 and 7 and at the end.
  No end-only verification.

### Changes made

1. `.pi/prompts/ship.md` step 9: the credit line now skips the operator's own login (`gh api user --jq .login`), because #1032's and #1008's close comments thanked `@gotgenes` in his own voice.
2. Filed [#1034] (`/subagents:sessions` is empty after `/reload`).
   `pi-subagents` has no open improvement phase, so no roadmap disposition was recorded.

[#1034]: https://github.com/gotgenes/pi-packages/issues/1034
