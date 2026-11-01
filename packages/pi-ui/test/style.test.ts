import { describe, expect, it } from "vitest";
import { formatKey, layoutHints, navigationHint, type Hint } from "../src/navigation.ts";
import { copyLine, plainText, styleBadge, styleLine, type Line } from "../src/style.ts";
import { keys } from "./helpers.ts";

const tagged = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};
describe("semantic tones", () => {
  it("styles spans by tone, sanitizes each span and lets an override recolor the whole line", () => {
    const line: Line = [
      "plain ",
      { text: "handle\x1b]0;x\x07", tone: "accent", bold: true },
      { text: "\nnote", tone: "muted" },
    ];
    expect(styleLine(line, tagged)).toBe(
      "plain <accent><b>handle</b></accent><muted> note</muted>",
    );
    expect(styleLine(line, tagged, { tone: "accent" })).toBe(
      "<accent>plain </accent><accent><b>handle</b></accent><accent> note</accent>",
    );
    expect(plainText(line)).toBe("plain handle note");
    expect(styleBadge({ text: "[on]" }, tagged)).toBe("<dim>[on]</dim>");
    expect(styleBadge(undefined, tagged)).toBe("");
  });
  it("copies spans so caller mutation cannot change a snapshot", () => {
    const span = { text: "a", tone: "accent" as const },
      source = [span],
      copy = copyLine(source) as typeof source;
    span.text = "b";
    source.push({ text: "c", tone: "accent" });
    expect(plainText(copy)).toBe("a");
  });
});
describe("hints", () => {
  it("formats key ids consistently and builds navigation from page bindings", () => {
    expect(["pageUp", "ctrl+pageDown", "escape", "shift+tab", "ctrl+r"].map(formatKey)).toEqual([
      "PgUp",
      "Ctrl+PgDn",
      "Esc",
      "Shift+Tab",
      "Ctrl+R",
    ]);
    expect(navigationHint(keys()).keys).toBe("↑↓ PgUp/PgDn Home/End");
  });
  it("wraps between hints and drops the least important first, never priority 0", () => {
    const hints: Hint[] = [
      { keys: "Enter", action: "open", priority: 0 },
      { keys: "Esc", action: "close", priority: 0 },
      { keys: "Tab", action: "view", priority: 1 },
      { keys: "/cmd", action: "run", priority: 2 },
      { keys: "↑↓", priority: 3 },
    ];
    expect(layoutHints(hints, 80, 2)).toEqual([
      "Enter open · Esc close · Tab view · /cmd run · ↑↓",
    ]);
    expect(layoutHints(hints, 25, 2)).toEqual([
      "Enter open · Esc close",
      "Tab view · /cmd run · ↑↓",
    ]);
    expect(layoutHints(hints, 22, 2)).toEqual(["Enter open · Esc close", "Tab view · /cmd run"]);
    expect(layoutHints(hints, 12, 2)).toEqual(["Enter open", "Esc close"]);
    expect(layoutHints(hints, 5, 1)).toEqual(["Enter open"]);
    expect(layoutHints(hints, 80, 0)).toEqual([]);
  });
});
