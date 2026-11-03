/**
 * events.ts — what pi-git publishes on the session's `pi.events` bus.
 */

import type { WorktreeStatus } from "./git.ts";
import type { WorktreeRecord } from "./ledger.ts";
import type { FoundWorktree } from "./worktrees.ts";

/**
 * This session's worktrees, for pi-dashboard and other extensions in the same
 * session. Emitted on session start, `/tree`, every ledger change, and after
 * each refresh of the worktrees' git status.
 */
export const GIT_SNAPSHOT_EVENT = "git:snapshot";
export const GIT_SNAPSHOT_VERSION = 1;

export interface GitSnapshotWorktree extends Omit<WorktreeRecord, "v" | "kind"> {
  /** Last measured git status of an active worktree; absent until measured. */
  status?: WorktreeStatus;
  /** Why the status could not be measured. */
  error?: string;
}

export interface GitSnapshotEvent {
  version: typeof GIT_SNAPSHOT_VERSION;
  /** This session's worktrees, newest first, removed ones included. */
  worktrees: GitSnapshotWorktree[];
  /** Worktrees under the worktree root that this session's ledger does not name. */
  found: FoundWorktree[];
}

export function snapshotEvent(
  records: Iterable<WorktreeRecord>,
  statuses: ReadonlyMap<string, { status: WorktreeStatus } | { error: string }>,
  found: readonly FoundWorktree[],
): GitSnapshotEvent {
  const worktrees = [...records]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ v: _v, kind: _kind, ...record }): GitSnapshotWorktree => {
      const measured = record.state === "active" ? statuses.get(record.path) : undefined;
      return { ...record, ...measured };
    });
  return { version: GIT_SNAPSHOT_VERSION, worktrees, found: [...found] };
}
