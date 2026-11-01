import { sanitizeLine } from "../../../../packages/pi-ui/src/index.ts";
import type { StashRecord } from "../state.ts";

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
  return sanitizeLine(id).slice(0, 8) || "?";
}

/** Who stored a version: its subagent when known, else its session. */
export function originLabel(record: Pick<StashRecord, "createdBy" | "agent">): string {
  return record.agent
    ? `agent ${sanitizeLine(record.agent).slice(0, 8) || "?"}`
    : shortSession(record.createdBy);
}

export function entrySummary(record: Pick<StashRecord, "bytes" | "lines">): string {
  return `${formatBytes(record.bytes)} · ${record.lines} line${record.lines === 1 ? "" : "s"}`;
}

/** Numbered preview rows; never more than `maxLines`. */
export function previewRows(text: string, maxLines: number, startLine = 1): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const shown = lines.slice(0, Math.max(0, maxLines));
  const digits = String(startLine + Math.max(0, shown.length - 1)).length;
  return shown.map((line, i) => `${String(startLine + i).padStart(digits)}  ${sanitizeLine(line)}`);
}
