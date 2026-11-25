// Display text for summary counts, shared by every renderer so a count reads the
// same in the dashboard, bb and anywhere else.
//
// Each function is self-contained: it uses no module-level value and calls only
// the others here by name, so a renderer that cannot import modules (the
// dashboard page's inline script) can embed their source with
// `Function.prototype.toString` and get the same output.

import type { SummaryCount } from "#src/summary";

/**
 * A size in bytes, short: `887 B`, `12.4 KiB`, `1.0 GiB`. Binary units (1 KiB
 * is 1,024 bytes) with one decimal from KiB up; a value that would round to
 * 1024.0 of one unit reads as 1.0 of the next.
 */
export function formatBytes(bytes: number): string {
  if (!(Math.abs(bytes) >= 1024)) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (unit < units.length - 1 && Math.abs(Math.round(value * 10) / 10) >= 1024) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * A count, short: up to two decimals below 10,000 (`7`, `2.5`, `9999`), then
 * thousands (`12k`, `999k`) and millions (`1.2M`, `1500M`).
 */
export function formatCount(value: number): string {
  if (Math.abs(value) < 10_000) return String(+value.toFixed(2));
  if (Math.abs(value) < 999_500) return `${Math.round(value / 1000)}k`;
  return `${+(value / 1_000_000).toFixed(1)}M`;
}

/**
 * A summary count as display text: its value, formatted for its `unit`, then
 * its label: `1 worktree`, `3 running`, `887 B in the store`. The producer
 * chose the label for the value, so this never inflects it.
 */
export function formatSummaryCount(count: Pick<SummaryCount, "label" | "value" | "unit">): string {
  const value = count.unit === "bytes" ? formatBytes(count.value) : formatCount(count.value);
  return count.label ? `${value} ${count.label}` : value;
}
