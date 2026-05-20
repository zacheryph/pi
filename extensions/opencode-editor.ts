/**
 * opencode-editor.ts
 *
 * Editor styled like opencode:
 *  - Dark gray background (ANSI 256 color 236)
 *  - Left accent bar `│` tracking thinking level + bash mode
 *  - 4-char left padding, 3-char right padding inside the box
 *  - No top/bottom border lines — replaced with blank bg rows
 *  - Autocomplete menu floats above the editor
 *  - OUTER-char margin on left + right of the editor
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BG = "\x1b[48;5;236m"; // Elevated dark gray background
const RESET = "\x1b[0m";
const DIM_BAR = "\x1b[38;5;245m"; // Light gray bar for autocomplete
const OUTER = 1; // Outer margin chars on each side (terminal bg shows through)

// ─── Helpers ────────────────────────────────────────────────────────────────

function reapplyBg(str: string, bg: string): string {
  return str.replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
}

function isBorderLine(line: string): boolean {
  const plain = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return plain.startsWith("─");
}

// ─── Editor ─────────────────────────────────────────────────────────────────

const BRIGHT_THINKING: Record<string, string> = {
  off: "\x1b[38;5;250m", // bright gray
  minimal: "\x1b[38;5;123m", // bright cyan
  low: "\x1b[38;5;81m", // bright sky blue
  medium: "\x1b[38;5;14m", // bright cyan
  high: "\x1b[38;5;201m", // bright magenta
  xhigh: "\x1b[38;5;196m", // bright red
};

class OpenCodeEditor extends CustomEditor {
  private maxAutocompleteLines = 0;
  private editorTheme: any;
  private getThinkingLevel: () => string;

  constructor(tui: any, theme: any, kb: any, getThinkingLevel: () => string) {
    super(tui, theme, kb, { paddingX: 3 });
    this.editorTheme = theme;
    this.getThinkingLevel = getThinkingLevel;
  }

  render(width: number): string[] {
    const innerWidth = width - 2 * OUTER - 2; // reserves: OUTER each side + bar + extra space
    const raw = super.render(innerWidth);
    if (raw.length === 0) return [];

    const level = this.getThinkingLevel();
    const isBash = (this as any).getText().trimStart().startsWith("!");
    const brightBar = isBash
      ? this.editorTheme.fg("bashMode", "┃")
      : (BRIGHT_THINKING[level] ?? BRIGHT_THINKING.off) + "┃" + RESET;

    const leftMargin = " ".repeat(OUTER);
    const barPrefix = leftMargin + brightBar + BG + " ";
    const blankRow = barPrefix + " ".repeat(innerWidth) + RESET;
    const autocompleteBarPrefix = leftMargin + DIM_BAR + "┃" + RESET + BG + " ";

    // Split: [topBorder, ...content, bottomBorder, ...autocomplete]
    const bottomBorderIdx = raw.findIndex((line, index) => index > 0 && isBorderLine(line));

    const contentLines =
      bottomBorderIdx >= 0 ? raw.slice(1, bottomBorderIdx) : raw.slice(1);
    const autocompleteLines =
      bottomBorderIdx >= 0 ? raw.slice(bottomBorderIdx + 1) : [];

    const wrapContent = (line: string) =>
      barPrefix + reapplyBg(line, BG) + RESET;
    const wrapAutocomplete = (line: string) =>
      autocompleteBarPrefix + reapplyBg(line, BG) + RESET;

    // Anchor the editor at the bottom while autocomplete is open:
    // track the tallest autocomplete list seen and pad shorter lists with blank
    // lines at the top so the total height (and editor position) stays stable.
    let paddedAutocomplete: string[];
    if (autocompleteLines.length > 0) {
      this.maxAutocompleteLines = Math.max(
        this.maxAutocompleteLines,
        autocompleteLines.length,
      );
      const padCount = this.maxAutocompleteLines - autocompleteLines.length;
      paddedAutocomplete = [
        ...Array(padCount).fill(""), // blank lines hold the reserved space
        ...autocompleteLines.map(wrapAutocomplete),
      ];
    } else {
      this.maxAutocompleteLines = 0; // reset when autocomplete closes
      paddedAutocomplete = [];
    }

    return [
      ...paddedAutocomplete, // autocomplete floats above (stable height)
      blankRow, // blank top row (replaces ───)
      ...contentLines.map(wrapContent), // text content
      blankRow, // blank bottom row (replaces ───)
    ];
  }
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent(
      (tui, theme, kb) =>
        new OpenCodeEditor(tui, theme, kb, () => pi.getThinkingLevel()),
    );
  });
}
