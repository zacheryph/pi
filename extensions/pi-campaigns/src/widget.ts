/**
 * Pure rendering for the campaigns widget: a full-width header rule and one inset
 * row per campaign, sized to the terminal in cells (ANSI and wide Unicode aware).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type CampaignRow = {
  id: string;
  done: number;
  total: number;
  blocked: number;
  paused: boolean;
  checking: boolean;
};

/** Minimal theme surface; identity styling keeps the renderer usable in tests. */
export type WidgetTheme = { fg(color: "border" | "dim" | "accent" | "warning" | "muted", text: string): string };
const plain: WidgetTheme = { fg: (_color, text) => text };

export const MAX_CAMPAIGN_ROWS = 8;

/** Labels from disk must never add rows or terminal control codes. */
function singleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function renderHeading(width: number, theme: WidgetTheme): string {
  const prefix = theme.fg("border", "──") + " " + theme.fg("dim", "Campaigns") + " ";
  const rule = theme.fg("border", "─".repeat(Math.max(0, width - visibleWidth(prefix))));
  return truncateToWidth(prefix + rule, width, "…");
}

/** Status sits on the right and gives way to the campaign id on narrow terminals. */
function alignColumns(left: string, right: string, width: number): string {
  if (width < 12) return truncateToWidth(left, width, "…", true);
  const status = truncateToWidth(right, Math.floor(width * 0.5), "…");
  const label = truncateToWidth(left, Math.max(0, width - visibleWidth(status) - 2), "…");
  const gap = Math.max(0, width - visibleWidth(label) - visibleWidth(status));
  return label + " ".repeat(gap) + status;
}

function renderRow(row: CampaignRow, width: number, theme: WidgetTheme): string {
  // Keep rows inset from Pi's full-width chrome; blank when padding leaves no room.
  if (width <= 2) return " ".repeat(width);
  const inner = width - 2;
  const icon = row.checking ? theme.fg("accent", "⟳") : row.paused ? theme.fg("dim", "Ⅱ") : theme.fg("muted", "◦");
  const left = icon + " " + singleLine(row.id);
  const parts = [row.done + "/" + row.total];
  if (row.blocked) parts.push(theme.fg("warning", "! " + row.blocked + " blocked"));
  if (row.paused) parts.push(theme.fg("dim", "paused"));
  return " " + alignColumns(left, parts.join("  "), inner) + " ";
}

/** Header plus up to MAX_CAMPAIGN_ROWS rows; an inset overflow row counts the rest. */
export function renderCampaignWidget(rows: readonly CampaignRow[], terminalWidth: number, theme: WidgetTheme = plain): string[] {
  const width = Math.max(0, Math.floor(terminalWidth));
  if (width === 0 || rows.length === 0) return [];
  const shown = rows.length > MAX_CAMPAIGN_ROWS ? rows.slice(0, MAX_CAMPAIGN_ROWS - 1) : rows;
  const lines = [renderHeading(width, theme), ...shown.map(row => renderRow(row, width, theme))];
  if (shown.length < rows.length) {
    const more = "+" + (rows.length - shown.length) + " more · /campaigns";
    lines.push(width <= 2 ? " ".repeat(width) : " " + theme.fg("dim", truncateToWidth(more, width - 2, "…", true)) + " ");
  }
  return lines;
}
