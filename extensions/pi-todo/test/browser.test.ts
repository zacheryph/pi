import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  KeybindingsManager,
  renderFakeCursor,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { DisposableComponent } from "../../../packages/pi-ui/src/index.ts";
import { type TodoState } from "../src/state.js";
import { showTodoBrowser, type TodoBrowserOptions } from "../src/ui/browser.js";
import { applyTodoReview, createTodoReviewState, type TodoActivity } from "../src/activity.js";

type Browser = DisposableComponent & { focused: boolean; handleInput(data: string): void };
const ENTER = "\r",
  ESC = "\x1b";
const body = Array.from({ length: 100 }, (_, i) => `row${String(i).padStart(3, "0")}`).join("\n");
const snapshot: TodoState = {
  schemaVersion: 2,
  revision: 1,
  tasks: Array.from({ length: 30 }, (_, i) => ({
    key: `t${i}`,
    subject: `Task${i}`,
    status: "pending",
    description: `hidden detail\n${body}`,
  })),
};
function setup(rows = 40) {
  const tui = { terminal: { rows, columns: 100 }, requestRender: vi.fn() };
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
  const components: Browser[] = [];
  const done = vi.fn();
  const ui = {
    notify: vi.fn(),
    custom: vi.fn(async (factory: Factory, _options?: unknown) => {
      let result: unknown;
      components.push(
        (await factory(
          tui as unknown as Parameters<Factory>[0],
          theme as unknown as Parameters<Factory>[1],
          keys as Parameters<Factory>[2],
          (value) => {
            result = value;
            done(value);
          },
        )) as Browser,
      );
      return result;
    }),
  };
  const ctx = { mode: "tui", hasUI: true, ui } as unknown as ExtensionContext;
  return { tui, ctx, ui, done, components };
}
async function open(state = snapshot, rows = 40) {
  const env = setup(rows);
  await showTodoBrowser(env.ctx, state);
  const browser = env.components[0];
  browser.focused = true;
  return { ...env, browser };
}
// Pi's Input wraps its cursor cell in zero-width markers that the TUI resolves to reverse video.
const [FAKE_CURSOR_START, FAKE_CURSOR_END] = renderFakeCursor("|").split("|");
const withoutPiMarkers = (text: string) =>
  text
    .replaceAll(CURSOR_MARKER, "")
    .replaceAll(FAKE_CURSOR_START, "")
    .replaceAll(FAKE_CURSOR_END, "");
// oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
const plain = (text: string) => withoutPiMarkers(text).replace(/\x1b\[[0-9;]*m/g, "");
const output = (browser: Browser, width = 100) => browser.render(width).map(plain).join("\n");
const selected = (browser: Browser) => /→ (?:● )?(t\d+):/.exec(output(browser))?.[1];

describe("todo browser placement", () => {
  it("opens the shared centered overlay and closes with Ctrl+C", async () => {
    const { ui, done, browser } = await open();
    expect(ui.custom).toHaveBeenCalledOnce();
    expect(ui.custom.mock.calls[0][1]).toMatchObject({
      overlay: true,
      overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" },
    });
    expect(browser.render(80)).toHaveLength(32);
    browser.handleInput("\x03");
    expect(done.mock.calls).toEqual([[undefined]]);
  });

  it.each(["rpc", "json", "print"] as const)("avoids custom UI in %s", async (mode) => {
    const { ctx, ui } = setup();
    await showTodoBrowser({ ...ctx, mode }, snapshot);
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Read-only browser requires TUI mode.", "warning");
  });

  it("guards hasUI and captures state before opening", async () => {
    const env = setup();
    await showTodoBrowser({ ...env.ctx, hasUI: false }, snapshot);
    expect(env.ui.custom).not.toHaveBeenCalled();
    const state = structuredClone(snapshot);
    const original = env.ui.custom.getMockImplementation()!;
    env.ui.custom.mockImplementationOnce(async (factory) => {
      state.tasks[0].subject = "mutated";
      state.tasks[0].description = "mutated detail";
      return original(factory);
    });
    await showTodoBrowser(env.ctx, state);
    const browser = env.components[0];
    expect(output(browser)).not.toContain("mutated");
    browser.handleInput(ENTER);
    expect(output(browser)).toContain("row000");
  });
});

describe("read-only todo browser", () => {
  it("renders title, dependencies, semantic badges and the mutation-command hints", async () => {
    const state = structuredClone(snapshot);
    state.tasks[1].dependsOn = ["t0"];
    const { browser } = await open(state);
    expect(output(browser)).toMatch(/╭─+ Todos ─+╮/);
    expect(output(browser)).toContain("/todo:add · /todo:clear");
    expect(output(browser)).toContain("Read-only task snapshot");
    expect(output(browser)).not.toContain("hidden detail");
    browser.handleInput("blocked");
    expect(output(browser)).toMatch(/t1: Task1 ← t0 +○ blocked/);
    expect(selected(browser)).toBe("t1");
    browser.handleInput(ENTER);
    expect(output(browser)).toMatch(/╭─+ Todos \/ t1: Task1 ← t0 ─+╮/);
    expect(output(browser)).toContain("Dependencies");
    expect(output(browser)).toContain("• t0 — pending");
    expect(output(browser)).toContain("hidden detail");
  });

  it("searches description/status/key and backs out of details", async () => {
    const { browser, done } = await open();
    browser.handleInput("hidden detail");
    expect(output(browser)).toContain("1/30 tasks");
    browser.handleInput(ESC);
    browser.handleInput("t29");
    expect(selected(browser)).toBe("t29");
    browser.handleInput(ENTER);
    browser.handleInput(ESC);
    expect(selected(browser)).toBe("t29");
    browser.handleInput(ESC);
    browser.handleInput(ESC);
    expect(done).toHaveBeenCalledOnce();
  });

  it("is read-only against deeply frozen state", async () => {
    const frozen = structuredClone(snapshot);
    for (const task of frozen.tasks) Object.freeze(task);
    Object.freeze(frozen.tasks);
    const { browser } = await open(Object.freeze(frozen));
    browser.handleInput(ENTER);
    expect(output(browser)).toContain("row000");
    expect(output((await open({ ...snapshot, tasks: [] })).browser)).toContain("No tasks.");
  });
});

describe("todo browser history views and review", () => {
  const now = Date.UTC(2026, 9, 22, 12);
  const state: TodoState = {
    schemaVersion: 2,
    revision: 3,
    tasks: [
      { key: "a", subject: "Task a", status: "pending" },
      { key: "b", subject: "Task b", status: "completed" },
      { key: "c", subject: "Task c", status: "in_progress" },
    ],
  };
  const activity: TodoActivity = new Map([
    ["a", { createdAt: now - 600_000, updates: [] }],
    [
      "b",
      {
        createdAt: now - 600_000,
        updates: [
          {
            revision: 2,
            at: now - 60_000,
            status: "completed",
            from: "pending",
            message: "Found three bugs",
          },
        ],
      },
    ],
    [
      "c",
      {
        createdAt: now - 600_000,
        updates: [
          {
            revision: 3,
            at: now - 30_000,
            status: "in_progress",
            from: "pending",
            message: "Delegated to subagent",
          },
        ],
      },
    ],
  ]);
  async function openHistory(options: Partial<TodoBrowserOptions> = {}) {
    const env = setup();
    const onReview = vi.fn<(marks: ReadonlyMap<string, number>) => void>();
    await showTodoBrowser(env.ctx, state, {
      activity,
      review: createTodoReviewState(),
      now,
      onReview,
      ...options,
    });
    const browser = env.components[0];
    browser.focused = true;
    return { ...env, browser, onReview };
  }
  const rows = (browser: Browser) =>
    output(browser)
      .split("\n")
      .map((line) => /^│ (.*?)\s+(?:[✓▸○] \w+)\s*│$/.exec(line.trim())?.[1])
      .filter((row): row is string => !!row);
  const TAB = "\t",
    SHIFT_TAB = "\x1b[Z",
    CTRL_R = "\x12";

  it("reserves a marker column, counts unreviewed in the status row and cycles All/Unreviewed/Recent views", async () => {
    const { browser } = await openHistory();
    expect(output(browser)).toContain("Read-only task snapshot · last reviewed never");
    expect(rows(browser)).toEqual(["→ ● c: Task c", "    a: Task a", "  ● b: Task b"]);
    expect(output(browser)).toContain("1/3 tasks · 2 unreviewed");
    expect(output(browser)).toContain("Tab view · Ctrl+R mark reviewed");
    expect(output(browser)).toMatch(/\bAll\b · Unreviewed · Recent/);
    browser.handleInput(TAB);
    expect(output(browser)).toContain("1/2 tasks · 3 total · 2 unreviewed");
    expect(rows(browser)).toEqual(["→ ● c: Task c", "  ● b: Task b"]);
    browser.handleInput(TAB);
    expect(output(browser)).toContain("1/3 tasks");
    expect(rows(browser)).toEqual(["→ ● c: Task c", "  ● b: Task b", "    a: Task a"]);
    browser.handleInput(TAB);
    expect(rows(browser)).toEqual(["→ ● c: Task c", "    a: Task a", "  ● b: Task b"]);
    browser.handleInput(SHIFT_TAB);
    browser.handleInput(SHIFT_TAB);
    expect(rows(browser)).toEqual(["→ ● c: Task c", "  ● b: Task b"]);
    browser.handleInput("three bugs");
    expect(rows(browser)).toEqual(["→ ● b: Task b"]);
  });

  it("Enter reviews the opened task once at its shown revision; Ctrl+R reviews the filtered rest", async () => {
    const { browser, onReview } = await openHistory();
    browser.handleInput(ENTER);
    expect(onReview).toHaveBeenCalledWith(new Map([["c", 3]]));
    expect(output(browser)).toContain("Activity (newest first; ● = unreviewed)");
    expect(output(browser)).toMatch(/● just now \(\d\d:\d\d:\d\d\) · r3 · pending → in_progress/);
    expect(output(browser)).toContain("    Delegated to subagent");
    expect(output(browser)).toMatch(/Reviewed +never/);
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
    expect(output(browser)).not.toContain("unreviewed ·");
    expect(output(browser)).not.toMatch(/\d unreviewed/);
    browser.handleInput(CTRL_R);
    expect(onReview).toHaveBeenCalledTimes(2);
  });

  it("opens on the requested view with an explanatory empty state and no review hint when nothing is new", async () => {
    const review = applyTodoReview(createTodoReviewState(), {
      at: now - 120_000,
      tasks: { b: 2, c: 3 },
    });
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
    const hostile: TodoActivity = new Map([
      [
        "c",
        {
          updates: [
            { revision: 3, at: now, status: "in_progress", message: `${unsafe}\n`.repeat(30) },
          ],
        },
      ],
    ]);
    const { browser, tui } = await openHistory({ activity: hostile });
    for (const step of [() => {}, () => browser.handleInput(ENTER)]) {
      step();
      for (const height of [3, 5, 10, 40]) {
        tui.terminal.rows = height;
        for (let width = 1; width <= 30; width++) {
          for (const line of browser.render(width)) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
            expect(withoutPiMarkers(line)).not.toMatch(/[\x07\u202e]/);
          }
        }
      }
    }
  });
});
