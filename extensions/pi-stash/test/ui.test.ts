import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import stashExtension from "#src/index";
import type { StashRecord } from "#src/state";
import { StashBrowser, showStashBrowser, type StashPreview } from "#src/ui/browser";
import { bodyRow, entryRow, formatAge, formatBytes, headerRule, previewRows } from "#src/ui/render";

const plain = { fg: (_token: string, text: string) => text } as Theme;
// Colors every token so width math must ignore escape sequences.
const ansi = { fg: (_token: string, text: string) => `\x1b[31m${text}\x1b[0m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as Theme;
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const WIDE = "検索結果😀データ";
const WIDTHS = [0, 1, 2, 3, 4, 5, 8, 13, 21, 40, 80];

const record = (overrides: Partial<StashRecord> = {}): StashRecord => ({
  name: "auth-findings", hash: "3f9a1c2b7d01".padEnd(64, "a"), bytes: 12_345, lines: 340, mime: "text/plain",
  description: `${WIDE} \x1b[2Jdescription`, createdAt: Date.now() - 3_600_000, createdBy: "session-1234567890", source: "content",
  ...overrides,
});

/** Every body row keeps one space at each edge, or is blank when too narrow. */
function expectPadded(row: string, width: number): void {
  expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  const text = strip(row);
  if (width <= 2) expect(text.trim()).toBe("");
  else if (text.trim()) {
    expect(text.startsWith(" ")).toBe(true);
    expect(text.endsWith(" ")).toBe(true);
  }
}

describe("render helpers", () => {
  it("formats sizes and ages", () => {
    expect([formatBytes(10), formatBytes(2048), formatBytes(15 * 1024 * 1024), formatBytes(3 * 1024 ** 3)]).toEqual(["10 B", "2.0 KB", "15 MB", "3.0 GB"]);
    expect([formatAge(0, 30_000), formatAge(0, 120_000), formatAge(0, 7_200_000), formatAge(0, 172_800_000)]).toEqual(["30s", "2m", "2h", "2d"]);
  });

  it("pads body rows and blanks them when padding cannot fit", () => {
    for (const width of WIDTHS) {
      for (const text of ["plain", ansi.fg("accent", WIDE), ""]) {
        const row = bodyRow(text, width);
        expect(visibleWidth(row)).toBe(width);
        expectPadded(row, width);
      }
    }
    expect(bodyRow("abc", 2)).toBe("  ");
    expect(strip(bodyRow("abcdef", 5))).toBe(" abc ");
  });

  it("fits entry rows and header rules at every width with ANSI and wide text", () => {
    for (const width of WIDTHS) {
      expect(visibleWidth(entryRow(record(), width, ansi))).toBeLessThanOrEqual(width);
      expect(visibleWidth(headerRule(WIDE, "3 · 1.2 KB", width, ansi))).toBeLessThanOrEqual(width);
    }
    expect(strip(entryRow(record(), 120, ansi))).toMatch(/^stash:auth-findings@3f9a1c2b7d01 — 検索結果😀データ description +12 KB · 340 lines · 1h$/);
    expect(headerRule("Stash", "2", 20, plain)).toBe("── Stash ────── 2 ──");
  });

  it("numbers preview rows and strips control sequences", () => {
    expect(previewRows("a\n\x1b[2Jb\nc\n", 2)).toEqual(["1  a", "2  b"]);
    expect(previewRows(Array.from({ length: 12 }, () => "x").join("\n"), 12, 1).at(-1)).toBe("12  x");
  });
});

describe("StashBrowser", () => {
  const make = (entries: StashRecord[], rows = 12, load: () => StashPreview = vi.fn(() => ({ lines: [`${WIDE} line`, "\x1b]52;c;evil\x07second"], note: "Preview stops here" }))) => {
    const done = vi.fn();
    const requestRender = vi.fn();
    const browser = new StashBrowser({ tui: { requestRender, terminal: { rows } }, theme: ansi, entries, load, warning: "Store is over the cap", done });
    return { browser, done, load };
  };

  it("lists entries, previews with line numbers, and goes back and closes with Esc", () => {
    const load = vi.fn(() => ({ lines: [`${WIDE} line`, "\x1b]52;c;evil\x07second"], note: "Preview stops here" }));
    const { browser, done } = make([record(), record({ name: "second", hash: "b".repeat(64) })], 30, load);
    const list = browser.render(80).map(strip);
    expect(list[0]).toMatch(/^ ╭─+ Stash ─+╮ $/);
    expect(list[1]).toContain("Store is over the cap");
    expect(list[2]).toContain("2 entries · 24 KB");
    expect(list[3]).toContain("→ stash:auth-findings@3f9a1c2b7d01");
    expect(list.at(-2)).toContain("Enter details · Esc close");
    browser.handleInput("\x1b[B");
    browser.handleInput("\r");
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ name: "second" }));
    const preview = browser.render(80).map(strip);
    expect(preview[0]).toMatch(/^ ╭─+ Stash \/ second ─+╮ $/);
    expect(preview.join("\n")).toContain("Name: second");
    expect(preview.join("\n")).toContain(`Hash: ${"b".repeat(64)}`);
    expect(preview.join("\n")).toContain("Description: 検索結果😀データ description");
    expect(preview.join("\n")).toMatch(/Contents:[^\n]*\n[^\n]*1  検索結果😀データ line/);
    expect(preview.join("\n")).toContain("2  second");
    expect(preview.join("\n")).toContain("Preview stops here");
    browser.handleInput("\x1b");
    expect(strip(browser.render(80)[0])).toMatch(/Stash/);
    browser.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("stays within width and pads every body row at narrow widths", () => {
    for (const view of ["list", "preview"] as const) {
      const { browser } = make([record()], 8);
      if (view === "preview") browser.handleInput("\r");
      for (const width of WIDTHS) {
        const lines = browser.render(width);
        if (!width) {
          expect(lines).toEqual([]);
          continue;
        }
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        for (const line of lines.slice(1)) expectPadded(line, width);
      }
    }
  });

  it("bounds rows to the terminal and scrolls the preview", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `row ${i + 1}`);
    const { browser } = make([record()], 10, vi.fn(() => ({ lines })));
    browser.handleInput("\r");
    const first = browser.render(40);
    expect(first.length).toBe(8);
    browser.handleInput("\x1b[6~");
    expect(browser.render(40).map(strip).join("\n")).toContain("Description:");
    browser.handleInput("\x1b[F");
    expect(browser.render(40).map(strip).join("\n")).toContain("row 100");
  });

  it("shows an empty state and read errors", () => {
    expect(make([]).browser.render(60).map(strip)).toContainEqual(expect.stringMatching(/No stash entries on this branch/));
    const { browser } = make([record()], 30, vi.fn(() => { throw new Error("missing blob"); }));
    browser.handleInput("\r");
    expect(browser.render(60).map(strip)).toContainEqual(expect.stringMatching(/Unable to read: missing blob/));
  });

  it.each(["fullscreen", "regular"] as const)("opens in the %s renderer like /todo", async (mode) => {
    const components: { render: (width: number) => string[] }[] = [];
    type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
    const custom = vi.fn(async (factory: Factory) => {
      let result: unknown;
      const component = await factory(
        { mode, terminal: { rows: 30 }, requestRender: vi.fn() } as unknown as Parameters<Factory>[0],
        plain as Parameters<Factory>[1],
        {} as Parameters<Factory>[2],
        (value) => { result = value; },
      );
      components.push(component);
      return result;
    });
    const ctx = { ui: { custom } } as unknown as ExtensionContext;
    await showStashBrowser(ctx, [record()], () => ({ lines: ["content"] }));
    expect(custom).toHaveBeenCalledTimes(2);
    expect(components[0].render(80)).toEqual([]);
    expect(custom).toHaveBeenLastCalledWith(expect.any(Function), mode === "fullscreen"
      ? { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } }
      : { overlay: false });
    expect(components[1].render(80).map(strip).join("\n")).toContain("╭");
  });
});

describe("tool renderers", () => {
  const tools = new Map<string, ToolDefinition>();
  stashExtension({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: () => {}, on: () => {}, appendEntry: () => {}, events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI);
  const options = (expanded: boolean) => ({ expanded, isPartial: false }) as never;

  it("collapses to a receipt and expands to a padded preview, never the full content", () => {
    const put = tools.get("stash_put")!;
    const details = { handle: "stash:big@3f9a1c2b7d01", bytes: 999_999, lines: 5000, source: "content", preview: `${WIDE}\nline 2\n… (5000 lines total)` };
    const result = { content: [{ type: "text" as const, text: "receipt" }], details };
    const collapsed = put.renderResult!(result, options(false), ansi, {} as never).render(80).map(strip);
    expect(collapsed[0]).toMatch(/stash:big@3f9a1c2b7d01 · 977 KB · 5000 lines/);
    const component = put.renderResult!(result, options(true), ansi, {} as never);
    for (const width of WIDTHS) {
      const rows = component.render(width);
      for (const row of rows) expectPadded(row, width);
    }
    expect(component.render(60).map(strip)).toEqual([
      expect.stringMatching(/^ stash:big@3f9a1c2b7d01/),
      expect.stringMatching(/^ 1  検索結果😀データ +$/),
      expect.stringMatching(/^ 2  line 2 +$/),
      expect.stringMatching(/^ 3  … \(5000 lines total\) +$/),
    ]);
  });

  it("renders get and list receipts within width", () => {
    const get = tools.get("stash_get")!;
    const list = tools.get("stash_list")!;
    const getResult = { content: [], details: { handle: "stash:a@3f9a1c2b7d01", summary: "lines 1-10 of 99", preview: "1\tone\n2\ttwo" } };
    const listResult = { content: [], details: { total: 1, entries: [record()] } };
    for (const width of WIDTHS) {
      for (const row of get.renderResult!(getResult, options(true), ansi, {} as never).render(width)) expectPadded(row, width);
      for (const row of list.renderResult!(listResult, options(true), ansi, {} as never).render(width)) expectPadded(row, width);
    }
    expect(strip(list.renderResult!(listResult, options(false), ansi, {} as never).render(40)[0])).toMatch(/1 entry/);
    const error = get.renderResult!({ content: [{ type: "text", text: "boom\x1b[2J" }], details: undefined } as never, options(false), ansi, {} as never);
    expect(strip(error.render(40)[0])).toMatch(/boom/);
  });
});
