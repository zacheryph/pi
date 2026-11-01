import { describe, expect, it } from "vitest";
import { Widget, renderWidget, type WidgetView } from "../src/widget.ts";
import { ICONS } from "../src/icons.ts";
import { bounded, plain, theme } from "./helpers.ts";

const tagged = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
};
function view(): WidgetView {
  return {
    title: { label: "Tasks", icon: ICONS.tasks },
    meta: [[{ text: "● 2 new", tone: "accent" }, " · 3/8"], ["3/8"]],
    maxRows: 5,
    rows: Array.from({ length: 8 }, (_, i) => ({
      left: [{ text: `item${i} 界 long identity\nextra`, tone: "default" as const }],
      right: [[{ text: "✓ completed", tone: "success" as const }], ["✓"]],
      group: i % 2 ? "finished" : "running",
    })),
  };
}
describe("pure widget layout", () => {
  it("reserves overflow with a grouped summary and honors row/visibility limits", () => {
    const v = view();
    expect(plain(renderWidget(v, 60, theme))).toContain("+5 more (2 running, 3 finished)");
    expect(renderWidget(v, 60, theme)).toHaveLength(5);
    expect(plain(renderWidget({ ...v, maxVisible: 1 }, 60, theme))).toContain("+7 more");
    expect(renderWidget({ ...v, maxRows: 1 }, 60, theme)).toHaveLength(1);
    expect(renderWidget({ ...v, maxRows: 0 }, 60, theme)).toEqual([]);
    const ungrouped = { ...v, rows: v.rows.map(({ group: _group, ...row }) => row) };
    expect(plain(renderWidget(ungrouped, 60, theme))).toMatch(/\+5 more\s*$/m);
  });
  it("treats Infinity as unbounded for both row budgets", () => {
    const v = view();
    expect(renderWidget({ ...v, maxRows: Infinity }, 60, theme)).toHaveLength(9);
    expect(renderWidget({ ...v, maxRows: Infinity, maxVisible: Infinity }, 60, theme)).toHaveLength(
      9,
    );
    expect(renderWidget({ ...v, maxRows: NaN }, 60, theme)).toEqual([]);
  });
  it("dims the heading while idle and keeps two spaces after the icon", () => {
    const active = renderWidget(view(), 80, tagged as never)[0];
    expect(active).toContain(`<accent>${ICONS.tasks}  Tasks</accent>`);
    expect(renderWidget({ ...view(), active: false }, 80, tagged as never)[0]).toContain(
      `<dim>${ICONS.tasks}  Tasks</dim>`,
    );
    expect(active).toContain("<accent>● 2 new</accent> · 3/8");
  });
  it("keeps the last right fallback over left text when asked", () => {
    const row = { left: "identity that is long", right: [["✓ completed"], ["✓"]] };
    const body = (keepRight: boolean, width: number) =>
      plain(
        renderWidget({ title: "T", rows: [{ ...row, keepRight }], maxRows: 2 }, width, theme),
      ).split("\n")[1];
    expect(body(false, 8)).toBe(" ide… ✓ ");
    expect(body(false, 4)).toBe(" i… ");
    expect(body(true, 4)).toBe("  ✓ ");
  });
  it("never wraps a task/agent row or exceeds any viewport budget", () => {
    for (let width = 0; width <= 80; width++)
      for (let maxRows = 0; maxRows <= 8; maxRows++) {
        const lines = renderWidget({ ...view(), maxRows }, width, theme);
        bounded(lines, width, maxRows);
        for (const row of lines.slice(1)) {
          if (width <= 2) expect(row).toBe(" ".repeat(width));
          else {
            expect(row.startsWith(" ")).toBe(true);
            expect(row.endsWith(" ")).toBe(true);
          }
        }
      }
  });
  it("copies presentation data and leaves selection, empty states and refresh to the caller", () => {
    const v = view(),
      widget = new Widget(v, theme);
    v.rows = [];
    expect(plain(widget.render(60))).toContain("item0");
    widget.setView({ ...v, emptyText: "No tasks\nin this view" });
    expect(plain(widget.render(60))).toContain("No tasks in this view");
    expect(plain(widget.render(60))).not.toContain("item0");
  });
});
