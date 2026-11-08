import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { expect, vi } from "vitest";
import { sanitizeText } from "../src/text.ts";
import type { UISurface, UITheme } from "../src/types.ts";

export const theme: UITheme = {
  fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
export { flushMicrotasks as flush } from "../../pi-test-helpers/src/wait.ts";
export const keys = () => new KeybindingsManager(TUI_KEYBINDINGS);
export const plain = (lines: readonly string[]) => lines.map(sanitizeText).join("\n");
export function surface(rows = 30) {
  return { terminal: { rows, columns: 80 }, requestRender: vi.fn() } satisfies UISurface;
}
export function bounded(lines: readonly string[], width: number, height: number) {
  expect(lines.length).toBeLessThanOrEqual(height);
  for (const line of lines) {
    expect(line).not.toMatch(/[\r\n\v\f\u2028\u2029]/);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}
export const wheel = (delta: number): TuiMouseEvent => ({
  type: "wheel",
  button: "none",
  x: 0,
  y: 0,
  screenX: 0,
  screenY: 0,
  width: 80,
  height: 30,
  shift: false,
  alt: false,
  ctrl: false,
  wheelDelta: delta,
});
