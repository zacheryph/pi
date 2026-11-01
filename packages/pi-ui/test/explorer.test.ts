import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerView } from "../src/explorer.ts";
import { bounded, flush, keys, plain, surface, theme, wheel } from "./helpers.ts";

const long = Array.from({ length: 80 }, (_, i) => `line${i}`).join("\n");
function setup(view?: Partial<ExplorerView>) {
  const tui = surface(),
    done = vi.fn(),
    onOpen = vi.fn(),
    onReview = vi.fn();
  const data: ExplorerView = {
    title: { label: "Items", icon: "✓" },
    note: "Snapshot",
    onOpen,
    onReview,
    items: [
      {
        id: "a",
        label: "Alpha",
        marker: true,
        description: "needle",
        badge: { label: "enabled", color: "success" },
        detail: long,
      },
      { id: "b", label: "Beta", marker: true, detail: "beta details" },
    ],
    tabs: [
      { label: "All", ids: ["a", "b"] },
      { label: "Recent", ids: ["b"] },
      { label: "Empty", ids: [], emptyText: "No recent items" },
    ],
    legend: [{ label: "✓", color: "success", meaning: "enabled" }],
    ...view,
  };
  const explorer = new Explorer({ tui, theme, keys: keys(), view: data, done });
  explorer.focused = true;
  return { explorer, data, tui, done, onOpen, onReview };
}
const output = (view: Explorer, width = 80) => plain(view.render(width));
describe("Explorer", () => {
  it("copies snapshot presentation, keeps opaque ids, and preserves the focused input cursor", () => {
    const { explorer, data } = setup();
    data.items[0].label = "mutated";
    data.items[0].badge!.label = "changed";
    expect(output(explorer)).toContain("Alpha");
    expect(output(explorer)).toContain("enabled");
    expect(output(explorer)).not.toContain("mutated");
    expect(explorer.render(80).some((row) => row.includes(CURSOR_MARKER))).toBe(true);
    const onOpen = vi.fn();
    const opaque = setup({
      items: [{ id: "\nopaque", label: "safe", detail: "detail" }],
      onOpen,
      tabs: undefined,
    }).explorer;
    opaque.handleInput("\r");
    expect(onOpen).toHaveBeenCalledWith("\nopaque");
  });
  it("filters searchable metadata/paste, opens details, backs out, clears filter and closes", () => {
    const { explorer, onOpen, done } = setup();
    explorer.render(80);
    explorer.handleInput("\x1b[200~needle\x1b[201~");
    expect(output(explorer)).toContain("Alpha");
    expect(output(explorer)).not.toContain("Beta");
    explorer.handleInput("\r");
    expect(onOpen).toHaveBeenCalledWith("a");
    expect(output(explorer)).toContain("line0");
    explorer.handleInput("\x1b[F");
    expect(output(explorer)).toContain("line79");
    explorer.handleInput("\x1b");
    expect(output(explorer)).toContain("Alpha");
    explorer.handleInput("\x1b");
    expect(output(explorer)).toContain("Beta");
    explorer.handleInput("\x1b");
    explorer.handleInput("\x03");
    expect(done).toHaveBeenCalledOnce();
  });
  it("supports tab order, filtered reviews and local marker clearing without mutating input", () => {
    const { explorer, onReview, data } = setup();
    explorer.handleInput("\t");
    expect(output(explorer)).not.toContain("Alpha");
    explorer.handleInput("\x12");
    expect(onReview).toHaveBeenCalledWith(["b"]);
    explorer.handleInput("\x12");
    expect(onReview).toHaveBeenCalledOnce();
    expect(data.items[1].marker).toBe(true);
    explorer.handleInput("\t");
    expect(output(explorer)).toContain("No recent items");
    explorer.handleInput("\x1b[Z");
    expect(output(explorer)).toContain("Beta");
  });
  it("bounds malicious fields, themed rows and all narrow viewports in both list and detail", () => {
    const { explorer, tui } = setup({
      items: [{ id: "x", label: "界👨‍👩‍👧‍👦\nlabel\x1b]52;c;bad\x07", detail: long }],
      tabs: undefined,
    });
    for (const state of ["list", "detail"]) {
      if (state === "detail") explorer.handleInput("\r");
      for (const rows of [0, 1, 3, 8, 30])
        for (let width = 0; width <= 80; width++) {
          tui.terminal.rows = rows;
          bounded(explorer.render(width), width, Math.floor(rows * 0.8));
        }
    }
  });
  it("handles wheel selection and ignores it in regular mode", () => {
    const { explorer, onOpen, tui } = setup();
    expect(explorer.handleMouse(wheel(1))).toEqual({ handled: true });
    explorer.handleInput("\r");
    expect(onOpen).toHaveBeenCalledWith("b");
    tui.mode = "regular";
    expect(explorer.handleMouse(wheel(1))).toBeUndefined();
  });
  it("loads only opened details and rejects stale loads after back, reopen and disposal", async () => {
    const pending: Array<{ resolve: (text: string) => void; signal: AbortSignal }> = [];
    const loadDetail = vi.fn(
      (_id: string, signal: AbortSignal) =>
        new Promise<string>((resolve) => pending.push({ resolve, signal })),
    );
    const { explorer } = setup({ loadDetail });
    expect(loadDetail).not.toHaveBeenCalled();
    explorer.handleInput("\r");
    expect(output(explorer)).toContain("Loading…");
    await flush();
    explorer.handleInput("\x1b");
    expect(pending[0].signal.aborted).toBe(true);
    explorer.handleInput("\r");
    await flush();
    pending[0].resolve("stale");
    pending[1].resolve("fresh");
    await flush();
    expect(output(explorer)).toContain("fresh");
    expect(output(explorer)).not.toContain("stale");
    explorer.handleInput("\x1b");
    explorer.handleInput("\r");
    await flush();
    explorer.dispose();
    expect(pending[2].signal.aborted).toBe(true);
    pending[2].resolve("late");
    await flush();
    expect(explorer.render(80)).toEqual([]);
  });
  it("renders synchronous and asynchronous detail failures safely", async () => {
    for (const loadDetail of [
      () => {
        throw new Error("sync\x1b]0;bad\x07");
      },
      () => Promise.reject(new Error("async")),
    ]) {
      const { explorer } = setup({ loadDetail });
      explorer.handleInput("\r");
      await flush();
      expect(output(explorer)).toContain("Unable to load:");
      expect(output(explorer)).not.toContain("bad");
      explorer.dispose();
    }
  });
});
