import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { TldrResult } from "./core.js";

const NOTHING: Component = { render: () => [], invalidate() {} };
type ViewerContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;

/** Open the modal before the model request. Loading, results, and errors render in place. */
export async function showTldr(
  ctx: ViewerContext,
  load: (signal: AbortSignal) => Promise<TldrResult>,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("/tldr requires interactive terminal mode.", "warning");
    return;
  }
  const mode = await ctx.ui.custom<TUI["mode"] | undefined>((tui, _theme, _keys, done) => {
    done(tui.mode);
    return NOTHING;
  });
  const controller = new AbortController();
  try {
    await ctx.ui.custom<void>(
      (tui, theme, _keys, done) => {
        const viewer = new TldrViewer(tui, theme, () => {
          controller.abort();
          done(undefined);
        });
        // Yield to the TUI so the loading modal appears before the request starts.
        void Promise.resolve()
          .then(() => load(controller.signal))
          .then(
            (result) => {
              if (!controller.signal.aborted) viewer.setSummary(result);
            },
            (error) => {
              if (!controller.signal.aborted) viewer.setError(String(error));
            },
          );
        return viewer;
      },
      mode === "fullscreen"
        ? { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } }
        : { overlay: false },
    );
  } finally {
    controller.abort();
  }
}

export class TldrViewer implements Component, Focusable {
  focused = false;
  private offset = 0;
  private height = 8;
  private maxOffset = 0;
  private closed = false;
  private summary?: TldrResult;
  private error?: string;

  constructor(
    private readonly tui: Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows"> },
    private readonly theme: Pick<Theme, "fg" | "bold">,
    private readonly done: (value: undefined) => void,
  ) {}

  setSummary(summary: TldrResult): void {
    if (this.closed) return;
    this.summary = summary;
    this.error = undefined;
    this.offset = 0;
    this.tui.requestRender();
  }

  setError(message: string): void {
    if (this.closed) return;
    // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control sequences.
    this.error = message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 360);
    this.tui.requestRender();
  }

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
    // Framed rows need margin + border + pad on each side (6 cols) plus at least one content column.
    const framed = w >= 7 && maxH >= 7;
    const contentW = Math.max(1, w - (framed ? 6 : 2));
    const margin = framed ? " " : "";
    const row = (content: string): string => {
      // Unframed rows need a pad on each side plus one content column; otherwise render blank.
      if (!framed && w < 3) return " ".repeat(w);
      const text = truncateToWidth(content, contentW, "", true);
      if (framed)
        return `${margin}${theme.fg("border", "│")} ${text}${" ".repeat(Math.max(0, contentW - visibleWidth(text)))} ${theme.fg("border", "│")}${margin}`;
      return " " + text + " ".repeat(Math.max(0, w - visibleWidth(text) - 1));
    };
    const wrap = (text: string) => wrapTextWithAnsi(text, contentW);
    const findings = this.summary?.findings.split(/\s*;\s*/).filter(Boolean) ?? [];
    const inner = this.error
      ? [theme.fg("accent", theme.bold("Could not summarize")), ...wrap(this.error)]
      : this.summary
        ? [
            theme.fg("accent", theme.bold("Premise")),
            ...wrap(this.summary.premise),
            "",
            theme.fg("accent", theme.bold("Findings / turns")),
            ...findings.flatMap((item) => wrap(`• ${item}`)),
            "",
            theme.fg("accent", theme.bold("Current status")),
            ...wrap(this.summary.status),
          ]
        : [theme.fg("accent", "Summarizing session…")];
    this.height = Math.max(0, maxH - (framed ? 5 : 1));
    this.maxOffset = Math.max(0, inner.length - this.height);
    this.offset = Math.min(this.offset, this.maxOffset);
    const lines: string[] = [];
    if (framed) {
      const innerW = w - 4;
      const heading = truncateToWidth(
        ` TLDR · ${this.summary?.title || "session"} `,
        Math.max(1, innerW - 2),
        "",
      );
      lines.push(
        margin +
          theme.fg("border", "╭") +
          theme.fg("accent", theme.bold(heading)) +
          theme.fg("border", "─".repeat(Math.max(0, innerW - visibleWidth(heading))) + "╮") +
          margin,
      );
      lines.push(row(""));
    }
    for (const line of inner.slice(this.offset, this.offset + this.height)) lines.push(row(line));
    if (framed) {
      lines.push(row(""));
      lines.push(
        row(theme.fg("dim", this.maxOffset ? "↑↓ scroll · Enter/Esc close" : "Enter/Esc close")),
      );
      lines.push(margin + theme.fg("border", `╰${"─".repeat(w - 4)}╯`) + margin);
    } else {
      lines.push(row("Enter/Esc close"));
    }
    return lines;
  }

  invalidate(): void {}
  dispose(): void {
    this.closed = true;
  }
}
