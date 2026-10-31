import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { handleFor, type StashRecord } from "../state.ts";
import { safeStashLine } from "./text.ts";

type Fg = Pick<Theme, "fg">;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatAge(createdAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function shortSession(id: string): string {
  return safeStashLine(id).slice(0, 8) || "?";
}

/** Who stored a version: its subagent when known, else its session. */
export function originLabel(record: Pick<StashRecord, "createdBy" | "agent">): string {
  return record.agent ? `agent ${safeStashLine(record.agent).slice(0, 8) || "?"}` : shortSession(record.createdBy);
}

/**
 * One padded body row: a space on both sides of the content, content
 * truncated to the width left after padding, blank when even that won't fit.
 */
export function bodyRow(text: string, width: number): string {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (width <= 2) return " ".repeat(width);
  const fitted = truncateToWidth(text, width - 2, "");
  return ` ${fitted}${" ".repeat(Math.max(0, width - 2 - visibleWidth(fitted)))} `;
}

/** Left text clips first; the right column keeps its cells when there is room. */
export function splitRow(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (!right || rightWidth + 2 > width) return truncateToWidth(left, width, "");
  const clipped = truncateToWidth(left, width - rightWidth - 1, "");
  return clipped + " ".repeat(Math.max(1, width - visibleWidth(clipped) - rightWidth)) + right;
}

/** Full-width header rule: `── title ─────── right ──`. */
export function headerRule(title: string, right: string, width: number, theme: Fg): string {
  width = Math.max(0, Math.floor(width));
  const label = `── ${title} `;
  const tail = right ? ` ${right} ──` : "──";
  const fill = width - visibleWidth(label) - visibleWidth(tail);
  if (fill < 1) return theme.fg("accent", truncateToWidth(title, width, ""));
  return theme.fg("border", "── ") + theme.fg("accent", title) + theme.fg("border", ` ${"─".repeat(fill)}`)
    + (right ? theme.fg("border", " ") + theme.fg("muted", right) + theme.fg("border", " ──") : theme.fg("border", "──"));
}

export function entrySummary(record: Pick<StashRecord, "bytes" | "lines">): string {
  return `${formatBytes(record.bytes)} · ${record.lines} line${record.lines === 1 ? "" : "s"}`;
}

/** List row: handle and description on the left, origin (when adopted), size and age on the right. */
export function entryRow(record: StashRecord, width: number, theme: Fg, now = Date.now()): string {
  const description = record.description ? ` — ${safeStashLine(record.description)}` : "";
  const left = theme.fg("accent", safeStashLine(handleFor(record))) + theme.fg("muted", description);
  const origin = record.via === "adopt" ? `↑ ${originLabel(record)} · ` : "";
  const right = theme.fg("dim", `${origin}${entrySummary(record)} · ${formatAge(record.createdAt, now)}`);
  return splitRow(left, right, width);
}

/** Numbered preview rows; never more than `maxLines`. */
export function previewRows(text: string, maxLines: number, startLine = 1): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const shown = lines.slice(0, Math.max(0, maxLines));
  const digits = String(startLine + Math.max(0, shown.length - 1)).length;
  return shown.map((line, i) => `${String(startLine + i).padStart(digits)}  ${safeStashLine(line)}`);
}
