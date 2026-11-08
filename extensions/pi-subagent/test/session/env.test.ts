import { execSync } from "node:child_process";
import { describe, expect, it, onTestFinished } from "vitest";
import { detectEnv } from "#src/session/env";
import type { ShellExec } from "#src/types";
import { tempDir } from "../../../../packages/pi-test-helpers/src/temp.ts";

/** ShellExec stub that shells out via child_process. */
function mockExec(): ShellExec {
  return async (command, args, options) => {
    try {
      const stdout = execSync(`${command} ${args.join(" ")}`, {
        cwd: options?.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: options?.timeout,
      });
      return { stdout, stderr: "", code: 0 };
    } catch (err: any) {
      return { stdout: "", stderr: err.stderr ?? "", code: err.status ?? 1 };
    }
  };
}

describe("detectEnv", () => {
  it("detects git repo in current project", async () => {
    const env = await detectEnv(mockExec(), process.cwd());
    expect(env.isGitRepo).toBe(true);
    expect(env.platform).toBe(process.platform);
  });

  it("returns branch name when on a branch", async () => {
    // Create a temp repo on a known branch to test branch detection
    const tmpDir = tempDir(onTestFinished, "pi-env-branch-");
    execSync(
      "git init && git config user.email test@test.com && git config user.name Test && git checkout -b test-branch && git -c commit.gpgsign=false commit --allow-empty -m init",
      {
        cwd: tmpDir,
        stdio: "pipe",
      },
    );
    const env = await detectEnv(mockExec(), tmpDir);
    expect(env.isGitRepo).toBe(true);
    expect(env.branch).toBe("test-branch");
  });

  it("detects non-git directory", async () => {
    const tmpDir = tempDir(onTestFinished, "pi-env-test-");
    const env = await detectEnv(mockExec(), tmpDir);
    expect(env.isGitRepo).toBe(false);
    expect(env.branch).toBe("");
    expect(env.platform).toBe(process.platform);
  });
});
