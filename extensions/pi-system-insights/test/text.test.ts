import { describe, expect, it } from "vitest";
import type { InsightItem, InsightView } from "#src/types";
import { insightText, MAX_INSIGHT_ITEMS } from "#src/text";

const item = (id: string, overrides: Partial<InsightItem> = {}): InsightItem => ({
  id,
  label: id,
  description: `About ${id}\nin two lines`,
  detail: [],
  ...overrides,
});

describe("insightText", () => {
  it("heads a text view with its title and note, then the text", () => {
    const view: InsightView = {
      title: "Prompt",
      note: "Effective prompt",
      text: "line one\nline two",
    };
    expect(insightText(view)).toBe(
      "System insights · Prompt\nEffective prompt\n\nline one\nline two",
    );
  });

  it("lists items with their badge or status and a one-line description", () => {
    const view: InsightView = {
      title: "Skills",
      note: "Discovered skills",
      noun: ["skill", "skills"],
      legend: [{ label: "[loaded]", tone: "success", meaning: "fresh observation" }],
      items: [
        item("alpha", { badge: { text: "[loaded]", tone: "success" } }),
        item("beta", { status: "active" }),
        item("gamma", { description: "" }),
      ],
    };
    expect(insightText(view).split("\n")).toEqual([
      "System insights · Skills",
      "Discovered skills",
      "3 skills",
      "- alpha [loaded] — About alpha in two lines",
      "- beta active — About beta in two lines",
      "- gamma",
      "[loaded]=fresh observation",
      "Item details are in the terminal UI.",
    ]);
  });

  it("counts the items it does not list", () => {
    const items = Array.from({ length: MAX_INSIGHT_ITEMS + 5 }, (_, index) => item(`t${index}`));
    const lines = insightText({ title: "Tools", note: "", items }).split("\n");
    expect(lines).toContain("+5 more");
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(MAX_INSIGHT_ITEMS);
  });

  it("says so when a list is empty", () => {
    expect(insightText({ title: "Skills", note: "", items: [] })).toBe(
      "System insights · Skills\n0 items",
    );
  });
});
