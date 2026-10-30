import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { type StashRecord } from "../state.ts";
import { bodyRow, entryRow, formatBytes, previewRows } from "./render.ts";
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

const NOTHING: Component = { render: () => [], invalidate() {} };

/** Read-only list → detail modal. Owns no files or state beyond its snapshot. */
export class StashBrowser implements Component {
  private selected = 0;
  private detail: { record: StashRecord; lines: string[] } | undefined;
  private offset = 0;
  private closed = false;
  private width = 80;

  constructor(private readonly options: StashBrowserOptions) {}

  private height(): number {
    return Math.max(0, Math.floor(this.options.tui.terminal.rows * 0.8));
  }

  private framed(): boolean {
    return this.width >= 7 && this.height() >= (this.options.warning ? 4 : 3);
  }

  private contentWidth(): number {
    return Math.max(1, this.width - (this.framed() ? 6 : 2));
  }

  private bodyHeight(): number {
    return Math.max(0, this.height() - (this.framed() ? 2 : 0) - 1 - (this.options.warning && this.height() > 1 ? 1 : 0));
  }

  private detailLines(): string[] {
    if (!this.detail) return [];
    return this.detail.lines.flatMap((line) => wrapTextWithAnsi(line, this.contentWidth()));
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
      const max = Math.max(0, this.detailLines().length - page);
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
      let content: string[];
      try {
        const preview = this.options.load(record);
        content = previewRows(preview.lines.join("\n"), preview.lines.length);
        if (preview.note) content.push("", safeStashLine(preview.note));
      } catch (error) {
        content = [`Unable to read: ${safeStashLine(error instanceof Error ? error.message : String(error))}`];
      }
      this.detail = { record, lines: [
        `Name: ${safeStashLine(record.name)}`,
        `Hash: ${safeStashLine(record.hash)}`,
        `Description: ${record.description ? safeStashLine(record.description) : "—"}`,
        "", "Contents:", ...content,
      ] };
      this.offset = 0;
    }
    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    this.width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const height = this.height();
    if (!this.width || !height) return [];
    const { theme, entries } = this.options;
    const frame = this.framed();
    const body = this.bodyHeight();
    const contentWidth = this.contentWidth();
    const lines: string[] = [];
    const row = (text = "") => frame
      ? ` ${theme.fg("border", "│")}${bodyRow(text, this.width - 4)}${theme.fg("border", "│")} `
      : bodyRow(text, this.width);
    if (frame) {
      const title = this.detail ? `Stash / ${safeStashLine(this.detail.record.name)}` : "Stash";
      const label = truncateToWidth(` ${title} `, this.width - 4, "");
      const spare = this.width - 4 - visibleWidth(label);
      const left = Math.floor(spare / 2);
      lines.push(` ${theme.fg("border", `╭${"─".repeat(left)}`)}${theme.fg("accent", label)}${theme.fg("border", `${"─".repeat(spare - left)}╮`)} `);
    }
    if (this.options.warning && height > 1) lines.push(row(theme.fg("warning", safeStashLine(this.options.warning))));
    if (this.detail) {
      const content = this.detailLines();
      this.offset = Math.min(this.offset, Math.max(0, content.length - body));
      for (let i = 0; i < body; i++) lines.push(row(content[this.offset + i] ?? ""));
      const end = Math.min(content.length, this.offset + body);
      lines.push(row(theme.fg("dim", `${content.length ? this.offset + 1 : 0}–${end}/${content.length} · ↑↓ scroll · Esc back`)));
    } else {
      const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      const summary = `${entries.length} entries · ${formatBytes(total)}`;
      if (body > 1) lines.push(row(theme.fg("muted", summary)));
      const slots = Math.max(0, body - (body > 1 ? 1 : 0));
      this.selected = Math.max(0, Math.min(this.selected, entries.length - 1));
      const start = Math.max(0, Math.min(this.selected - Math.floor(slots / 2), entries.length - slots));
      for (let i = 0; i < slots; i++) {
        const record = entries[start + i];
        const text = record ? (start + i === this.selected ? theme.fg("accent", "→ ") : "  ")
          + entryRow(record, Math.max(0, contentWidth - 2), theme)
          : i === 0 && !entries.length ? theme.fg("muted", "No stash entries on this branch.") : "";
        lines.push(row(text));
      }
      lines.push(row(theme.fg("dim", "↑↓ select · Enter details · Esc close")));
    }
    if (frame) lines.push(` ${theme.fg("border", `╰${"─".repeat(this.width - 4)}╯`)} `);
    return lines.slice(0, height);
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
  // Pi's regular renderer cannot display overlays. Match /todo's mode probe.
  const mode = await ctx.ui.custom<TUI["mode"] | undefined>((tui, _theme, _keys, done) => {
    done(tui.mode);
    return NOTHING;
  });
  await ctx.ui.custom<void>((tui, theme, _keys, done) => new StashBrowser({
    tui, theme, entries: snapshot, load, warning, done: () => done(undefined),
  }), mode === "fullscreen"
    ? { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } }
    : { overlay: false });
}
