---
issue: 1008
issue_title: "pi-subagents: the mid-run update renderer calls `theme.fg(\"info\")`, which throws, so updates render as plain custom messages"
---

# Retro: #1008 — pi-subagents: the mid-run update renderer calls `theme.fg("info")`, which throws, so updates render as plain custom messages

## Stage: Planning (2026-10-02T16:00:02Z)

### Session summary

Reproduced the defect through the real code path: a disposable vitest spike passed Pi 0.84.4's real `dark` `Theme` to `createUpdateRenderer()`, and it threw `Unknown theme color: info` while `accent` rendered.
Planned a two-step fix: `"info"` → `"accent"` with `RendererTheme.fg` typed as Pi's `ThemeColor` (`fix:`), then the same tightening on `src/ui/display.ts`'s `Theme` (`refactor:`), each pinned by an `expectTypeOf` check that `tsc` enforces.

### Observations

- The existing test asserted `[info:●]` against a stub theme that accepts any string, so it pinned the bug; the stub cannot catch an unknown color at runtime, so the type pin carries the guard.
- Spike measurement: tightening `RendererTheme` yields exactly 2 `tsc` errors (`"info"`, `StatusPresentation.iconStyle: string`); tightening `display.ts` `Theme` yields 0 more.
- Operator chose "renderer + `display.ts` Theme" over renderer-only and over deduping the two interfaces.
- No runtime test against a real `Theme`: the package root exports neither `getThemeByName` nor the `theme` singleton (only `Theme`, `initTheme`, `ThemeColor`); the spike deep-imported `dist/` instead, which is too brittle for the suite.
- The Tidy-First assessor recommended no preparatory commits; it noted that the unexported `RendererTheme` can be pinned via `Parameters<ReturnType<typeof createUpdateRenderer>>[2]["fg"]`.

## Stage: Implementation — TDD (2026-10-02T16:59:27Z)

### Session summary

Completed both TDD cycles: the `fix:` commit switches the update renderer to `accent` and types `RendererTheme.fg` as `ThemeColor`, and the `refactor:` commit types `display.ts`'s `Theme.fg` the same way.
Added two `expectTypeOf` pins (one per interface), which `tsc` enforces; the vitest count rose by 2 (the pins are runtime no-ops).
Every named killing mutation went red: `"accent"` → `"dim"` failed the vitest assertion, and reverting either `fg` parameter to `string` failed `run check`.

### Observations

- Deviation: the plan's "0 new `tsc` errors" for the `display.ts` tightening was never actually measured.
  The planning spike's `perl` regex expected `};` right after the `fg` line, but `bold` sits between them, so the substitution matched nothing.
  The real fallout was one private helper, `subLine` in `src/tools/get-result-renderer.ts`, whose `color: string` parameter now reads `Parameters<Theme["fg"]>[0]` (all three callers pass literals).
  A direct `ThemeColor` import there was avoided because the module header says "No SDK types".
  Lesson: after a scripted spike, confirm the substitution applied (`git diff --stat`) before reading its result, as the `testing` skill already says for mutations.
- `display.ts`'s header ("no SDK") was reworded to "no SDK runtime imports", since the new import is type-only.
- The operator asked whether this raises the Pi floor to 1.0.0.
  It does not: the published 0.81.0 tarball (the current `>=0.81.0` floor) already exports `type ThemeColor` with `accent`, and the import is type-only.
- Pre-completion reviewer: WARN.
  The only finding was that it did not capture `fallow decision-surface` output.
  Re-run here: it surfaced 3 `public-api-contract` decisions, for `display.ts`, `renderer.ts`, and `get-result-renderer.ts`.
  All their consumers are inside the package and compile under `tsc`, and none of the three modules is in a public entry.

## Stage: Sync (worktree) (2026-10-02T17:26:53Z)

### Session summary

Pre-push checks passed on the branch: `pnpm run lint` and `pnpm fallow dead-code` both exit 0.
The plan's `**Release:**` marker is `ship independently`, and no follow-up issues were filed.

**Peer session transcript:** `/Users/chris/.pi/agent/sessions/--Users-chris-development-pi-pi-packages-worktrees-issue-1008--/2026-10-02T15-50-13-386Z_01a0fd4f-1489-7268-840e-fa28aa367ee3.jsonl` — read with `read_session_file({ path: "<path>" })` for message-level verification at land/retro time.

### Observations

- The one plan deviation (the `get-result-renderer.ts` `subLine` parameter) is recorded in the TDD stage note and the `refactor:` commit body.

## Stage: Final Retrospective (2026-10-02T18:49:02Z)

### Session summary

Planning, TDD, and sync ran in one peer worktree session, and the root session shipped it: an ff-merge of six commits, green CI on `606a96dc`, #1008 closed, and `pi-subagents` 21.9.2 released.
The fix is two commits, `accent` for the update glyph with `RendererTheme.fg` typed as `ThemeColor`, and the same typing on `src/ui/display.ts`'s `Theme`.
The root session that shipped it also ran the 2026-10-02 backlog triage, which ranked #1008 as the pi-subagents lane's next item.

### Observations

#### What went well

- The planning probe ran the real code path: it passed Pi's real `dark` `Theme` to `createUpdateRenderer()` and saw it throw, rather than reasoning from the stub theme the existing test used, which pinned the bug (`[info:●]`).
- TDD killed every named mutation, including two type-level ones, by reverting the `fg` parameter to `string` and watching `run check` go red.
  This is the first use in this package of `expectTypeOf` pins that `tsc` enforces as the guard for a defect the runtime stub cannot see.
- The triage's new per-package lane table worked as intended on its first use: #1008 was the pi-subagents lane's `Next`, ran in a worktree, and touched no file of any other lane.

#### What caused friction (agent side)

- `instruction-violation` — the planning spike measured the `display.ts` tightening's fallout with a `perl -0pi` substitution that matched nothing, because its pattern expected `};` directly after the `fg` line and `bold` sits between them.
  The "0 new errors" it reported went into both the plan and the planning retro as a measurement.
  The `testing` skill already says to confirm a mutation applied with `git diff --stat`, but planning loaded it (turn 21) only after the spike (turn 13), and the `edit-tool` skill, whose trigger is a scripted substitution, was never loaded.
  Self-identified in TDD step 2.
  Impact: the predicted 0 errors were really 1, the `subLine` retype, absorbed in-step with a deviation note.
  No rework, but a false number survived two committed artifacts.
- `instruction-violation` — planning prefixed about a dozen commands with `cd packages/pi-subagents;` where `AGENTS.md` names `pnpm --filter` or `pnpm -C`, and sync appended its stage note with a `cat >> … <<'EOF'` heredoc where `markdown-conventions` names `Write`/`Edit`.
  Neither was caught.
  Impact: added friction but no rework; `rumdl check` passed the heredoc output.
- `instruction-violation` — the ship close comment ended "Thanks @gotgenes for the Pi 1.0.0 confirmation", crediting the operator's own login, where `/ship` step 9 says to credit a **third party**.
  Self-identified in the ship report.
  Impact: one redundant sentence in a published comment.

#### What caused friction (user side)

- The operator's mid-TDD question ("does this raise the Pi floor to 1.0.0?") was the right redirecting question at the right time: the answer took one tarball download (`pnpm view … dist.tarball`) and settled a floor decision before it reached a commit.

### Diagnostic details

- **Model-performance correlation** — planning and TDD ran on `anthropic/claude-opus-5-5` at medium thinking, sync on `anthropic/claude-sonnet-5-5`, and both subagents (`tidy-first-assessor`, `pre-completion-reviewer`) on `claude-sonnet-5-5`, per their own transcripts.
  The mechanical sync stage was the one that slipped into a heredoc, but one occurrence is not a model signal.
- **Feedback-loop gap analysis** — TDD ran `run check` and the target test after each Red and Green, and the full gates at the baseline and the end; there is no gap.
  The gap was in planning, where a spike's result was read without verifying that its edit had applied.

### Changes made

1. `.pi/skills/edit-tool/SKILL.md` — `## Scripted substitutions` gains the rule to confirm a scripted edit applied (`git diff --stat`) before reading any result from it, a spike's `tsc` count included.
