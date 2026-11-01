import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  DetailView,
  TextViewport,
  footerRows,
  renderBlocks,
  statusRule,
  type Block,
} from "../src/detail.ts";
import { bounded, keys, plain, surface, theme, wheel } from "./helpers.ts";

const text = Array.from(
  { length: 80 },
  (_, i) => `row${i.toString().padStart(2, "0")} 界 text`,
).join("\n");
describe("footer status rule", () => {
  it("renders the status inline in a widget-style rule, dropping the optional icon first", () => {
    expect(plain([statusRule("1/5 tasks", 24, theme, "✓")])).toBe("── ✓  1/5 tasks ────────");
    expect(plain([statusRule("1/5 tasks", 24, theme)])).toBe("── 1/5 tasks ───────────");
    expect(plain([statusRule("1/5 tasks", 15, theme, "✓")])).toBe("── 1/5 tasks ──");
    expect(plain([statusRule("", 6, theme, "✓")])).toBe("──────");
    expect(plain([statusRule("bad\x1b]52;c;x\x07\nrow", 20, theme, "\x1b[31m✓")])).toBe(
      "── ✓  bad row ──────",
    );
  });
  it("bounds ANSI and wide text at every width and keeps hints below the rule", () => {
    for (let width = 0; width < 40; width++) {
      const rule = statusRule("界é👨‍👩‍👧‍👦 status", width, theme, "界");
      expect(visibleWidth(rule)).toBe(width);
      bounded([rule], width, 1);
    }
    const rows = footerRows("2/3", [{ keys: "Esc", action: "close" }], 20, theme, "✓");
    expect(plain(rows)).toBe("── ✓  2/3 ──────────\nEsc close");
  });
});
describe("detail viewport", () => {
  it("reflows and clamps across scroll, content updates, and repeated resizes", () => {
    const viewport = new TextViewport(text);
    viewport.move(Infinity, 40, 5);
    expect(viewport.position(40, 5)).toEqual({ start: 76, end: 80, total: 80 });
    viewport.setContent("short", false);
    expect(viewport.render(30, 5)).toEqual(["short"]);
    expect(viewport.position(30, 5)).toEqual({ start: 1, end: 1, total: 1 });
    viewport.setContent("1234567890");
    expect(viewport.render(5, 4)).toEqual(["12345", "67890"]);
    expect(viewport.render(20, 4)).toEqual(["1234567890"]);
    expect(viewport.render(0, 4)).toEqual([]);
  });
  it("keeps a valid empty range in a zero-row viewport and integer positions on fractional wheel deltas", () => {
    const view = new TextViewport(text);
    view.move(Infinity, 40, 0);
    expect(view.position(40, 0)).toEqual({ start: 0, end: 0, total: 80 });
    view.move(-Infinity, 40, 5);
    view.move(1.5, 40, 5);
    expect(view.position(40, 5).start).toBe(2);
  });
  it("normalizes strings, supports trusted renderers and invalidates cached theme-dependent rows", () => {
    const viewport = new TextViewport("\x1b]52;c;clipboard\x07safe");
    expect(viewport.render(40, 4)).toEqual(["safe"]);
    const render = vi.fn((width: number) => [theme.fg("accent", `width ${width}`)]);
    viewport.setContent(render);
    viewport.render(20, 4);
    viewport.render(20, 4);
    expect(render).toHaveBeenCalledTimes(1);
    viewport.invalidate();
    viewport.render(20, 4);
    expect(render).toHaveBeenCalledTimes(2);
  });
});
describe("structured blocks", () => {
  const blocks: Block[] = [
    { heading: "Premise" },
    { text: "A long premise that wraps\nacross\x1b]0;bad\x07 lines" },
    { heading: "Fields" },
    {
      fields: [
        ["Name", [{ text: "worker", tone: "accent" }]],
        ["Description", "does work that keeps going"],
      ],
    },
    { bullets: ["first finding that is long enough to wrap", "second"] },
    { lines: ["const a = 1;", "", "return a;"], numbered: 9 },
  ];
  it("spaces headings, aligns fields, hangs bullets and numbers preview lines", () => {
    const rows = renderBlocks(blocks, 30, theme).map((row) => plain([row]));
    expect(rows[0]).toBe("Premise");
    expect(rows).toContain("");
    expect(rows.indexOf("Fields")).toBe(rows.indexOf("") + 1);
    expect(rows).toContain("Name         worker");
    expect(rows.find((row) => row.startsWith("Description"))).toBe("Description  does work that");
    expect(rows).toContain("             keeps going");
    expect(rows).toContain("• first finding that is long");
    expect(rows).toContain("  enough to wrap");
    expect(rows).toContain(" 9  const a = 1;");
    expect(rows).toContain("10  ");
    expect(rows).toContain("11  return a;");
    expect(rows.join("\n")).not.toContain("bad");
  });
  it("stacks fields when labels take more than half the width, and stays bounded at every width", () => {
    expect(plain(renderBlocks([{ fields: [["Description", "x"]] }], 16, theme))).toBe(
      "Description\n  x",
    );
    for (let width = 0; width <= 40; width++)
      for (const row of renderBlocks(blocks, width, theme))
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  });
});
describe("DetailView", () => {
  it("handles loading/results/errors and title changes, and stops updating after disposal", () => {
    const tui = surface(),
      done = vi.fn();
    const view = new DetailView({
      tui,
      theme,
      keys: keys(),
      title: { label: "TLDR", detail: "session" },
      content: [{ text: "Summarizing…", tone: "muted" }],
      done,
    });
    expect(plain(view.render(60))).toContain("Summarizing…");
    view.setContent(text);
    view.setTitle({ label: "TLDR", detail: "Refactor\x1b]0;x\x07 plan" });
    expect(plain(view.render(60))).toContain("TLDR / Refactor plan");
    view.handleInput("\x1b[F");
    expect(plain(view.render(60))).toContain("row79");
    expect(plain(view.render(60))).toContain("/80 lines");
    view.setContent("Could not load\x1b]0;bad\x07");
    expect(plain(view.render(60))).toContain("Could not load");
    view.handleInput("\x1b");
    view.handleInput("\x03");
    expect(done).toHaveBeenCalledOnce();
    const requests = tui.requestRender.mock.calls.length;
    view.setContent("late result");
    view.setTitle("late");
    expect(tui.requestRender).toHaveBeenCalledTimes(requests);
  });
  it("takes only the rows short content needs and blanks the status row when all of it is shown", () => {
    const view = new DetailView({
      tui: surface(30),
      theme,
      keys: keys(),
      title: "Short",
      content: "one\ntwo\nthree",
      done: vi.fn(),
    });
    const rows = view.render(60);
    // Frame 2 + body 3 + blank status row 1 + hints 1: no header divider, so no
    // bare footer divider either, but a blank row keeps the hints off the content.
    expect(rows).toHaveLength(7);
    expect(plain(rows)).not.toContain("lines");
    expect(plain(rows)).not.toMatch(/│ ─+ │/);
    expect(plain(rows)).toMatch(/│ three +│ \n │ +│ \n │ Esc close/);
    view.setContent(text);
    expect(view.render(60)).toHaveLength(24);
    expect(plain(view.render(60))).toContain("── 1–20/80 lines ──");
  });
  it("scrolls by keyboard and wheel, honors key remapping, and shows formatted hints", () => {
    const tui = surface(15),
      bindings = keys();
    bindings.setUserBindings({ "tui.altScreen.pageDown": ["ctrl+n"] });
    const view = new DetailView({
      tui,
      theme,
      keys: bindings,
      title: "Details",
      content: text,
      done: vi.fn(),
      closeOnEnter: true,
    });
    view.render(50);
    view.handleInput("\x0e");
    expect(plain(view.render(50))).not.toContain("row00");
    expect(plain(view.render(80))).toContain("Enter/Esc close · ↑↓ PgUp/Ctrl+N Home/End");
    view.handleInput("\x1b[H");
    view.handleMouse(wheel(2));
    expect(plain(view.render(50))).toContain("row02");
    for (const width of [80, 5, 1, 0, 8, 20]) bounded(view.render(width), width, 12);
  });
});
