import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { Theme } from "#src/ui/display";
import { renderWatchOverlay, watchHeight, type WatchSection } from "#src/ui/watch-renderer";

const theme: Theme = { fg: (_color, text) => text, bold: text => text };
function section(id = "a", overrides: Partial<WatchSection> = {}): WatchSection {
  return { id, label: `Agent: task ${id}`, status: "running", blocks: [{ kind: "text", text: "old line\nlatest output" }], ...overrides };
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
    const lines = render([section("a", { blocks: [{ kind: "text", text: "old never visible" }, { kind: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5\nnewest" }] })], 32, 6);
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

  it("keeps Think label on first visible row of long thinking tails across resize", () => {
    const blocks: WatchSection["blocks"] = [{ kind: "thinking", text: "offscreen start\n" + "long reasoning 界 ".repeat(100) + "\nLATEST" }];
    for (const width of [4, 8, 12, 24, 40, 60]) {
      const lines = render([section("a", { blocks })], width, 6);
      expect(lines).toHaveLength(6);
      expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
      if (width >= 12) {
        expect(lines[2]).toContain("Think ");
        expect(lines[3]).not.toContain("Think");
        if (width >= 24) expect(lines.join("\n")).toContain("LATEST");
        expect(lines.join("\n")).not.toContain("offscreen start");
      }
    }
  });

  it("applies current semantic colors per row and compact labels only to typed categories", () => {
    const blocks: WatchSection["blocks"] = [
      { kind: "thinking", text: "reasoning" },
      { kind: "text", text: "normal prose" },
      { kind: "tool", text: "✓ read auth.ts", status: "success" },
      { kind: "skill", text: "deploy · loading…", status: "pending" },
      { kind: "skill", text: "deploy · loaded", status: "success" },
      { kind: "tool", text: "✗ bash failed", status: "error" },
      { kind: "skill", text: "deploy · failed", status: "error" },
      { kind: "error", text: "Provider failed" },
    ];
    const calls: Array<[string, string]> = [];
    const colors: Theme = { fg: (color, text) => { calls.push([color, text]); return text; }, bold: text => text };
    const first = render([section("a", { blocks })], 40, 14, colors);
    expect(calls).toContainEqual(["thinkingText", "Think reasoning"]);
    expect(calls).toContainEqual(["text", "normal prose"]);
    expect(calls).toContainEqual(["toolOutput", "Tool ✓ read auth.ts"]);
    expect(calls).toContainEqual(["warning", "Skill deploy · loading…"]);
    expect(calls).toContainEqual(["success", "Skill deploy · loaded"]);
    expect(calls).toContainEqual(["error", "Tool ✗ bash failed"]);
    expect(calls).toContainEqual(["error", "Skill deploy · failed"]);
    expect(calls).toContainEqual(["error", "Provider failed"]);
    expect(first.join("\n")).not.toContain("Text normal");
    const changed: Theme = { fg: (_color, text) => `\x1b[35m${text}\x1b[0m`, bold: text => text };
    const second = render([section("a", { blocks })], 40, 14, changed);
    expect(second).not.toEqual(first);
    expect(second.every(line => visibleWidth(line) === 40)).toBe(true);
    expect(blocks[0].text).not.toContain("\x1b");
  });

  it("colors all wrapped failure rows as error and keeps category label when tailed", () => {
    const calls: Array<[string, string]> = [];
    const colors: Theme = { fg: (color, text) => { calls.push([color, text]); return text; }, bold: text => text };
    render([section("a", { blocks: [{ kind: "tool", text: "bad ".repeat(100), status: "error" }] })], 24, 6, colors);
    const rows = calls.filter(([color]) => color === "error");
    expect(rows).toHaveLength(3);
    expect(rows[0][1]).toMatch(/^Tool /);
    expect(rows[1][1]).toMatch(/^ {5}/);
  });

  it("does not fabricate thinking when provider has emitted no visible blocks", () => {
    const text = render([section("a", { blocks: [] })]).join("\n");
    expect(text).toContain("Working…");
    expect(text).not.toContain("Think");
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
    const lines = render([section("a", { label: "界界👩‍💻\nInjected\x1b[2J", blocks: [{ kind: "text", text: "界界界界界界界界界界界 👩‍💻\n\x1b[2Jtail" }] })], 24, 8, colors);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(24);
      expect(line).not.toContain("\x1b[2J");
      expect(line).not.toContain("\n");
    }
  });
});
