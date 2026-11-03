/**
 * fold.ts — rebuild pi-git's state from the session's `git:ledger` entries.
 */

import { isWorktreeRecord, LEDGER_TYPE, type WorktreeRecord } from "./ledger.ts";
import { isPrRecord, type PrRecord } from "./prs.ts";

export interface Ledger {
  /** Latest record per worktree path, in creation order. */
  worktrees: Map<string, WorktreeRecord>;
  /** Latest record per pull request key, in first-seen order. */
  prs: Map<string, PrRecord>;
}

/** Fold every entry of the session; entries of other types and malformed data are skipped. */
export function foldLedger(entries: Iterable<unknown>): Ledger {
  const ledger: Ledger = { worktrees: new Map(), prs: new Map() };
  for (const entry of entries) {
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item.type !== "custom" || item.customType !== LEDGER_TYPE) continue;
    if (isWorktreeRecord(item.data)) ledger.worktrees.set(item.data.path, item.data);
    else if (isPrRecord(item.data)) ledger.prs.set(item.data.key, item.data);
  }
  return ledger;
}
