import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isActionRef,
  isDetailContent,
  isJsonObject,
  isJsonValue,
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
    tabs: [{ label: "All", ids: ["t1"], emptyText: "Nothing." }],
    initialTab: 0,
    marker: {
      label: "unreviewed",
      clearAction: "mark reviewed",
      onClear: { action: "todo.review" },
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

    expect(isActionRef({ action: "todo.review", args: { ids: ["t1"] } })).toBe(true);
    expect(isActionRef({ args: {} })).toBe(false);
  });
});
