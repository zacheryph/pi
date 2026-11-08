import { KeybindingsManager, TUI_KEYBINDINGS, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { sanitizeText } from "../src/text.ts";
import type { UISurface, UITheme } from "../src/types.ts";
import { ansiTheme } from "../../pi-test-helpers/src/theme.ts";

export { expectBounded as bounded } from "../../pi-test-helpers/src/render.ts";
export { flushMicrotasks as flush } from "../../pi-test-helpers/src/wait.ts";

export const theme: UITheme = ansiTheme;
export const keys = () => new KeybindingsManager(TUI_KEYBINDINGS);
export const plain = (lines: readonly string[]) => lines.map(sanitizeText).join("\n");
export function surface(rows = 30) {
  return { terminal: { rows, columns: 80 }, requestRender: vi.fn() } satisfies UISurface;
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
