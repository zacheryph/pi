import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { UIKeys } from "#src/types";
import type { Hint } from "#surface";

export type { Hint } from "#surface";

/** Shared priorities so every view drops hints in the same order. */
export const HINT_PRIORITY = { action: 0, view: 1, extension: 2, navigation: 3 } as const;

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

const KEY_NAMES: Record<string, string> = {
  pageup: "PgUp",
  pagedown: "PgDn",
  escape: "Esc",
  enter: "Enter",
  return: "Enter",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/** One display format for every key id: `ctrl+pageUp` → `Ctrl+PgUp`. */
export function formatKey(id: string): string {
  return id
    .split("+")
    .map(
      (part) =>
        KEY_NAMES[part.toLowerCase()] ??
        (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)),
    )
    .join("+");
}

/**
 * Movement hint from the user's page bindings. Arrows and Home/End are always
 * shown; alternate-screen line/top/bottom bindings still work but are not listed.
 */
export function navigationHint(keys: UIKeys): Hint {
  const page = (["tui.altScreen.pageUp", "tui.altScreen.pageDown"] as const)
    .flatMap((name) => keys.getKeys(name).slice(0, 1))
    .map(formatKey)
    .join("/");
  return {
    keys: ["↑↓", page, "Home/End"].filter(Boolean).join(" "),
    priority: HINT_PRIORITY.navigation,
  };
}

export function hintText(hint: Hint): string {
  return hint.action ? `${hint.keys} ${hint.action}` : hint.keys;
}

function pack(hints: readonly Hint[], width: number): string[] {
  const rows: string[] = [];
  for (const text of hints.map(hintText)) {
    const last = rows.at(-1);
    if (last !== undefined && visibleWidth(last) + 3 + visibleWidth(text) <= width)
      rows[rows.length - 1] = `${last} · ${text}`;
    else rows.push(text);
  }
  return rows;
}

/**
 * Plain hint rows in caller order, wrapped between hints (never inside one).
 * Least important hints are dropped until the rows fit `maxRows`.
 */
export function layoutHints(hints: readonly Hint[], width: number, maxRows: number): string[] {
  if (maxRows <= 0) return [];
  const kept = [...hints];
  for (;;) {
    const rows = pack(kept, Math.max(1, width));
    if (rows.length <= maxRows) return rows;
    let drop = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      const priority = kept[i].priority ?? HINT_PRIORITY.extension;
      if (priority > 0 && (drop < 0 || priority > (kept[drop].priority ?? HINT_PRIORITY.extension)))
        drop = i;
    }
    if (drop < 0) return rows.slice(0, maxRows);
    kept.splice(drop, 1);
  }
}
