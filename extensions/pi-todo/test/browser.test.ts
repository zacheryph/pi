import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { type TodoState } from "../src/state.js";
import { ReadOnlyBrowser, type ReadOnlyBrowserOptions, showTodoBrowser, type TodoBrowserOptions } from "../src/ui/browser.js";
import { applyTodoReview, createTodoReviewState, type TodoActivity } from "../src/activity.js";

const ENTER = "\r", ESC = "\x1b", DOWN = "\x1b[B", PAGE_DOWN = "\x1b[6~", HOME = "\x1b[H", END = "\x1b[F";
const body = Array.from({ length: 100 }, (_, i) => `row${String(i).padStart(3, "0")}`).join("\n");
const snapshot: TodoState = {
  schemaVersion: 2, revision: 1,
  tasks: Array.from({ length: 30 }, (_, i) => ({ key: `t${i}`, subject: `Task${i}`, status: "pending", description: `hidden detail\n${body}` })),
};
function setup(rows = 40, renderer: "fullscreen" | "regular" = "fullscreen") {
  const tui = { mode: renderer, terminal: { rows, columns: 100 }, requestRender: vi.fn() };
  const theme: ReadOnlyBrowserOptions["theme"] = { fg: (_color, text) => text, bold: text => text };
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
  const components: Awaited<ReturnType<Factory>>[] = [];
  const done = vi.fn();
  const ui = { notify: vi.fn(), custom: vi.fn(async (factory: Factory) => {
    let result: unknown;
    components.push(await factory(tui as unknown as Parameters<Factory>[0], theme as Parameters<Factory>[1], keys as Parameters<Factory>[2], value => {
      result = value;
      done(value);
    }));
    return result;
  }) };
  const ctx = { mode: "tui", hasUI: true, ui } as unknown as ExtensionContext;
  return { tui, theme, keys, ctx, ui, done, components };
}
async function open(state = snapshot, rows = 40, renderer: "fullscreen" | "regular" = "fullscreen") {
  const env = setup(rows, renderer);
  await showTodoBrowser(env.ctx, state);
  const browser = env.components[1] as ReadOnlyBrowser;
  browser.focused = true;
  return { ...env, browser };
}
const plain = (text: string) => text.replaceAll(CURSOR_MARKER, "").replace(/\x1b\[[0-9;]*m/g, "");
const output = (browser: ReadOnlyBrowser, width = 100) => browser.render(width).map(plain).join("\n");
const selected = (browser: ReadOnlyBrowser) => /→ (t\d+):/.exec(output(browser))?.[1];

describe("todo browser placement", () => {
  it.each(["fullscreen", "regular"] as const)("probes actual %s mode, not settings", async renderer => {
    const { ui, components, done, browser } = await open(snapshot, 40, renderer);
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(components[0].render(80)).toEqual([]);
    expect(ui.custom).toHaveBeenLastCalledWith(expect.any(Function), renderer === "fullscreen"
      ? { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } }
      : { overlay: false });
    expect(browser.render(80)).toHaveLength(32);
    browser.handleInput("\x03");
    expect(done.mock.calls).toEqual([[renderer], [undefined]]);
  });

  it.each(["rpc", "json", "print"] as const)("avoids custom UI in %s", async mode => {
    const { ctx, ui } = setup();
    await showTodoBrowser({ ...ctx, mode }, snapshot);
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Read-only browser requires TUI mode.", "warning");
  });

  it("guards hasUI and captures state before asynchronous probe", async () => {
    const env = setup();
    await showTodoBrowser({ ...env.ctx, hasUI: false }, snapshot);
    expect(env.ui.custom).not.toHaveBeenCalled();
    const state = structuredClone(snapshot);
    const original = env.ui.custom.getMockImplementation()!;
    env.ui.custom.mockImplementationOnce(async factory => {
      state.tasks[0].subject = "mutated";
      state.tasks[0].description = "mutated detail";
      return original(factory);
    });
    await showTodoBrowser(env.ctx, state);
    const browser = env.components[1] as ReadOnlyBrowser;
    expect(output(browser)).not.toContain("mutated");
    browser.handleInput(ENTER);
    expect(output(browser)).toContain("row000");
  });
});

describe("read-only todo browser", () => {
  it("renders centered padded title, dependencies and explicit mutation-command footer", async () => {
    const state = structuredClone(snapshot);
    state.tasks[1].dependsOn = ["t0"];
    const { browser } = await open(state);
    expect(output(browser)).toMatch(/╭─+ Todos ─+╮/);
    expect(output(browser)).toContain("/todos:add · /todos:clear");
    expect(output(browser)).not.toContain("hidden detail");
    browser.handleInput("blocked");
    expect(output(browser)).toContain("t1: Task1 ← t0");
    expect(output(browser)).toMatch(/t1: Task1 ← t0 +○ blocked/);
    expect(selected(browser)).toBe("t1");
    browser.handleInput(ENTER);
    expect(output(browser)).toContain("Dependencies:");
    expect(output(browser)).toContain("t0 — pending");
  });

  it("propagates focus to Input, searches description/status/key, navigates and backs out", async () => {
    const { browser, done } = await open();
    expect(browser.render(100).join("")).toContain(CURSOR_MARKER);
    browser.focused = false;
    expect(browser.render(100).join("")).not.toContain(CURSOR_MARKER);
    browser.focused = true;
    browser.handleInput("hidden detail");
    expect(output(browser)).toContain("30 total");
    browser.handleInput(DOWN);
    expect(selected(browser)).toBe("t1");
    browser.handleInput(ENTER);
    expect(browser.render(100).join("")).not.toContain(CURSOR_MARKER);
    expect(output(browser)).toContain("Subject: Task1");
    browser.handleInput(PAGE_DOWN);
    expect(output(browser)).not.toContain("row000");
    browser.handleInput(END);
    expect(output(browser)).toContain("row099");
    browser.handleInput(HOME);
    expect(output(browser)).toContain("Key: t1");
    browser.handleInput(ESC);
    expect(selected(browser)).toBe("t1");
    browser.handleInput(ESC);
    expect(selected(browser)).toBe("t0");
    browser.handleInput("t29");
    expect(selected(browser)).toBe("t29");
    browser.handleInput(ESC);
    browser.handleInput(ESC);
    browser.handleInput(ESC);
    expect(done.mock.calls).toEqual([["fullscreen"], [undefined]]);
  });

  it("pages list, honors remapped keys, resize scroll and bounds", async () => {
    const { browser, tui, keys } = await open();
    const count = browser.render(100).filter(line => /t\d+: Task/.test(line)).length;
    browser.handleInput(PAGE_DOWN);
    expect(selected(browser)).toBe(`t${count}`);
    browser.handleInput(END);
    expect(selected(browser)).toBe("t29");
    browser.handleInput(HOME);
    expect(selected(browser)).toBe("t0");
    keys.setUserBindings({ "tui.altScreen.pageDown": "ctrl+f", "tui.altScreen.pageUp": "ctrl+b" });
    expect(output(browser, 120)).toContain("Ctrl+B/Ctrl+F");
    browser.handleInput(PAGE_DOWN);
    expect(selected(browser)).toBe("t0");
    browser.handleInput("\x06");
    expect(selected(browser)).not.toBe("t0");
    browser.handleInput(ENTER);
    tui.terminal.rows = 10;
    browser.render(25);
    browser.handleInput(END);
    expect(output(browser, 25)).toContain("row099");
  });

  it("empty/no-match navigation safe; read-only against deeply frozen state", async () => {
    const state = structuredClone(snapshot);
    for (const task of state.tasks) Object.freeze(task);
    Object.freeze(state.tasks);
    Object.freeze(state);
    const before = JSON.stringify(state);
    for (const input of [state, { ...state, tasks: [] }]) {
      const { browser } = await open(input);
      browser.handleInput("missing");
      browser.handleInput(DOWN);
      browser.handleInput(END);
      browser.handleInput(ENTER);
      expect(output(browser)).toContain("No matching tasks.");
      expect(output(browser)).toContain("0/0 tasks");
    }
    expect(JSON.stringify(state)).toBe(before);
  });

  it("bounds width 1..30, tiny heights, Unicode, trusted ANSI and sanitizes paste", async () => {
    const unsafe = "safe\x1b[2J\x1b]52;c;bad\x07\x1b_Pi:c\x07\x9b31m\u202e\u200eend";
    const strange = "日本語 👩‍💻 e\u0301 🦀 ".repeat(20);
    const { browser, tui, theme } = await open({ ...snapshot, tasks: [{ key: unsafe, subject: `${unsafe}\n${strange}`, status: "pending", dependsOn: [unsafe], description: `${unsafe}\n${strange}` }] });
    theme.fg = (_token, text) => `\x1b[32m${text}\x1b[0m`;
    for (const height of [0, 1, 2, 3, 5, 10, 40]) {
      tui.terminal.rows = height;
      for (let width = 1; width <= 30; width++) {
        const lines = browser.render(width);
        expect(lines).toHaveLength(Math.floor(height * .8));
        for (const line of lines) expect(visibleWidth(line)).toBe(width);
      }
    }
    tui.terminal.rows = 40;
    browser.handleInput(`\x1b[200~safe\x1b]52;c;bad\x07\x1b[201~`);
    expect(output(browser)).toContain("Filter: safe");
    browser.handleInput(ENTER);
    expect(output(browser)).toContain("safeend");
    expect(output(browser)).not.toMatch(/[\x07\x9b\u202e\u200e]/);
    for (let width = 1; width <= 30; width++) {
      for (const line of browser.render(width)) expect(visibleWidth(line)).toBe(width);
    }
  });

  it("mouse wheel fullscreen only; dispose and close disable input", async () => {
    const { browser, tui, done } = await open();
    browser.render(100);
    const wheel = { type: "wheel", wheelDelta: 3 } as TuiMouseEvent;
    expect(browser.handleMouse(wheel)).toEqual({ handled: true });
    expect(selected(browser)).toBe("t3");
    tui.mode = "regular";
    expect(browser.handleMouse(wheel)).toBeUndefined();
    browser.dispose();
    browser.handleInput("\x03");
    expect(done.mock.calls).toEqual([["fullscreen"]]);
  });
});

describe("todo browser history views and review", () => {
  const now = Date.UTC(2026, 9, 22, 12);
  const state: TodoState = { schemaVersion: 2, revision: 3, tasks: [
    { key: "a", subject: "Task a", status: "pending" },
    { key: "b", subject: "Task b", status: "completed" },
    { key: "c", subject: "Task c", status: "in_progress" },
  ] };
  const activity: TodoActivity = new Map([
    ["a", { createdAt: now - 600_000, updates: [] }],
    ["b", { createdAt: now - 600_000, updates: [
      { revision: 2, at: now - 60_000, status: "completed", from: "pending", message: "Found three bugs" },
    ] }],
    ["c", { createdAt: now - 600_000, updates: [
      { revision: 3, at: now - 30_000, status: "in_progress", from: "pending", message: "Delegated to subagent" },
    ] }],
  ]);
  async function openHistory(options: Partial<TodoBrowserOptions> = {}) {
    const env = setup();
    const onReview = vi.fn<(marks: ReadonlyMap<string, number>) => void>();
    await showTodoBrowser(env.ctx, state, { activity, review: createTodoReviewState(), now, onReview, ...options });
    const browser = env.components[1] as ReadOnlyBrowser;
    browser.focused = true;
    return { ...env, browser, onReview };
  }
  const rows = (browser: ReadOnlyBrowser) => output(browser).split("\n")
    .map(line => /^│ (.*?)\s+(?:[✓▸○] \w+)\s*│$/.exec(line.trim())?.[1]).filter((row): row is string => !!row);
  const TAB = "\t", SHIFT_TAB = "\x1b[Z", CTRL_R = "\x12";

  it("reserves a marker column, counts unreviewed in the note and cycles All/Unreviewed/Recent views", async () => {
    const { browser } = await openHistory();
    expect(output(browser)).toContain("Read-only task snapshot · last reviewed never · 2 unreviewed");
    expect(rows(browser)).toEqual(["→ ● c: Task c", "    a: Task a", "  ● b: Task b"]);
    expect(output(browser)).toContain("All · 1/3 tasks · 3 total");
    expect(output(browser)).toContain("Tab view · Ctrl+R mark reviewed");
    browser.handleInput(TAB);
    expect(output(browser)).toContain("Unreviewed · 1/2 tasks · 3 total");
    expect(rows(browser)).toEqual(["→ ● c: Task c", "  ● b: Task b"]);
    browser.handleInput(TAB);
    expect(output(browser)).toContain("Recent · 1/3 tasks");
    expect(rows(browser)).toEqual(["→ ● c: Task c", "  ● b: Task b", "    a: Task a"]);
    browser.handleInput(TAB);
    expect(output(browser)).toContain("All · 1/3 tasks");
    browser.handleInput(SHIFT_TAB);
    browser.handleInput(SHIFT_TAB);
    expect(output(browser)).toContain("Unreviewed ·");
    browser.handleInput("three bugs");
    expect(rows(browser)).toEqual(["→ ● b: Task b"]);
  });

  it("Enter reviews the opened task once at its shown revision; Ctrl+R reviews the filtered rest", async () => {
    const { browser, onReview } = await openHistory();
    browser.handleInput(ENTER);
    expect(onReview).toHaveBeenCalledWith(new Map([["c", 3]]));
    expect(output(browser)).toContain("Activity (newest first; ● = unreviewed):");
    expect(output(browser)).toMatch(/● 30s|● just now \(\d\d:\d\d:\d\d\) · r3 · pending → in_progress/);
    expect(output(browser)).toContain("    Delegated to subagent");
    expect(output(browser)).toContain("Reviewed: never");
    browser.handleInput(ESC);
    expect(rows(browser)).toEqual(["→   c: Task c", "    a: Task a", "  ● b: Task b"]);
    expect(output(browser)).toContain("· 1 unreviewed");
    browser.handleInput(ENTER);
    browser.handleInput(ESC);
    expect(onReview).toHaveBeenCalledTimes(1);
    browser.handleInput("task a");
    browser.handleInput(CTRL_R);
    expect(onReview).toHaveBeenCalledTimes(1);
    browser.handleInput(ESC);
    browser.handleInput(CTRL_R);
    expect(onReview).toHaveBeenLastCalledWith(new Map([["b", 2]]));
    expect(output(browser)).toContain("· all reviewed");
    browser.handleInput(CTRL_R);
    expect(onReview).toHaveBeenCalledTimes(2);
  });

  it("opens on the requested view with an explanatory empty state and no review hint when nothing is new", async () => {
    const review = applyTodoReview(createTodoReviewState(), { at: now - 120_000, tasks: { b: 2, c: 3 } });
    const { browser, onReview } = await openHistory({ view: "unreviewed", review });
    expect(output(browser)).toContain("No unreviewed messages. Tab for other views.");
    expect(output(browser)).toContain("last reviewed 2m ago");
    expect(output(browser)).not.toContain("Ctrl+R");
    expect(rows(browser)).toEqual([]);
    browser.handleInput(TAB);
    expect(rows(browser)).toEqual(["→ c: Task c", "  b: Task b", "  a: Task a"]);
    browser.handleInput(CTRL_R);
    expect(onReview).not.toHaveBeenCalled();
  });

  it("keeps every frame bounded with markers, views and hostile message text", async () => {
    const unsafe = "safe\x1b[2J\x1b]52;c;bad\x07\u202e日本語 👩‍💻 e\u0301";
    const hostile: TodoActivity = new Map([["c", { updates: [{ revision: 3, at: now, status: "in_progress", message: `${unsafe}\n`.repeat(30) }] }]]);
    const { browser, tui } = await openHistory({ activity: hostile });
    for (const step of [() => {}, () => browser.handleInput(ENTER)]) {
      step();
      for (const height of [3, 5, 10, 40]) {
        tui.terminal.rows = height;
        for (let width = 1; width <= 30; width++) {
          for (const line of browser.render(width)) {
            expect(visibleWidth(line)).toBe(width);
            expect(line.replaceAll(CURSOR_MARKER, "")).not.toMatch(/[\x07\u202e]/);
          }
        }
      }
    }
  });
});
