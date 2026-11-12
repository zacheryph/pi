/**
 * fold.ts — rebuild pi-git's state from the session's `git:ledger` entries.
 */

import { customData, readEntries, type EntriesSource } from "#session-state";
import { isWorktreeRecord, LEDGER_TYPE, type WorktreeRecord } from "#src/ledger";
import { isPrRecord, type PrRecord } from "#src/prs";

export interface Ledger {
  /** Latest record per worktree path, in creation order. */
  worktrees: Map<string, WorktreeRecord>;
  /** Latest record per pull request key, in first-seen order. */
  prs: Map<string, PrRecord>;
}

function fold(records: readonly unknown[]): Ledger {
  const ledger: Ledger = { worktrees: new Map(), prs: new Map() };
  for (const data of records) {
    if (isWorktreeRecord(data)) ledger.worktrees.set(data.path, data);
    else if (isPrRecord(data)) ledger.prs.set(data.key, data);
  }
  return ledger;
}

/** Fold every entry of the session; entries of other types and malformed data are skipped. */
export function foldLedger(entries: Iterable<unknown>): Ledger {
  return fold(customData(entries, LEDGER_TYPE));
}

/** Fold `ctx`'s whole session, every branch (see the note at the top of ledger.ts). */
export function readLedger(ctx: EntriesSource): Ledger {
  return fold(readEntries(ctx, { type: LEDGER_TYPE, scope: "all" }));
}
