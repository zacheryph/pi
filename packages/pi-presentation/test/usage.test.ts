import { describe, expect, it } from "vitest";
import { sessionUsage } from "#src/usage";

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
      ]),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });
});
