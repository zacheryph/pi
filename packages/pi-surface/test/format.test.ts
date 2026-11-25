import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { formatBytes, formatCount, formatSummaryCount } from "#src/index";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [887, "887 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [1536, "1.5 KiB"],
    [12_698, "12.4 KiB"],
    // Just under a unit: 1023.95 KiB would round to 1024.0 KiB, so it reads as the next unit.
    [1024 * 1024 - 51, "1.0 MiB"],
    [1024 * 1024 - 52, "1023.9 KiB"],
    [1024 ** 2, "1.0 MiB"],
    [15 * 1024 ** 2, "15.0 MiB"],
    [50 * 1024 ** 2, "50.0 MiB"],
    [1024 ** 3 - 1, "1.0 GiB"],
    [1024 ** 3, "1.0 GiB"],
    [3 * 1024 ** 3, "3.0 GiB"],
    [2 * 1024 ** 4, "2.0 TiB"],
    // Past the largest unit the number grows instead.
    [2048 * 1024 ** 5, "2048.0 PiB"],
  ] as const)("%s bytes reads %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it("rounds a fractional byte count below 1 KiB", () => {
    expect(formatBytes(887.4)).toBe("887 B");
  });
});

describe("formatCount", () => {
  it.each([
    [0, "0"],
    [1, "1"],
    [2.5, "2.5"],
    [0.125, "0.13"],
    [887, "887"],
    [9999, "9999"],
    [10_000, "10k"],
    [12_499, "12k"],
    [999_499, "999k"],
    // 999.5k would round to 1000k, so it reads in millions.
    [999_500, "1M"],
    [1_073_741_824, "1073.7M"],
    [1_250_000, "1.3M"],
  ] as const)("%s reads %s", (value, text) => {
    expect(formatCount(value)).toBe(text);
  });
});

describe("formatSummaryCount", () => {
  it("puts the producer's label after the value, never inflecting it", () => {
    expect(formatSummaryCount({ label: "worktrees", value: 0 })).toBe("0 worktrees");
    expect(formatSummaryCount({ label: "worktree", value: 1 })).toBe("1 worktree");
    expect(formatSummaryCount({ label: "worktrees", value: 2 })).toBe("2 worktrees");
    expect(formatSummaryCount({ label: "running", value: 12_400 })).toBe("12k running");
    expect(formatSummaryCount({ label: "", value: 3 })).toBe("3");
  });

  it("formats a bytes count as a size", () => {
    expect(formatSummaryCount({ label: "in the store", value: 887, unit: "bytes" })).toBe(
      "887 B in the store",
    );
    expect(formatSummaryCount({ label: "on this branch", value: 12_698, unit: "bytes" })).toBe(
      "12.4 KiB on this branch",
    );
    expect(formatSummaryCount({ label: "store cap", value: 1024 ** 3, unit: "bytes" })).toBe(
      "1.0 GiB store cap",
    );
    expect(formatSummaryCount({ label: "", value: 0, unit: "bytes" })).toBe("0 B");
  });

  it("works from its source alone, as a page's inline script embeds it", () => {
    const context = createContext({});
    new Script([formatBytes, formatCount, formatSummaryCount].join("\n")).runInContext(context);
    const embedded = (code: string) => new Script(code).runInContext(context) as unknown;
    expect(embedded('formatSummaryCount({ label: "entry", value: 1 })')).toBe("1 entry");
    expect(
      embedded('formatSummaryCount({ label: "in the store", value: 887, unit: "bytes" })'),
    ).toBe("887 B in the store");
    expect(
      embedded("formatSummaryCount({ label: 'store cap', value: 1073741824, unit: 'bytes' })"),
    ).toBe("1.0 GiB store cap");
  });
});
