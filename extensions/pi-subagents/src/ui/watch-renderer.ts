/** Passive watch panel: evenly stacked sections, always following output tails. */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import type { Theme } from "#src/ui/display";
import { watchText } from "#src/ui/watch-tail";

export interface WatchSection {
  id: string;
  label: string;
  status: SubagentStatus;
  blocks: readonly string[];
}

export function watchHeight(rows: number): number { return Math.max(0, Math.floor(rows) - 6); }

export function renderWatchOverlay(sections: readonly WatchSection[], width: number, height: number, theme: Theme): string[] {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  if (width < 4 || height < 4) return [];
  const inner = width - 2;
  const fit = (text: string) => {
    const clipped = truncateToWidth(text, inner, "…");
    return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
  };
  const row = (text: string) => theme.fg("border", "│") + fit(text) + theme.fg("border", "│");
  const rule = (text: string, left: string, right: string) => {
    const label = truncateToWidth(text, inner, "…");
    return theme.fg("border", left) + label
      + theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(label))) + right);
  };
  const lines = [rule(theme.fg("accent", " Subagents · Ctrl+Alt+S "), "┌", "┐")];
  const budget = height - 2;
  if (sections.length === 0) {
    lines.push(row(theme.fg("dim", "Waiting for background agents…")));
  } else {
    // Reserve at least a header and one tail row per visible agent.
    let count = Math.min(sections.length, Math.floor(budget / 2));
    if (count < sections.length) count = Math.min(count, Math.floor((budget - 1) / 2));
    count = Math.max(1, count);
    const body = budget - (count < sections.length ? 1 : 0);
    for (let index = 0; index < count; index++) {
      const section = sections[index];
      const allocation = Math.floor(body / count) + (index < body % count ? 1 : 0);
      const icon = section.status === "running" ? "●" : section.status === "queued" ? "◦"
        : section.status === "completed" ? "✓" : "✗";
      const color = section.status === "error" ? "error" : section.status === "completed" ? "success" : "accent";
      const label = watchText(section.label).replace(/\s+/g, " ").trim();
      lines.push(row(theme.fg(color, truncateToWidth(`── ${icon} ${label} · ${section.status}`, inner, "…"))));
      const tailRows = allocation - 1;
      const blocks = section.blocks.length ? section.blocks : [section.status === "queued" ? "Queued…" : section.status === "running" ? "Thinking…" : "No text output."];
      let tail: string[] = [];
      for (let block = blocks.length - 1; block >= 0 && tail.length < tailRows; block--) {
        const wrapped = wrapTextWithAnsi(watchText(blocks[block]), inner);
        tail = [...wrapped.slice(-tailRows), ...tail].slice(-tailRows);
      }
      // Bottom-align each tail; no scrollbar, input handling, or inherited history.
      while (tail.length < tailRows) tail.unshift("");
      lines.push(...tail.map(text => row(theme.fg("muted", text))));
    }
    if (count < sections.length) lines.push(row(theme.fg("dim", `+${sections.length - count} more agents`)));
  }
  while (lines.length < height - 1) lines.push(row(""));
  lines.push(rule("", "└", "┘"));
  return lines;
}
