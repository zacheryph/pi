import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { handleFor, type StashRecord } from "../state.ts";
import { bodyRow, entryRow, entrySummary, formatBytes, headerRule, previewRows } from "./render.ts";
import { safeStashLine } from "./text.ts";

export interface StashPreview {
  lines: string[];
  /** Shown after the lines, e.g. when the preview stops before the end. */
  note?: string;
}

export interface StashBrowserOptions {
  tui: Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows"> };
  theme: Pick<Theme, "fg">;
  entries: readonly StashRecord[];
  /** Loads an entry's leading lines; the caller bounds them. */
  load: (record: StashRecord) => StashPreview;
  /** Optional warning row, such as the store exceeding its size cap. */
  warning?: string;
  done: () => void;
}

/** Read-only list → numbered preview. Owns no files or state beyond its snapshot. */
export class StashBrowser implements Component {
  private selected = 0;
  private detail: { record: StashRecord; lines: string[] } | undefined;
  private offset = 0;
  private closed = false;

  constructor(private readonly options: StashBrowserOptions) {}

  private bodyHeight(): number {
    const rows = Math.max(4, Math.floor(this.options.tui.terminal.rows * 0.8));
    // Header, footer, optional warning.
    return Math.max(1, rows - 2 - (this.options.warning ? 1 : 0));
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const { entries } = this.options;
    const page = this.bodyHeight();
    if (matchesKey(data, "ctrl+c")) return this.close();
    if (matchesKey(data, "escape")) {
      if (!this.detail) return this.close();
      this.detail = undefined;
      this.offset = 0;
    } else if (this.detail) {
      const max = Math.max(0, this.detail.lines.length - page);
      const move = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1
        : matchesKey(data, "pageUp") ? -page : matchesKey(data, "pageDown") ? page
        : matchesKey(data, "home") ? -Infinity : matchesKey(data, "end") ? Infinity : 0;
      this.offset = Math.max(0, Math.min(max, this.offset + move));
    } else if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "down")) {
      this.selected = Math.min(entries.length - 1, this.selected + 1);
    } else if (matchesKey(data, "enter") && entries[this.selected]) {
      const record = entries[this.selected];
      let lines: string[];
      try {
        const preview = this.options.load(record);
        lines = previewRows(preview.lines.join("\n"), preview.lines.length);
        if (preview.note) lines.push("", safeStashLine(preview.note));
      } catch (error) {
        lines = [`Unable to read: ${error instanceof Error ? error.message : String(error)}`];
      }
      this.detail = { record, lines };
      this.offset = 0;
    }
    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    if (!width) return [];
    const { theme, entries } = this.options;
    const height = this.bodyHeight();
    const lines: string[] = [];
    const inner = Math.max(0, width - 2);
    if (this.detail) {
      const { record } = this.detail;
      lines.push(headerRule(safeStashLine(handleFor(record)), entrySummary(record), width, theme));
      if (this.options.warning) lines.push(bodyRow(theme.fg("warning", this.options.warning), width));
      const visible = this.detail.lines.slice(this.offset, this.offset + height);
      for (let i = 0; i < height; i++) lines.push(bodyRow(visible[i] ?? "", width));
      const end = Math.min(this.detail.lines.length, this.offset + height);
      lines.push(bodyRow(theme.fg("dim", `${this.detail.lines.length ? this.offset + 1 : 0}–${end}/${this.detail.lines.length} · ↑↓ scroll · Esc back`), width));
      return lines;
    }
    const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    lines.push(headerRule("Stash", `${entries.length} · ${formatBytes(total)}`, width, theme));
    if (this.options.warning) lines.push(bodyRow(theme.fg("warning", this.options.warning), width));
    if (!entries.length) {
      lines.push(bodyRow(theme.fg("muted", "No stash entries on this branch."), width));
    } else {
      this.selected = Math.max(0, Math.min(this.selected, entries.length - 1));
      const start = Math.max(0, Math.min(this.selected - Math.floor(height / 2), entries.length - height));
      for (const [i, record] of entries.slice(start, start + height).entries()) {
        const active = start + i === this.selected;
        const marker = active ? theme.fg("accent", "→ ") : "  ";
        lines.push(bodyRow(marker + entryRow(record, Math.max(0, inner - 2), theme), width));
      }
    }
    lines.push(bodyRow(theme.fg("dim", "↑↓ select · Enter preview · Esc close"), width));
    return lines;
  }

  invalidate(): void {}

  private close(): void {
    this.closed = true;
    this.options.done();
  }
}

export async function showStashBrowser(
  ctx: ExtensionContext,
  entries: readonly StashRecord[],
  load: (record: StashRecord) => StashPreview,
  warning?: string,
): Promise<void> {
  const snapshot = entries.map((entry) => ({ ...entry }));
  await ctx.ui.custom<void>((tui, theme, _keys, done) => new StashBrowser({
    tui, theme, entries: snapshot, load, warning, done: () => done(undefined),
  }));
}
