---
issue: 369
issue_title: "pi-subagents-worktrees packages > 0.0.1 not published on npm"
---

# Retro: #369 — pi-subagents-worktrees packages > 0.0.1 not published on npm

## Stage: Planning (2026-06-10T01:50:32Z)

### Session summary

Diagnosed why `@gotgenes/pi-subagents-worktrees` is stuck at `0.0.1` on npm despite GitHub releases through `0.2.2`: the `packages` array in `scripts/publish-released.sh` hardcodes six packages and never included `pi-subagents-worktrees`, so the CI `publish` job silently skipped it on every release.
The `0.0.1` on npm was a one-off manual scaffold-time publish (no `pi-subagents-worktrees-v0.0.1` git tag exists).
Produced `packages/pi-subagents-worktrees/docs/plans/0001-publish-worktrees-package.md` — first plan/retro in this package.

### Observations

- Two decisions surfaced via `ask_user`: backfill scope (chose **only `0.2.2`**, the current latest, not the intermediate `0.1.0`/`0.2.0`/`0.2.1`) and backfill mechanism (chose **manual local publish without `--provenance`** over a new `workflow_dispatch` CI job).
- The fix is split: a committed one-line allowlist addition in `scripts/publish-released.sh` (recurrence prevention) plus an operational runbook for the maintainer to `pnpm --filter @gotgenes/pi-subagents-worktrees publish` `0.2.2` (backfill).
- The script edit lives at repo root, outside every `packages/<dir>` scope, so it triggers **no** release-please version bump — intentional and important: we are not cutting `0.2.3`.
- Root cause is a duplicated source of truth — the package list exists in both `release-please-config.json` and `scripts/publish-released.sh`.
  Rejected folding the structural fix (derive the script's list from `release-please-config.json` via `jq`) into this change to keep blast radius small; captured it as an Open Question / follow-up instead.
- Package is ship-source: no `files` allowlist, no `prepack`/`prepublishOnly`, so the backfill publish needs no build step.
- No automated test exists for the bash publish script; verification is `bash -n` plus the next-release end-to-end signal.
  Next stage is `/build-plan` (script edit + runbook), not `/tdd-plan`.

## Stage: Implementation — Build (2026-06-10T02:10:00Z)

### Session summary

Added `"packages/pi-subagents-worktrees:@gotgenes/pi-subagents-worktrees"` to the `packages` array in `scripts/publish-released.sh` in one commit.
The backfill runbook (step 2 from the plan) is operational — it is documented in the plan and will be posted to the issue by `/ship-issue`, not committed.
No TypeScript or test files were modified; `bash -n` confirmed script syntax; all lint and test checks passed.

### Observations

- Single committed change: one insertion in `scripts/publish-released.sh` — exactly as planned, no deviations.
- `bash -n` syntax check passed immediately; lint (Biome + ESLint) exited clean (the 3 Biome `INFO`-level suggestions are in `packages/pi-permission-system/`, an unrelated prior session).
- Pre-completion reviewer returned **PASS** — all deterministic checks clean, conventional commits valid, no dead code, no test artifacts expected for a bash-only change.
- The backfill runbook to publish `0.2.2` to npm locally must be executed by the maintainer after `/ship-issue` pushes and CI passes.
  Exact commands: `npm whoami`, then `pnpm --filter @gotgenes/pi-subagents-worktrees publish --access public --no-git-checks`, then `npm view @gotgenes/pi-subagents-worktrees version` to confirm `0.2.2` resolves.

## Stage: Final Retrospective (2026-06-10T02:12:38Z)

### Session summary

Shipped the one-line `scripts/publish-released.sh` allowlist fix across plan/build/ship stages with a `PASS` pre-completion review and clean CI, then backfilled `0.2.2` to npm and closed the issue with a thank-you and apology to the reporter.
The single substantive friction was the manual-publish ref: the plan's runbook published from `main`, which the user caught would pollute the tarball with files added after the `v0.2.2` tag.

### Observations

#### What went well

- Root-cause diagnosis in planning was precise and evidence-backed: identified the hardcoded `packages` array in `scripts/publish-released.sh`, and confirmed the npm `0.0.1` was a manual scaffold publish by noting the absence of a `pi-subagents-worktrees-v0.0.1` git tag.
- The `ask_user` gate cleanly surfaced the two real decisions (backfill scope, backfill mechanism) instead of guessing — both were preference-sensitive and shaped the plan.
- Tight execution: one-line fix, `PASS` review, no rework, no deviations from plan through build and ship.

#### What caused friction (agent side)

- `missing-context` (user-caught) — the plan's backfill runbook published from `main` and explicitly reasoned "no checkout of a tag is needed since `main` already sits on the latest release."
  That reasoning ignored that `main` accumulates plan/retro docs inside `packages/pi-subagents-worktrees/docs/` between the `v0.2.2` tag and HEAD.
  A `pnpm pack --dry-run` confirms publishing from `main` ships `docs/plans/0001-*.md` and `docs/retro/0001-*.md` — files absent from the tagged release.
  The user caught it with "We don't have to check out a tag of some sort?"
  Impact: corrected publish guidance (check out `pi-subagents-worktrees-v0.2.2` first); no committed rework, but the artifact would have been unfaithful to the GitHub release had the user not asked.

#### What caused friction (user side)

- None — the user's two interventions ("don't close until we publish" and the tag-checkout question) were well-timed strategic steers that improved the outcome.

### Diagnostic details

- **Unused-tool / root-cause check** — the `missing-context` gap was a reasoning miss, not a search miss, but a `git diff --name-only <tag>..HEAD -- packages/<PKG>/` (or `pnpm pack --dry-run`) at plan time would have surfaced the doc-pollution delta before it reached the runbook.
- **Deeper structural cause** — `packages/pi-subagents-worktrees/package.json` has no `files` allowlist, so every npm publish ships `docs/` (plans, retros) and `test/` to consumers, not just during this backfill.
  This is a per-package packaging-hygiene gap that likely affects sibling ship-source packages; it warrants its own issue rather than an inline retro fix.
- Other lenses (model-performance, escalation-delay, feedback-loop) found nothing notable: one subagent dispatch (`pre-completion-reviewer`) was appropriately scoped, no rabbit holes, and verification (`lint`, `bash -n`, pre-completion checks) ran incrementally.

### Changes made

1. Added this Final Retrospective stage entry to `packages/pi-subagents-worktrees/docs/retro/0001-publish-worktrees-package.md`.
2. No `AGENTS.md` change — the proposed manual-backfill tag-checkout note was declined as a band-aid that the `files`-allowlist fix would obsolete.

### Follow-up

1. Open an issue to add a `files` allowlist to `packages/pi-subagents-worktrees/package.json` (and audit sibling ship-source packages) so npm publishes exclude `docs/` and `test/`.
   This is the proper fix for the tarball-pollution friction the manual backfill exposed; run `/plan-issue` on it rather than patching `AGENTS.md`.
