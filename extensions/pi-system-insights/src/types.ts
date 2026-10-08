/** Plain-data views, captured when a command opens. No model or settings mutation. */
export interface InsightBadge {
  /** Complete display text, e.g. "[loaded]"; renderer does not add punctuation. */
  label: string;
  color: "success" | "dim";
}

export interface InsightLegend extends InsightBadge {
  meaning: string;
}

export interface InsightItem {
  id: string;
  label: string;
  /** Compact state displayed next to the label. */
  status?: string;
  /** Optional right-aligned indicator in list and first detail (Name) row. */
  badge?: InsightBadge;
  /** Search metadata only; descriptions are not displayed in list rows. */
  description: string;
  /** Text shown by Enter; no files opened or instructions loaded by the viewer. */
  detail: string;
}

export interface InsightView {
  title: string;
  note: string;
  /** A text view (prompt), or a list with read-only drilldown (tools/skills). */
  text?: string;
  items?: readonly InsightItem[];
  /** Contextual color meanings displayed in both list and detail footers. */
  legend?: readonly InsightLegend[];
}
