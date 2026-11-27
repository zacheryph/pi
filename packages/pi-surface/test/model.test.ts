import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isActionRef,
  isDetailContent,
  isExplorerModel,
  isJsonObject,
  isJsonValue,
  isLine,
  isSpan,
  type DetailModel,
  type ExplorerModel,
  type JsonValue,
  type WidgetModel,
} from "#src/index";

const SRC = join(import.meta.dirname, "../src");

describe("package boundary", () => {
  it("imports neither pi-tui nor pi-coding-agent at runtime", () => {
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(SRC, file), "utf8");
      expect(source, file).not.toMatch(/["']@earendil-works\/pi-tui(?:\/[^"']*)?["']/);
      // Type-only imports are erased; anything else would load the SDK.
      for (const match of source.matchAll(
        /^\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']@earendil-works\/pi-coding-agent[^"']*["']/gm,
      ))
        expect(match[2], `${file}: ${match[0]}`).toBe("type ");
    }
  });
});

describe("view models are JSON", () => {
  const explorer: ExplorerModel = {
    title: { label: "Todos", icon: "T", detail: "branch" },
    items: [
      {
        id: "t1",
        label: [{ text: "t1", tone: "accent" }, " — renew"],
        search: "auth",
        badge: { text: "in progress", tone: "accent" },
        marked: true,
        detail: [
          { fields: [["Status", { text: "open", tone: "success", bold: true }]] },
          { heading: "Notes" },
          { bullets: ["one", "two"] },
          { lines: ["a", "b"], numbered: 3 },
          { text: "done", tone: "muted" },
        ],
      },
    ],
    noun: ["task", "tasks"],
    notices: [["Read-only", { text: " · capped", tone: "warning" }]],
    tabs: [
      { label: "All", ids: ["t1"], emptyText: "Nothing." },
      { label: "Done", ids: [], secondary: true },
    ],
    initialTab: 0,
    marker: {
      label: "flagged",
      clearAction: "unflag",
      onClear: { action: "todo.unflag" },
    },
    emptyText: "No tasks.",
    hints: [{ keys: "/todo:add", priority: 2 }],
    onOpen: { action: "todo.open", args: { source: "explorer" } },
    loadDetail: { action: "todo.detail" },
  };
  const widget: WidgetModel = {
    title: "Subagents",
    active: false,
    meta: ["2 queued"],
    rows: [
      {
        left: "worker",
        right: [[{ text: "running", tone: "accent" }]],
        keepRight: true,
        group: "running",
      },
    ],
    emptyText: "Idle",
  };
  const detail: DetailModel = { title: "Details", content: "plain text" };

  it("survives a JSON round trip unchanged and is typed as JSON", () => {
    const models: JsonValue[] = [explorer, widget, detail];
    for (const model of models) {
      expect(isJsonValue(model)).toBe(true);
      expect(JSON.parse(JSON.stringify(model))).toStrictEqual(model);
    }
  });

  it("accepts a secondary explorer tab and rejects a flag that is not a boolean", () => {
    expect(isExplorerModel(explorer)).toBe(true);
    const tabs = [{ label: "Done", ids: [], secondary: "yes" }];
    expect(isExplorerModel({ ...explorer, tabs })).toBe(false);
  });

  it("recognizes JSON values, detail content and action references", () => {
    expect(isJsonValue({ a: [1, "b", null, { c: true }], d: undefined })).toBe(true);
    const notJson = [() => 1, Number.NaN, Infinity, new Date(), new Map(), [undefined], 1n];
    notJson.forEach((value, i) => expect(isJsonValue(value), `case ${i}`).toBe(false));
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isJsonValue(cycle)).toBe(false);
    const shared = { x: 1 };
    expect(isJsonValue([shared, shared])).toBe(true);
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);

    expect(isDetailContent("text")).toBe(true);
    expect(isDetailContent(explorer.items[0].detail)).toBe(true);
    for (const value of [
      [{}],
      [{ heading: 1 }],
      [{ text: "x", tone: "loud" }],
      [{ lines: [1] }],
      [{ fields: [["a"]] }],
      {},
    ])
      expect(isDetailContent(value), JSON.stringify(value)).toBe(false);

    expect(isActionRef({ action: "todo.unflag", args: { ids: ["t1"] } })).toBe(true);
    expect(isActionRef({ args: {} })).toBe(false);
  });
});

describe("spans", () => {
  it("accept a state icon and refuse unknown ones", () => {
    expect(isSpan({ text: "✓", tone: "success", icon: "done" })).toBe(true);
    expect(isSpan({ text: "", icon: "waiting" })).toBe(true);
    expect(isLine([{ text: "▸", icon: "active" }, " in_progress"])).toBe(true);
    expect(isSpan({ text: "x", icon: "sparkles" })).toBe(false);
  });

  it("accept a clock's start time, and refuse one that is not a finite number", () => {
    expect(isSpan({ text: "01:23", tone: "dim", since: 1_700_000_000_000 })).toBe(true);
    expect(isSpan({ text: "01:23", since: "yesterday" })).toBe(false);
    expect(isSpan({ text: "01:23", since: Number.NaN })).toBe(false);
  });
});
