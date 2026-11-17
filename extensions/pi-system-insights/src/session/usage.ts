import type { SessionUsage } from "#surface";

interface UsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
}

const amount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Billed usage across every entry in the session file, abandoned branches and
 * compacted history included, matching Pi's `getSessionStats()` (`/session`):
 * assistant and tool-result messages, `usage` entries (such as cache warming),
 * and the usage of compaction and branch summaries.
 */
export function sessionUsage(entries: Iterable<unknown>): SessionUsage {
  const totals: SessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const add = (usage: UsageLike | undefined) => {
    if (!usage || typeof usage !== "object") return;
    totals.input += amount(usage.input);
    totals.output += amount(usage.output);
    totals.cacheRead += amount(usage.cacheRead);
    totals.cacheWrite += amount(usage.cacheWrite);
    totals.cost += amount(usage.cost?.total);
  };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as {
      type?: unknown;
      usage?: UsageLike;
      message?: { role?: unknown; usage?: UsageLike };
    };
    if (item.type === "usage" || item.type === "branch_summary" || item.type === "compaction")
      add(item.usage);
    else if (
      item.type === "message" &&
      (item.message?.role === "assistant" || item.message?.role === "toolResult")
    )
      add(item.message.usage);
  }
  return totals;
}

/** The parts of Pi's session manager that say whether its history changed. */
export interface HistorySource {
  getSessionId(): string;
  getLeafId(): string | null;
  getEntries(): Iterable<unknown>;
}

/**
 * Identifies the session file's history as it stands, cheaply: its id, its
 * leaf, which moves on every append, and the number of entries where the
 * session manager tells it without copying them.
 */
export function historyRevision(manager: HistorySource): string {
  const count = (manager as { getEntryCount?: () => unknown }).getEntryCount?.();
  return JSON.stringify([manager.getSessionId(), manager.getLeafId(), count ?? null]);
}

/**
 * The session's usage totals, computed from its whole history once and kept
 * until the history changes: `invalidate` after an event that says so, or a
 * different revision when the reader asks. A status-only refresh reads the
 * cached totals without scanning anything.
 */
export class UsageCache {
  private cached?: { revision: string; totals: SessionUsage };

  /** Session history changed: the next read scans it again. */
  invalidate(): void {
    this.cached = undefined;
  }

  totals(manager: HistorySource): SessionUsage {
    const revision = historyRevision(manager);
    if (this.cached?.revision !== revision)
      this.cached = { revision, totals: sessionUsage(manager.getEntries()) };
    return { ...this.cached.totals };
  }
}
