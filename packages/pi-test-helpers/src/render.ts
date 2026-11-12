/**
 * Assertions for terminal rendering (vitest only), following the spacing rule
 * in AGENTS.md: body rows keep a space at both edges, nothing exceeds the
 * width, and rows too narrow for padding plus content render blank.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect } from "vitest";
import { stripAnsi } from "#src/theme";

/** Double-width CJK and an emoji: width math must count columns, not code units. */
export const WIDE_TEXT = "検索結果😀データ";

/** Widths from nothing to a normal terminal, including every padding edge case. */
export const NARROW_WIDTHS = [0, 1, 2, 3, 4, 5, 8, 13, 21, 40, 80] as const;

/** Every line fits `width` columns (and `height` rows, when given) and holds no line break. */
export function expectBounded(lines: readonly string[], width: number, height?: number): void {
  if (height !== undefined) expect(lines.length).toBeLessThanOrEqual(height);
  for (const line of lines) {
    expect(line).not.toMatch(/[\r\n\v\f\u2028\u2029]/);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}

/** A body row keeps one space at each edge, or is blank when too narrow for both. */
export function expectPadded(row: string, width: number): void {
  expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  const text = stripAnsi(row);
  if (width <= 2) expect(text.trim()).toBe("");
  else if (text.trim()) {
    expect(text.startsWith(" ")).toBe(true);
    expect(text.endsWith(" ")).toBe(true);
  }
}
