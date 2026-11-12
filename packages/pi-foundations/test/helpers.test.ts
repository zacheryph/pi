import { describe, expect, it } from "vitest";
import { errorText } from "#src/errors";
import { isRecord } from "#src/guards";
import { formatBytes, formatDuration, oneLine, plural } from "#src/format";

describe("plain-data helpers", () => {
  it("rejects arrays even when they have record-like properties", () => {
    for (const value of [
      null,
      undefined,
      true,
      0,
      "x",
      Symbol("x"),
      [],
      Object.assign([], { key: "a" }),
    ])
      expect(isRecord(value)).toBe(false);
    for (const value of [{}, { key: "a" }, Object.create(null), new Date(0)])
      expect(isRecord(value)).toBe(true);
  });

  it("keeps Error messages and stringifies other thrown values without sanitizing", () => {
    expect(errorText(new Error("broken\n\u001b[31mred"))).toBe("broken\n\u001b[31mred");
    expect(errorText("reason")).toBe("reason");
    expect(errorText(undefined)).toBe("undefined");
    expect(errorText(null)).toBe("null");
    expect(errorText(42)).toBe("42");
    expect(errorText({ toString: () => "custom reason" })).toBe("custom reason");
  });

  it("flattens whitespace without an implicit cap or terminal sanitization", () => {
    expect(oneLine("  one\r\n\ttwo\u2028three  ")).toBe("one two three");
    expect(oneLine("x".repeat(200))).toHaveLength(200);
    expect(oneLine("\u001b[31mx\u001b[0m")).toBe("\u001b[31mx\u001b[0m");
    expect(oneLine("   ")).toBe("");
  });

  it.each([
    ["abc", 3, "abc"],
    ["abcd", 3, "ab…"],
    ["abc", 1, "…"],
    ["x", 1, "x"],
    ["abc", 0, ""],
    ["abc", -1, ""],
    ["  a   b ", 3, "a b"],
  ] as const)("caps %s at %s including its ellipsis", (text, max, result) => {
    expect(oneLine(text, max)).toBe(result);
  });

  it.each([
    [0, "0 B", "0 bytes"],
    [10, "10 B", "10 bytes"],
    [1023, "1023 B", "1023 bytes"],
    [1024, "1.0 KB", "1 KB"],
    [2048, "2.0 KB", "2 KB"],
    [1536, "1.5 KB", "2 KB"],
    [10240, "10 KB", "10 KB"],
    [1024 ** 2, "1.0 MB", "1 MB"],
    [15 * 1024 ** 2, "15 MB", "15 MB"],
    [3 * 1024 ** 3, "3.0 GB", "3072 MB"],
  ] as const)("preserves display and log policies at %s bytes", (bytes, display, log) => {
    expect(formatBytes(bytes)).toBe(display);
    expect(formatBytes(bytes, "log")).toBe(log);
  });

  it.each([
    [-1000, "0s"],
    [0, "0s"],
    [499, "0s"],
    [500, "1s"],
    [59499, "59s"],
    [59500, "1m 0s"],
    [61000, "1m 1s"],
    [3600000, "1h 0m"],
    [3660000, "1h 1m"],
  ] as const)("keeps compact rounding at %s ms", (ms, result) => {
    expect(formatDuration(ms)).toBe(result);
  });

  it("keeps decimal agent seconds separate from compact job durations", () => {
    expect(formatDuration(1250, "seconds")).toBe("1.3s");
    expect(formatDuration(-1000, "seconds")).toBe("-1.0s");
    expect(formatDuration(61000, "seconds")).toBe("61.0s");
  });

  it("returns words without prefixes and supports irregular plurals", () => {
    expect(plural(0, "task")).toBe("tasks");
    expect(plural(1, "task")).toBe("task");
    expect(plural(2, "task")).toBe("tasks");
    expect(plural(2, "entry", "entries")).toBe("entries");
    expect(plural(1, "entry", "entries")).toBe("entry");
  });
});
