import {
  type Component, CURSOR_MARKER, KeybindingsManager, type OverlayHandle, type Terminal,
  TUI_KEYBINDINGS, TuiAltScreen, TuiMainScreen, visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsightViewer, sanitizeInsightText } from "#src/viewer";

function terminal() {
  const size = { columns: 120, rows: 30 };
  let input: (data: string) => void = () => {};
  const term: Terminal = {
    start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write: vi.fn(),
    get columns() { return size.columns; }, get rows() { return size.rows; }, kittyProtocolActive: false,
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  return { size, term, send: (data: string) => input(data) };
}
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const keys = () => new KeybindingsManager(TUI_KEYBINDINGS);

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("insights under actual Pi renderers", () => {
  it("preserves padded Input IME cursor, fills overlay margins, and retains focus across resizes", () => {
    const { term, size, send } = terminal();
    const tui = new TuiAltScreen(term, false, "/tmp/pi-system-insights-tui-test");
    const parentInput = vi.fn();
    const parent: Component = {
      render: (width) => Array.from({ length: size.rows }, () => "B".repeat(width)),
      invalidate() {}, handleInput: parentInput,
    };
    tui.addChild(parent);
    tui.setFocus(parent);
    tui.start();
    let handle: OverlayHandle | undefined;
    const done = vi.fn(() => handle?.hide());
    const viewer = new InsightViewer({ tui, theme, keys: keys(), done,
      view: { title: "Skills", note: "Snapshot", items: [{
        id: "skill", label: "日本語", description: "search metadata", badge: { label: "[loaded]", color: "success" },
        detail: "Name: 日本語\nDescription: search metadata\n" + "detail body\n".repeat(100),
      }], legend: [{ label: "green", color: "success", meaning: "fresh observation" }] },
    });
    const plain = sanitizeInsightText;
    try {
      handle = tui.showOverlay(viewer, { anchor: "center", width: "80%", maxHeight: "80%" });
      tui.renderNow();
      send("日本語");
      for (const [columns, rows] of [[120, 30], [80, 24], [60, 20], [120, 30]]) {
        size.columns = columns;
        size.rows = rows;
        tui.renderNow();
        expect(tui.getFocusedComponent()).toBe(viewer);
        expect(viewer.focused).toBe(true);
        const overlayWidth = Math.floor(columns * .8);
        const local = viewer.render(overlayWidth);
        expect(local).toHaveLength(Math.floor(rows * .8));
        const markerRow = local.findIndex((line) => line.includes(CURSOR_MARKER));
        expect(markerRow).toBeGreaterThanOrEqual(0);
        const markerCol = visibleWidth(local[markerRow].split(CURSOR_MARKER)[0]);
        const screen = tui.getScreenLines().map(plain);
        const screenRow = screen.findIndex((line) => line.includes("Filter:"));
        expect(screenRow).toBeGreaterThanOrEqual(0);
        const outerLeft = Math.floor((columns - overlayWidth) / 2);
        // Cursor's final absolute move precedes hardware-cursor visibility toggle.
        const stream = vi.mocked(term.write).mock.calls.map(([text]) => text).join("");
        const moves = [...stream.matchAll(/\x1b\[(\d+);(\d+)H\x1b\[\?25[hl]/g)];
        expect(moves.at(-1)?.slice(1)).toEqual([String(screenRow + 1), String(outerLeft + markerCol + 1)]);
        for (const line of screen) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
        const top = screen.findIndex((line) => line.includes("╭"));
        const bottom = screen.findIndex((line) => line.includes("╰"));
        expect(screen[top - 1].slice(outerLeft, outerLeft + overlayWidth)).toBe(" ".repeat(overlayWidth));
        expect(screen[bottom + 1].slice(outerLeft, outerLeft + overlayWidth)).toBe(" ".repeat(overlayWidth));
        expect(screen[top + 1].slice(outerLeft, outerLeft + overlayWidth)).toMatch(/^ │ +│ $/);
      }
      send("\r");
      tui.renderNow();
      expect(viewer.render(96).join("\n")).not.toContain(CURSOR_MARKER);
      expect(tui.getScreenLines().join("\n")).toContain("System insights · Skills / 日本語");
      send("\x1b");
      tui.renderNow();
      expect(viewer.render(96).join("\n")).toContain(CURSOR_MARKER);
      expect(tui.getFocusedComponent()).toBe(viewer);
      expect(parentInput).not.toHaveBeenCalled();
      send("\x03");
      tui.renderNow();
      expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(tui.getFocusedComponent()).toBe(parent);
      send("parent key");
      expect(parentInput).toHaveBeenCalledWith("parent key");
    } finally { handle?.hide(); viewer.dispose(); tui.stop(); }
  });

  it("captures fullscreen input, pages details, bounds resize, and restores parent focus", () => {
    const { term, size, send } = terminal();
    const tui = new TuiAltScreen(term, false, "/tmp/pi-system-insights-tui-test");
    const parentInput = vi.fn();
    const parent: Component = { render: () => ["PARENT EDITOR"], invalidate() {}, handleInput: parentInput };
    tui.addChild(parent);
    tui.setFocus(parent);
    tui.start();
    let handle: OverlayHandle | undefined;
    const done = vi.fn(() => handle?.hide());
    const viewer = new InsightViewer({ tui, theme, keys: keys(), done,
      view: { title: "INSIGHTS", note: "Read-only", items: [{
        id: "read", label: "read", status: "active", description: "Read files",
        detail: Array.from({ length: 100 }, (_, i) => `DETAIL ${i}`).join("\n"),
      }] },
    });
    try {
      handle = tui.showOverlay(viewer, { anchor: "center", width: "80%", maxHeight: "80%" });
      tui.renderNow();
      expect(tui.getFocusedComponent()).toBe(viewer);
      expect(tui.getScreenLines().join("\n")).toContain("INSIGHTS");
      send("\r");
      tui.renderNow();
      expect(tui.getScreenLines().join("\n")).toContain("DETAIL 0");
      send("\x1b[F");
      tui.renderNow();
      expect(tui.getScreenLines().join("\n")).toContain("DETAIL 99");
      expect(parentInput).not.toHaveBeenCalled();
      size.columns = 52;
      size.rows = 14;
      tui.renderNow();
      expect(tui.getScreenLines()).toHaveLength(14);
      for (const line of tui.getScreenLines()) expect(visibleWidth(line)).toBeLessThanOrEqual(52);
      send("\x1b");
      tui.renderNow();
      expect(tui.getScreenLines().join("\n")).toContain("INSIGHTS");
      expect(done).not.toHaveBeenCalled();
      for (const [columns, rows] of [[9, 5], [3, 3], [1, 1], [52, 14]]) {
        size.columns = columns;
        size.rows = rows;
        tui.renderNow();
        expect(tui.getScreenLines()).toHaveLength(rows);
        for (const line of tui.getScreenLines()) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
        expect(tui.getFocusedComponent()).toBe(viewer);
        expect(parentInput).not.toHaveBeenCalled();
      }
      send("\x03");
      tui.renderNow();
      expect(done).toHaveBeenCalledOnce();
      expect(tui.getFocusedComponent()).toBe(parent);
      expect(tui.getScreenLines().join("\n")).not.toContain("INSIGHTS");
    } finally { handle?.hide(); viewer.dispose(); tui.stop(); }
  });

  it("regular non-overlay component stays bounded and removable", () => {
    const { term, size, send } = terminal();
    const tui = new TuiMainScreen(term, false, "/tmp/pi-system-insights-tui-test");
    const parent: Component = { render: width => ["PARENT EDITOR".slice(0, width)], invalidate() {} };
    tui.addChild(parent);
    let viewer: InsightViewer;
    const done = vi.fn(() => { tui.removeChild(viewer); tui.setFocus(parent); });
    viewer = new InsightViewer({ tui, theme, keys: keys(), done,
      view: { title: "REGULAR INSIGHTS", note: "Read-only", text: "中文 text\n".repeat(100) },
    });
    tui.addChild(viewer);
    tui.setFocus(viewer);
    tui.start();
    try {
      for (const columns of [120, 40, 10]) {
        size.columns = columns;
        tui.renderNow();
        for (const line of tui.captureRenderState().previousLines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
        }
        expect(viewer.render(columns)).toHaveLength(Math.floor(size.rows * 0.8));
      }
      send("\x03");
      tui.renderNow();
      expect(done).toHaveBeenCalledOnce();
      expect(tui.captureRenderState().previousLines.join("\n")).not.toContain("REGULAR INSIGHTS");
    } finally { tui.removeChild(viewer); viewer.dispose(); tui.stop(); }
  });
});
