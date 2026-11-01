import type { Badge, Block, Tone } from "../../../packages/pi-ui/src/index.ts";

/** Plain-data views, captured when a command opens. No model or settings mutation. */
export interface InsightLegend {
  /** Complete display text, e.g. "[loaded]"; the viewer does not add punctuation. */
  label: string;
  tone: Tone;
  meaning: string;
}

export interface InsightItem {
  id: string;
  label: string;
  /** Right-aligned list indicator, repeated beside the label in the detail header. */
  badge?: Badge;
  /** Search metadata only; descriptions are not displayed in list rows. */
  description: string;
  /** Compact state: shown on the right when there is no badge, otherwise only searched. */
  status?: string;
  /** Structured content shown by Enter; no files opened or instructions loaded by the viewer. */
  detail: readonly Block[];
}

export interface InsightView {
  title: string;
  note: string;
  /** A text view (prompt), or a list with read-only drilldown (tools/skills). */
  text?: string;
  items?: readonly InsightItem[];
  /** Counted noun for the list status row, e.g. `["tool", "tools"]`. */
  noun?: readonly [singular: string, plural: string];
  /** Contextual color meanings displayed above the list and detail. */
  legend?: readonly InsightLegend[];
}
