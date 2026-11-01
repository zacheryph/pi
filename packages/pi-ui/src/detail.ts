import {
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { cells, layoutPanel, renderPanel } from "./layout.ts";
import { openModal, type ModalContext, type ModalOptions } from "./modal.ts";
import { navigationDelta, navigationHints } from "./navigation.ts";
import { sanitizeLine, sanitizeText } from "./text.ts";
import type { Title, UIKeys, UISurface, UITheme } from "./types.ts";

/** Strings are untrusted plain text. A renderer returns trusted, already styled physical rows. */
export type DetailContent = string | ((width: number) => readonly string[]);

/** Reusable scrolling model for detail panels, explorers and caller-owned passive views. */
export class TextViewport {
  private content: DetailContent = "";
  private cached?: { width: number; lines: readonly string[] };
  private offset = 0;
  constructor(content: DetailContent = "") {
    this.setContent(content);
  }
  setContent(content: DetailContent, reset = true): void {
    this.content = typeof content === "string" ? sanitizeText(content) : content;
    this.invalidate();
    if (reset) this.offset = 0;
  }
  invalidate(): void {
    this.cached = undefined;
  }
  private lines(width: number): readonly string[] {
    width = cells(width);
    if (!width) return [];
    if (this.cached?.width !== width)
      this.cached = {
        width,
        lines:
          typeof this.content === "string"
            ? wrapTextWithAnsi(this.content, width)
            : [...this.content(width)],
      };
    return this.cached.lines;
  }
  private clamp(width: number, height: number): readonly string[] {
    const lines = this.lines(width);
    this.offset = Math.min(this.offset, Math.max(0, lines.length - Math.max(1, cells(height))));
    return lines;
  }
  move(delta: number, width: number, height: number): void {
    const lines = this.lines(width);
    if (Number.isNaN(delta)) return;
    this.offset = Math.max(
      0,
      Math.min(
        Math.max(0, lines.length - Math.max(1, cells(height))),
        this.offset + Math.trunc(delta),
      ),
    );
  }
  render(width: number, height: number): string[] {
    return this.clamp(width, height).slice(this.offset, this.offset + cells(height));
  }
  position(width: number, height: number): { start: number; end: number; total: number } {
    const lines = this.clamp(width, height);
    return {
      start: lines.length && cells(height) ? this.offset + 1 : 0,
      end: cells(height) ? Math.min(lines.length, this.offset + cells(height)) : 0,
      total: lines.length,
    };
  }
}

export interface DetailViewOptions {
  tui: UISurface;
  theme: UITheme;
  keys: UIKeys;
  title: Title;
  content: DetailContent;
  done: () => void;
  closeOnEnter?: boolean;
  heightFraction?: number;
}

export function viewHeight(rows: number, fraction = 0.8): number {
  const safe = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0.8;
  return cells(cells(rows) * safe);
}

export class DetailView implements Component, Focusable {
  focused = false;
  private readonly viewport: TextViewport;
  private readonly title: Title;
  private width: number;
  private closed = false;
  constructor(private readonly options: DetailViewOptions) {
    this.viewport = new TextViewport(options.content);
    this.title = typeof options.title === "string" ? options.title : { ...options.title };
    this.width = cells(options.tui.terminal.columns);
  }
  setContent(content: DetailContent, reset = true): void {
    if (!this.closed) {
      this.viewport.setContent(content, reset);
      this.options.tui.requestRender();
    }
  }
  private geometry() {
    return layoutPanel(
      this.width,
      viewHeight(this.options.tui.terminal.rows, this.options.heightFraction),
      0,
      2,
    );
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      (this.options.closeOnEnter && matchesKey(data, "enter"))
    ) {
      this.close();
      return;
    }
    const layout = this.geometry(),
      delta = navigationDelta(data, this.options.keys, layout.bodyRows);
    if (delta !== undefined) {
      this.viewport.move(delta, layout.contentWidth, layout.bodyRows);
      this.options.tui.requestRender();
    }
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || this.options.tui.mode !== "fullscreen" || event.type !== "wheel")
      return undefined;
    const layout = this.geometry();
    this.viewport.move(event.wheelDelta ?? 0, layout.contentWidth, layout.bodyRows);
    this.options.tui.requestRender();
    return { handled: true };
  }
  render(width: number): string[] {
    if (this.closed) return [];
    this.width = cells(width);
    const layout = this.geometry(),
      { theme, keys } = this.options;
    const position = this.viewport.position(layout.contentWidth, layout.bodyRows);
    const after = [
      this.options.closeOnEnter ? "Enter/Esc close · Ctrl+C close" : "Esc close · Ctrl+C close",
      `${position.start}–${position.end}/${position.total} · ${navigationHints(keys)}`,
    ].map((text) => theme.fg("dim", sanitizeLine(text)));
    return renderPanel(
      layout,
      this.title,
      this.viewport.render(layout.contentWidth, layout.bodyRows),
      theme,
      { after },
    );
  }
  invalidate(): void {
    this.viewport.invalidate();
  }
  private close(): void {
    if (!this.closed) {
      this.closed = true;
      this.options.done();
    }
  }
  dispose(): void {
    this.closed = true;
  }
}

/** Snapshot options before the mode probe; live content is updated through DetailView.setContent. */
export async function showDetail(
  ctx: ModalContext,
  view: Pick<DetailViewOptions, "title" | "content" | "closeOnEnter" | "heightFraction">,
  options?: ModalOptions,
): Promise<void> {
  const snapshot = {
    ...view,
    title: typeof view.title === "string" ? view.title : { ...view.title },
  };
  await openModal<void>(
    ctx,
    (tui, theme, keys, done) =>
      new DetailView({ ...snapshot, tui, theme, keys, done: () => done(undefined) }),
    options,
  );
}
