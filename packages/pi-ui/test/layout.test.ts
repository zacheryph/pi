import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  BoundedLines,
  bodyRow,
  cells,
  divider,
  fitPanelHeight,
  labeledRule,
  layoutPanel,
  renderPanel,
  splitColumns,
  titleText,
} from "#src/layout";
import { bounded, plain, theme } from "#test/helpers";

const styled = theme.fg("accent", "界é👨‍👩‍👧‍👦 longer text");
describe("terminal geometry", () => {
  it("bounds frames and rows at every small width/height and after repeated resizes", () => {
    for (const width of [...Array.from({ length: 12 }, (_, i) => i), 20, 40, 80, 120]) {
      for (let height = 0; height <= 12; height++) {
        const g = layoutPanel(width, height, 4, 3);
        const rows = renderPanel(
          g,
          { label: "Title\nunsafe", icon: "✓", detail: "界" },
          [styled, styled],
          theme,
          { before: [styled, styled, styled, styled], after: [styled, styled, styled] },
        );
        bounded(rows, width, height);
        expect(rows.length).toBe(width ? height : 0);
        for (const row of g.framed ? rows.slice(1, -1) : rows) {
          if (width <= 2) expect(row).toBe(" ".repeat(width));
          else {
            expect(row.startsWith(" ")).toBe(true);
            expect(row.endsWith(" ")).toBe(true);
          }
        }
      }
    }
  });
  it("divides header rows from the body, dropping the divider before any body or header row", () => {
    expect(layoutPanel(40, 12, 2, 3)).toMatchObject({ beforeRows: 2, dividerRows: 1, bodyRows: 4 });
    expect(layoutPanel(40, 12, 0, 3)).toMatchObject({ dividerRows: 0, bodyRows: 7 });
    // Tight: header + footer + one body row leave no room for the divider.
    expect(layoutPanel(40, 7, 2, 2)).toMatchObject({ beforeRows: 2, dividerRows: 0, bodyRows: 1 });
    const g = layoutPanel(20, 8, 1, 1);
    const rows = renderPanel(g, "T", ["body"], theme, { before: ["head"], after: ["foot"] });
    expect(plain(rows).split("\n").slice(1, 4)).toEqual([
      " │ head           │ ",
      " │ ────────────── │ ",
      " │ body           │ ",
    ]);
    const unframed = renderPanel(layoutPanel(5, 3, 1, 0), "T", ["界界界"], theme, {
      before: ["界"],
    });
    expect(plain(unframed)).toBe(" 界  \n ─── \n 界… ");
    for (let width = 0; width < 12; width++)
      expect(visibleWidth(divider(width, theme))).toBe(width);
  });
  it("fits the panel height to its content, capped at the maximum", () => {
    // Frame 2 + header 2 + divider 1 + body 3 + footer 2.
    expect(fitPanelHeight(40, 20, 3, 2, 2)).toBe(10);
    expect(layoutPanel(40, 10, 2, 2)).toMatchObject({ bodyRows: 3, dividerRows: 1 });
    expect(fitPanelHeight(40, 20, 3)).toBe(5);
    expect(fitPanelHeight(40, 20, 0)).toBe(3);
    expect(fitPanelHeight(40, 8, 30, 2, 2)).toBe(8);
    // Unframed at narrow widths: header 1 + divider 1 + body 2 + footer 1.
    expect(fitPanelHeight(5, 10, 2, 1, 1)).toBe(5);
    expect(fitPanelHeight(0, 10, 3)).toBe(10);
    // A short framed panel must retain the cap's narrower content width.
    expect(fitPanelHeight(7, 20, 1)).toBe(3);
    expect(layoutPanel(7, fitPanelHeight(7, 20, 1)).contentWidth).toBe(1);
    expect(fitPanelHeight(7, 2, 1)).toBe(1);
    expect(fitPanelHeight(40, 20, 3.9, 1.9, 2.9)).toBe(9);
    for (const width of [0, 3, 7, 20])
      for (const max of [0, 1, 3, 6, 12])
        expect(fitPanelHeight(width, max, 4, 2, 1)).toBeLessThanOrEqual(max);
  });
  it("keeps padded body rows and full-width rules in display cells without wrapping", () => {
    for (let width = 0; width < 100; width++) {
      const body = bodyRow(styled + "\nsecond row", width);
      expect(visibleWidth(body)).toBe(width);
      bounded([body], width, 1);
      const rule = labeledRule(
        width,
        (text) => theme.fg("border", text),
        [styled, "短"],
        [styled, "4/8"],
      );
      expect(visibleWidth(rule)).toBe(width);
    }
  });
  it("prioritizes right-hand fallbacks, clips left first and drops right before the minimum left", () => {
    expect(plain([splitColumns("long identity", ["too long a status", "ok"], 12)])).toBe(
      "long ide… ok",
    );
    expect(plain([splitColumns("identity", "ok", 3)])).toBe("id…");
    expect(plain([splitColumns("identity", ["long status"], 6, { keepRight: true })])).toBe(
      "long …",
    );
    expect(plain([splitColumns("identity", ["ok"], 3, { minLeftWidth: 3, keepRight: true })])).toBe(
      " ok",
    );
    expect(plain([splitColumns("identity", ["bad", "✓"], 4, { minLeftWidth: 2 })])).toBe("i… ✓");
  });
  it("does not reserve a right column for empty styled text", () => {
    expect(plain([splitColumns("abcdefgh", theme.fg("dim", ""), 8)])).toBe("abcdefgh");
  });
  it("retains trusted cursor markers and ANSI, but truncates all row break variants", () => {
    expect(bodyRow(`x${CURSOR_MARKER}y`, 8)).toContain(CURSOR_MARKER);
    const source = [styled + "\u2028second", "tail"],
      component = new BoundedLines(source);
    source.push("mutated");
    bounded(component.render(6), 6, 2);
    expect(plain(component.render(80))).not.toContain("second");
    expect(plain(new BoundedLines(["abcdefgh"]).render(5))).toBe("abcd…");
    expect(component.render(0)).toEqual(["", ""]);
  });
  it("normalizes invalid dimensions and untrusted titles", () => {
    expect([NaN, Infinity, -1].map(cells)).toEqual([0, 0, 0]);
    expect(
      titleText({ label: "bad\x1b]52;c;secret\x07title", icon: "✓", detail: "one\ntwo" }),
    ).toBe("✓  badtitle / one two");
    expect(layoutPanel(NaN, 10).height).toBe(0);
  });
});
