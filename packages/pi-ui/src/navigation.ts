import { matchesKey } from "@earendil-works/pi-tui";
import type { UIKeys } from "./types.ts";

/** The same bindings drive both interaction and footer hints. */
export function navigationDelta(data: string, keys: UIKeys, page: number): number | undefined {
  if (matchesKey(data, "up") || keys.matches(data, "tui.altScreen.lineUp")) return -1;
  if (matchesKey(data, "down") || keys.matches(data, "tui.altScreen.lineDown")) return 1;
  if (keys.matches(data, "tui.altScreen.pageUp")) return -Math.max(1, page);
  if (keys.matches(data, "tui.altScreen.pageDown")) return Math.max(1, page);
  if (matchesKey(data, "home") || keys.matches(data, "tui.altScreen.top")) return -Infinity;
  if (matchesKey(data, "end") || keys.matches(data, "tui.altScreen.bottom")) return Infinity;
  return undefined;
}

export function navigationHints(keys: UIKeys): string {
  const names = [
    "tui.altScreen.pageUp",
    "tui.altScreen.pageDown",
    "tui.altScreen.top",
    "tui.altScreen.bottom",
  ] as const;
  return ["↑↓", ...names.flatMap((name) => keys.getKeys(name).slice(0, 1)), "Home/End"].join(" · ");
}
