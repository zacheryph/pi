---
issue: 704
issue_title: "`cleanupWorktree` silently discards work when the fallback commit fails"
---

# Preserve the worktree when the rescue commit fails, and retry past hooks

## Release Recommendation

**Release:** ship independently

This package has no `docs/architecture/` roadmap, so this issue belongs to no release batch.
It is a standalone data-loss fix and should reach users as soon as it lands.

## Problem Statement

`cleanupWorktree` (`src/worktree.ts`) wraps the whole changes-exist path — `git status`, `git add -A`, `git commit`, branch creation — in one `try`.
Its `catch` cannot tell "nothing to do" from "something went wrong partway through", so any exception force-removes the worktree via `removeWorktree` and returns `{ hasChanges: false }`.
The caller is told the agent produced nothing, and the directory holding the agent's work is deleted.

The reporter's trigger is a pre-commit hook that rewrites files and exits non-zero — the ordinary `prettier --write` / `eslint --fix` / `rumdl fmt` pattern.
This repository is itself such a repository, for a different reason: the `committed` `commit-msg` hook rejects the rescue commit's `pi-agent: <description>` subject outright.

```text
error Disallowed type `pi-agent` used, please use one of ["feat", "fix", "perf", "revert", "docs", "style", "chore", "refactor", "test", "build", "ci"]
```

So every subagent that runs in a worktree here and produces changes currently loses them.

Two things are wrong, and the fix needs both.
The worktree must not be destroyed when its fate is uncertain, and the rescue commit must actually succeed in the case that motivates the report — otherwise every run in a hook-using repository merely trades destroyed work for an abandoned worktree.

## Goals

- Never remove a worktree whose cleanup did not demonstrably succeed.
- Make the rescue commit succeed past a rejecting hook by retrying once with `--no-verify`, re-staging first so a formatter's rewrites are captured.
- Tell the user, in the result addendum, both when a worktree was preserved and when hooks were bypassed to save their work.
- Replace the ambiguous `{ hasChanges, branch?, path? }` result with a discriminated union so each outcome carries exactly its own data.

This change is **not** breaking.
`WorktreeCleanupResult` is internal: the package's `exports` map is `{ ".": "./src/index.ts" }`, `index.ts` exports only the default extension function, and no file outside this package references `cleanupWorktree`, `WorktreeCleanupResult`, or `WorktreeInfo`.
Commits use `fix:`.

## Non-Goals

- No configuration key gating the hook bypass.
  The bypass is unconditional and announced in the addendum instead.
- No retry beyond the single `--no-verify` attempt, and no retry for `git add` or `git branch` failures.
- No automatic reclamation of preserved worktrees, and no startup reporting of them.
  Preserving is the point; surfacing them later is tracked separately as [#714].
- No change to `createWorktree`, `pruneWorktrees`, or `loadWorktreesConfig`.
- No change to the rescue commit's `pi-agent: <description>` subject or the 200-character truncation.
- Nothing from [#707] (wildcards in `worktreeAgents`), which touches `src/config.ts` and does not overlap this change.
- The `docs/plans/` and `docs/retro/` files carried by [#705] are not imported; this plan and its retro supersede them.

## Background

The relevant modules are small and the dependency graph is shallow.

- `src/worktree.ts` owns all git plumbing: `createWorktree`, `cleanupWorktree`, the private `removeWorktree`, and `pruneWorktrees`.
- `src/workspace-provider.ts` holds the only consumer of `WorktreeCleanupResult`: `WorktreeWorkspace.dispose` reads `hasChanges` and `branch` to build a result addendum, and returns `undefined` otherwise.
  That `undefined` is what makes the loss *silent* — fixing `worktree.ts` alone would stop the destruction but leave the agent unaware.
- `src/index.ts` calls `pruneWorktrees(process.cwd())` at init for crash recovery.

Two facts established during the review of [#705] shape the design.

1. A worktree's `.git` is a file pointing back at the main repository, so a worktree shares the main repository's `.git/hooks` directory.
   Tests must install a hook at `<repoDir>/.git/hooks/pre-commit`, not under the worktree path, which does not exist as a directory.
2. `git worktree prune` only drops administrative entries whose directory is already gone.
   It reclaims nothing for a preserved worktree, so `pruneWorktrees` is not a safety net for this change.

There is also a pre-existing output-argument smell in the function being rewritten.
`cleanupWorktree` assigns `worktree.branch = branchName`, mutating the `WorktreeInfo` it received, then returns the same value.
Nothing reads the mutated field: `dispose` reads `result.branch`, and the only test touching `wt.branch` reads it right after `createWorktree`.
Per the `code-design` structural heuristics, a function should not write back into a received dependency bag, so the mutation is removed as preparatory tidying.

This package has no `docs/architecture/` directory, so there are no layout listings, complexity tables, or roadmap step-marks to update.
`.pi/skills/package-pi-subagents/SKILL.md` mentions this package only as a packaging-pattern reference and does not describe cleanup behavior, so it stays untouched.
The `files` allowlist is `src`, `README.md`, `CHANGELOG.md`, `LICENSE`, so no documentation added here ships in the tarball.

## Design Overview

### Result shape

`WorktreeCleanupResult` becomes a discriminated union, so no consumer can read a field that the outcome does not define.

```typescript
export type WorktreeCleanupResult =
  | { outcome: "clean" }
  | { outcome: "committed"; branch: string; hooksBypassed: boolean }
  | { outcome: "failed"; path: string; error: string };
```

`path` disappears from the success case.
Today it is populated with the path of a worktree that was just removed, and no consumer reads it — a field that means "the worktree that no longer exists" is worth deleting rather than carrying forward.
`hooksBypassed` is read by `dispose` to choose the addendum wording, so it is not a speculative field.

### Cleanup flow

`cleanupWorktree` keeps its overall shape and delegates the three git steps to named helpers, placed below it per the stepdown rule.

```typescript
try {
  if (!statusPorcelain(worktree.path)) {
    removeWorktree(cwd, worktree.path);
    return { outcome: "clean" };
  }
  stageAll(worktree.path);
  const hooksBypassed = commitStaged(worktree.path, `pi-agent: ${safeDesc}`);
  const branch = createBranch(worktree.path, worktree.branch);
  removeWorktree(cwd, worktree.path);
  return { outcome: "committed", branch, hooksBypassed };
} catch (err) {
  debugLog("cleanupWorktree", err);
  return {
    outcome: "failed",
    path: worktree.path,
    error: err instanceof Error ? err.message : String(err),
  };
}
```

The `catch` no longer calls `removeWorktree` at all, so the nested `try`/`catch` around that call disappears with it.

`commitStaged` owns the retry and reports whether it had to bypass hooks.

```typescript
/** Commit the staged snapshot. Returns true if hooks had to be bypassed. */
function commitStaged(worktreePath: string, message: string): boolean {
  try {
    runGit(worktreePath, ["commit", "-m", message]);
    return false;
  } catch (err) {
    debugLog("git commit rejected — retrying with --no-verify", err);
    // A hook may have rewritten files (prettier --write, rumdl fmt) before
    // failing; re-stage so those corrections ride along in the rescue commit.
    stageAll(worktreePath);
    runGit(worktreePath, ["commit", "--no-verify", "-m", message]);
    return true;
  }
}
```

If the retry also throws, it propagates to the outer `catch` and the worktree is preserved.
`createBranch` keeps the existing collision-suffix fallback but **returns** the name it used instead of assigning to `worktree.branch`, which removes the output-argument mutation.

### Addendum

`dispose` dispatches once over the union with an exhaustive `switch` — the `code-design` skill treats a single exhaustive switch at one dispatch site as the dispatch point, not a scattered conditional.

```typescript
const result = cleanupWorktree(this.repoCwd, this.info, outcome.description);
switch (result.outcome) {
  case "clean":
    return undefined;
  case "committed":
    return { resultAddendum: committedAddendum(result) };
  case "failed":
    return { resultAddendum: failedAddendum(result) };
}
```

The existing success wording is preserved byte-for-byte and the bypass notice is appended as a second line, so the current assertion and the README sentence both stay accurate:

```text
Changes saved to branch `pi-agent-abc`. Merge with: `git merge pi-agent-abc`
Commit hooks were bypassed to save this work — review the commit before merging.
```

The failure wording names the path and the underlying error:

```text
Worktree cleanup failed; the worktree was left in place at `/tmp/pi-agent-abc-1f2e` for manual recovery: <error>
```

### Edge cases

| Case                                 | Outcome                                               | Worktree      |
| ------------------------------------ | ----------------------------------------------------- | ------------- |
| Worktree path already gone           | `clean`                                               | n/a           |
| Clean tree                           | `clean`                                               | removed       |
| Commit succeeds first try            | `committed`, `hooksBypassed: false`                   | removed       |
| Hook rejects, `--no-verify` succeeds | `committed`, `hooksBypassed: true`                    | removed       |
| Hook rewrote files then rejected     | `committed`, `hooksBypassed: true`, rewrites included | removed       |
| `git add -A` fails                   | `failed`                                              | **preserved** |
| Both commit attempts fail            | `failed`                                              | **preserved** |
| Both `git branch` attempts fail      | `failed`                                              | **preserved** |

The last row is a deliberate widening: the commit has already succeeded there, so the work is safe in the object database, but the worktree is preserved anyway because the plan's rule is that an uncertain outcome never removes anything.

## Module-Level Changes

1. `src/worktree.ts`
   - Replace the `WorktreeCleanupResult` interface with the discriminated union above.
   - Rewrite `cleanupWorktree`'s body per the sketch; the `catch` returns the `failed` variant and no longer calls `removeWorktree`.
   - Add private helpers below `cleanupWorktree`: `statusPorcelain`, `stageAll`, `commitStaged`, `createBranch`, and a small `runGit(cwd, args, timeout?)` wrapper that collapses the repeated `execFileSync("git", …, { stdio: "pipe", timeout })` literal.
   - `createBranch` returns the branch name; delete the `worktree.branch = branchName` assignment.
   - No change to `createWorktree`, `removeWorktree`, or `pruneWorktrees`.
2. `src/workspace-provider.ts`
   - `WorktreeWorkspace.dispose` switches exhaustively over `result.outcome` and gains the two new addendum strings.
3. `test/worktree.test.ts`
   - Migrate the five `result.hasChanges` assertions (lines 120, 132, 186, 230, 238) and every `result.branch!` non-null assertion to the union, via a local `assertOutcome` assertion helper so the tests narrow instead of asserting non-null.
   - Add a shared `installPreCommitHook(repoDir, body)` helper and an `afterEach` that removes the hook and any worktree a test left preserved.
   - Add the new cases listed under TDD Order.
4. `test/workspace-provider.test.ts`
   - Add `dispose` cases for the `failed` and hook-bypassed `committed` outcomes.
   - The existing `expect(result?.resultAddendum).toContain("Changes saved to branch")` assertion at line 120 stays valid because the success wording is unchanged.
5. `README.md`
   - Extend the Behavior section with the bypass-on-rejection and preserve-on-failure bullets.

Historical plans under `docs/plans/` and `packages/pi-subagents/docs/plans/` quote the old addendum string and the old `hasChanges` shape.
They are records of past decisions and are deliberately left alone.

## Test Impact Analysis

1. **Newly enabled coverage.**
   Extracting `commitStaged` makes the retry decision testable through `cleanupWorktree`'s observable result — `hooksBypassed` distinguishes "committed cleanly" from "committed by bypassing hooks", which the current boolean result cannot express.
   The union also makes the preserved case assertable without inspecting the filesystem alone.
2. **Tests that become redundant.**
   None are removed.
   The existing `cleanupWorktree` tests cover the clean, dirty, branch-collision, already-deleted, and message-truncation paths; all remain meaningful and are only rewritten to read the union.
3. **Tests that must stay as-is.**
   `test/index.test.ts` (which mocks `#src/worktree` and asserts `pruneWorktrees` is called with the cwd) and the `createWorktree` tests are untouched — neither exercises the cleanup result.
4. **Assertion quality.**
   The preserved-worktree tests must assert that the agent's file is still *readable* in the preserved worktree, not merely that the directory exists.
   Directory existence is the mechanism; content survival is the property the issue is about.

## Invariants at risk

There is no prior phase roadmap for this package, so the invariants at risk are internal to this plan.

1. **The clean and success paths must still remove the worktree.**
   Widening the preserve rule must not leak worktrees on the happy path.
   Pinned by the existing "removes worktree when no changes" and "commits and creates branch" tests, which assert `existsSync(wt.path)` is false.
2. **The success addendum string must not drift.**
   `test/workspace-provider.test.ts` line 120 and the README both quote it.
   Appending the bypass notice on a new line keeps the existing substring assertion true.
3. **Step 3's preservation test must survive step 4.**
   This is the one real cross-step trap.
   If step 3 triggers preservation with a failing pre-commit hook, step 4's `--no-verify` retry makes that same scenario *succeed*, silently inverting the earlier test's meaning.
   Step 3 therefore triggers the failure at `git add -A` by pre-creating the worktree's `index.lock`, which no later step bypasses.
   Verified at planning time: with the lock in place, `git status --porcelain` still reports the change, `git add -A` fails with `fatal: Unable to create '<gitdir>/index.lock': File exists`, the file remains on disk, and nothing is written to the object database.
   The lock path comes from `git rev-parse --absolute-git-dir` run inside the worktree.

## TDD Order

1. **Tidy: extract git helpers and drop the output argument.**
   Extract `runGit`, `statusPorcelain`, `stageAll`, and `createBranch` from `cleanupWorktree`; `createBranch` returns the name and the `worktree.branch` assignment is deleted.
   No behavior change and no test change; the existing suite stays green.
   `refactor(pi-subagents-worktrees): extract git helpers from cleanupWorktree (#704)`
2. **Tidy: convert the result to a discriminated union.**
   Introduce the `clean` and `committed` variants only, migrate `dispose` and every test assertion, and add the `assertOutcome` helper.
   The `failed` variant is not added yet, since nothing produces it.
   This is one commit because removing `hasChanges` breaks all consumers at the type level simultaneously.
   `refactor(pi-subagents-worktrees): model cleanup result as a discriminated union (#704)`
3. **Preserve the worktree when cleanup fails.**
   Red: a `cleanupWorktree` test that locks the worktree index, then asserts `outcome === "failed"`, that `path` is the worktree path, that `error` is non-empty, and that the agent's file is still readable at that path.
   A second red test asserts `dispose` returns an addendum naming the preserved path.
   Green: add the `failed` variant, strip `removeWorktree` from the `catch`, and add the `dispose` branch.
   `fix(pi-subagents-worktrees): preserve the worktree when cleanup fails (#704)`
4. **Retry the rescue commit past a rejecting hook.**
   Red: a test installing a pre-commit hook that exits non-zero asserts `outcome === "committed"` with `hooksBypassed: true`, the branch exists, and the worktree was removed.
   A second red test installs a hook that rewrites a file *and* exits non-zero, then asserts the rewritten content is present in the committed tree — pinning the re-stage.
   A third asserts `dispose`'s addendum carries the bypass notice.
   Green: add `commitStaged`'s retry and the `hooksBypassed` field.
   `fix(pi-subagents-worktrees): retry the rescue commit with --no-verify (#704)`
5. **Document the new behavior.**
   Add the two Behavior bullets to `README.md`.
   `docs(pi-subagents-worktrees): document rescue-commit retry and worktree preservation (#704)`

Every commit in steps 1 through 5 carries the attribution trailer agreed during the review of [#705], after a blank line at the end of the body:

```text
Co-authored-by: Anders Bjørnkjær Bennedsgaard <abbennedsgaard@gmail.com>
```

## Risks and Mitigations

| Risk                                                            | Mitigation                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bypassing hooks commits content a secret scanner meant to block | The commit is local and unpushed, and the addendum tells the user hooks were bypassed so they review before merging. The alternative — preserving a worktree in `tmpdir` — leaves the same content on disk with less visibility. |
| Preserved worktrees accumulate in `tmpdir`                      | The `--no-verify` retry removes the common cause, so preservation is now reserved for genuine git failures. Later visibility is tracked in [#714].                                                                               |
| Re-staging commits a destructive hook's rewrite                 | A hook that rewrites files has already written them to the worktree; committing them to a branch is strictly more recoverable than discarding them with the worktree.                                                            |
| `index.lock` test leaves a stale lock behind                    | `afterEach` removes the lock file and any preserved worktree, so later tests in the file are unaffected.                                                                                                                         |
| The union migration silently drops an assertion                 | Step 2 is a pure refactor with no behavior change, so any dropped assertion shows up as a test that no longer narrows; `pnpm run check` fails on an unnarrowed field access.                                                     |

## Open Questions

1. Should a preserved worktree be surfaced again after the session that created it ends?
   Deferred to [#714]; this plan deliberately stops at reporting the path once, in the addendum.
2. Should the rescue commit's subject change so conventional-commit linters accept it without a bypass?
   Choosing a compliant type such as `chore:` would let the commit pass this repository's `committed` hook unaided, but it would still be rejected by hooks that fail for other reasons, so the retry is needed regardless.
   Not pursued here; the subject is listed as a non-goal.

[#705]: https://github.com/gotgenes/pi-packages/pull/705
[#707]: https://github.com/gotgenes/pi-packages/issues/707
[#714]: https://github.com/gotgenes/pi-packages/issues/714
