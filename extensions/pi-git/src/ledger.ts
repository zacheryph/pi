/**
 * ledger.ts — pi-git's session entries.
 *
 * Every change to a worktree appends the whole record as a `git:ledger` custom
 * entry; the latest one per path wins. The fold reads `getEntries()`, every
 * branch of the session, not just the current one: a worktree created on disk
 * stays created when `/tree` moves back past the call that made it.
 */

export const LEDGER_TYPE = "git:ledger";
export const LEDGER_VERSION = 1;

/**
 * - `active`: on disk and registered with its repository.
 * - `missing`: gone without pi-git removing it (deleted or pruned outside Pi).
 * - `removed`: removed through `git_worktree_remove` or `/git:worktrees remove`.
 */
export type WorktreeState = "active" | "missing" | "removed";

export interface WorktreeRecord {
  v: typeof LEDGER_VERSION;
  kind: "worktree";
  /** Resolved path of the worktree; the record's identity. */
  path: string;
  /** Main working tree of the repository it belongs to. */
  repo: string;
  branch: string;
  /**
   * What the branch started from. `sha` is the commit the worktree was created
   * at; `ref` (when known) is the branch it was cut from, used to tell when the
   * work has been merged.
   */
  base: { ref?: string; sha: string };
  /** Workspace name, when the worktree is one of several grouped in one directory. */
  workspace?: string;
  /** The workspace directory: the cwd to give an agent that works across its repositories. */
  workspacePath?: string;
  /** Subagent ids that ran in this worktree (or its workspace), oldest first. */
  agents: string[];
  state: WorktreeState;
  createdAt: number;
  updatedAt: number;
  /** Subagent id of the session that created it, when that was a subagent. */
  createdBy?: string;
  /** `adopt` when a descendant session created or changed it and handed it up. */
  via?: "adopt";
}

const STATES: ReadonlySet<unknown> = new Set(["active", "missing", "removed"]);

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Shape check for data read back from a session file or handed over by another session. */
export function isWorktreeRecord(value: unknown): value is WorktreeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const base = record.base as Record<string, unknown> | undefined;
  return (
    record.v === LEDGER_VERSION &&
    record.kind === "worktree" &&
    isString(record.path) &&
    isString(record.repo) &&
    isString(record.branch) &&
    !!base &&
    isString(base.sha) &&
    (base.ref === undefined || isString(base.ref)) &&
    (record.workspace === undefined || isString(record.workspace)) &&
    (record.workspacePath === undefined || isString(record.workspacePath)) &&
    Array.isArray(record.agents) &&
    record.agents.every(isString) &&
    STATES.has(record.state) &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
}

/** Latest record per path, in creation order. */
export function foldLedger(entries: Iterable<unknown>): Map<string, WorktreeRecord> {
  const records = new Map<string, WorktreeRecord>();
  for (const entry of entries) {
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item.type !== "custom" || item.customType !== LEDGER_TYPE) continue;
    if (!isWorktreeRecord(item.data)) continue;
    records.set(item.data.path, item.data);
  }
  return records;
}
