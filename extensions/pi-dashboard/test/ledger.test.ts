import { describe, expect, it } from "vitest";
import { memoryStats } from "#src/memory";
import { sessionUsage } from "#src/usage";

const usage = (input: number, output: number, cost: number, cacheRead = 0, cacheWrite = 0) =>
  ({ input, output, cacheRead, cacheWrite, totalTokens: input + output, cost: { total: cost } });

describe("sessionUsage", () => {
  it("adds assistant, tool-result, usage, summary and compaction usage like /session", () => {
    expect(sessionUsage([
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", usage: usage(100, 20, 0.5, 1000, 50) } },
      { type: "message", message: { role: "toolResult", usage: usage(10, 5, 0.1) } },
      { type: "message", message: { role: "toolResult" } },
      { type: "usage", usage: usage(7, 3, 0.02) },
      { type: "compaction", usage: usage(40, 10, 0.2) },
      { type: "branch_summary", usage: usage(1, 1, 0.01) },
      { type: "custom", data: { usage: usage(999, 999, 99) } },
    ])).toEqual({ input: 158, output: 39, cacheRead: 1000, cacheWrite: 50, cost: expect.closeTo(0.83, 10) });
  });

  it("ignores malformed usage", () => {
    expect(sessionUsage([null, { type: "message", message: { role: "assistant", usage: { input: "x", cost: null } } }]))
      .toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });
});

const observation = (id: string, tokenCount = 10) => ({ id, content: "fact", timestamp: "t", relevance: "high", sourceEntryIds: ["e"], tokenCount });

describe("memoryStats", () => {
  it("counts compactions and omits blackhole without its entries", () => {
    expect(memoryStats([
      { type: "compaction", timestamp: "2026-10-30T01:00:00.000Z" },
      { type: "message" },
      { type: "compaction", timestamp: "2026-10-30T02:00:00.000Z" },
    ])).toEqual({ compactions: 2, lastCompactionAt: Date.parse("2026-10-30T02:00:00.000Z") });
    expect(memoryStats([])).toEqual({ compactions: 0 });
  });

  it("folds pi-blackhole's ledger: observations, drops, reflections and kept tokens", () => {
    expect(memoryStats([
      { type: "custom", customType: "om.observations.recorded", data: { observations: [observation("a1", 30), observation("b2", 20)], coversUpToId: "x" } },
      { type: "custom", customType: "om.observations.unanchored", data: { observations: [observation("c3", 5), observation("a1", 30)] } },
      { type: "custom", customType: "om.observations.dropped", data: { observationIds: ["b2", "zz"], coversUpToId: "y" } },
      { type: "custom", customType: "om.reflections.recorded", data: { reflections: [{ id: "r1" }, { id: "r1" }, { id: "r2" }] } },
      { type: "custom", customType: "om.observations.recorded", data: { observations: "broken" } },
      { type: "compaction", timestamp: "not a date" },
    ])).toEqual({ compactions: 1, blackhole: { observations: 3, kept: 2, keptTokens: 35, dropped: 1, reflections: 2 } });
  });
});
