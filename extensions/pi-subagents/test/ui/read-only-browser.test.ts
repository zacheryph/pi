import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, type TuiMouseEvent, visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  type BrowserView, ReadOnlyBrowser, type ReadOnlyBrowserOptions, sanitizeBrowserText, showReadOnlyBrowser,
} from "#src/ui/read-only-browser";

const ESC = "\x1b", ENTER = "\r", DOWN = "\x1b[B", PAGE_DOWN = "\x1b[6~", PAGE_UP = "\x1b[5~";
const HOME = "\x1b[H", END = "\x1b[F";
const body = Array.from({ length: 100 }, (_, i) => `row${String(i).padStart(3, "0")}`).join("\n");
const view: BrowserView = {
  title: "Definitions", note: "Read-only snapshot",
  items: Array.from({ length: 40 }, (_, i) => ({
    id: String(i), label: `Agent${i}`, status: i % 2 ? "disabled" : "enabled",
    badge: { label: i % 2 ? "[disabled]" : "[enabled]", color: i % 2 ? "dim" : "success" },
    description: "hidden searchable description", detail: `Name: Agent${i}\n${body}`,
  })),
};
const plain = (text: string) => text.replaceAll(CURSOR_MARKER, "").replace(/\x1b\[[0-9;]*m/g, "");
function setup(input = view, rows = 40, overrides: Partial<ReadOnlyBrowserOptions> = {}) {
  const tui = {
    mode: "fullscreen" as ReadOnlyBrowserOptions["tui"]["mode"],
    terminal: { rows, columns: 100 }, requestRender: vi.fn(),
  };
  const options: ReadOnlyBrowserOptions = {
    tui, theme: { fg: (_color, text) => text, bold: text => text },
    keys: new KeybindingsManager(TUI_KEYBINDINGS), done: vi.fn(), view: input, ...overrides,
  };
  const browser = new ReadOnlyBrowser(options);
  browser.focused = true;
  return { browser, ...options, tui };
}
const output = (browser: ReadOnlyBrowser, width = 80) => browser.render(width).map(plain).join("\n");
const selected = (browser: ReadOnlyBrowser) => /→ Name: (Agent\d+)/.exec(output(browser))?.[1];
const firstRow = (browser: ReadOnlyBrowser, width = 80) => Number(/row(\d+)/.exec(output(browser, width))?.[1]);

// Handler tests use the actual component factory but do not block waiting for input.
function context(mode: ExtensionContext["mode"] = "tui", renderer = "fullscreen", hasUI = true) {
  type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
  const { tui, theme, keys } = setup();
  tui.mode = renderer as typeof tui.mode;
  const components: Awaited<ReturnType<Factory>>[] = [];
  const completions: unknown[] = [];
  const ui = {
    notify: vi.fn(),
    custom: vi.fn(async (factory: Factory) => {
      let result: unknown;
      components.push(await factory(tui as unknown as Parameters<Factory>[0], theme as Parameters<Factory>[1], keys as Parameters<Factory>[2], value => {
        result = value;
        completions.push(value);
      }));
      return result;
    }),
  };
  return { ctx: { mode, hasUI, ui: ui as unknown as ExtensionContext["ui"] }, ui, components, completions };
}

describe("showReadOnlyBrowser", () => {
  it.each(["fullscreen", "regular"])("probes actual %s renderer before mounting", async renderer => {
    const { ctx, ui, components, completions } = context("tui", renderer);
    await showReadOnlyBrowser(ctx, view);
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(components[0].render(80)).toEqual([]);
    expect(completions).toEqual([renderer]);
    expect(ui.custom).toHaveBeenLastCalledWith(expect.any(Function), renderer === "fullscreen"
      ? { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } }
      : { overlay: false });
    expect(components[1].render(80)).toHaveLength(32);
    components[1].handleInput?.("\x03");
    expect(completions).toEqual([renderer, undefined]);
  });

  it.each(["rpc", "json", "print"] as const)("never opens terminal UI in %s mode", async mode => {
    const { ctx, ui } = context(mode);
    await showReadOnlyBrowser(ctx, view);
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Read-only browser requires TUI mode.", "warning");
  });

  it("guards hasUI and captures item/badge before awaiting renderer probe", async () => {
    const noUI = context("tui", "fullscreen", false);
    await showReadOnlyBrowser(noUI.ctx, view);
    expect(noUI.ui.custom).not.toHaveBeenCalled();
    const { ctx, ui, components } = context();
    const snapshot = { ...view, items: view.items.map(item => ({ ...item, badge: { ...item.badge! } })) };
    const original = ui.custom.getMockImplementation()!;
    ui.custom.mockImplementationOnce(async factory => {
      snapshot.items[0].detail = "mutated";
      snapshot.items[0].badge.label = "bad badge";
      return original(factory);
    });
    await showReadOnlyBrowser(ctx, snapshot);
    const browser = components[1] as ReadOnlyBrowser;
    expect(output(browser)).not.toContain("bad badge");
    browser.handleInput(ENTER);
    expect(output(browser)).toContain("row000");
    expect(output(browser)).not.toContain("mutated");
  });
});

describe("ReadOnlyBrowser", () => {
  it("centers rounded padded title, right-aligns status, hides description", () => {
    const { browser } = setup();
    const lines = browser.render(80).map(plain);
    expect(lines).toHaveLength(32);
    expect(lines[0]).toBe(" ".repeat(80));
    expect(lines.at(-1)).toBe(lines[0]);
    const top = /^ ╭(─*) Definitions (─*)╮ $/.exec(lines[1]);
    expect(top).not.toBeNull();
    expect(Math.abs(top![1].length - top![2].length)).toBeLessThanOrEqual(1);
    expect(lines[2]).toBe(` │${" ".repeat(76)}│ `);
    expect(lines.at(-3)).toBe(lines[2]);
    expect(lines.at(-2)).toBe(` ╰${"─".repeat(76)}╯ `);
    expect(lines.find(line => line.includes("→ Name: Agent0"))).toMatch(/Agent0 +\[enabled\] │ $/);
    expect(lines.join("\n")).not.toContain("hidden searchable description");
    expect(lines.join("\n")).toContain("Enter to see · Esc to close/clear filter");
    expect(lines.join("\n")).toContain("Ctrl+C close");
  });

  it("clips names before status, themes badges independently of selection, and renders Body full-width", () => {
    const detail = `Name: ${"長".repeat(100)}\nDescription: test\n\nBody\n${"x".repeat(200)}\n  indented instruction`;
    const { browser } = setup({ ...view, items: [{
      id: "long", label: "長".repeat(100), status: "enabled", description: "test", detail,
      badge: { label: "[enabled]", color: "success" },
    }] }, 100, { theme: {
      fg: (token, text) => `\x1b[${token === "success" ? 32 : token === "accent" ? 36 : 90}m${text}\x1b[0m`,
      bold: text => text,
    } });
    for (const width of [24, 40, 80]) {
      const row = browser.render(width).find(line => line.includes("[enabled]"))!;
      expect(row).toContain("\x1b[32m[enabled]\x1b[0m");
      expect(plain(row)).toMatch(/ +\[enabled\] │ $/);
      expect(visibleWidth(row)).toBe(width);
      browser.handleInput(ENTER);
      const detailRows = browser.render(width);
      expect(detailRows.filter(line => line.includes("[enabled]"))).toHaveLength(1);
      const fullBodyLine = detailRows.map(plain).find(line => line.includes("xxxxx"))!;
      expect(fullBodyLine).toBe(` │ ${"x".repeat(width - 6)} │ `);
      expect(detailRows.map(plain)).toContain(` │ Body${" ".repeat(width - 10)} │ `);
      expect(detailRows.map(plain).find(line => line.includes("indented"))).toMatch(/^ │   indented/);
      browser.handleInput(ESC);
    }
  });

  it("filters name/status/description; Escape backs out, clears filter, closes once", () => {
    const { browser, done, tui } = setup();
    browser.handleInput("disabled");
    expect(selected(browser)).toBe("Agent1");
    expect(output(browser)).toContain("1/20 items · 40 total");
    browser.handleInput(DOWN);
    expect(selected(browser)).toBe("Agent3");
    browser.handleInput(ENTER);
    expect(output(browser)).toContain("Definitions / Agent3");
    expect(output(browser)).toContain("Esc to go back");
    expect(browser.render(80).join("")).not.toContain(CURSOR_MARKER);
    browser.handleInput(PAGE_DOWN);
    expect(firstRow(browser)).toBeGreaterThan(0);
    browser.handleInput(ESC);
    expect(selected(browser)).toBe("Agent3");
    expect(output(browser)).toContain("Filter: disabled");
    expect(browser.render(80).join("")).toContain(CURSOR_MARKER);
    browser.handleInput(ESC);
    browser.handleInput("hidden searchable description");
    expect(output(browser)).toContain("40 total");
    browser.handleInput(ESC);
    browser.handleInput("Agent39");
    expect(selected(browser)).toBe("Agent39");
    browser.handleInput(ESC);
    expect(done).not.toHaveBeenCalled();
    browser.handleInput(ESC);
    browser.handleInput(ESC);
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it.each(["list", "filtered", "detail"])("Ctrl+C closes once from %s", state => {
    const { browser, done } = setup();
    if (state === "filtered") browser.handleInput("Agent");
    if (state === "detail") browser.handleInput(ENTER);
    browser.handleInput("\x03");
    browser.handleInput("\x03");
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("pages list/detail by visible body, clamps ends, recalculates on resize", () => {
    const { browser, tui } = setup();
    const count = browser.render(80).filter(line => /Name: Agent\d+/.test(line)).length;
    browser.handleInput(PAGE_DOWN);
    expect(selected(browser)).toBe(`Agent${count}`);
    browser.handleInput(END);
    expect(selected(browser)).toBe("Agent39");
    browser.handleInput(HOME);
    expect(selected(browser)).toBe("Agent0");
    browser.handleInput(ENTER);
    const detailRows = browser.render(80).filter(line => /row\d+/.test(line)).length + 1; // Name row
    browser.handleInput(PAGE_DOWN);
    expect(firstRow(browser)).toBe(detailRows - 1);
    browser.handleInput(PAGE_UP);
    expect(firstRow(browser)).toBe(0);
    browser.handleInput(END);
    expect(output(browser)).toContain("row099");
    tui.terminal.rows = 10;
    browser.render(40);
    browser.handleInput(END);
    expect(output(browser, 40)).toContain("row099");
    browser.handleInput(HOME);
    expect(firstRow(browser, 40)).toBe(0);
  });

  it("honors remapped page keys and prints actual bindings", () => {
    const { browser } = setup(view, 40, {
      keys: new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.altScreen.pageDown": "ctrl+f", "tui.altScreen.pageUp": "ctrl+b",
      }),
    });
    expect(output(browser, 120)).toContain("Ctrl+B/Ctrl+F");
    browser.handleInput(PAGE_DOWN);
    expect(selected(browser)).toBe("Agent0");
    browser.handleInput("\x06");
    expect(selected(browser)).not.toBe("Agent0");
    browser.handleInput("\x02");
    expect(selected(browser)).toBe("Agent0");
  });

  it("empty/no-match lists safely accept navigation and Enter", () => {
    for (const input of [{ ...view, items: [] }, view]) {
      const { browser, done } = setup(input);
      browser.handleInput("missing");
      browser.handleInput(DOWN);
      browser.handleInput(END);
      browser.handleInput(ENTER);
      expect(output(browser)).toContain("No matching items.");
      expect(output(browser)).toContain("0/0 items");
      expect(done).not.toHaveBeenCalled();
    }
  });

  it("bounds Unicode and trusted ANSI across tiny layouts, resize, focus and theme changes", () => {
    let color = 31;
    const strange = "日本語 👩‍💻 e\u0301 🦀 ".repeat(20);
    const { browser, tui } = setup({ ...view, title: strange, note: strange, items: [{
      id: "one", label: strange, description: strange, detail: strange,
      badge: { label: "[enabled]", color: "success" },
    }] }, 40, { theme: { fg: (_token, text) => `\x1b[${color}m${text}\x1b[0m`, bold: text => text } });
    for (const height of [0, 1, 2, 3, 5, 10, 40]) {
      tui.terminal.rows = height;
      for (const width of [0, 1, 2, 3, 4, 5, 7, 12, 40, 80]) {
        const lines = browser.render(width);
        expect(lines).toHaveLength(width === 0 ? 0 : Math.floor(height * .8));
        for (const line of lines) expect(visibleWidth(line)).toBe(width);
      }
    }
    browser.handleInput("日本語👩‍💻".repeat(30));
    for (const width of [15, 20, 40, 80]) {
      const filter = browser.render(width).find(line => line.includes(CURSOR_MARKER))!;
      expect(filter).toBeDefined();
      expect(visibleWidth(filter.split(CURSOR_MARKER)[0])).toBeLessThan(width - 3);
    }
    browser.focused = false;
    expect(browser.render(80).join("")).not.toContain(CURSOR_MARKER);
    color = 32;
    browser.invalidate();
    expect(browser.render(80).join("")).toContain("\x1b[32m");
    browser.handleInput(ESC);
    browser.handleInput(ENTER);
    for (const width of [1, 2, 7, 20, 80]) {
      for (const line of browser.render(width)) expect(visibleWidth(line)).toBe(width);
    }
  });

  it("scrubs terminal commands/control/bidi from all fields and bracketed paste without mutation", () => {
    const unsafe = "safe\x1b[2J\x1b]52;c;bad\x07\x1b_Pi:c\x07\x1bPpayload\x1b\\\x9b31m\x08\r\u202eend";
    expect(sanitizeBrowserText(unsafe)).toBe("safeend");
    expect(sanitizeBrowserText("ok\x1b]0;unfinished")).toBe("ok");
    const item = Object.freeze({
      id: unsafe, label: unsafe, status: unsafe, description: unsafe, detail: unsafe,
      badge: Object.freeze({ label: unsafe, color: "success" as const }),
    });
    const { browser } = setup(Object.freeze({ title: unsafe, note: unsafe, items: Object.freeze([item]) }));
    browser.focused = false;
    expect(output(browser)).not.toMatch(/[\x07\x08\x9b\u202e]/);
    browser.handleInput("\x1b[200~safe\x1b]52;c;bad\x07\x1b[201~");
    expect(output(browser)).toContain("Filter: safe");
    browser.handleInput(ENTER);
    expect(output(browser)).toContain("safeend");
    expect(item.detail).toBe(unsafe);
  });

  it("wheel navigates fullscreen only; disposal disables input", () => {
    const { browser, tui, done } = setup();
    const wheel = { type: "wheel", wheelDelta: 3 } as TuiMouseEvent;
    browser.render(80);
    expect(browser.handleMouse(wheel)).toEqual({ handled: true });
    expect(selected(browser)).toBe("Agent3");
    expect(browser.handleMouse({ type: "click" } as TuiMouseEvent)).toBeUndefined();
    tui.mode = "regular";
    expect(browser.handleMouse(wheel)).toBeUndefined();
    browser.dispose();
    browser.handleInput("\x03");
    expect(done).not.toHaveBeenCalled();
  });
});
