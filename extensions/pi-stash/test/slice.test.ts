import { describe, expect, it } from "vitest";
import { clampMaxBytes, DEFAULT_GET_BYTES, HARD_MAX_BYTES, parseJsonPath, previewOf, sliceText } from "#src/slice";

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

describe("sliceText", () => {
  it("returns the numbered head by default", () => {
    const result = sliceText("a\nb\nc\n", {});
    expect(result).toMatchObject({ mode: "head", text: "1\ta\n2\tb\n3\tc", totalLines: 3, range: [1, 3], truncated: false });
  });

  it("reads inclusive line ranges and clamps the end", () => {
    expect(sliceText(numbered(10), { lines: [3, 4] })).toMatchObject({ text: "3\tline 3\n4\tline 4", range: [3, 4], truncated: false });
    expect(sliceText(numbered(10), { lines: [9, 50] })).toMatchObject({ range: [9, 10], truncated: false });
    expect(sliceText(numbered(3), { lines: [7, 9] })).toMatchObject({ text: expect.stringContaining("entry has 3 lines"), hint: "Valid range is [1, 3]" });
    expect(() => sliceText("a", { lines: [5, 2] })).toThrow(/1 <= start <= end/);
  });

  it("truncates at maxBytes and names the next range", () => {
    const result = sliceText(numbered(5000), { maxBytes: 1024 });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024);
    expect(result.truncated).toBe(true);
    const [, last] = result.range!;
    expect(result.next).toEqual([last + 1, last + last]);
    expect(result.hint).toBe(`truncated at line ${last} of 5000; next range is [${last + 1}, ${last + last}]`);
    const next = sliceText(numbered(5000), { lines: result.next, maxBytes: 1024 });
    expect(next.text.startsWith(`${last + 1}\tline ${last + 1}`)).toBe(true);
  });

  it("never exceeds the 50 KB / 2,000-line hard cap", () => {
    const result = sliceText(numbered(10_000), { maxBytes: 10_000_000 });
    expect(result.range).toEqual([1, 2000]);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(HARD_MAX_BYTES);
    expect(clampMaxBytes(undefined)).toBe(DEFAULT_GET_BYTES);
    expect(clampMaxBytes(1)).toBe(256);
  });

  it("clips a single oversized line instead of returning nothing, without splitting code points", () => {
    const result = sliceText("😀".repeat(1000), { maxBytes: 300 });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(300);
    expect(result.text).toMatch(/^1\t(😀)+ …\[line clipped\]$/);
    // The clipped line is incomplete, so the read is truncated even though it is the only line.
    expect(result).toMatchObject({ truncated: true, clipped: true, range: [1, 1] });
    expect(result.next).toBeUndefined();
    expect(result.hint).toBe(`line 1 clipped at 300 bytes; raise maxBytes (max ${HARD_MAX_BYTES}) or use jsonPath if the entry is JSON`);
  });

  it("reports a clipped line alongside the next range when more lines follow", () => {
    const result = sliceText(`${"x".repeat(1000)}\nshort\n`, { lines: [1, 2], maxBytes: 300 });
    expect(result).toMatchObject({ truncated: true, clipped: true, range: [1, 1], next: [2, 2] });
    expect(result.hint).toBe(`line 1 clipped at 300 bytes; raise maxBytes (max ${HARD_MAX_BYTES}) or use jsonPath if the entry is JSON; truncated at line 1 of 2; next range is [2, 2]`);
  });

  it("drops the raise-maxBytes advice once the hard cap is reached", () => {
    const result = sliceText("y".repeat(HARD_MAX_BYTES * 2), { maxBytes: HARD_MAX_BYTES });
    expect(result).toMatchObject({ truncated: true, clipped: true });
    expect(result.hint).toBe(`line 1 clipped at ${HARD_MAX_BYTES} bytes; use jsonPath if the entry is JSON`);
  });

  it("does not mark reads that fit as clipped", () => {
    const result = sliceText(numbered(3), {});
    expect(result.truncated).toBe(false);
    expect(result).not.toHaveProperty("clipped");
  });

  it("marks a clipped single grep match and a clipped one-line JSON value as truncated", () => {
    const grep = sliceText(`needle ${"z".repeat(1000)}`, { grep: { pattern: "needle" }, maxBytes: 300 });
    expect(grep).toMatchObject({ truncated: true, clipped: true, matches: 1, matchesShown: 1 });
    expect(grep.hint).toMatch(/^first matching line clipped at 300 bytes/);
    const json = sliceText(JSON.stringify({ blob: "q".repeat(1000) }), { jsonPath: "$.blob", maxBytes: 300 });
    expect(json).toMatchObject({ mode: "json", truncated: true, clipped: true });
    expect(json.hint).toMatch(/^value clipped at 300 bytes/);
  });

  it("greps with context, separators, and match markers", () => {
    const text = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"].join("\n");
    const result = sliceText(text, { grep: { pattern: "^(beta|zeta)$", context: 1 } });
    expect(result).toMatchObject({ mode: "grep", matches: 2, matchesShown: 2, truncated: false });
    expect(result.text).toBe("1-\talpha\n2:\tbeta\n3-\tgamma\n--\n5-\tepsilon\n6:\tzeta\n7-\teta");
    expect(sliceText(text, { grep: { pattern: "BETA", ignoreCase: true } }).text).toBe("2:\tbeta");
    expect(sliceText(text, { grep: { pattern: "nothing" } })).toMatchObject({ text: "(no matches)", matches: 0 });
  });

  it("merges overlapping grep context", () => {
    const result = sliceText("a\nx\nb\nx\nc", { grep: { pattern: "x", context: 1 } });
    expect(result.text).toBe("1-\ta\n2:\tx\n3-\tb\n4:\tx\n5-\tc");
  });

  it("truncates grep output on whole groups and hints at the next match", () => {
    const text = Array.from({ length: 400 }, (_, i) => `match ${i}`).join("\n");
    const result = sliceText(text, { grep: { pattern: "match" }, maxBytes: 300 });
    expect(result.truncated).toBe(true);
    expect(result.matches).toBe(400);
    expect(result.hint).toMatch(new RegExp(`showing ${result.matchesShown} of 400 matches; next match is at line ${result.matchesShown! + 1}`));
  });

  it("rejects invalid regular expressions", () => {
    expect(() => sliceText("a", { grep: { pattern: "(" } })).toThrow(/Invalid grep pattern/);
  });

  it("selects JSON values by path and rejects non-JSON entries", () => {
    const json = JSON.stringify({ items: [{ name: "a" }, { name: "b", "odd key": 1 }] });
    expect(sliceText(json, { jsonPath: "$.items[1].name" }).text).toBe('"b"');
    expect(sliceText(json, { jsonPath: "items[-1]['odd key']" }).text).toBe("1");
    expect(sliceText(json, { jsonPath: '$["items"][0]' })).toMatchObject({ mode: "json", text: '{\n  "name": "a"\n}' });
    expect(() => sliceText(json, { jsonPath: "$.missing" })).toThrow(/no key "missing"/);
    expect(() => sliceText(json, { jsonPath: "$.items[9]" })).toThrow(/does not match/);
    expect(() => sliceText("not json", { jsonPath: "$" })).toThrow(/not valid JSON/);
    expect(() => parseJsonPath("$..x")).toThrow(/Invalid jsonPath/);
  });

  it("truncates large JSON values", () => {
    const json = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ i })));
    const result = sliceText(json, { jsonPath: "$", maxBytes: 512 });
    expect(result.truncated).toBe(true);
    expect(result.hint).toMatch(/use a deeper jsonPath/);
  });

  it("allows at most one mode", () => {
    expect(() => sliceText("a", { lines: [1, 1], grep: { pattern: "a" } })).toThrow(/at most one/);
  });
});

describe("previewOf", () => {
  it("keeps short content whole and caps long content", () => {
    expect(previewOf("a\nb\n")).toBe("a\nb");
    expect(previewOf(numbered(50))).toBe(`${numbered(10).trimEnd()}\n… (50 lines total)`);
    expect(Buffer.byteLength(previewOf("x".repeat(5000)))).toBeLessThanOrEqual(1024 + 4);
  });
});
