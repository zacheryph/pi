/**
 * git.ts — the git commands pi-git runs, through `execFile` (argv, never a
 * shell). Every call is bounded by a timeout and an optional abort signal.
 */

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly code: number | string | undefined,
  ) {
    super(stderr.trim() || `git ${args.join(" ")} failed${code === undefined ? "" : ` (${code})`}`);
    this.name = "GitError";
  }
}

export interface GitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Run git in `cwd` and return its stdout. Rejects with a {@link GitError}. */
export function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        // Never stop for credentials or an editor; pi-git only runs local commands.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          reject(new GitError(args, String(stderr || error.message), code));
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });
}

/** `git` that answers true/false for commands that report through their exit status. */
async function succeeds(cwd: string, args: readonly string[], options?: GitOptions) {
  try {
    await git(cwd, args, options);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

/** Resolve symlinks (`/var` → `/private/var` on macOS); the path itself when it cannot be. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface RepoInfo {
  /** Main working tree of the repository, even when `path` is inside a linked worktree. */
  root: string;
  /** Directory name of the main working tree, used to name worktrees. */
  name: string;
}

/**
 * The repository containing `path`. A path inside a linked worktree resolves to
 * the repository's main working tree, so worktrees are always created from it.
 */
export async function repoInfo(path: string, options?: GitOptions): Promise<RepoInfo> {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  let common: string;
  try {
    common = (
      await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], options)
    ).trim();
  } catch (error) {
    if (error instanceof GitError) throw new Error(`${path} is not inside a git repository`);
    throw error;
  }
  if (basename(common) !== ".git") {
    throw new Error(`${path} belongs to a bare repository; worktrees need a main working tree`);
  }
  const root = realPath(dirname(common));
  return { root, name: basename(root) };
}

/** Throws unless `name` is a valid branch name. */
export async function checkBranchName(cwd: string, name: string, options?: GitOptions) {
  if (!(await succeeds(cwd, ["check-ref-format", "--branch", name], options))) {
    throw new Error(`"${name}" is not a valid branch name`);
  }
}

export async function localBranchExists(cwd: string, branch: string, options?: GitOptions) {
  return succeeds(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], options);
}

/** Remote-tracking branches named `<remote>/<branch>`, which `git worktree add` can check out. */
export async function remoteBranches(cwd: string, branch: string, options?: GitOptions) {
  const out = await git(
    cwd,
    ["for-each-ref", "--format=%(refname:short)", `refs/remotes/*/${branch}`],
    options,
  );
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The commit `ref` names, or undefined when it names none. */
export async function resolveCommit(cwd: string, ref: string, options?: GitOptions) {
  try {
    return (
      await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], options)
    ).trim();
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}

/** The branch checked out in `cwd`, or undefined when `HEAD` is detached. */
export async function currentBranch(cwd: string, options?: GitOptions) {
  const out = (await git(cwd, ["branch", "--show-current"], options)).trim();
  return out || undefined;
}

/**
 * The main repository a linked worktree directory belongs to, read from its
 * `.git` file (`gitdir: <repo>/.git/worktrees/<name>`). Undefined for anything
 * else, including a main working tree.
 */
export async function worktreeRepo(path: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(path, ".git"), "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match) return undefined;
  const gitdir = isAbsolute(match[1].trim()) ? match[1].trim() : resolve(path, match[1].trim());
  const marker = `${join(".git", "worktrees")}`;
  const at = gitdir.lastIndexOf(marker);
  if (at < 0) return undefined;
  return realPath(gitdir.slice(0, at).replace(/[\\/]+$/, ""));
}

export interface WorktreeStatus {
  /** Uncommitted changes, including untracked files. Removing the worktree loses them. */
  dirty: boolean;
  /**
   * Commits only a detached `HEAD` holds: no branch or remote has them, so
   * removing the worktree loses them too. Always 0 on a branch.
   */
  detached: number;
  /** Commits on `HEAD` that no remote and not the base have. The kept branch still holds them. */
  unpushed: number;
  /** The worktree has commits of its own and the base ref already contains them. */
  merged: boolean;
}

/** What a worktree's branch started from, as far as it is known. */
export interface BaseRef {
  ref?: string;
  sha?: string;
}

/**
 * The git status of the worktree at `path`. `base` names what the branch was
 * cut from: commits it already holds never count as unpushed. With no base,
 * every commit that no remote has counts.
 */
export async function worktreeStatus(
  path: string,
  base: BaseRef,
  options?: GitOptions,
): Promise<WorktreeStatus> {
  // Explicit, so `status.showUntrackedFiles=no` cannot hide files removal would delete.
  const dirty =
    (await git(path, ["status", "--porcelain", "--untracked-files=all"], options)).trim().length >
    0;
  const baseRef = base.ref && (await resolveCommit(path, base.ref, options)) ? base.ref : undefined;
  const exclude = [
    "--not",
    "--remotes",
    ...(base.sha ? [base.sha] : []),
    ...(baseRef ? [baseRef] : []),
  ];
  const unpushed = Number(
    (await git(path, ["rev-list", "--count", "HEAD", ...exclude], options)).trim(),
  );
  const head = await resolveCommit(path, "HEAD", options);
  const merged =
    !!baseRef &&
    !!head &&
    head !== base.sha &&
    (await succeeds(path, ["merge-base", "--is-ancestor", "HEAD", baseRef], options));
  const detached = (await currentBranch(path, options))
    ? 0
    : Number(
        (
          await git(
            path,
            ["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"],
            options,
          )
        ).trim(),
      );
  return {
    dirty,
    detached: Number.isFinite(detached) ? detached : 0,
    unpushed: Number.isFinite(unpushed) ? unpushed : 0,
    merged,
  };
}
