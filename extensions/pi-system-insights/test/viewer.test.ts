import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type KeybindingsConfig,
  type TuiMouseEvent,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { InsightView } from "../src/types.js";
import { InsightViewer, type InsightViewerOptions, sanitizeInsightText, showInsightView } from "../src/viewer.js";

const UP = "\x1b[A", DOWN = "\x1b[B", ESC = "\x1b", ENTER = "\r";
const PAGE_UP = "\x1b[5~", PAGE_DOWN = "\x1b[6~", HOME = "\x1b[H", END = "\x1b[F";
const plain = (text: string) => text.replaceAll(CURSOR_MARKER, "").replace(/\x1b\[[0-9;]*m/g, "");
const rows = (n: number) => Array.from({ length: n }, (_, i) => `row${String(i).padStart(3, "0")}`).join("\n");
const items = (n = 40) => Array.from({ length: n }, (_, i) => ({
  id: `id${i}`, label: `Tool${i}`, status: i % 2 ? "inactive" : "active",
  description: "Searchable description", detail: `Detail${i}\n${rows(100)}`,
}));
const listView: InsightView = { title: "Tools", note: "Read-only snapshot", items: items() };
const textView: InsightView = { title: "Prompt", note: "Captured prompt", text: rows(100) };
const skillView: InsightView = {
  title: "Skills", note: "Read-only snapshot",
  legend: [
    { label: "green", color: "success", meaning: "fresh observation" },
    { label: "grey", color: "dim", meaning: "unobserved/dirty" },
  ],
  items: ["fresh", "dirty"].map((label, index) => ({
    id: label, label, description: `Hidden searchable description ${label}`,
    status: "Verbose state must not be shown",
    badge: { label: "[loaded]", color: index ? "dim" as const : "success" as const },
    detail: `Name: ${label}\nDescription: Hidden searchable description ${label}\n${rows(100)}`,
  })),
};
function setup(view: InsightView = textView, rows = 40, overrides: Partial<InsightViewerOptions> = {}) {
  const tui = {
    mode: "fullscreen" as InsightViewerOptions["tui"]["mode"], terminal: { rows, columns: 100 },
    requestRender: vi.fn(),
  };
  const options: InsightViewerOptions = {
    tui, theme: { fg: (_color, text) => text, bold: (text) => text },
    keys: new KeybindingsManager(TUI_KEYBINDINGS), done: vi.fn(), view, ...overrides,
  };
  const viewer = new InsightViewer(options);
  viewer.focused = true;
  return { viewer, ...options, tui };
}
const output = (viewer: InsightViewer, width = 80) => viewer.render(width).map(plain).join("\n");
const contentRowCount = (viewer: InsightViewer, width = 80) => viewer.render(width).map(plain)
  .filter((line) => /row\d{3}/.test(line)).length;
const listRowCount = (viewer: InsightViewer, width = 80) => viewer.render(width).map(plain)
  .filter((line) => /(?:→|  ) Tool\d+/.test(line)).length;
const firstRow = (viewer: InsightViewer, width = 80) => Number(/row(\d+)/.exec(output(viewer, width))?.[1]);
const selected = (viewer: InsightViewer) => /→ (Tool\d+)/.exec(output(viewer))?.[1];

describe("showInsightView", () => {
  type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
  function context(mode: ExtensionContext["mode"] = "tui", fullscreen = true, hasUI = true) {
    const { tui, theme, keys } = setup();
    tui.mode = fullscreen ? "fullscreen" : "regular";
    const components: Awaited<ReturnType<Factory>>[] = [];
    const completions: unknown[] = [];
    const ui = {
      notify: vi.fn(),
      custom: vi.fn(async (factory: Factory) => {
        let result: unknown;
        components.push(await factory(tui as unknown as Parameters<Factory>[0], theme as Parameters<Factory>[1], keys as Parameters<Factory>[2], (value) => {
          result = value;
          completions.push(value);
        }));
        return result;
      }),
    };
    return { ctx: { mode, hasUI, ui: ui as unknown as ExtensionContext["ui"] }, ui, components, completions };
  }

  it("probes actual tui.mode, returns nothing, then mounts centered focused 80% overlay", async () => {
    const { ctx, ui, components, completions } = context();
    await showInsightView(ctx, textView);
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(ui.custom.mock.calls[0]).toHaveLength(1);
    expect(components[0].render(80)).toEqual([]);
    expect(completions).toEqual(["fullscreen"]);
    expect(ui.custom).toHaveBeenLastCalledWith(expect.any(Function), {
      overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" },
    });
    components[1].handleInput?.("\x03");
    expect(completions).toEqual(["fullscreen", undefined]);
  });

  it("mounts regular mode non-overlay, bounded to 80% rows", async () => {
    const { ctx, ui, components } = context("tui", false);
    await showInsightView(ctx, textView);
    expect(ui.custom).toHaveBeenLastCalledWith(expect.any(Function), { overlay: false });
    expect(components[1].render(80)).toHaveLength(32);
  });

  it.each(["rpc", "json", "print"] as const)("warns in %s mode without custom", async (mode) => {
    const { ctx, ui } = context(mode);
    await showInsightView(ctx, textView);
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("System insights viewer requires TUI mode.", "warning");
  });

  it("guards hasUI too", async () => {
    const { ctx, ui } = context("tui", true, false);
    await showInsightView(ctx, textView);
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("clones nested badge and legend entries before async mode probe", async () => {
    const { ctx, ui, components } = context();
    const view = {
      ...skillView,
      items: skillView.items!.map((item) => ({ ...item, badge: { ...item.badge! } })),
      legend: skillView.legend!.map((entry) => ({ ...entry })),
    };
    const original = ui.custom.getMockImplementation()!;
    ui.custom.mockImplementationOnce(async (factory) => {
      view.items[0].badge.label = "mutated badge";
      view.items[0].badge.color = "dim";
      view.legend[0].label = "mutated legend";
      view.legend[0].meaning = "wrong meaning";
      return original(factory);
    });
    await showInsightView(ctx, view);
    const viewer = components[1] as InsightViewer;
    expect(output(viewer)).toContain("[loaded]");
    expect(output(viewer)).toContain("green=fresh observation");
    expect(output(viewer)).not.toContain("mutated");
    expect(output(viewer)).not.toContain("wrong meaning");
  });

  it("captures snapshot before async mode probe", async () => {
    const { ctx, ui, components } = context();
    const view = { ...listView, items: items(1) };
    const original = ui.custom.getMockImplementation()!;
    ui.custom.mockImplementationOnce(async (factory) => {
      view.items[0].detail = "captured detail";
      const promise = original(factory);
      view.items[0].detail = "later mutation";
      return promise;
    });
    // Original detail is captured before either mutation in the probe.
    await showInsightView(ctx, view);
    components[1].handleInput?.(ENTER);
    expect(output(components[1] as InsightViewer)).toContain("Detail0");
    expect(output(components[1] as InsightViewer)).not.toContain("later mutation");
  });
});

describe("InsightViewer", () => {
  it("uses exactly floor(80% terminal rows), even for short content", () => {
    for (const height of [0, 1, 2, 3, 5, 10, 24, 40, 101]) {
      const { viewer } = setup({ ...textView, text: "short" }, height);
      expect(viewer.render(80)).toHaveLength(Math.floor(height * 0.8));
    }
  });

  it("keeps prompt syntax literal, without Markdown reinterpretation", () => {
    const raw = "# Heading\n**bold** [link](file:///tmp)\n```ts\n  const x = 1;\n```";
    const { viewer } = setup({ ...textView, text: raw });
    for (const line of raw.split("\n")) expect(output(viewer)).toContain(line);
  });

  it("centers title in rounded frame with one-column and one-row buffers", () => {
    const { viewer } = setup();
    const lines = viewer.render(80).map(plain);
    expect(lines).toHaveLength(32);
    for (const line of lines) expect(visibleWidth(line)).toBe(80);
    expect(lines[0]).toBe(" ".repeat(80));
    expect(lines.at(-1)).toBe(" ".repeat(80));
    const top = /^ ╭(─*) System insights · Prompt (─*)╮ $/.exec(lines[1]);
    expect(top).not.toBeNull();
    expect(Math.abs(top![1].length - top![2].length)).toBeLessThanOrEqual(1);
    expect(lines[2]).toBe(` │${" ".repeat(76)}│ `);
    expect(lines.at(-3)).toBe(lines[2]);
    expect(lines.at(-2)).toBe(` ╰${"─".repeat(76)}╯ `);
    const rule = lines.findIndex((line) => line.startsWith(" ├"));
    expect(lines[rule + 1]).toContain("Esc to close");
    expect(lines[rule + 2]).toMatch(/1–\d+\/100 lines/);
    expect(lines[rule + 3]).toContain("↑↓ scroll");
    expect(lines[4]).toContain("row000");
    const body = contentRowCount(viewer);
    expect(rule - 4).toBe(body);
    viewer.handleInput(PAGE_DOWN);
    expect(firstRow(viewer)).toBe(body);
  });

  it("indexes hide descriptions but keep search metadata and detail content", () => {
    for (const view of [listView, skillView]) {
      const { viewer } = setup(view);
      const description = view.items![0].description;
      expect(output(viewer)).not.toContain(description);
      viewer.handleInput(description);
      expect(output(viewer)).toContain(`Filter: ${description}`);
      viewer.handleInput(ENTER);
      expect(output(viewer)).toContain(view.items![0].detail.split("\n")[0]);
      if (view === skillView) expect(output(viewer)).toContain(`Description: ${description}`);
      expect(output(viewer)).toContain(`System insights · ${view.title} / ${view.items![0].label}`);
      expect(output(viewer)).toContain("Esc to go back");
    }
  });

  it("right-aligns skill badges independently of selection and colors legend at render time", () => {
    let palette = { success: 32, dim: 90, accent: 36 };
    const theme: InsightViewerOptions["theme"] = {
      fg: (token, text) => `\x1b[${palette[token as keyof typeof palette] ?? 37}m${text}\x1b[0m`,
      bold: (text) => text,
    };
    const { viewer } = setup(skillView, 40, { theme });
    const raw = viewer.render(80);
    const indexRows = raw.filter((line) => plain(line).includes("Name:"));
    expect(indexRows).toHaveLength(2);
    expect(indexRows[0]).toContain("\x1b[32m[loaded]\x1b[0m");
    expect(indexRows[1]).toContain("\x1b[90m[loaded]\x1b[0m");
    for (const line of indexRows) expect(plain(line)).toMatch(/Name: \w+ +\[loaded\] │ $/);
    expect(raw.join("\n")).not.toContain("Verbose state");
    expect(raw.join("\n")).toContain("\x1b[32mgreen\x1b[0m");
    expect(raw.join("\n")).toContain("\x1b[90mgrey\x1b[0m");
    expect(output(viewer)).toContain("green=fresh observation · grey=unobserved/dirty");
    expect(output(viewer)).not.toContain("in context");
    expect(output(viewer)).toContain("Enter to see · Esc to close/clear filter");
    viewer.handleInput(ENTER);
    const detail = viewer.render(80);
    const name = detail.find((line) => plain(line).includes("Name: fresh"))!;
    expect(name).toContain("\x1b[32m[loaded]\x1b[0m");
    expect(plain(name)).toMatch(/Name: fresh +\[loaded\] │ $/);
    expect(detail.filter((line) => plain(line).includes("[loaded]"))).toHaveLength(1);
    expect(output(viewer)).toContain("green=fresh observation · grey=unobserved/dirty");
    viewer.handleInput(DOWN);
    expect(output(viewer)).not.toContain("[loaded]");
    viewer.handleInput(HOME);
    palette = { success: 92, dim: 2, accent: 96 };
    viewer.invalidate();
    expect(viewer.render(80).join("\n")).toContain("\x1b[92m[loaded]\x1b[0m");
    viewer.handleInput(ESC);
    viewer.handleInput(DOWN);
    viewer.handleInput(ENTER);
    expect(viewer.render(80).find((line) => plain(line).includes("Name: dirty")))
      .toContain("\x1b[2m[loaded]\x1b[0m");
  });

  it("clips long names before badges, keeps right columns aligned, and omits oversized indicators", () => {
    const long = { ...skillView.items![0], label: "長".repeat(100), detail: `Name: ${"長".repeat(100)}\nsecond line` };
    const { viewer } = setup({ ...skillView, items: [long] });
    for (const width of [24, 40, 80]) {
      const line = viewer.render(width).map(plain).find((line) => line.includes("[loaded]"))!;
      expect(line).toMatch(/ +\[loaded\] │ $/);
      expect(visibleWidth(line)).toBe(width);
      viewer.handleInput(ENTER);
      const detail = viewer.render(width).map(plain);
      expect(detail.filter((row) => row.includes("[loaded]"))).toHaveLength(1);
      expect(visibleWidth(detail.find((row) => row.includes("[loaded]"))!)).toBe(width);
      viewer.handleInput(ESC);
    }
    for (const line of viewer.render(8)) expect(visibleWidth(line)).toBeLessThanOrEqual(8);
  });

  it("tool statuses align right without rendering descriptions", () => {
    const { viewer } = setup(listView);
    const lines = viewer.render(80).map(plain);
    expect(lines.find((line) => line.includes("→ Tool0"))).toMatch(/→ Tool0 +active │ $/);
    expect(lines.find((line) => line.includes("  Tool1 "))).toMatch(/Tool1 +inactive │ $/);
    expect(lines.join("\n")).not.toContain("Searchable description");
    expect(lines[4]).toContain("Filter:");
    expect(lines[5]).toContain("→ Tool0");
    const rule = lines.findIndex((line) => line.startsWith(" ├"));
    expect(rule - 5).toBe(listRowCount(viewer));
    expect(lines[rule + 2]).toContain("1/40 items · 40 total");
  });

  it("tiny layouts prioritize core actions, relax chrome, and stay fully padded", () => {
    const { viewer, tui } = setup(listView, 10);
    let lines = viewer.render(40).map(plain);
    expect(lines).toHaveLength(8);
    expect(lines.join("\n")).toContain("Enter see · Esc clear/close");
    expect(lines.join("\n")).not.toContain("Ctrl+C");
    tui.terminal.rows = 7; // five rows: frame, body, rule, core help
    expect(output(viewer, 20)).toContain("Enter · Esc");
    for (const width of [1, 2, 3, 4, 5, 7, 12, 40]) {
      for (const height of [0, 1, 2, 3, 5, 10, 40]) {
        tui.terminal.rows = height;
        lines = viewer.render(width).map(plain);
        expect(lines).toHaveLength(Math.floor(height * .8));
        for (const line of lines) expect(visibleWidth(line)).toBe(width);
      }
    }
  });

  it("caches plain wrapping through scroll/theme invalidation, keyed by inner content width", () => {
    const { viewer } = setup();
    const cache = viewer as unknown as { layout: { width: number; lines: string[] } };
    viewer.render(80);
    const first = cache.layout;
    expect(first.width).toBe(74);
    viewer.handleInput(DOWN);
    viewer.render(80);
    viewer.invalidate();
    viewer.render(80);
    expect(cache.layout).toBe(first);
    viewer.render(40);
    expect(cache.layout).not.toBe(first);
    expect(cache.layout.width).toBe(34);
  });

  it("filters descriptions, drills down, scrolls detail, then preserves filter and selection", () => {
    const { viewer, done, tui } = setup(listView);
    viewer.handleInput("Searchable");
    viewer.handleInput(DOWN);
    viewer.handleInput(DOWN);
    expect(selected(viewer)).toBe("Tool2");
    viewer.handleInput(ENTER);
    expect(output(viewer)).toContain("Detail2");
    expect(viewer.render(80).join("")).not.toContain(CURSOR_MARKER);
    viewer.handleInput(PAGE_DOWN);
    expect(firstRow(viewer)).toBeGreaterThan(0);
    viewer.handleInput(ESC);
    expect(selected(viewer)).toBe("Tool2");
    expect(output(viewer)).toContain("Filter: Searchable");
    expect(viewer.render(80).join("")).toContain(CURSOR_MARKER);
    expect(done).not.toHaveBeenCalled();
    viewer.handleInput(ESC);
    expect(output(viewer)).not.toContain("Filter: Searchable");
    expect(done).not.toHaveBeenCalled();
    viewer.handleInput(ESC);
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(undefined);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it.each(["prompt", "list", "detail", "filtered"])("Ctrl+C closes from %s, once", (state) => {
    const { viewer, done } = setup(state === "prompt" ? textView : listView);
    if (state === "detail") viewer.handleInput(ENTER);
    if (state === "filtered") viewer.handleInput("Tool");
    viewer.handleInput("\x03");
    viewer.handleInput("\x03");
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("pages prompt by body height, clamps ends, handles Home/End and resize", () => {
    const { viewer, tui } = setup();
    const body = contentRowCount(viewer); // only body, after frame/padding/footer
    expect(firstRow(viewer)).toBe(0);
    viewer.handleInput(PAGE_DOWN);
    expect(firstRow(viewer)).toBe(body);
    viewer.handleInput(PAGE_UP);
    expect(firstRow(viewer)).toBe(0);
    viewer.handleInput(END);
    expect(output(viewer)).toContain("row099");
    viewer.handleInput(HOME);
    expect(firstRow(viewer)).toBe(0);
    tui.terminal.rows = 10;
    expect(viewer.render(50)).toHaveLength(8);
    const resizedBody = contentRowCount(viewer, 50);
    viewer.handleInput(PAGE_DOWN);
    expect(firstRow(viewer, 50)).toBe(resizedBody);
  });

  it("pages list and keeps selected row visible through overflow and resize", () => {
    const { viewer, tui } = setup(listView);
    const body = listRowCount(viewer);
    viewer.handleInput(PAGE_DOWN);
    expect(selected(viewer)).toBe(`Tool${body}`);
    viewer.handleInput(END);
    expect(selected(viewer)).toBe("Tool39");
    tui.terminal.rows = 10;
    expect(viewer.render(80)).toHaveLength(8);
    expect(selected(viewer)).toBe("Tool39");
    const resizedBody = listRowCount(viewer);
    viewer.handleInput(PAGE_UP);
    expect(selected(viewer)).toBe(`Tool${39 - resizedBody}`);
    viewer.handleInput(HOME);
    expect(selected(viewer)).toBe("Tool0");
  });

  it("honors remapped paging and shows actual keys", () => {
    const bindings: KeybindingsConfig = {
      "tui.altScreen.pageDown": "ctrl+f", "tui.altScreen.pageUp": "ctrl+b",
      "tui.altScreen.top": "ctrl+home", "tui.altScreen.bottom": "ctrl+end",
    };
    const { viewer } = setup(textView, 40, { keys: new KeybindingsManager(TUI_KEYBINDINGS, bindings) });
    expect(output(viewer, 120)).toContain("Ctrl+B/Ctrl+F · Home/End · Ctrl+Home/Ctrl+End");
    viewer.handleInput(PAGE_DOWN);
    expect(firstRow(viewer)).toBe(0);
    const body = contentRowCount(viewer);
    viewer.handleInput("\x06");
    expect(firstRow(viewer)).toBe(body);
    viewer.handleInput("\x02");
    expect(firstRow(viewer)).toBe(0);
  });

  it("empty list and no matches stay bounded and Enter is safe", () => {
    const { viewer, done } = setup({ ...listView, items: [] });
    viewer.handleInput(DOWN);
    viewer.handleInput(END);
    viewer.handleInput(ENTER);
    expect(output(viewer)).toContain("No matching items.");
    expect(output(viewer)).toContain("0/0 items");
    expect(done).not.toHaveBeenCalled();
    const populated = setup(listView).viewer;
    populated.handleInput("does not exist");
    populated.handleInput(ENTER);
    expect(output(populated)).toContain("0/0 items · 40 total");
  });

  it("IME focus propagates only to visible search Input", () => {
    const { viewer } = setup(listView);
    viewer.handleInput("日本語👩‍💻");
    expect(output(viewer)).toContain("日本語👩‍💻");
    expect(viewer.render(80).join("")).toContain(CURSOR_MARKER);
    for (const width of [1, 2, 4, 8, 9, 10, 15]) {
      for (const line of viewer.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    viewer.focused = false;
    expect(viewer.render(80).join("")).not.toContain(CURSOR_MARKER);
  });

  it("keeps IME marker inside padded input while a long Unicode query scrolls horizontally", () => {
    const { viewer } = setup(listView);
    viewer.handleInput("日本語👩‍💻".repeat(30));
    for (const width of [15, 20, 40, 80]) {
      const lines = viewer.render(width);
      const filter = lines.find((line) => line.includes(CURSOR_MARKER))!;
      expect(filter).toBeDefined();
      const cursorColumn = visibleWidth(filter.split(CURSOR_MARKER)[0]);
      expect(cursorColumn).toBeGreaterThanOrEqual(3 + "Filter: ".length);
      expect(cursorColumn).toBeLessThan(width - 3);
      expect(visibleWidth(filter)).toBe(width);
      expect(plain(filter)).toMatch(/^ │ Filter: .* │ $/);
    }
  });

  it("bounds Unicode and trusted theme ANSI at tiny widths, heights and on invalidate", () => {
    let color = 31;
    const theme: InsightViewerOptions["theme"] = {
      fg: (_token, text) => `\x1b[${color}m${text}\x1b[0m`, bold: (text) => `\x1b[1m${text}\x1b[22m`,
    };
    const strange = "日本語 👩‍💻 e\u0301 中文 🦀 ".repeat(12);
    for (const view of [{ title: strange, note: strange, text: strange }, {
      title: strange, note: strange, items: [{ id: "one", label: strange, status: strange, description: strange, detail: strange }],
    }]) {
      const { viewer, tui } = setup(view, 40, { theme });
      for (const height of [1, 2, 3, 5, 8, 40]) {
        tui.terminal.rows = height;
        for (const width of [0, 1, 2, 3, 4, 7, 20, 80]) {
          const lines = viewer.render(width);
          expect(lines.length).toBeLessThanOrEqual(Math.floor(height * 0.8));
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
      color = 32;
      viewer.invalidate();
      expect(viewer.render(80).join("\n")).toContain("\x1b[32m");
    }
  });

  it("sanitizes all untrusted fields and pasted search, without mutating source", () => {
    const malicious = "safe\x1b[2J\x1b]52;c;bad\x07\x1b_Pi:c\x07\x1bPpayload\x1b\\\x9b31m\x07\x08\r\u202eend";
    expect(sanitizeInsightText(malicious)).toBe("safeend");
    expect(sanitizeInsightText("ok\x1b]0;unfinished")).toBe("ok");
    const source = Object.freeze({ title: malicious, note: malicious,
      items: Object.freeze([Object.freeze({ id: malicious, label: malicious, status: malicious, description: malicious, detail: malicious,
        badge: Object.freeze({ label: malicious, color: "success" as const }),
      })]),
      legend: Object.freeze([Object.freeze({ label: malicious, color: "dim" as const, meaning: malicious })]),
    });
    const { viewer } = setup(source);
    viewer.focused = false;
    expect(output(viewer)).not.toMatch(/[\x07\x08\x9b\u202e]/);
    viewer.handleInput("\x1b[200~safe\x1b]52;c;bad\x07\x1b[201~");
    expect(output(viewer)).toContain("Filter: safe");
    viewer.handleInput(ENTER);
    expect(output(viewer)).toContain("safeend");
    expect(source.items[0].detail).toBe(malicious);
  });

  it("wraps plain long text at content width after padding/frame and recomputes after resize", () => {
    const { viewer } = setup({ ...textView, text: "漢字".repeat(400) });
    viewer.render(40);
    viewer.handleInput(END);
    const narrow = wrapTextWithAnsi("漢字".repeat(400), 40 - 6).length;
    expect(output(viewer, 40)).toContain(`${narrow}/${narrow} lines`);
    viewer.render(80);
    const wide = wrapTextWithAnsi("漢字".repeat(400), 80 - 6).length;
    expect(output(viewer, 80)).toContain(`${wide}/${wide} lines`);
  });

  it("wheel scrolls fullscreen only; dispose stops input", () => {
    const { viewer, tui, done } = setup();
    const wheel = { type: "wheel", wheelDelta: 3 } as TuiMouseEvent;
    viewer.render(80);
    expect(viewer.handleMouse(wheel)).toEqual({ handled: true });
    expect(firstRow(viewer)).toBe(3);
    expect(viewer.handleMouse({ type: "click" } as TuiMouseEvent)).toBeUndefined();
    tui.mode = "regular";
    expect(viewer.handleMouse(wheel)).toBeUndefined();
    viewer.dispose();
    viewer.handleInput("\x03");
    expect(done).not.toHaveBeenCalled();
  });
});
