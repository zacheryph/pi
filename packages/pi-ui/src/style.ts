import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeLine } from "#src/text";
import type { UIColor, UITheme } from "#src/types";

/**
 * Semantic tones. Extensions say what text means; this module alone decides how
 * each tone looks, so every view shares one palette and selection rule.
 */
export type Tone = "default" | "accent" | "muted" | "dim" | "success" | "warning" | "error";
/** Untrusted plain text, optionally toned. Never pre-styled ANSI. */
export type Span = string | { text: string; tone?: Tone; bold?: boolean };
/** One logical line made of spans. */
export type Line = Span | readonly Span[];
/** Right-column label, e.g. a status. */
export interface Badge {
  text: string;
  tone?: Tone;
}

/** Clipped text always ends in this marker so readers can tell content was cut. */
export const ELLIPSIS = "…";

const COLORS: Record<Exclude<Tone, "default">, UIColor> = {
  accent: "accent",
  muted: "muted",
  dim: "dim",
  success: "success",
  warning: "warning",
  error: "error",
};

interface NormalSpan {
  text: string;
  tone: Tone;
  bold: boolean;
}

function normalize(line: Line | undefined): NormalSpan[] {
  if (line === undefined) return [];
  const list: readonly Span[] =
    typeof line === "string" || !Array.isArray(line) ? [line as Span] : line;
  return list.map((span) =>
    typeof span === "string"
      ? { text: sanitizeLine(span), tone: "default", bold: false }
      : { text: sanitizeLine(span.text), tone: span.tone ?? "default", bold: Boolean(span.bold) },
  );
}

/** Sanitized text without styling, for searching, titles and measuring. */
export function plainText(line: Line | undefined): string {
  return normalize(line)
    .map((span) => span.text)
    .join("");
}

export function paint(theme: UITheme, tone: Tone, text: string, bold = false): string {
  if (!text) return "";
  const weighted = bold ? theme.bold(text) : text;
  return tone === "default" ? weighted : theme.fg(COLORS[tone], weighted);
}

/** Style an untrusted line. `tone` overrides every span's tone, e.g. for a selected row. */
export function styleLine(
  line: Line | undefined,
  theme: UITheme,
  override: { tone?: Tone; bold?: boolean } = {},
): string {
  return normalize(line)
    .map((span) => paint(theme, override.tone ?? span.tone, span.text, override.bold ?? span.bold))
    .join("");
}

export function styleBadge(badge: Badge | undefined, theme: UITheme): string {
  return badge ? paint(theme, badge.tone ?? "dim", sanitizeLine(badge.text)) : "";
}

/** Snapshot a line so later caller mutation cannot change a rendered view. */
export function copyLine(line: Line): Line {
  if (typeof line === "string") return line;
  if (Array.isArray(line))
    return line.map((span: Span) => (typeof span === "string" ? span : { ...span }));
  return { ...(line as Exclude<Span, string>) };
}

/** Width-bounded clip of trusted, already styled text with the shared ellipsis. */
export function clip(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), ELLIPSIS);
}
