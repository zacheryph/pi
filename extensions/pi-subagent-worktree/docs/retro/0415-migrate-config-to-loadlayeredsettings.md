---
issue: 415
issue_title: "Migrate pi-subagents-worktrees config loader to loadLayeredSettings"
---

# Retro: #415 — Migrate pi-subagents-worktrees config loader to loadLayeredSettings

## Stage: Planning (2026-06-16T18:30:00Z)

### Session summary

Planned the consumer-side migration of `pi-subagents-worktrees/src/config.ts` to the shared `loadLayeredSettings` helper published by `@gotgenes/pi-subagents/settings`.
Confirmed the prerequisite from [#380] is satisfied: the helper and the `./settings` subpath shipped in pi-subagents v16.4.0 (tag present, CHANGELOG confirms).
Scoped the change to a single package despite two `pkg:*` labels, since only worktrees code changes.

### Observations

- Despite `pkg:pi-subagents` and `pkg:pi-subagents-worktrees` labels, pi-subagents itself does not change — the helper is already published — so this is a single-package plan filed under `packages/pi-subagents-worktrees/docs/plans/`.
- The only observable behavior change is the malformed-file warning wording: the local loader says `Ignoring malformed config`, the shared helper says `Ignoring malformed settings` (fixed wording, same `[pi-subagents-worktrees]` label via `warnLabel`).
  This is stderr text, not an API/return/default change, so it is not breaking — but `config.test.ts` asserts the old text and must update.
- Worktrees currently resolves `@gotgenes/pi-subagents@15.0.1` (no `./settings`) in its nested `node_modules`; the plan bumps the peer/dev floor to `16.4.0` and requires `pnpm install` in the same commit so the new import resolves.
- Folded the dep bump, `pnpm install`, `config.ts` rewrite, docstring update, and test-assertion update into one TDD cycle/commit — the import will not resolve and the module will not compile mid-change otherwise.
- Author is the operator (`gotgenes`) and the proposed change is unambiguous, so the `ask-user` gate was skipped.

## Stage: Implementation — TDD (2026-06-16T20:35:00Z)

### Session summary

Executed the single TDD cycle from the plan: updated the malformed-JSON assertion in `test/config.test.ts` (`config` → `settings`), bumped `@gotgenes/pi-subagents` peer/dev floors to `>=16.4.0`/`^16.4.0` in `package.json`, ran `pnpm install`, and rewrote `src/config.ts` to delegate to `loadLayeredSettings`.
All 26 worktrees tests pass; full repo suite (1030 pi-subagents, 2003 pi-permission-system) is green.
Pre-completion reviewer returned PASS.

### Observations

- `pnpm install` also added a `minimumReleaseAgeExclude` entry for `@gotgenes/pi-subagents@16.4.0` to `pnpm-workspace.yaml` (supply-chain policy); this was staged alongside the other changes in the single commit.
- The first `git commit` attempt failed due to a `pnpm` supply-chain check in the pre-commit hook; adding the `pnpm-workspace.yaml` change to the staged set resolved it.
- Pre-completion reviewer noted a pre-existing stepdown-rule violation in `config.ts` (`sanitize` defined before `loadWorktreesConfig`); this predates the PR and is minor — not fixed here to keep scope tight.
- No deviations from the plan; the single atomic commit strategy proved correct — all five files were required to compile and pass simultaneously.

## Stage: Final Retrospective (2026-06-17T00:51:13Z)

### Session summary

Shipped #415 cleanly across Planning, TDD, and Ship stages: pushed `7e89bb83`, CI passed, issue closed as the final consumer step of #380.
No release-please PR (a `refactor:` commit produces no changelog entry and triggers no release).
The single real friction was a one-attempt commit failure caused by an unstaged `pnpm-workspace.yaml` change.

### Observations

#### What went well

- Textbook feedback loop in TDD: baseline `check`/`lint`/`test` before the cycle, red confirmed on the single file (`test/config.test.ts`), green confirmed, then full suite + `check` + `lint` + `fallow dead-code` before pre-completion.
  No verification was deferred to the end.
- Planning correctly predicted the single-atomic-commit requirement; all five files (`config.ts`, `config.test.ts`, `package.json`, `pnpm-lock.yaml`, plus the surprise `pnpm-workspace.yaml`) had to land together to compile and pass.

#### What caused friction (agent side)

- `missing-context` — `pnpm install` after the dependency bump also added a `minimumReleaseAgeExclude` entry for `@gotgenes/pi-subagents@16.4.0` to `pnpm-workspace.yaml` (because 16.4.0 was published the same day, below the supply-chain minimum-release-age threshold).
  Only `pnpm-lock.yaml` was anticipated and staged, so the first `git commit` failed in the pre-commit hook's pnpm dependency-status check.
  Self-identified and resolved in one retry (stage `pnpm-workspace.yaml`, re-commit).
  Impact: one failed commit attempt, no code rework.
  Both the plan's Module-Level Changes and `tdd-plan.md` step 5 name only `pnpm-lock.yaml`, which is why the second file was missed.

#### What caused friction (user side)

- None — the operator's involvement was workflow-driven (running each stage prompt); no corrections were needed.

### Diagnostic details

- **Model-performance correlation** — the entire Ship stage (CI watch, close-comment authoring, release-PR decision, final report) ran on `opencode-go/deepseek-v4-flash`; the retro ran on `anthropic/claude-opus-4-8`.
  Ship handled this simple case correctly, but `/ship-issue` carries conditional judgment (stacked-release batching, which sibling issues to close, whether a blocked release-PR should stop the merge).
  A flash model is a borderline fit for that stage — fine here because the refactor needed no release, but worth watching on issues with release-PR merges or multi-issue sequences.

### Changes made

1. `.pi/prompts/tdd-plan.md` — step 5 now checks `git diff --name-only pnpm-lock.yaml pnpm-workspace.yaml` and notes that `pnpm install` can add a `minimumReleaseAgeExclude` entry to `pnpm-workspace.yaml`.
2. `.pi/skills/code-design/SKILL.md` — extended the dependency-change bullet to note that bumping to a freshly-published version may also add a `minimumReleaseAgeExclude` entry to `pnpm-workspace.yaml`, which must be staged.
