import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { Theme } from "#src/ui/display";
import { renderWatchOverlay, watchHeight, type WatchSection } from "#src/ui/watch-renderer";

const theme: Theme = { fg: (_color, text) => text, bold: text => text };
function section(id = "a", overrides: Partial<WatchSection> = {}): WatchSection {
  return { id, label: `Agent: task ${id}`, status: "running", blocks: ["old line\nlatest output"], ...overrides };
}
const render = (sections: WatchSection[] = [section()], width = 40, height = 14, colors = theme) =>
  renderWatchOverlay(sections, width, height, colors);

describe("watch overlay renderer", () => {
  it("stacks agent sections with headers, separators and equal bounded height", () => {
    const lines = render([section(), section("b", { status: "queued", blocks: [] })]);
    expect(lines).toHaveLength(14);
    const text = lines.join("\n");
    expect(text).toContain("Subagents");
    expect(text).toContain("Ctrl+Alt+S");
    expect(text).toContain("── ● Agent: task a · running");
    expect(text).toContain("── ◦ Agent: task b · queued");
    expect(text).toContain("latest output");
    expect(text).toContain("Queued…");
    expect(lines.every(line => visibleWidth(line) === 40)).toBe(true);
  });

  it("always tails newest wrapped rows; no scrolling chrome", () => {
    const lines = render([section("a", { blocks: ["old never visible", "line 1\nline 2\nline 3\nline 4\nline 5\nnewest"] })], 32, 6);
    const text = lines.join("\n");
    expect(text).not.toContain("old never visible");
    expect(text).not.toContain("line 1");
    expect(text).toContain("line 5");
    expect(text).toContain("newest");
  });

  it("reports exact overflow rather than removing headers or exceeding height", () => {
    const lines = render(Array.from({ length: 8 }, (_, i) => section(String(i))), 40, 8);
    expect(lines).toHaveLength(8);
    expect(lines.join("\n")).toContain("+6 more agents");
    expect(lines.join("\n")).toContain("task 0");
    expect(lines.join("\n")).toContain("task 1");
    expect(lines.join("\n")).not.toContain("task 2");
  });

  it("shows waiting placeholder when manually opened with no agents", () => {
    expect(render([]).join("\n")).toContain("Waiting for background agents");
  });

  it("renders safely at tiny sizes and leaves six dock rows untouched", () => {
    expect(watchHeight(24)).toBe(18);
    expect(watchHeight(3)).toBe(0);
    for (const width of [0, 1, 2, 3, 4, 8, 12, 20]) {
      for (const height of [0, 1, 3, 4, 5, 8]) {
        const lines = render([section(), section("b")], width, height);
        expect(lines.length).toBeLessThanOrEqual(height);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("measures ANSI and wide Unicode by terminal cells and strips agent-provided controls", () => {
    const colors: Theme = { fg: (_color, text) => `\x1b[32m${text}\x1b[0m`, bold: text => text };
    const lines = render([section("a", { label: "界界👩‍💻\nInjected\x1b[2J", blocks: ["界界界界界界界界界界 👩‍💻\n\x1b[2Jtail"] })], 24, 8, colors);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(24);
      expect(line).not.toContain("\x1b[2J");
      expect(line).not.toContain("\n");
    }
  });
});
