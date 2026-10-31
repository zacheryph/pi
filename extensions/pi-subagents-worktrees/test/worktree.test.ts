import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupWorktree,
  createWorktree,
  discardWorktree,
  pruneWorktrees,
  type WorktreeCleanupResult,
} from "#src/worktree";
import {
  initGitRepo,
  installPreCommitHook,
  lockGitIndex,
} from "#test/support/git-fixture";

/** Narrow a cleanup result to the expected outcome, failing the test otherwise. */
function assertOutcome<T extends WorktreeCleanupResult["outcome"]>(
  result: WorktreeCleanupResult,
  outcome: T,
): asserts result is Extract<WorktreeCleanupResult, { outcome: T }> {
  if (result.outcome !== outcome) {
    throw new Error(
      `expected outcome "${outcome}", got "${result.outcome}": ${JSON.stringify(result)}`,
    );
  }
}

describe("worktree", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = initGitRepo("pi-wt-test-");
  });

  afterEach(() => {
    // Clean up any lingering worktrees first, then remove repo
    try {
      pruneWorktrees(repoDir);
    } catch {
      /* ignore */
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("createWorktree", () => {
    it("creates a worktree in tmpdir", () => {
      const wt = createWorktree(repoDir, "test-id-1");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.branch).toBe("pi-agent-test-id-1");

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Cleanup
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt!.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });

    it("returns undefined for non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        const wt = createWorktree(nonGit, "test-id-2");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns undefined for git repo with no commits", () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        const wt = createWorktree(emptyRepo, "no-commits");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("uses unique paths for multiple worktrees", () => {
      const wt1 = createWorktree(repoDir, "multi-1");
      const wt2 = createWorktree(repoDir, "multi-2");
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      // Cleanup
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt1!.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt2!.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });
  });

  describe("cleanupWorktree", () => {
    /**
     * Worktrees a test created. Cleanup normally removes them itself, but a
     * failure path deliberately leaves one on disk — and worktrees live under
     * `tmpdir`, so deleting `repoDir` does not reclaim them.
     */
    let created: string[];

    beforeEach(() => {
      created = [];
    });

    afterEach(() => {
      for (const path of created) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", path], {
            cwd: repoDir,
            stdio: "pipe",
          });
        } catch {
          /* already removed by the code under test */
        }
      }
    });

    /** Create a worktree and register it for post-test cleanup. */
    function worktreeFor(agentId: string) {
      const wt = createWorktree(repoDir, agentId);
      expect(wt).toBeDefined();
      created.push(wt!.path);
      return wt!;
    }

    it("removes worktree when no changes made", () => {
      const wt = worktreeFor("clean-1");

      const result = cleanupWorktree(repoDir, wt, "test cleanup");
      expect(result).toEqual({ outcome: "clean" });
    });

    it("commits changes and creates branch when changes exist", () => {
      const wt = worktreeFor("dirty-1");

      // Make a change in the worktree
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

      const result = cleanupWorktree(repoDir, wt, "added new file");
      assertOutcome(result, "committed");
      expect(result.hooksBypassed).toBe(false);
      expect(result.branch).toContain("pi-agent-dirty-1");

      // Verify the branch exists in the main repo
      const branches = execFileSync(
        "git",
        ["branch", "--list", result.branch],
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      expect(branches).toContain(result.branch);

      // Verify the commit message
      const log = execFileSync(
        "git",
        ["log", "--oneline", "-1", result.branch],
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      expect(log).toContain("pi-agent: added new file");
    });

    it("does not force-overwrite existing branch", () => {
      // Create first worktree, make changes, cleanup → creates branch
      const wt1 = worktreeFor("conflict-1");
      writeFileSync(join(wt1.path, "file1.txt"), "first run");
      const result1 = cleanupWorktree(repoDir, wt1, "first");
      assertOutcome(result1, "committed");
      expect(result1.branch).toBe("pi-agent-conflict-1");

      // Create second worktree with same agent ID, make changes
      const wt2 = worktreeFor("conflict-1");
      writeFileSync(join(wt2.path, "file2.txt"), "second run");
      const result2 = cleanupWorktree(repoDir, wt2, "second");

      // Should use a different branch name (timestamp suffix)
      assertOutcome(result2, "committed");
      expect(result2.branch).not.toBe("pi-agent-conflict-1");
      expect(result2.branch).toContain("pi-agent-conflict-1-");

      // Both branches should exist
      const branches = execFileSync(
        "git",
        ["branch", "--list", "pi-agent-conflict-1*"],
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      expect(branches).toContain("pi-agent-conflict-1");
      expect(branches).toContain(result2.branch);
    });

    it("handles already-deleted worktree gracefully", () => {
      const wt = worktreeFor("gone-1");
      // Manually delete the worktree directory
      rmSync(wt.path, { recursive: true, force: true });

      const result = cleanupWorktree(repoDir, wt, "already gone");
      expect(result).toEqual({ outcome: "clean" });
    });

    it("bypasses hooks to save the work when the rescue commit is rejected", () => {
      const wt = worktreeFor("hooked-1");
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");
      installPreCommitHook(repoDir, "exit 1");

      const result = cleanupWorktree(repoDir, wt, "rejected by hook");

      assertOutcome(result, "committed");
      expect(result.hooksBypassed).toBe(true);
      expect(existsSync(wt.path)).toBe(false);

      const committed = execFileSync(
        "git",
        ["show", `${result.branch}:new-file.txt`],
        { cwd: repoDir, stdio: "pipe" },
      ).toString();
      expect(committed).toBe("agent wrote this");
    });

    it("includes files a rejecting hook rewrote in the rescue commit", () => {
      const wt = worktreeFor("formatter-1");
      writeFileSync(join(wt.path, "new-file.txt"), "unformatted");
      // The formatter pattern: rewrite the file, then fail the commit anyway.
      installPreCommitHook(repoDir, "echo formatted > new-file.txt\nexit 1");

      const result = cleanupWorktree(repoDir, wt, "formatter rewrote the file");

      assertOutcome(result, "committed");
      const committed = execFileSync(
        "git",
        ["show", `${result.branch}:new-file.txt`],
        { cwd: repoDir, stdio: "pipe" },
      ).toString();
      expect(committed).toBe("formatted\n");
    });

    it("preserves the worktree and reports the error when cleanup fails", () => {
      const wt = worktreeFor("locked-1");
      writeFileSync(join(wt.path, "precious.txt"), "agent work");
      lockGitIndex(wt.path);

      const result = cleanupWorktree(repoDir, wt, "work that must survive");

      assertOutcome(result, "failed");
      expect(result.path).toBe(wt.path);
      expect(result.error).toBeTruthy();
      // The point of preserving: the work is still there to recover.
      expect(readFileSync(join(wt.path, "precious.txt"), "utf8")).toBe(
        "agent work",
      );
    });

    it("truncates commit message at 200 chars", () => {
      const wt = worktreeFor("long-msg");
      writeFileSync(join(wt.path, "change.txt"), "something");
      const longDesc = "x".repeat(300);
      const result = cleanupWorktree(repoDir, wt, longDesc);
      assertOutcome(result, "committed");

      const log = execFileSync(
        "git",
        ["log", "--oneline", "-1", result.branch],
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      // "pi-agent: " prefix (10 chars) + 200 chars of x = 210 total max
      expect(log.length).toBeLessThanOrEqual(220); // some slack for hash prefix
    });
  });

  describe("discardWorktree", () => {
    it("removes a worktree along with its uncommitted work", () => {
      const wt = createWorktree(repoDir, "discard-1")!;
      writeFileSync(join(wt.path, "unwanted.txt"), "abandoned work");

      discardWorktree(repoDir, wt.path);

      expect(existsSync(wt.path)).toBe(false);
    });

    it("reports failure instead of swallowing it", () => {
      expect(() =>
        discardWorktree(repoDir, join(tmpdir(), "pi-agent-never-registered")),
      ).toThrow();
    });
  });

  describe("pruneWorktrees", () => {
    it("does not throw on a clean repo", () => {
      expect(() => pruneWorktrees(repoDir)).not.toThrow();
    });

    it("does not throw on non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        expect(() => pruneWorktrees(nonGit)).not.toThrow();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});
