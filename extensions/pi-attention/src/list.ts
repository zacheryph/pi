import {
  matchesKey,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { plural } from "#foundations/format";
import {
  cells,
  clip,
  fitPanelHeight,
  footerRows,
  HINT_PRIORITY,
  ICONS,
  layoutPanel,
  navigationDelta,
  navigationHint,
  paint,
  renderPanel,
  splitColumns,
  styleLine,
  viewHeight,
  type Hint,
  type UIKeys,
  type UISurface,
  type UITheme,
} from "#ui";
import type { AttentionList, AttentionRow } from "#surface";
import {
  detailText,
  EMPTY_TEXT,
  failedText,
  LIST_TITLE,
  moreText,
  READY_ICON,
  STALE_ICON,
  stateLabel,
} from "#src/rows";

export interface AttentionViewOptions {
  tui: UISurface;
  theme: UITheme;
  keys: UIKeys;
  list: AttentionList;
  /** Enter on a row that has a link or an `open` action; the view closes first. */
  onOpen: (row: AttentionRow) => void;
  /** `d` on a row with a `dismiss` action; the view stays open and updates when the producer does. */
  onDismiss: (row: AttentionRow) => void;
  /** Called once, when the view closes. */
  done: () => void;
  now?: () => number;
}

/** A row Enter can act on: it has a link to open or an action that opens it in the session. */
export const canOpen = (row: AttentionRow | undefined): row is AttentionRow =>
  Boolean(row && (row.link || row.open));

/** Cells before a row's title: the selection pointer, a space, the diamond and a space. */
const LEAD = 4;

/**
 * The `/attention` overlay: one block per owed row (title and state, then its
 * reason and age), a blank row between blocks, inside pi-ui's padded panel.
 * The list follows the producers while it is open: `setList` keeps the
 * selection on the same row when it is still there.
 */
export class AttentionView implements Component, Focusable {
  focused = false;
  private list: AttentionList;
  private selected = 0;
  private offset = 0;
  private width: number;
  private closed = false;

  constructor(private readonly options: AttentionViewOptions) {
    this.list = options.list;
    this.width = cells(options.tui.terminal.columns);
  }

  /** The row under the pointer, if any. */
  get current(): AttentionRow | undefined {
    return this.list.rows[this.selected];
  }

  /** Replace the rows, keeping the selection on the same key where it still exists. */
  setList(list: AttentionList): void {
    if (this.closed) return;
    const key = this.current?.key;
    this.list = list;
    const index = list.rows.findIndex((row) => row.key === key);
    this.selected = Math.max(0, Math.min(index >= 0 ? index : this.selected, list.rows.length - 1));
    this.options.tui.requestRender();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private hints(): Hint[] {
    const row = this.current;
    return [
      ...(canOpen(row) ? [{ keys: "Enter", action: "open", priority: HINT_PRIORITY.action }] : []),
      ...(row?.dismiss ? [{ keys: "d", action: "dismiss", priority: HINT_PRIORITY.action }] : []),
      { keys: "Esc", action: "close", priority: HINT_PRIORITY.action },
      navigationHint(this.options.keys),
    ];
  }

  private status(): string {
    const count = this.list.rows.length;
    const parts = [
      `${count ? this.selected + 1 : 0}/${count} ${plural(count, "item")}`,
      moreText(this.list),
    ];
    return parts.filter(Boolean).join(" · ");
  }

  private chrome(contentWidth: number) {
    const { theme } = this.options;
    const failed = failedText(this.list);
    return {
      before: failed ? [paint(theme, "warning", failed)] : [],
      after: footerRows(this.status(), this.hints(), contentWidth, theme),
    };
  }

  /** Each row's block, with where it starts in the body. */
  private blocks(contentWidth: number): { lines: string[]; starts: number[] } {
    const { theme } = this.options;
    const now = this.now();
    const lines: string[] = [];
    const starts: number[] = [];
    this.list.rows.forEach((row, index) => {
      if (index) lines.push("");
      starts.push(lines.length);
      const selected = index === this.selected;
      const stale = row.state === "stale";
      const pointer = selected ? paint(theme, "accent", ICONS.selected) + " " : "  ";
      const icon = stale ? paint(theme, "dim", STALE_ICON) : paint(theme, "warning", READY_ICON);
      const title = styleLine(
        row.title,
        theme,
        selected ? { tone: "accent" } : stale ? { tone: "muted" } : {},
      );
      const badge = paint(theme, stale ? "dim" : "warning", stateLabel(row));
      lines.push(
        splitColumns(`${pointer}${icon} ${title}`, badge, contentWidth, {
          minLeftWidth: Math.min(12, contentWidth),
        }),
      );
      const detail = detailText(row, now);
      if (detail)
        lines.push(
          contentWidth > LEAD
            ? " ".repeat(LEAD) + clip(paint(theme, "muted", detail), contentWidth - LEAD)
            : "",
        );
    });
    return { lines, starts };
  }

  private layout() {
    const cap = viewHeight(this.options.tui.terminal.rows);
    const { contentWidth } = layoutPanel(this.width, cap);
    const { before, after } = this.chrome(contentWidth);
    const { lines, starts } = this.blocks(contentWidth);
    const height = fitPanelHeight(this.width, cap, lines.length, before.length, after.length);
    const layout = layoutPanel(this.width, height, before.length, after.length);
    return { layout, before, after, lines, starts };
  }

  private move(delta: number): void {
    if (Number.isNaN(delta) || !this.list.rows.length) return;
    this.selected = Math.max(
      0,
      Math.min(this.list.rows.length - 1, Math.trunc(this.selected + delta)),
    );
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    // A page moves by the rows a block takes: a title, a detail line and the gap.
    const page = Math.max(1, Math.floor(this.layout().layout.bodyRows / 3));
    const delta = navigationDelta(data, this.options.keys, page);
    const row = this.current;
    if (delta !== undefined) this.move(delta);
    else if (matchesKey(data, "enter")) {
      if (canOpen(row)) {
        this.close();
        this.options.onOpen(row);
        return;
      }
    } else if (data === "d" && row?.dismiss) this.options.onDismiss(row);
    this.options.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || event.type !== "wheel") return undefined;
    this.move(event.wheelDelta ?? 0);
    this.options.tui.requestRender();
    return { handled: true };
  }

  render(width: number): string[] {
    if (this.closed) return [];
    this.width = cells(width);
    const { theme } = this.options;
    const { layout, before, after, lines, starts } = this.layout();
    const rows = layout.bodyRows;
    let body: string[];
    if (!this.list.rows.length) body = [paint(theme, "muted", EMPTY_TEXT)];
    else {
      // Scroll just enough to show the whole selected block.
      const start = starts[this.selected] ?? 0;
      const end = (starts[this.selected + 1] ?? lines.length + 1) - 1;
      if (start < this.offset) this.offset = start;
      if (end > this.offset + rows) this.offset = Math.min(start, end - rows);
      this.offset = Math.max(0, Math.min(this.offset, lines.length - rows));
      body = lines.slice(this.offset, this.offset + rows);
    }
    return renderPanel(layout, LIST_TITLE, body, theme, { before, after });
  }

  invalidate(): void {}

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done();
  }

  dispose(): void {
    this.closed = true;
  }
}
