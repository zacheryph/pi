import type { UsageSection } from "./protocol.ts";

interface UsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
}

const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Billed usage across every entry in the session file, abandoned branches and
 * compacted history included, matching Pi's `getSessionStats()` (`/session`).
 */
export function sessionUsage(entries: Iterable<unknown>): UsageSection {
  const totals: UsageSection = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const add = (usage: UsageLike | undefined) => {
    if (!usage || typeof usage !== "object") return;
    totals.input += num(usage.input);
    totals.output += num(usage.output);
    totals.cacheRead += num(usage.cacheRead);
    totals.cacheWrite += num(usage.cacheWrite);
    totals.cost += num(usage.cost?.total);
  };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { type?: unknown; usage?: UsageLike; message?: { role?: unknown; usage?: UsageLike } };
    if (item.type === "usage" || item.type === "branch_summary" || item.type === "compaction") add(item.usage);
    else if (item.type === "message" && (item.message?.role === "assistant" || item.message?.role === "toolResult")) add(item.message.usage);
  }
  return totals;
}
