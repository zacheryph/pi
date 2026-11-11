import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/** Run git with a fixed identity and signing off, never the user's config. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=bundle test",
      "-c",
      "user.email=bundle-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).toString();
}

/** A repository with one commit on `main`, removed when the test ends. */
export function repository(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bundle-repo-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}
