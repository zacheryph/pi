import { oneLine } from "#foundations/format";
import type { InsightView } from "#src/types";
import { insightTitle } from "#src/viewer";

/** Items `insightText` lists before it counts the rest. */
export const MAX_INSIGHT_ITEMS = 100;

/**
 * An insight view as plain text, for a host without the terminal modal. A text view
 * (the prompt) is its note and text; a list is one row per item with its badge or status
 * and a one-line description. Item details stay in the modal. Length limits belong to the
 * output that shows it.
 */
export function insightText(view: InsightView): string {
  const lines = [insightTitle(view.title), ...(view.note ? [view.note] : [])];
  if (view.text !== undefined) return [...lines, "", view.text].join("\n");
  const items = view.items ?? [];
  const [singular, plural] = view.noun ?? ["item", "items"];
  lines.push(`${items.length} ${items.length === 1 ? singular : plural}`);
  for (const item of items.slice(0, MAX_INSIGHT_ITEMS)) {
    const state = item.badge?.text ?? item.status;
    const description = oneLine(item.description, 120);
    lines.push(
      `- ${item.label}${state ? ` ${state}` : ""}${description ? ` — ${description}` : ""}`,
    );
  }
  if (items.length > MAX_INSIGHT_ITEMS) lines.push(`+${items.length - MAX_INSIGHT_ITEMS} more`);
  if (view.legend?.length)
    lines.push(view.legend.map((entry) => `${entry.label}=${entry.meaning}`).join(" · "));
  if (items.length) lines.push("Item details are in the terminal UI.");
  return lines.join("\n");
}
