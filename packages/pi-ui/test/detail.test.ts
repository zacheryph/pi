import { describe, expect, it, vi } from "vitest";
import { DetailView, TextViewport } from "../src/detail.ts";
import { bounded, keys, plain, surface, theme, wheel } from "./helpers.ts";

const text = Array.from(
  { length: 80 },
  (_, i) => `row${i.toString().padStart(2, "0")} 界 text`,
).join("\n");
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
describe("DetailView", () => {
  it("handles loading/results/errors through setContent and stops updating after disposal", () => {
    const tui = surface(),
      done = vi.fn();
    const view = new DetailView({
      tui,
      theme,
      keys: keys(),
      title: "Summary",
      content: "Loading…",
      done,
    });
    expect(plain(view.render(60))).toContain("Loading…");
    view.setContent(text);
    view.handleInput("\x1b[F");
    expect(plain(view.render(60))).toContain("row79");
    view.setContent("Could not load\x1b]0;bad\x07");
    expect(plain(view.render(60))).toContain("Could not load");
    view.handleInput("\x1b");
    view.handleInput("\x03");
    expect(done).toHaveBeenCalledOnce();
    const requests = tui.requestRender.mock.calls.length;
    view.setContent("late result");
    expect(tui.requestRender).toHaveBeenCalledTimes(requests);
  });
  it("scrolls by keyboard and fullscreen wheel, and honors key remapping", () => {
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
    });
    view.render(50);
    view.handleInput("\x0e");
    expect(plain(view.render(50))).not.toContain("row00");
    expect(plain(view.render(80))).toContain("ctrl+n");
    view.handleInput("\x1b[H");
    view.handleMouse(wheel(2));
    expect(plain(view.render(50))).toContain("row02");
    tui.mode = "regular";
    expect(view.handleMouse(wheel(1))).toBeUndefined();
    for (const width of [80, 5, 1, 0, 8, 20]) bounded(view.render(width), width, 12);
  });
});
