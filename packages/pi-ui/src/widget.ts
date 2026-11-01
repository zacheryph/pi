import type { Component } from "@earendil-works/pi-tui";
import {
  bodyRow,
  cells,
  labeledRule,
  splitColumns,
  titleText,
  type ColumnOptions,
} from "./layout.ts";
import { sanitizeLine } from "./text.ts";
import type { Title, UITheme } from "./types.ts";

export interface WidgetRow extends ColumnOptions {
  /** Trusted, already styled content. Domain state and status mapping stay with callers. */
  left: string;
  right?: string | readonly string[];
}
export interface WidgetView {
  title: Title;
  right?: readonly string[];
  rows: readonly (string | WidgetRow)[];
  maxRows: number;
  maxVisible?: number;
  /** Additional rows omitted by the caller before rendering. */
  omitted?: number;
  emptyText?: string;
}

/** No sorting, timers, events, terminal reads, or task/agent lifecycle. */
export function renderWidget(view: WidgetView, width: number, theme: UITheme): string[] {
  width = cells(width);
  const budget = cells(view.maxRows);
  if (!width || !budget) return [];
  const heading = theme.fg("accent", titleText(view.title));
  const lines = [labeledRule(width, (text) => theme.fg("border", text), [heading], view.right)];
  const available = budget - 1,
    limit = Math.min(view.rows.length, cells(view.maxVisible ?? view.rows.length));
  const omitted = cells(view.omitted ?? 0);
  const overflow = view.rows.length > Math.min(limit, available) || omitted > 0;
  const count = Math.min(limit, Math.max(0, available - (overflow ? 1 : 0)));
  for (const row of view.rows.slice(0, count)) {
    const text =
      typeof row === "string"
        ? row
        : splitColumns(row.left, row.right ?? "", Math.max(0, width - 2), row);
    lines.push(bodyRow(text, width));
  }
  const hidden = view.rows.length - count + omitted;
  if (hidden && lines.length < budget)
    lines.push(bodyRow(theme.fg("dim", `+${hidden} more`), width));
  else if (!view.rows.length && !omitted && view.emptyText && lines.length < budget)
    lines.push(bodyRow(theme.fg("muted", sanitizeLine(view.emptyText)), width));
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
    right: view.right && [...view.right],
    rows: view.rows.map((row) =>
      typeof row === "string"
        ? row
        : {
            ...row,
            right: typeof row.right === "string" ? row.right : row.right && [...row.right],
          },
    ),
  };
}
