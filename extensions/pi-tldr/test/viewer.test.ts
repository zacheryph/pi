import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { TldrResult } from "../src/core.js";
import { TldrViewer } from "../src/viewer.js";

// oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control sequences.
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
/** Theme that emits real ANSI so width math is exercised against escape codes. */
const ansiTheme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as any;

const summary: TldrResult = {
  title: "routing-migration",
  premise: "Migrate 网络 routes 🚀 to the new stack",
  findings: "One issue; two fixes ;three",
  status: "Pending rollout review",
};

function setup(rows = 40) {
  const tui = { requestRender: vi.fn(), terminal: { rows } };
  const viewer = new TldrViewer(tui, ansiTheme, vi.fn());
  return { viewer, tui };
}

describe("TldrViewer rendering", () => {
  it("splits semicolon-separated findings into separate bullets", () => {
    const { viewer } = setup();
    viewer.setSummary(summary);
    const text = viewer.render(80).map(plain);
    const bullets = text
      .filter((line) => line.includes("• "))
      .map((line) => /• (\S+(?: \S+)*)/.exec(line)?.[1]);
    expect(bullets).toEqual(["One issue", "two fixes", "three"]);
  });

  it("shows loading, then summary, then error states in place", () => {
    const { viewer, tui } = setup();
    expect(viewer.render(60).map(plain).join("\n")).toContain("Summarizing session…");
    viewer.setSummary(summary);
    expect(tui.requestRender).toHaveBeenCalled();
    expect(viewer.render(60).map(plain).join("\n")).toContain("TLDR · routing-migration");
    viewer.setError("Error: boom\x1b]0;hijack\x07");
    const errorText = viewer.render(60).map(plain).join("\n");
    expect(errorText).toContain("Could not summarize");
    expect(errorText).not.toContain("\x07");
  });

  const states: Array<[string, (viewer: TldrViewer) => void]> = [
    ["loading", () => {}],
    ["summary", (viewer) => viewer.setSummary(summary)],
    ["error", (viewer) => viewer.setError("Error: 模型 request failed with a long explanation 🚧")],
  ];

  for (const [state, prepare] of states) {
    it(`keeps every line exactly the given width with ANSI and wide text (${state})`, () => {
      for (const width of [100, 40, 12, 7, 6, 5, 3, 2, 1]) {
        const { viewer } = setup();
        prepare(viewer);
        const lines = viewer.render(width);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines)
          expect(visibleWidth(line), `width ${width}: ${JSON.stringify(plain(line))}`).toBe(width);
      }
    });

    it(`pads body rows by at least one space inside borders and edges (${state})`, () => {
      for (const width of [100, 40, 12, 7]) {
        const { viewer } = setup();
        prepare(viewer);
        const body = viewer.render(width).map(plain).slice(1, -1);
        for (const line of body) expect(line, `framed width ${width}`).toMatch(/^ │ .* │ $/u);
      }
      for (const width of [6, 5, 4, 3, 2]) {
        const { viewer } = setup();
        prepare(viewer);
        for (const line of viewer.render(width).map(plain)) {
          expect(line.startsWith(" "), `narrow width ${width}`).toBe(true);
          expect(line.endsWith(" "), `narrow width ${width}`).toBe(true);
        }
      }
    });
  }

  it("falls back to an unframed layout when the terminal is too short", () => {
    const { viewer } = setup(5);
    viewer.setSummary(summary);
    const lines = viewer.render(40).map(plain);
    expect(lines.every((line) => !line.includes("│"))).toBe(true);
    expect(lines.at(-1)).toContain("Enter/Esc close");
  });
});
