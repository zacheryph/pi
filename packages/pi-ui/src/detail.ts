import {
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { cells, layoutPanel, renderPanel, splitColumns } from "./layout.ts";
import { openModal, type ModalContext, type ModalOptions } from "./modal.ts";
import {
  HINT_PRIORITY,
  layoutHints,
  navigationDelta,
  navigationHint,
  type Hint,
} from "./navigation.ts";
import {
  clip,
  copyLine,
  paint,
  styleBadge,
  styleLine,
  type Badge,
  type Line,
  type Tone,
} from "./style.ts";
import { sanitizeLine, sanitizeText } from "./text.ts";
import type { Title, UIKeys, UISurface, UITheme } from "./types.ts";

/**
 * Structured detail content. All text is untrusted plain text; the library owns
 * styling, wrapping and spacing so every detail view reads the same way.
 */
export type Block =
  /** Section heading; a blank row precedes every heading but the first row. */
  | { heading: string }
  /** Aligned `label  value` rows; values wrap under themselves. */
  | { fields: readonly (readonly [label: string, value: Line])[] }
  /** Free text; newlines are kept and long lines wrap. */
  | { text: string; tone?: Tone }
  | { bullets: readonly string[] }
  /** Preformatted lines, e.g. a file preview; optionally numbered from `numbered`. */
  | { lines: readonly string[]; numbered?: boolean | number };
/** A plain string is shorthand for one text block. */
export type DetailContent = string | readonly Block[];
/** Low-level escape hatch for caller-owned views: trusted, already styled physical rows. */
export type RowRenderer = (width: number) => readonly string[];

const FOOTER_HINT_ROWS = 2;

export function copyContent(content: DetailContent): DetailContent {
  if (typeof content === "string") return content;
  return content.map((block): Block => {
    if ("fields" in block)
      return { fields: block.fields.map(([label, value]) => [label, copyLine(value)] as const) };
    if ("bullets" in block) return { bullets: [...block.bullets] };
    if ("lines" in block) return { ...block, lines: [...block.lines] };
    return { ...block };
  });
}

function wrap(text: string, width: number): string[] {
  return width > 0 ? wrapTextWithAnsi(text, width) : [];
}

/** First row at full width, continuation rows indented under `prefix`. */
function hanging(prefix: string, text: string, width: number): string[] {
  const indent = visibleWidth(prefix);
  if (width - indent < 1) return wrap(prefix + text, width);
  return wrap(text, width - indent).map((row, i) => (i ? " ".repeat(indent) : prefix) + row);
}

/** Render structured content to styled physical rows of at most `width` cells. */
export function renderBlocks(content: DetailContent, width: number, theme: UITheme): string[] {
  width = cells(width);
  if (!width) return [];
  const blocks: readonly Block[] = typeof content === "string" ? [{ text: content }] : content;
  const rows: string[] = [];
  for (const block of blocks) {
    if ("heading" in block) {
      if (rows.length) rows.push("");
      rows.push(clip(paint(theme, "accent", sanitizeLine(block.heading), true), width));
    } else if ("fields" in block) {
      const labels = block.fields.map(([label]) => sanitizeLine(label));
      const column = Math.max(0, ...labels.map(visibleWidth)) + 2;
      const stacked = column > width / 2;
      block.fields.forEach(([, value], i) => {
        const label = paint(theme, "dim", labels[i]);
        const styled = styleLine(value, theme);
        if (stacked) rows.push(clip(label, width), ...hanging("  ", styled, width));
        else
          rows.push(
            ...hanging(label + " ".repeat(column - visibleWidth(labels[i])), styled, width),
          );
      });
    } else if ("text" in block) {
      for (const line of sanitizeText(block.text).split("\n"))
        rows.push(...(line ? wrap(paint(theme, block.tone ?? "default", line), width) : [""]));
    } else if ("bullets" in block) {
      for (const item of block.bullets) rows.push(...hanging("• ", sanitizeLine(item), width));
    } else {
      const start = typeof block.numbered === "number" ? cells(block.numbered) : 1;
      const digits = String(start + Math.max(0, block.lines.length - 1)).length;
      block.lines.forEach((line, i) => {
        const text = sanitizeLine(line);
        const prefix = block.numbered
          ? paint(theme, "dim", String(start + i).padStart(digits)) + "  "
          : "";
        rows.push(...(text || prefix ? hanging(prefix, text, width) : [""]));
      });
    }
  }
  return rows;
}

/** Shared detail header: bold label with its badge right-aligned, then a blank row. */
export function renderDetail(
  content: DetailContent,
  width: number,
  theme: UITheme,
  header?: { label: Line; badge?: Badge },
): string[] {
  const body = renderBlocks(content, width, theme);
  if (!header || !cells(width)) return body;
  return [
    splitColumns(
      styleLine(header.label, theme, { bold: true }),
      styleBadge(header.badge, theme),
      width,
      {
        minLeftWidth: Math.min(8, cells(width)),
      },
    ),
    "",
    ...body,
  ];
}

/** Shared footer: a dim status row, then up to two rows of prioritized hints. */
export function footerRows(
  status: string,
  hints: readonly Hint[],
  width: number,
  theme: UITheme,
): string[] {
  return [status, ...layoutHints(hints, width, FOOTER_HINT_ROWS)].map((row) =>
    paint(theme, "dim", sanitizeLine(row)),
  );
}

/** Reusable scrolling model for detail panels, explorers and caller-owned passive views. */
export class TextViewport {
  private content: string | RowRenderer = "";
  private cached?: { width: number; lines: readonly string[] };
  private offset = 0;
  constructor(content: string | RowRenderer = "") {
    this.setContent(content);
  }
  /** Strings are untrusted plain text; renderers return trusted styled rows. */
  setContent(content: string | RowRenderer, reset = true): void {
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

export function positionText(position: { start: number; end: number; total: number }): string {
  return `${position.start}–${position.end}/${position.total} lines`;
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

function copyTitle(title: Title): Title {
  return typeof title === "string" ? title : { ...title };
}

export class DetailView implements Component, Focusable {
  focused = false;
  private readonly viewport = new TextViewport();
  private title: Title;
  private width: number;
  private closed = false;
  constructor(private readonly options: DetailViewOptions) {
    this.title = copyTitle(options.title);
    this.width = cells(options.tui.terminal.columns);
    this.show(options.content, true);
  }
  private show(content: DetailContent, reset: boolean): void {
    const snapshot = copyContent(content);
    this.viewport.setContent((width) => renderBlocks(snapshot, width, this.options.theme), reset);
  }
  /** Replace the content, e.g. loading → result/error. Ignored after closing. */
  setContent(content: DetailContent, reset = true): void {
    if (this.closed) return;
    this.show(content, reset);
    this.options.tui.requestRender();
  }
  setTitle(title: Title): void {
    if (this.closed) return;
    this.title = copyTitle(title);
    this.options.tui.requestRender();
  }
  private hints(): Hint[] {
    return [
      {
        keys: this.options.closeOnEnter ? "Enter/Esc" : "Esc",
        action: "close",
        priority: HINT_PRIORITY.action,
      },
      navigationHint(this.options.keys),
    ];
  }
  private geometry() {
    const height = viewHeight(this.options.tui.terminal.rows, this.options.heightFraction);
    const { contentWidth } = layoutPanel(this.width, height);
    // Footer height never depends on the status text, which is always one row.
    const after = footerRows("", this.hints(), contentWidth, this.options.theme);
    return { layout: layoutPanel(this.width, height, 0, after.length) };
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
    const { layout } = this.geometry(),
      delta = navigationDelta(data, this.options.keys, layout.bodyRows);
    if (delta !== undefined) {
      this.viewport.move(delta, layout.contentWidth, layout.bodyRows);
      this.options.tui.requestRender();
    }
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || event.type !== "wheel") return undefined;
    const { layout } = this.geometry();
    this.viewport.move(event.wheelDelta ?? 0, layout.contentWidth, layout.bodyRows);
    this.options.tui.requestRender();
    return { handled: true };
  }
  render(width: number): string[] {
    if (this.closed) return [];
    this.width = cells(width);
    const { layout } = this.geometry(),
      { theme } = this.options;
    const body = this.viewport.render(layout.contentWidth, layout.bodyRows);
    const position = this.viewport.position(layout.contentWidth, layout.bodyRows);
    const after = footerRows(positionText(position), this.hints(), layout.contentWidth, theme);
    return renderPanel(layout, this.title, body, theme, { after });
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

/** Static detail modal. For live content, construct `DetailView` through `openModal`. */
export async function showDetail(
  ctx: ModalContext,
  view: Pick<DetailViewOptions, "title" | "content" | "closeOnEnter" | "heightFraction">,
  options?: ModalOptions,
): Promise<void> {
  const snapshot = { ...view, title: copyTitle(view.title), content: copyContent(view.content) };
  await openModal<void>(
    ctx,
    (tui, theme, keys, done) =>
      new DetailView({ ...snapshot, tui, theme, keys, done: () => done(undefined) }),
    options,
  );
}
