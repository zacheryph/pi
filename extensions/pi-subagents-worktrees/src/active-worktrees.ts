/**
 * active-worktrees.ts — the worktrees this process still has a child running in.
 *
 * A rescue worktree preserved by a failed cleanup and a worktree a child is
 * still working in are indistinguishable by path, so the preserved-worktree
 * scan needs to be told which ones are live. The provider records a worktree
 * while its child runs and forgets it once the child is disposed.
 */

import { realpathSync } from "node:fs";
import { debugLog } from "#src/debug";

/** The read side: is a child of this process still running in that worktree? */
export interface LiveWorktrees {
  /** True while a child is running in the worktree at this resolved path. */
  contains(resolvedPath: string): boolean;
}

/**
 * Live worktree paths, keyed by the path the caller knows and stored in the
 * resolved form git reports (`/private/var/...` rather than `/var/...` on macOS).
 */
export class ActiveWorktrees implements LiveWorktrees {
  private readonly resolvedByPath = new Map<string, string>();

  /** Record a worktree as live. Resolves now, while the directory still exists. */
  add(path: string): void {
    this.resolvedByPath.set(path, resolve(path));
  }

  /** Forget a worktree. Safe after its directory has been removed. */
  remove(path: string): void {
    this.resolvedByPath.delete(path);
  }

  contains(resolvedPath: string): boolean {
    for (const live of this.resolvedByPath.values()) {
      if (live === resolvedPath) return true;
    }
    return false;
  }
}

/** Resolve symlinks, falling back to the given path when it cannot be resolved. */
function resolve(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    debugLog("realpath", err);
    return path;
  }
}
