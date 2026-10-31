---
issue: 369
issue_title: "pi-subagents-worktrees packages > 0.0.1 not published on npm"
---

# Publish pi-subagents-worktrees releases to npm

## Problem Statement

A user pinning `npm:@gotgenes/pi-subagents-worktrees@0.2.2` gets an npm `E404` — the registry only has `0.0.1`, even though GitHub has releases and tags up to `0.2.2`.
The package's GitHub releases (`0.1.0`, `0.2.0`, `0.2.1`, `0.2.2`) were cut by release-please but never reached npm.

The root cause is `scripts/publish-released.sh`: its `packages` array hardcodes the six packages eligible for publishing and never included `pi-subagents-worktrees`.
The `0.0.1` on npm was a one-off manual publish at scaffold time (there is no `pi-subagents-worktrees-v0.0.1` git tag).
Every release-please release since then produced a tag and a GitHub release, but the `publish` CI job skipped the package because it was absent from the array.

## Goals

- Add `pi-subagents-worktrees` to the publish allowlist in `scripts/publish-released.sh` so future releases publish automatically.
- Backfill the current latest release, `0.2.2`, to npm so the reporter's pin resolves.

## Non-Goals

- Backfilling intermediate releases `0.1.0`, `0.2.0`, `0.2.1` (decision: publish only the current latest `0.2.2`).
- Adding provenance attestation to the backfilled version (decision: one-time manual local publish, no `--provenance`).
- Replacing the hardcoded `packages` array with a list derived from `release-please-config.json` (noted as a follow-up in Open Questions).
- Cutting a new release (`0.2.3`); the script fix lives at repo root and triggers no version bump, which is intentional.

## Background

Relevant files and facts:

- `scripts/publish-released.sh` — invoked by the `publish` job in `.github/workflows/ci.yml`.
  It receives release-please's step outputs as `RELEASES` (JSON) and, for each entry in its `packages` array, checks `"${path}--release_created"` and runs `pnpm --filter <name> publish --access public --no-git-checks --provenance`.
  The array currently lists six packages; `pi-subagents-worktrees` is missing.
- `release-please-config.json` — already lists all seven packages (including `pi-subagents-worktrees`), so release-please correctly cuts tags and GitHub releases for it.
  This is the duplicated source of truth: the package list lives both here and in the publish script.
- `.release-please-manifest.json` — records `packages/pi-subagents-worktrees: 0.2.2`, matching `main`'s `package.json`.
- `packages/pi-subagents-worktrees/package.json` — `version: 0.2.2`, ship-source (`exports["."]` → `./src/index.ts`), no `files` allowlist, no `prepack`/`prepublishOnly` script.
  Publishing is a plain `pnpm publish` with no build step (unlike `pi-subagents`, which builds a type bundle at `prepack`).
- npm registry currently: `@gotgenes/pi-subagents-worktrees` `latest = 0.0.1`, `versions = ["0.0.1"]`.
- Git tags present: `pi-subagents-worktrees-v0.1.0`, `-v0.2.0`, `-v0.2.1`, `-v0.2.2` (no `-v0.0.1`).

AGENTS.md constraints that apply:

- This package is ship-source; no `dist/` is committed and none is needed to publish.
- The repo uses pnpm exclusively — the backfill uses `pnpm publish`, never `npm publish`.
- Editing `scripts/` triggers no release-please release (it is outside every `packages/<dir>` scope), so the script fix cannot accidentally bump a version.

## Design Overview

Two independent fixes:

1. Recurrence fix (committed) — add one entry to the `packages` array in `scripts/publish-released.sh`:

   ```bash
   packages=(
     "packages/pi-autoformat:@gotgenes/pi-autoformat"
     "packages/pi-colgrep:@gotgenes/pi-colgrep"
     "packages/pi-github-tools:@gotgenes/pi-github-tools"
     "packages/pi-permission-system:@gotgenes/pi-permission-system"
     "packages/pi-session-tools:@gotgenes/pi-session-tools"
     "packages/pi-subagents:@gotgenes/pi-subagents"
     "packages/pi-subagents-worktrees:@gotgenes/pi-subagents-worktrees"
   )
   ```

   This is the minimal, low-blast-radius change: it leaves the existing six entries untouched and only affects what the `publish` job does when a `pi-subagents-worktrees` release is created.
   From the next release onward, the job publishes the package automatically.

2. Backfill (operational, not committed) — a maintainer publishes the current `0.2.2` from `main` with an npm token:

   ```bash
   pnpm --filter @gotgenes/pi-subagents-worktrees publish --access public --no-git-checks
   ```

   `--provenance` is omitted because provenance requires the OIDC token available only inside GitHub Actions; this is a deliberate one-time manual publish.
   No build step runs (no `prepack`), so the tarball ships `src/` directly, matching how the package is consumed.

Edge cases and notes:

- The backfill publishes exactly `0.2.2` because that is the version in `main`'s `package.json`; no checkout of a tag is needed since `main` already sits on the latest release.
- The script fix and the backfill are decoupled: the fix does not republish `0.2.2` (no new release event), and the backfill does not depend on the fix landing first.

## Module-Level Changes

| File                          | Change                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `scripts/publish-released.sh` | Add `"packages/pi-subagents-worktrees:@gotgenes/pi-subagents-worktrees"` to the `packages` array. |

No source, test, or doc files in `packages/pi-subagents-worktrees/` change.
No architecture/health docs reference the publish script.
The plan and retro files for this issue live under `packages/pi-subagents-worktrees/docs/{plans,retro}/`, both already excluded in `release-please-config.json`.

## Test Impact Analysis

There is no automated test harness for `scripts/publish-released.sh` (it is a bash script with no test coverage), and this change adds none — introducing a bats/shell test rig is out of scope for a one-line allowlist addition.
Verification is manual:

- `bash -n scripts/publish-released.sh` confirms the edited script still parses.
- Reasoning: the new entry follows the identical `path:filter` shape as the existing six, and `path` (`packages/pi-subagents-worktrees`) matches the key release-please emits (`"${path}--release_created"`).

The true end-to-end proof is the next `pi-subagents-worktrees` release publishing automatically; that cannot be exercised within this change.

## Implementation Steps

This is a build-style change (one shell-script edit plus a runbook), not a TDD cycle.

1. Edit `scripts/publish-released.sh` — append the `pi-subagents-worktrees` entry to the `packages` array.
   Verify with `bash -n scripts/publish-released.sh`.
   Commit: `fix(ci): publish pi-subagents-worktrees from release script (#369)`.

2. Backfill runbook (maintainer-executed, outside this commit) — record the exact commands in the issue/PR so the maintainer can run them with npm auth:

   ```bash
   # from main, which is at 0.2.2
   npm whoami                                   # confirm npm auth
   pnpm --filter @gotgenes/pi-subagents-worktrees publish --access public --no-git-checks
   npm view @gotgenes/pi-subagents-worktrees version    # expect 0.2.2
   ```

   Acceptance: `pi install npm:@gotgenes/pi-subagents-worktrees@0.2.2` succeeds (no `E404`).

## Risks and Mitigations

- Risk: the duplicated package list in `scripts/publish-released.sh` vs `release-please-config.json` causes this same omission for the next new package.
  Mitigation: the immediate fix closes the current gap; the structural fix (derive the list from `release-please-config.json`) is captured in Open Questions as a follow-up rather than bundled here to keep the change small and reversible.
- Risk: the manual backfill lacks provenance, unlike the other six packages.
  Mitigation: accepted per the chosen mechanism; only this single `0.2.2` artifact is affected, and all future releases publish through CI with `--provenance`.
- Risk: a manual publish from a dirty or stale working tree ships unintended content.
  Mitigation: the runbook publishes from `main` (already on `0.2.2`); `--no-git-checks` is used only because pnpm otherwise blocks publishing off a tag-less branch — the maintainer confirms a clean `git status` first.

## Open Questions

- Should `scripts/publish-released.sh` derive its package list from `release-please-config.json` (e.g. via `jq`, mapping each `packages/<dir>` to `@gotgenes/<basename>`) to eliminate the duplicated source of truth and prevent this class of bug entirely?
  Deferred as a separate follow-up: it changes how all seven packages publish (higher blast radius) and warrants its own issue.
- Should intermediate releases `0.1.0`/`0.2.0`/`0.2.1` ever be backfilled?
  Deferred unless a user reports needing a pinned intermediate version.
