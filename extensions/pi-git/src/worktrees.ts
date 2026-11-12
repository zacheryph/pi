/**
 * worktrees.ts — create, inspect and remove the worktrees pi-git manages.
 *
 * A worktree lives under the configured root until someone removes it:
 *
 * - `<root>/<repo>/<branch>` on its own, with `/` in the branch name as `-`;
 * - `<root>/<workspace>/<repo>` when grouped in a workspace, so an agent started
 *   in `<root>/<workspace>` sees each repository side by side.
 *
 * Nothing here deletes a branch, and removal refuses to drop uncommitted or
 * unpushed work unless forced.
 */
import { errorText } from "#foundations/errors";

import { existsSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  checkBranchName,
  currentBranch,
  git,
  type GitOptions,
  localBranchExists,
  realPath,
  remoteBranches,
  repoInfo,
  resolveCommit,
  worktreeRepo,
  worktreeStatus,
  type BaseRef,
  type WorktreeStatus,
} from "#src/git";
import { LEDGER_VERSION, type WorktreeRecord } from "#src/ledger";

const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CreateRequest {
  /** Session cwd; `repo` is relative to it. */
  cwd: string;
  root: string;
  repo?: string;
  branch: string;
  base?: string;
  workspace?: string;
  now: number;
  createdBy?: string;
}

/** True when `child` is `parent` or inside it. */
export function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Path segment for a branch name: `feat/login` → `feat-login`. */
export function branchSlug(branch: string): string {
  return branch.replace(/[\\/]+/g, "-");
}

export function worktreePath(root: string, repoName: string, branch: string, workspace?: string) {
  return workspace ? join(root, workspace, repoName) : join(root, repoName, branchSlug(branch));
}

/** Create the worktree and return its first ledger record. */
export async function createWorktree(
  request: CreateRequest,
  options: GitOptions = {},
): Promise<WorktreeRecord> {
  const { branch, workspace } = request;
  if (workspace !== undefined && !WORKSPACE_PATTERN.test(workspace)) {
    throw new Error(
      `workspace "${workspace}" must be a single directory name of letters, digits, ".", "_" or "-"`,
    );
  }
  const repo = await repoInfo(resolve(request.cwd, request.repo ?? "."), options);
  await checkBranchName(repo.root, branch, options);

  const path = worktreePath(request.root, repo.name, branch, workspace);
  if (existsSync(path)) {
    throw new Error(
      workspace
        ? `${path} already exists: workspace "${workspace}" already has a worktree of ${repo.name}`
        : `${path} already exists`,
    );
  }

  const cutFrom = await currentBranch(repo.root, options);
  let args: string[];
  let base: WorktreeRecord["base"];
  if (request.base !== undefined) {
    const sha = await resolveCommit(repo.root, request.base, options);
    if (!sha) throw new Error(`base "${request.base}" names no commit in ${repo.root}`);
    if (await localBranchExists(repo.root, branch, options)) {
      throw new Error(`branch "${branch}" already exists; omit base to check it out as it is`);
    }
    args = ["worktree", "add", "-b", branch, path, request.base];
    base = { ref: request.base, sha };
  } else if (await localBranchExists(repo.root, branch, options)) {
    // Work already on the branch is not this worktree's to protect.
    args = ["worktree", "add", path, branch];
    base = { ...(cutFrom ? { ref: cutFrom } : {}), sha: (await resolveCommit(repo.root, branch))! };
  } else {
    const remotes = await remoteBranches(repo.root, branch, options);
    if (remotes.length > 1) {
      throw new Error(
        `branch "${branch}" exists on several remotes (${remotes.join(", ")}); pass base to choose one`,
      );
    }
    if (remotes.length === 1) {
      // `git worktree add <path> <branch>` creates a local branch tracking it.
      args = ["worktree", "add", path, branch];
      base = {
        ...(cutFrom ? { ref: cutFrom } : {}),
        sha: (await resolveCommit(repo.root, remotes[0]))!,
      };
    } else {
      const sha = await resolveCommit(repo.root, "HEAD", options);
      if (!sha) throw new Error(`${repo.root} has no commits yet`);
      args = ["worktree", "add", "-b", branch, path, "HEAD"];
      base = { ...(cutFrom ? { ref: cutFrom } : {}), sha };
    }
  }

  await mkdir(dirname(path), { recursive: true });
  try {
    await git(repo.root, args, { ...options, timeoutMs: 120_000 });
  } catch (error) {
    removeEmptyDirs(dirname(path), request.root);
    throw error;
  }
  return {
    v: LEDGER_VERSION,
    kind: "worktree",
    path: realPath(path),
    repo: repo.root,
    branch,
    base,
    ...(workspace ? { workspace, workspacePath: realPath(join(request.root, workspace)) } : {}),
    agents: [],
    state: "active",
    createdAt: request.now,
    updatedAt: request.now,
    ...(request.createdBy ? { createdBy: request.createdBy } : {}),
  };
}

/** Remove `dir` and its parents up to (not including) `stop` while they are empty. */
export function removeEmptyDirs(dir: string, stop: string): void {
  let current = dir;
  while (current !== stop && within(stop, current)) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

/** True while the worktree is on disk and still registered with its repository. */
export async function isLive(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return (await worktreeRepo(path)) !== undefined;
}

export type Inspection = { status: WorktreeStatus } | { error: string };

export async function inspect(
  path: string,
  base: BaseRef,
  options?: GitOptions,
): Promise<Inspection> {
  try {
    return { status: await worktreeStatus(path, base, options) };
  } catch (error) {
    return { error: errorText(error) };
  }
}

function commits(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

/**
 * What removing the worktree would lose, or undefined when nothing. Its branch
 * is kept, so committed work on a branch is never at risk, pushed or not.
 */
export function atRisk(status: WorktreeStatus): string | undefined {
  const reasons: string[] = [];
  if (status.dirty) reasons.push("uncommitted changes");
  if (status.detached > 0) reasons.push(`${commits(status.detached)} on no branch`);
  return reasons.length ? reasons.join(" and ") : undefined;
}

/** "uncommitted changes; 2 commits on no remote; merged into main", or "clean". */
export function describeStatus(status: WorktreeStatus, baseRef?: string): string {
  const parts: string[] = [];
  if (status.dirty) parts.push("uncommitted changes");
  if (status.detached > 0) parts.push(`${commits(status.detached)} on no branch`);
  if (status.unpushed > 0) parts.push(`${commits(status.unpushed)} on no remote`);
  if (status.merged && baseRef) parts.push(`merged into ${baseRef}`);
  return parts.length ? parts.join("; ") : "clean";
}

export interface RemoveRequest {
  path: string;
  repo: string;
  base: BaseRef;
  root: string;
  force?: boolean;
}

/**
 * Remove a worktree, keeping its branch. Without `force`, refuses when removal
 * would lose work: uncommitted changes, or commits only a detached `HEAD` has.
 * A worktree that is already gone only has its registration pruned. Returns the
 * status measured before removal, when there was a worktree to measure.
 */
export async function removeWorktree(
  request: RemoveRequest,
  options: GitOptions = {},
): Promise<WorktreeStatus | undefined> {
  let status: WorktreeStatus | undefined;
  if (await isLive(request.path)) {
    const inspection = await inspect(request.path, request.base, options);
    if ("status" in inspection) status = inspection.status;
    if (!request.force) {
      if ("error" in inspection)
        throw new Error(
          `cannot tell whether ${request.path} holds unsaved work (${inspection.error}); pass force to remove it anyway`,
        );
      const risk = atRisk(inspection.status);
      if (risk)
        throw new Error(
          `${request.path} has ${risk}, which removing it would lose; commit it to a branch, or pass force to discard it`,
        );
    }
    await git(
      request.repo,
      ["worktree", "remove", ...(request.force ? ["--force"] : []), request.path],
      options,
    );
  } else if (existsSync(request.repo)) {
    await git(request.repo, ["worktree", "prune"], options).catch(() => undefined);
  }
  removeEmptyDirs(dirname(request.path), request.root);
  return status;
}

export interface FoundWorktree {
  path: string;
  repo: string;
  branch?: string;
}

/**
 * Linked worktrees under `root` that `known` does not name: ones another
 * session created, or that were added there by hand. Looks two levels deep,
 * where pi-git puts them.
 */
export async function findWorktrees(
  root: string,
  known: ReadonlySet<string>,
  options?: GitOptions,
): Promise<FoundWorktree[]> {
  if (!existsSync(root)) return [];
  const found: FoundWorktree[] = [];
  for (const group of subdirectories(root)) {
    for (const candidate of subdirectories(group)) {
      const path = realPath(candidate);
      if (known.has(path)) continue;
      const repo = await worktreeRepo(path);
      if (!repo) continue;
      let branch: string | undefined;
      try {
        branch = await currentBranch(path, options);
      } catch {
        branch = undefined;
      }
      found.push({ path, repo, ...(branch ? { branch } : {}) });
    }
  }
  return found;
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
