import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import stashExtension from "#src/index";
import type { StashRecord } from "#src/state";
import { Explorer } from "../../../packages/pi-ui/src/index.ts";
import { showStashBrowser, stashExplorerView, type StashPreview } from "#src/ui/browser";
import { formatAge, formatBytes, originLabel, previewRows } from "#src/ui/render";
import {
  expectPadded,
  NARROW_WIDTHS,
  WIDE_TEXT,
} from "../../../packages/pi-test-helpers/src/render.ts";
import { ansiTheme, stripAnsi } from "../../../packages/pi-test-helpers/src/theme.ts";
import { flushMicrotasks as flush } from "../../../packages/pi-test-helpers/src/wait.ts";

// Colors every token so width math must ignore escape sequences.
const ansi = ansiTheme as Theme;

const record = (overrides: Partial<StashRecord> = {}): StashRecord => ({
  name: "auth-findings",
  hash: "3f9a1c2b7d01".padEnd(64, "a"),
  bytes: 12_345,
  lines: 340,
  mime: "text/plain",
  description: `${WIDE_TEXT} \x1b[2Jdescription`,
  createdAt: Date.now() - 3_600_000,
  createdBy: "session-1234567890",
  source: "content",
  ...overrides,
});

describe("render helpers", () => {
  it("formats sizes and ages", () => {
    expect([
      formatBytes(10),
      formatBytes(2048),
      formatBytes(15 * 1024 * 1024),
      formatBytes(3 * 1024 ** 3),
    ]).toEqual(["10 B", "2.0 KB", "15 MB", "3.0 GB"]);
    expect([
      formatAge(0, 30_000),
      formatAge(0, 120_000),
      formatAge(0, 7_200_000),
      formatAge(0, 172_800_000),
    ]).toEqual(["30s", "2m", "2h", "2d"]);
  });

  it("labels origins", () => {
    expect(originLabel(record())).toBe("session-");
    expect(originLabel(record({ agent: "a3f2b1c4-9d8e-4f6a" }))).toBe("agent a3f2b1c4");
    expect(originLabel(record({ agent: "\x1b[2J" }))).toBe("agent ?");
  });

  it("numbers preview rows and strips control sequences", () => {
    expect(previewRows("a\n\x1b[2Jb\nc\n", 2)).toEqual(["1  a", "2  b"]);
    expect(previewRows(Array.from({ length: 12 }, () => "x").join("\n"), 12, 1).at(-1)).toBe(
      "12  x",
    );
  });
});

describe("stash explorer", () => {
  const NOW = Date.now();
  const make = (
    entries: StashRecord[],
    rows = 12,
    load: () => StashPreview = vi.fn(() => ({
      lines: [`${WIDE_TEXT} line`, "\x1b]52;c;evil\x07second"],
      note: "Preview stops here",
    })),
  ) => {
    const done = vi.fn();
    const browser = new Explorer({
      tui: { requestRender: vi.fn(), terminal: { rows, columns: 80 } },
      theme: ansi,
      keys: new KeybindingsManager(TUI_KEYBINDINGS),
      view: stashExplorerView(entries, load, "Store is over the cap", NOW),
      done,
    });
    return { browser, done, load };
  };

  it("maps entries to accent handles, muted descriptions and dim size/age badges", () => {
    const view = stashExplorerView([record({ agent: "a3f2b1c4-9d8e", via: "adopt" })], vi.fn());
    expect(view.items[0]).toMatchObject({
      id: "stash:auth-findings@3f9a1c2b7d01",
      label: [
        { text: "stash:auth-findings@3f9a1c2b7d01", tone: "accent" },
        { text: ` — ${WIDE_TEXT} \x1b[2Jdescription`, tone: "muted" },
      ],
      badge: { text: "↑ agent a3f2b1c4 · 12 KB · 340 lines · 1h" },
    });
    // Only adopted rows name their origin; a session's own entries stay as they were.
    expect(stashExplorerView([record({ agent: "a3f2b1c4" })], vi.fn()).items[0].badge!.text).toBe(
      "12 KB · 340 lines · 1h",
    );
  });

  it("lists entries, previews lazily with line numbers, and goes back and closes with Esc", async () => {
    const load = vi.fn(() => ({
      lines: [`${WIDE_TEXT} line`, "\x1b]52;c;evil\x07second"],
      note: "Preview stops here",
    }));
    const { browser, done } = make(
      [record(), record({ name: "second", hash: "b".repeat(64) })],
      30,
      load,
    );
    const list = browser.render(80).map(stripAnsi);
    expect(list[0]).toMatch(/^ ╭─+ Stash ─+╮ $/);
    expect(list.join("\n")).toContain("Store is over the cap");
    expect(list.join("\n")).toContain("24 KB stored on this branch");
    expect(list.join("\n")).toContain("→ stash:auth-findings@3f9a1c2b7d01");
    expect(list.join("\n")).toContain("1/2 entries");
    expect(load).not.toHaveBeenCalled();
    browser.handleInput("\x1b[B");
    browser.handleInput("\r");
    await flush();
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ name: "second" }));
    const preview = browser.render(80).map(stripAnsi).join("\n");
    // The breadcrumb names the selected entry (its label, clipped to the frame).
    expect(preview).toMatch(/╭─+ Stash \/ stash:second@b+/);
    expect(preview).toMatch(/Name +second/);
    expect(preview).toMatch(/Hash +b{20}/);
    expect(preview).toMatch(/Description +検索結果😀データ description/);
    expect(preview).toMatch(/Contents[^\n]*\n[^\n]*1  検索結果😀データ line/);
    expect(preview).toContain("2  second");
    expect(preview).not.toContain("evil");
    expect(preview).toContain("Preview stops here");
    browser.handleInput("\x1b");
    expect(stripAnsi(browser.render(80)[0])).toMatch(/Stash/);
    browser.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("shows who stored an adopted entry in its details", async () => {
    const { browser } = make(
      [
        record({ agent: "a3f2b1c4-9d8e", via: "adopt" }),
        record({ name: "own", hash: "c".repeat(64) }),
      ],
      30,
      vi.fn(() => ({ lines: ["x"] })),
    );
    browser.handleInput("\r");
    await flush();
    expect(browser.render(80).map(stripAnsi).join("\n")).toMatch(
      /Stored by +agent a3f2b1c4 \(session session-\) · adopted from a subagent/,
    );
    browser.handleInput("\x1b");
    browser.handleInput("\x1b[B");
    browser.handleInput("\r");
    await flush();
    expect(browser.render(80).map(stripAnsi).join("\n")).toMatch(/Stored by +session- *│/);
  });

  it("stays within width at narrow widths", async () => {
    for (const view of ["list", "preview"] as const) {
      const { browser } = make([record()], 8);
      if (view === "preview") {
        browser.handleInput("\r");
        await flush();
      }
      for (const width of NARROW_WIDTHS)
        for (const line of browser.render(width))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("shows an empty state, and read errors below the metadata", async () => {
    expect(make([]).browser.render(60).map(stripAnsi)).toContainEqual(
      expect.stringMatching(/No stash entries on this branch/),
    );
    const { browser } = make(
      [record()],
      30,
      vi.fn(() => {
        throw new Error("missing blob");
      }),
    );
    browser.handleInput("\r");
    await flush();
    const detail = browser.render(60).map(stripAnsi).join("\n");
    expect(detail).toMatch(/Hash +3f9a1c2b7d01/);
    expect(detail).toContain("Couldn't read: missing blob");
  });

  it("opens the shared centered overlay and refuses non-interactive modes", async () => {
    type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
    const custom = vi.fn(async (_factory: Factory, _options?: unknown) => undefined);
    const notify = vi.fn();
    await showStashBrowser(
      { mode: "tui", hasUI: true, ui: { custom, notify } } as unknown as ExtensionContext,
      [record()],
      () => ({ lines: ["content"] }),
    );
    expect(custom).toHaveBeenCalledOnce();
    expect(custom.mock.calls[0][1]).toMatchObject({ overlay: true });
    await showStashBrowser(
      { mode: "rpc", hasUI: false, ui: { custom, notify } } as unknown as ExtensionContext,
      [record()],
      () => ({ lines: ["content"] }),
    );
    expect(custom).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("/stash requires interactive terminal mode.", "warning");
  });
});

describe("tool renderers", () => {
  const tools = new Map<string, ToolDefinition>();
  stashExtension({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: () => {},
    appendEntry: () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI);
  const options = (expanded: boolean) => ({ expanded, isPartial: false }) as never;

  it("collapses to a receipt and expands to a padded preview, never the full content", () => {
    const put = tools.get("stash_put")!;
    const details = {
      handle: "stash:big@3f9a1c2b7d01",
      bytes: 999_999,
      lines: 5000,
      source: "content",
      preview: `${WIDE_TEXT}\nline 2\n… (5000 lines total)`,
    };
    const result = { content: [{ type: "text" as const, text: "receipt" }], details };
    const collapsed = put.renderResult!(result, options(false), ansi, {} as never)
      .render(80)
      .map(stripAnsi);
    expect(collapsed[0]).toMatch(/stash:big@3f9a1c2b7d01 · 977 KB · 5000 lines/);
    const component = put.renderResult!(result, options(true), ansi, {} as never);
    for (const width of NARROW_WIDTHS) {
      const rows = component.render(width);
      for (const row of rows) expectPadded(row, width);
    }
    expect(component.render(60).map(stripAnsi)).toEqual([
      expect.stringMatching(/^ stash:big@3f9a1c2b7d01/),
      expect.stringMatching(/^ 1  検索結果😀データ +$/),
      expect.stringMatching(/^ 2  line 2 +$/),
      expect.stringMatching(/^ 3  … \(5000 lines total\) +$/),
    ]);
  });

  it("renders get and list receipts within width", () => {
    const get = tools.get("stash_get")!;
    const list = tools.get("stash_list")!;
    const getResult = {
      content: [],
      details: {
        handle: "stash:a@3f9a1c2b7d01",
        summary: "lines 1-10 of 99",
        preview: "1\tone\n2\ttwo",
      },
    };
    const listResult = { content: [], details: { total: 1, entries: [record()] } };
    for (const width of NARROW_WIDTHS) {
      for (const row of get.renderResult!(getResult, options(true), ansi, {} as never).render(
        width,
      ))
        expectPadded(row, width);
      for (const row of list.renderResult!(listResult, options(true), ansi, {} as never).render(
        width,
      ))
        expectPadded(row, width);
    }
    expect(
      stripAnsi(list.renderResult!(listResult, options(false), ansi, {} as never).render(40)[0]),
    ).toMatch(/1 entry/);
    const error = get.renderResult!(
      { content: [{ type: "text", text: "boom\x1b[2J" }], details: undefined } as never,
      options(false),
      ansi,
      {} as never,
    );
    expect(stripAnsi(error.render(40)[0])).toMatch(/boom/);
  });
});
