import { describe, expect, it } from "vitest";
import { customData, customEntries, readEntries } from "#src/index";

const custom = (customType: string, data: unknown) => ({ type: "custom", customType, data });

const entries = [
  null,
  "not an entry",
  { type: "message", message: { role: "user" } },
  custom("a", 1),
  custom("b", { ok: true }),
  { type: "custom_message", customType: "a", content: "not custom data" },
  custom("a", "two"),
  custom("c", 3),
  custom("a", 3),
];

const isNumber = (data: unknown): data is number => typeof data === "number";

describe("customEntries", () => {
  it("keeps custom entries of the given types in session order", () => {
    expect(customEntries(entries, ["a", "c"])).toEqual([
      { customType: "a", data: 1 },
      { customType: "a", data: "two" },
      { customType: "c", data: 3 },
      { customType: "a", data: 3 },
    ]);
    expect(customEntries(entries, "b")).toEqual([{ customType: "b", data: { ok: true } }]);
    expect(customEntries(entries, "missing")).toEqual([]);
  });
});

describe("customData", () => {
  it("returns data of one type, optionally narrowed by a guard", () => {
    expect(customData(entries, "a")).toEqual([1, "two", 3]);
    const numbers: number[] = customData(entries, "a", isNumber);
    expect(numbers).toEqual([1, 3]);
  });
});

describe("readEntries", () => {
  const branch = [custom("a", 1), custom("a", "two")];
  const ctx = {
    sessionManager: { getBranch: () => branch, getEntries: () => entries },
  };

  it("reads the current branch by default", () => {
    expect(readEntries(ctx, { type: "a" })).toEqual([1, "two"]);
    expect(readEntries(ctx, { type: "a", scope: "branch", guard: isNumber })).toEqual([1]);
  });

  it("reads every entry of the session with scope all", () => {
    expect(readEntries(ctx, { type: "a", scope: "all", guard: isNumber })).toEqual([1, 3]);
  });

  it("needs only getBranch for the branch and getEntries for all", () => {
    expect(readEntries({ sessionManager: { getBranch: () => branch } }, { type: "a" })).toEqual([
      1,
      "two",
    ]);
    expect(
      readEntries({ sessionManager: { getEntries: () => entries } }, { type: "c", scope: "all" }),
    ).toEqual([3]);
  });
});
