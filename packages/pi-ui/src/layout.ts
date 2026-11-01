import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { firstPhysicalLine, sanitizeLine } from "./text.ts";
import type { Title, UITheme } from "./types.ts";

/** Terminal dimensions and budgets are finite nonnegative integer cell counts. */
export function cells(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function titleText(title: Title): string {
  if (typeof title === "string") return sanitizeLine(title);
  return (
    [title.icon, title.label]
      .filter(Boolean)
      .map((part) => sanitizeLine(part!))
      .join(" ") + (title.detail ? ` / ${sanitizeLine(title.detail)}` : "")
  );
}

/** Trusted ANSI is retained; only one physical row is ever returned. */
export function bodyRow(text: string, width: number): string {
  width = cells(width);
  if (width <= 2) return " ".repeat(width);
  const fitted = truncateToWidth(firstPhysicalLine(text), width - 2, "");
  return ` ${fitted}${" ".repeat(Math.max(0, width - 2 - visibleWidth(fitted)))} `;
}

export interface ColumnOptions {
  /** Maximum admitted right-column width. Pre-truncate candidates when clipping is desired. */
  maxRightWidth?: number;
  minLeftWidth?: number;
  gap?: number;
}

/** Right candidates are ordered fallbacks; drop right before sacrificing the minimum left width. */
export function splitColumns(
  left: string,
  right: string | readonly string[],
  width: number,
  options: ColumnOptions = {},
): string {
  width = cells(width);
  left = firstPhysicalLine(left);
  const gap = cells(options.gap ?? 1);
  const maxRight = Math.min(width, cells(options.maxRightWidth ?? width));
  const minLeft = Math.min(width, cells(options.minLeftWidth ?? 1));
  const candidates = typeof right === "string" ? [right] : right;
  const fitted = candidates
    .map(firstPhysicalLine)
    .find(
      (text) =>
        visibleWidth(text) > 0 &&
        visibleWidth(text) <= maxRight &&
        visibleWidth(text) + gap + minLeft <= width,
    );
  if (!fitted) return truncateToWidth(left, width, "");
  const clipped = truncateToWidth(left, width - gap - visibleWidth(fitted), "");
  return (
    clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped) - visibleWidth(fitted))) + fitted
  );
}

/** MIT adaptation of subagents' labeled rule. Every width, including 0–8, is bounded. */
export function labeledRule(
  width: number,
  paint: (text: string) => string,
  left: readonly string[],
  right: readonly string[] = [],
): string {
  width = cells(width);
  for (const label of left.map(firstPhysicalLine)) {
    for (const tail of [...right.map(firstPhysicalLine), undefined]) {
      const end = tail === undefined ? "" : ` ${tail} ──`;
      const fill = width - 3 - visibleWidth(label) - 1 - visibleWidth(end);
      if (fill >= 1)
        return (
          paint("── ") +
          label +
          paint(` ${"─".repeat(fill)}`) +
          (tail === undefined ? "" : paint(" ") + tail + paint(" ──"))
        );
    }
  }
  const label = firstPhysicalLine(left.at(-1) ?? "");
  const clipped = truncateToWidth(label, width, "");
  return clipped + paint("─".repeat(Math.max(0, width - visibleWidth(clipped))));
}

export interface PanelLayout {
  width: number;
  height: number;
  framed: boolean;
  contentWidth: number;
  beforeRows: number;
  afterRows: number;
  bodyRows: number;
}

/** Reserve a body row, then footer actions, then optional header rows. */
export function layoutPanel(
  width: number,
  height: number,
  beforeRows = 0,
  afterRows = 0,
): PanelLayout {
  width = cells(width);
  height = cells(height);
  if (!width) height = 0;
  const framed = width >= 7 && height >= 3;
  const inner = Math.max(0, height - (framed ? 2 : 0));
  const after = Math.min(cells(afterRows), Math.max(0, inner - 1));
  const before = Math.min(cells(beforeRows), Math.max(0, inner - after - 1));
  return {
    width,
    height,
    framed,
    contentWidth: Math.max(0, width - (framed ? 6 : 2)),
    beforeRows: before,
    afterRows: after,
    bodyRows: inner - before - after,
  };
}

/** All lines are already styled. Title is plain/untrusted and is normalized here. */
export function renderPanel(
  layout: PanelLayout,
  title: Title,
  body: readonly string[],
  theme: UITheme,
  chrome: { before?: readonly string[]; after?: readonly string[] } = {},
): string[] {
  const { width, height, framed } = layout;
  if (!width || !height) return [];
  const lines: string[] = [];
  if (framed) {
    const inner = width - 4;
    const label = truncateToWidth(` ${titleText(title)} `, inner, "");
    const spare = Math.max(0, inner - visibleWidth(label)),
      left = Math.floor(spare / 2);
    lines.push(
      " " +
        theme.fg("border", "╭" + "─".repeat(left)) +
        theme.fg("accent", theme.bold(label)) +
        theme.fg("border", "─".repeat(spare - left) + "╮") +
        " ",
    );
  }
  const row = (text: string) =>
    framed
      ? " " + theme.fg("border", "│") + bodyRow(text, width - 4) + theme.fg("border", "│") + " "
      : bodyRow(text, width);
  for (let i = 0; i < layout.beforeRows; i++) lines.push(row(chrome.before?.[i] ?? ""));
  for (let i = 0; i < layout.bodyRows; i++) lines.push(row(body[i] ?? ""));
  for (let i = 0; i < layout.afterRows; i++) lines.push(row(chrome.after?.[i] ?? ""));
  if (framed) lines.push(" " + theme.fg("border", `╰${"─".repeat(width - 4)}╯`) + " ");
  return lines;
}

/** Trusted tool-result lines, bounded to one physical terminal row each. */
export class BoundedLines implements Component {
  private readonly lines: readonly string[];
  constructor(lines: readonly string[]) {
    this.lines = [...lines];
  }
  render(width: number): string[] {
    return this.lines.map((line) => truncateToWidth(firstPhysicalLine(line), cells(width), ""));
  }
  invalidate(): void {}
}
