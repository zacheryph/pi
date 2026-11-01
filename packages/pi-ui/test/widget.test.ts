import { describe, expect, it } from "vitest";
import { Widget, renderWidget, type WidgetView } from "../src/widget.ts";
import { ICONS } from "../src/icons.ts";
import { bounded, plain, theme } from "./helpers.ts";

function view(): WidgetView {
  return {
    title: { label: "Tasks", icon: ICONS.tasks },
    right: ["● 2 new · 3/8", "3/8"],
    maxRows: 5,
    rows: Array.from({ length: 8 }, (_, i) => ({
      left: theme.fg("accent", `item${i} 界 long identity\nextra`),
      right: ["✓ completed", "✓"],
    })),
  };
}
describe("pure widget layout", () => {
  it("reserves overflow and honors caller-owned row/visibility limits", () => {
    const v = view();
    expect(plain(renderWidget(v, 60, theme))).toContain("+5 more");
    expect(renderWidget(v, 60, theme)).toHaveLength(5);
    expect(plain(renderWidget({ ...v, maxVisible: 1, omitted: 2 }, 60, theme))).toContain(
      "+9 more",
    );
    expect(renderWidget({ ...v, maxRows: 1 }, 60, theme)).toHaveLength(1);
    expect(renderWidget({ ...v, maxRows: 0 }, 60, theme)).toEqual([]);
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
