import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";

export type UITheme = Pick<Theme, "fg" | "bold">;
export type UIColor = Parameters<Theme["fg"]>[0];
export type UIKeys = Pick<KeybindingsManager, "matches" | "getKeys">;
/** Fullscreen TUI collaborators. The library does not support Pi's regular renderer. */
export type UISurface = Pick<TUI, "requestRender"> & {
  terminal: Pick<TUI["terminal"], "rows" | "columns">;
};
export type DisposableComponent = Component & { dispose?(): void };
/** Plain text. `detail` renders as a breadcrumb: `icon  label / detail`. */
export type Title = string | { label: string; icon?: string; detail?: string };
