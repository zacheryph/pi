/**
 * git-fixture.ts — shared test fixtures for the worktree suites.
 *
 * Both `worktree.test.ts` and `workspace-provider.test.ts` drive real git
 * against a throwaway repository, so the setup lives here rather than being
 * duplicated per file.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a temporary git repo with an initial commit, returning its path. */
export function initGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], {
    cwd: dir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: dir,
    stdio: "pipe",
  });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

/**
 * Install a `pre-commit` hook in the repository shared by all its worktrees.
 *
 * A worktree's `.git` is a file pointing back at the main repository, so hooks
 * live under the main repo's `.git/hooks` — never under the worktree path.
 */
export function installPreCommitHook(repoDir: string, body: string): void {
  const hookPath = join(repoDir, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, `#!/bin/sh\n${body}\n`);
  chmodSync(hookPath, 0o755);
}

/**
 * Lock a worktree's git index so the next `git add` fails.
 *
 * This drives cleanup into its failure path *after* `git status` has already
 * reported changes, and before anything reaches the object database — the
 * genuinely unrecoverable case, where the work exists only in the worktree.
 */
export function lockGitIndex(worktreePath: string): void {
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: worktreePath,
    stdio: "pipe",
  })
    .toString()
    .trim();
  writeFileSync(join(gitDir, "index.lock"), "");
}
