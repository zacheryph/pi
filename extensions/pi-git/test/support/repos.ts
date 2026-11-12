import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Defer, tempDir } from "#test-helpers";

/** Run git with a fixed identity and signing off, so tests never depend on the user's config. */
export function run(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=pi-git test",
      "-c",
      "user.email=pi-git@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).toString();
}

export function commit(cwd: string, file: string, content: string, message = `add ${file}`) {
  writeFileSync(join(cwd, file), content);
  run(cwd, "add", file);
  run(cwd, "commit", "-m", message);
  return run(cwd, "rev-parse", "HEAD").trim();
}

export interface Sandbox {
  dir: string;
  /** Worktree root handed to pi-git. */
  root: string;
  /** Two repositories with one commit each on `main`. */
  api: string;
  web: string;
}

/**
 * A temp directory holding two repositories side by side, as a multi-repo
 * session sees them, removed by `cleanup` (vitest's `onTestFinished`).
 */
export function sandbox(cleanup: Defer): Sandbox {
  const dir = realpathSync(tempDir(cleanup, "pi-git-"));
  const api = join(dir, "src", "api");
  const web = join(dir, "src", "web");
  for (const repo of [api, web]) {
    mkdirSync(repo, { recursive: true });
    run(repo, "init", "-q", "-b", "main");
    commit(repo, "README.md", `# ${repo}\n`, "initial");
  }
  return {
    dir,
    root: join(dir, "worktrees"),
    api,
    web,
  };
}

/** A bare repository `repo` pushes to as `origin`. */
export function addRemote(repo: string, dir: string, name = "origin"): string {
  const remote = join(dir, `${name}-${Math.random().toString(36).slice(2)}.git`);
  run(dir, "init", "-q", "--bare", remote);
  run(repo, "remote", "add", name, remote);
  return remote;
}
