import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Terminal, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { WatchOverlay } from "#src/ui/watch-overlay";
import { createTestSubagent } from "#test/helpers/make-subagent";

function terminal() {
  const size = { columns: 120, rows: 30 };
  const term: Terminal = {
    start() {}, stop() {}, async drainInput() {}, write() {},
    get columns() { return size.columns; }, get rows() { return size.rows; }, kittyProtocolActive: false,
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  return { size, term };
}
function mount(tui: TuiAltScreen | TuiMainScreen) {
  const record = createTestSubagent({ status: "running", isBackground: true, completedAt: undefined, description: "Live task" });
  const settings = { overlayWidth: "third" as const, overlayDefaultOpen: false };
  const ui = {
    theme: { fg: (_: string, text: string) => text, bold: (text: string) => text },
    notify: vi.fn(),
    setWidget: vi.fn((_key: string, factory: unknown) => {
      if (typeof factory === "function") tui.addChild(factory(tui, ui.theme));
    }),
  };
  const watch = new WatchOverlay({ listAgents: () => [record] }, new AgentTypeRegistry(() => new Map()), settings);
  watch.setContext({ mode: "tui", hasUI: true, ui: ui as unknown as ExtensionUIContext });
  return { watch, ui };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("watch overlay under actual Pi renderers", () => {
  it("keeps parent focus, bounds fullscreen output on resize, and removes only its own overlay", () => {
    const { term, size } = terminal();
    const tui = new TuiAltScreen(term, false, "/tmp/pi-watch-tui-test");
    const editor: Component = { render: () => ["parent editor"], invalidate() {}, handleInput() {} };
    tui.addChild(editor);
    tui.setFocus(editor);
    tui.start();
    const { watch } = mount(tui);
    try {
      tui.renderNow();
      expect(tui.getScreenLines().join("\n")).not.toContain("Subagents");
      watch.toggle();
      tui.renderNow();
      expect(tui.getFocusedComponent()).toBe(editor);
      expect(tui.getScreenLines().join("\n")).toContain("Subagents");
      expect(tui.getScreenLines().slice(-6).join("\n")).not.toContain("│");
      size.columns = 72;
      size.rows = 18;
      tui.renderNow();
      expect(tui.getScreenLines()).toHaveLength(18);
      for (const line of tui.getScreenLines()) expect(visibleWidth(line)).toBeLessThanOrEqual(72);
      const other: Component = { render: () => ["OTHER OVERLAY"], invalidate() {}, handleInput() {} };
      const otherHandle = tui.showOverlay(other);
      expect(tui.getFocusedComponent()).toBe(other);
      watch.dispose();
      tui.renderNow();
      expect(otherHandle.isHidden()).toBe(false);
      expect(tui.getFocusedComponent()).toBe(other);
      expect(tui.getScreenLines().join("\n")).toContain("OTHER OVERLAY");
      expect(tui.getScreenLines().join("\n")).not.toContain("Subagents");
      otherHandle.hide();
    } finally { watch.dispose(); tui.stop(); }
  });

  it("never puts watch pixels into regular-mode render state", () => {
    const { term } = terminal();
    const tui = new TuiMainScreen(term, false, "/tmp/pi-watch-tui-test");
    const { watch, ui } = mount(tui);
    try {
      watch.toggle();
      expect(ui.notify).toHaveBeenCalledWith("Subagent watch overlay requires Pi fullscreen mode.", "warning");
      for (const count of [20, 80, 160]) {
        tui.addChild({ render: () => Array.from({ length: count }, (_, index) => `parent ${index}`), invalidate() {} });
        tui.renderNow();
        expect(tui.captureRenderState().previousLines.join("\n")).not.toContain("Subagents");
      }
    } finally { watch.dispose(); tui.stop(); }
  });
});
