import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { TldrResult } from "./core.js";

const NOTHING: Component = { render: () => [], invalidate() {} };
type ViewerContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;

/** Same mode policy as pi-system-insights: centered overlay only in fullscreen mode. */
export async function showTldr(ctx: ViewerContext, result: TldrResult): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("/tldr requires interactive terminal mode.", "warning");
    return;
  }
  const mode = await ctx.ui.custom<TUI["mode"] | undefined>((tui, _theme, _keys, done) => {
    done(tui.mode);
    return NOTHING;
  });
  await ctx.ui.custom<void>(
    (tui, theme, _keys, done) => new TldrViewer(tui, theme, done, result),
    mode === "fullscreen" ? { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } } : { overlay: false },
  );
}

export class TldrViewer implements Component, Focusable {
  focused = false;
  private offset = 0;
  private height = 8;
  private maxOffset = 0;
  private closed = false;

  constructor(
    private readonly tui: Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows"> },
    private readonly theme: Pick<Theme, "fg" | "bold">,
    private readonly done: (value: undefined) => void,
    private readonly summary: TldrResult,
  ) {}

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c")) {
      this.closed = true;
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) this.offset++;
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.offset--;
    if (matchesKey(data, "pageDown")) this.offset += this.height;
    if (matchesKey(data, "pageUp")) this.offset -= this.height;
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const { theme } = this;
    const w = Math.max(0, Math.floor(width));
    const maxH = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8));
    const framed = w >= 6 && maxH >= 7;
    const contentW = Math.max(1, w - (framed ? 6 : 0));
    const margin = framed ? " " : "";
    const row = (content: string): string => {
      const text = truncateToWidth(content, contentW, "", true);
      return framed ? `${margin}${theme.fg("border", "│")} ${text}${" ".repeat(Math.max(0, contentW - visibleWidth(text)))} ${theme.fg("border", "│")}${margin}`
        : truncateToWidth(text, w, "", true);
    };
    const inner = [
      theme.fg("accent", theme.bold("Premise")), ...wrapTextWithAnsi(this.summary.premise, contentW), "",
      theme.fg("accent", theme.bold("Findings / turns")), ...wrapTextWithAnsi(this.summary.findings, contentW), "",
      theme.fg("accent", theme.bold("Current status")), ...wrapTextWithAnsi(this.summary.status, contentW),
    ];
    this.height = Math.max(0, maxH - (framed ? 5 : 1));
    this.maxOffset = Math.max(0, inner.length - this.height);
    this.offset = Math.min(this.offset, this.maxOffset);
    const lines: string[] = [];
    if (framed) {
      const innerW = w - 4;
      const heading = truncateToWidth(` TLDR · ${this.summary.title || "session"} `, Math.max(1, innerW - 2), "");
      lines.push(margin + theme.fg("border", "╭") + theme.fg("accent", theme.bold(heading))
        + theme.fg("border", "─".repeat(Math.max(0, innerW - visibleWidth(heading))) + "╮") + margin);
      lines.push(row(""));
    }
    for (const line of inner.slice(this.offset, this.offset + this.height)) lines.push(row(line));
    if (framed) {
      lines.push(row(""));
      lines.push(row(theme.fg("dim", this.maxOffset ? "↑↓ scroll · Enter/Esc close" : "Enter/Esc close")));
      lines.push(margin + theme.fg("border", `╰${"─".repeat(w - 4)}╯`) + margin);
    } else {
      lines.push(row("Enter/Esc close"));
    }
    return lines;
  }

  invalidate(): void {}
  dispose(): void { this.closed = true; }
}
