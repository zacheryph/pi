import { describe, expect, it, vi } from "vitest";
import { sessionUsage, UsageCache } from "#src/session/usage";

const usage = (input: number, output: number, cost: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output,
  cost: { total: cost },
});

describe("sessionUsage", () => {
  it("adds assistant, tool-result, usage, summary and compaction usage like /session", () => {
    expect(
      sessionUsage([
        { type: "message", message: { role: "user", content: "hi" } },
        { type: "message", message: { role: "assistant", usage: usage(100, 20, 0.5, 1000, 50) } },
        { type: "message", message: { role: "toolResult", usage: usage(10, 5, 0.1) } },
        { type: "message", message: { role: "toolResult" } },
        { type: "usage", usage: usage(7, 3, 0.02) },
        { type: "compaction", usage: usage(40, 10, 0.2) },
        { type: "branch_summary", usage: usage(1, 1, 0.01) },
        { type: "custom", data: { usage: usage(999, 999, 99) } },
      ]),
    ).toEqual({
      input: 158,
      output: 39,
      cacheRead: 1000,
      cacheWrite: 50,
      cost: expect.closeTo(0.83, 10),
    });
  });

  it("ignores malformed usage", () => {
    expect(
      sessionUsage([
        null,
        { type: "message", message: { role: "assistant", usage: { input: "x", cost: null } } },
        { type: "message", message: { role: "assistant", usage: { input: -5, output: NaN } } },
      ]),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });
});

describe("UsageCache", () => {
  /** A history whose revision the test moves by hand, as Pi's leaf moves on append. */
  function history(sessionId = "a") {
    const entries: unknown[] = [{ type: "usage", usage: usage(1, 1, 0) }];
    let leaf = "1";
    const manager = {
      getSessionId: () => sessionId,
      getLeafId: () => leaf,
      getEntries: vi.fn(() => entries),
    };
    return {
      manager,
      /** Adds an entry without moving the leaf, so only `invalidate` can reveal it. */
      sneak: (entry: unknown) => entries.push(entry),
      append: (entry: unknown) => {
        entries.push(entry);
        leaf = String(entries.length);
      },
    };
  }

  it("scans history once until it changes", () => {
    const cache = new UsageCache();
    const h = history();
    expect(cache.totals(h.manager).input).toBe(1);
    expect(cache.totals(h.manager).input).toBe(1);
    expect(h.manager.getEntries).toHaveBeenCalledOnce();
    h.append({ type: "usage", usage: usage(2, 2, 0) });
    expect(cache.totals(h.manager).input).toBe(3);
    expect(h.manager.getEntries).toHaveBeenCalledTimes(2);
  });

  it("scans again after invalidation", () => {
    const cache = new UsageCache();
    const h = history();
    cache.totals(h.manager);
    h.sneak({ type: "usage", usage: usage(2, 2, 0) });
    expect(cache.totals(h.manager).input).toBe(1);
    cache.invalidate();
    expect(cache.totals(h.manager).input).toBe(3);
  });

  it("uses the entry count when the session manager offers it", () => {
    const cache = new UsageCache();
    const h = history();
    let count = 1;
    const manager = { ...h.manager, getEntryCount: () => count };
    cache.totals(manager);
    h.sneak({ type: "usage", usage: usage(2, 2, 0) });
    count = 2;
    expect(cache.totals(manager).input).toBe(3);
  });

  it("rebuilds for another session, and hands out copies", () => {
    const cache = new UsageCache();
    const totals = cache.totals(history("a").manager);
    totals.input = 99;
    expect(cache.totals(history("a").manager).input).toBe(1);
    const other = history("b");
    other.append({ type: "usage", usage: usage(5, 5, 0) });
    expect(cache.totals(other.manager).input).toBe(6);
  });
});
