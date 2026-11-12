import { describe, expect, it } from "vitest";
import { firstPhysicalLine, sanitizeLine, sanitizeText } from "#src/text";

const intros = [
  "\x1b]",
  "\x1bP",
  "\x1bX",
  "\x1b^",
  "\x1b_",
  "\x90",
  "\x98",
  "\x9d",
  "\x9e",
  "\x9f",
];
describe("untrusted terminal text", () => {
  it.each(intros)(
    "removes complete and incomplete %j string commands, including their payload",
    (intro) => {
      for (const end of ["\x07", "\x1b\\", "\x9c"])
        expect(sanitizeText(`before${intro}52;c;clipboard${end}after`)).toBe("beforeafter");
      expect(sanitizeText(`before${intro}title\nrest of payload`)).toBe("before");
    },
  );
  it("preserves visible hyperlink labels and strips CSI/C1/ESC commands", () => {
    expect(
      sanitizeText(
        "\x1b]8;;https://example.test\x07link\x1b]8;;\x07 \x1b[31mred\x1b[0m\x9b2J\x1b7",
      ),
    ).toBe("link red");
  });
  it("normalizes all line separators and tabs, drops unsafe and directional controls, preserves Unicode", () => {
    const text = "界é👨‍👩‍👧‍👦\r\nx\ry\u2028z\u2029w\t!\x00\x0b\x0c\x7f\u061c\u200e\u200f\u202e\u2066";
    expect(sanitizeText(text)).toBe("界é👨‍👩‍👧‍👦\nx\ny\nz\nw    !");
    expect(sanitizeLine(text)).toBe("界é👨‍👩‍👧‍👦 x y z w    !");
  });
  it("keeps trusted ANSI and cursor commands when clipping physical rows", () => {
    expect(firstPhysicalLine("\x1b[31mtrusted\x1b[0m\nrest")).toBe("\x1b[31mtrusted\x1b[0m");
    for (const separator of ["\r", "\n", "\v", "\f", "\u2028", "\u2029"])
      expect(firstPhysicalLine(`a${separator}b`)).toBe("a");
  });
});
