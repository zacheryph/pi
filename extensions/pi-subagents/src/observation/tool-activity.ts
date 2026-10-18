import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

/** Keep only a bounded, plain-text label; tool output must not control the terminal. */
function activityLabel(text: string): string {
  const plain = stripTerminalSequences(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Pi's truncator can append ANSI resets even to unstyled Unicode text.
  return stripTerminalSequences(truncateToWidth(plain, 240, "…"));
}

/**
 * Prefer explicit UI metadata, then the last non-empty line of streamed text.
 * Partial results may contain one progress line or cumulative output; neither
 * is retained here. Non-text/empty updates leave the previous activity intact.
 */
export function toolActivity(result: AgentToolResult<unknown>): string | undefined {
  const details = result.details;
  if (details && typeof details === "object" && "activity" in details) {
    const activity = details.activity;
    if (activity && typeof activity === "object" && "label" in activity && typeof activity.label === "string") {
      const label = activityLabel(activity.label);
      if (label) return label;
    }
  }

  for (let i = result.content.length - 1; i >= 0; i--) {
    const block = result.content[i];
    if (block.type !== "text") continue;
    const lines = stripTerminalSequences(block.text).split(/\r\n?|\n/);
    for (let j = lines.length - 1; j >= 0; j--) {
      const label = activityLabel(lines[j]);
      if (label) return label;
    }
  }
  return undefined;
}
