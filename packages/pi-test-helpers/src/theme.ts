/** The part of Pi's theme that renderers in this bundle call. */
export interface TestTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Leaves text unstyled, so rendered lines compare as plain strings. */
export const plainTheme: TestTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

/**
 * Wraps text in real SGR sequences, so tests see escape codes where a terminal
 * theme would put them: widths, truncation and sanitizing must cope with them.
 */
export const ansiTheme: TestTheme = {
  fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

// oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control sequences.
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * Remove color and style (SGR) sequences only. Any other control sequence a
 * renderer leaks, such as a screen clear or an OSC title, stays visible to the
 * assertion.
 */
export const stripAnsi = (text: string): string => text.replace(SGR, "");

/** Rendered lines joined with newlines, colors and styles removed. */
export const plainLines = (lines: readonly string[]): string => lines.map(stripAnsi).join("\n");
