import { describe, expect, it } from "vitest";
import { expectBounded, expectPadded, NARROW_WIDTHS, WIDE_TEXT } from "#src/render.ts";

describe("render assertions", () => {
  it("accept padded rows and blank rows too narrow for padding", () => {
    expectPadded(" ok ", 4);
    for (const width of NARROW_WIDTHS.filter((w) => w <= 2)) expectPadded(" ".repeat(width), width);
    expectBounded([WIDE_TEXT], 16, 1);
  });

  it("reject rows touching an edge, too wide, or holding line breaks", () => {
    expect(() => expectPadded("ok ", 3)).toThrow();
    expect(() => expectBounded([WIDE_TEXT], 15)).toThrow();
    expect(() => expectBounded(["a\nb"], 10)).toThrow();
  });
});
