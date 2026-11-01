import type { Component } from "@earendil-works/pi-tui";
import { inlineWindowOpen } from "./inline-window.ts";
import { bodyRow, cells, labeledRule, splitColumns, titleText } from "./layout.ts";
import { copyLine, paint, styleLine, type Line } from "./style.ts";
import { sanitizeLine } from "./text.ts";
import type { Title, UITheme } from "./types.ts";

export interface WidgetRow {
  left: Line;
  /** Ordered right-column fallbacks; the first that fits is shown. */
  right?: readonly Line[];
  /** At narrow widths keep the last right fallback and clip the left instead. */
  keepRight?: boolean;
  /** Category counted in the overflow row: `+3 more (2 running, 1 finished)`. */
  group?: string;
}
export interface WidgetView {
  title: Title;
  /** Accent heading while active, dim while idle. Default true. */
  active?: boolean;
  /** Ordered fallbacks shown at the right of the heading rule; dropped before the title clips. */
  meta?: readonly Line[];
  rows: readonly WidgetRow[];
  /** Total rows including the heading. `Infinity` means unbounded. */
  maxRows: number;
  /** Body rows before overflow. `Infinity` or omitted means no limit. */
  maxVisible?: number;
  emptyText?: string;
  /**
   * Shown in Pi's widget area. While an inline window is open, a docked widget
   * shows only its heading so the window keeps its rows. Leave unset for tool
   * results and other views in the transcript.
   */
  docked?: boolean;
}

/** Row budgets: nonnegative integers, with `Infinity` meaning unbounded. */
function budget(value: number | undefined): number {
  return value === undefined || value === Infinity ? Infinity : cells(value);
}

/** Groups are listed in their order of first appearance across all rows. */
function overflowText(rows: readonly WidgetRow[], hidden: readonly WidgetRow[]): string {
  const groups = new Map<string, number>();
  for (const row of rows) if (row.group) groups.set(sanitizeLine(row.group), 0);
  for (const row of hidden)
    if (row.group) groups.set(sanitizeLine(row.group), groups.get(sanitizeLine(row.group))! + 1);
  const summary = [...groups]
    .filter(([, count]) => count > 0)
    .map(([group, count]) => `${count} ${group}`)
    .join(", ");
  return `+${hidden.length} more${summary ? ` (${summary})` : ""}`;
}

/** No sorting, timers, events, terminal reads, or task/agent lifecycle. */
export function renderWidget(view: WidgetView, width: number, theme: UITheme): string[] {
  width = cells(width);
  const rowsBudget =
    view.docked && inlineWindowOpen() ? Math.min(1, budget(view.maxRows)) : budget(view.maxRows);
  if (!width || !rowsBudget) return [];
  const tone = view.active === false ? "dim" : "accent";
  const heading = [
    paint(theme, tone, titleText(view.title)),
    ...(typeof view.title === "string" || !view.title.icon
      ? []
      : [paint(theme, tone, titleText({ ...view.title, icon: undefined }))]),
  ];
  const meta = (view.meta ?? []).map((line) => styleLine(line, theme)).filter(Boolean);
  const lines = [labeledRule(width, (text) => theme.fg("border", text), heading, meta)];
  const available = rowsBudget - 1;
  const limit = Math.min(view.rows.length, budget(view.maxVisible));
  const overflow = view.rows.length > Math.min(limit, available);
  const count = Math.min(limit, Math.max(0, available - (overflow ? 1 : 0)));
  for (const row of view.rows.slice(0, count)) {
    const right = (row.right ?? []).map((line) => styleLine(line, theme));
    lines.push(
      bodyRow(
        splitColumns(styleLine(row.left, theme), right, Math.max(0, width - 2), {
          keepRight: row.keepRight,
        }),
        width,
      ),
    );
  }
  const hidden = view.rows.slice(count);
  if (hidden.length && lines.length < rowsBudget)
    lines.push(bodyRow(paint(theme, "dim", overflowText(view.rows, hidden)), width));
  else if (!view.rows.length && view.emptyText && lines.length < rowsBudget)
    lines.push(bodyRow(paint(theme, "muted", sanitizeLine(view.emptyText)), width));
  return lines;
}

/** Snapshot component for setWidget factories; callers own registration and refresh scheduling. */
export class Widget implements Component {
  private view: WidgetView;
  constructor(
    view: WidgetView,
    private readonly theme: UITheme,
  ) {
    this.view = snapshot(view);
  }
  setView(view: WidgetView): void {
    this.view = snapshot(view);
  }
  render(width: number): string[] {
    return renderWidget(this.view, width, this.theme);
  }
  invalidate(): void {}
}
function snapshot(view: WidgetView): WidgetView {
  return {
    ...view,
    title: typeof view.title === "string" ? view.title : { ...view.title },
    meta: view.meta?.map(copyLine),
    rows: view.rows.map((row) => ({
      ...row,
      left: copyLine(row.left),
      right: row.right?.map(copyLine),
    })),
  };
}
