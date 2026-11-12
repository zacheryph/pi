import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerView } from "#src/explorer";
import { bounded, flush, keys, plain, surface, theme, wheel } from "#test/helpers";

/** Tags each tone so tests can assert semantic styling. */
const tagged = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};
const long = Array.from({ length: 80 }, (_, i) => `line${i}`).join("\n");
function setup(view?: Partial<ExplorerView>, style: object = theme) {
  const tui = surface(),
    done = vi.fn(),
    onOpen = vi.fn(),
    onClear = vi.fn();
  const data: ExplorerView = {
    title: { label: "Items", icon: "✓" },
    noun: ["task", "tasks"],
    notices: [[{ text: "Snapshot" }, { text: " · old", tone: "warning" }]],
    onOpen,
    marker: { label: "unreviewed", clearAction: "mark reviewed", onClear },
    hints: [{ keys: "/todo:add", action: "add" }],
    items: [
      {
        id: "a",
        label: [
          { text: "Alpha", tone: "accent" },
          { text: " — first", tone: "muted" },
        ],
        marked: true,
        search: "needle",
        badge: { text: "enabled", tone: "success" },
        detail: long,
      },
      { id: "b", label: "Beta", marked: true, detail: [{ heading: "Beta details" }] },
    ],
    tabs: [
      { label: "All", ids: ["a", "b"] },
      { label: "Recent", ids: ["b"] },
      { label: "Empty", ids: [], emptyText: "No recent tasks" },
    ],
    ...view,
  };
  const explorer = new Explorer({ tui, theme: style as never, keys: keys(), view: data, done });
  explorer.focused = true;
  return { explorer, data, tui, done, onOpen, onClear };
}
const output = (view: Explorer, width = 80) => plain(view.render(width));
describe("Explorer", () => {
  it("copies snapshot presentation, keeps opaque ids, and preserves the focused input cursor", () => {
    const { explorer, data } = setup();
    data.items[0].badge!.text = "changed";
    expect(output(explorer)).toContain("Alpha — first");
    expect(output(explorer)).toContain("enabled");
    expect(output(explorer)).not.toContain("changed");
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
  it("styles spans by tone, accents markers on every row and the whole selected label", () => {
    const { explorer } = setup({}, tagged);
    explorer.handleInput("\x1b[B");
    // Tags inflate measured widths, so give tagged rows ample room.
    const rows = explorer.render(300).join("\n");
    expect(rows).toContain("<accent>Alpha</accent><muted> — first</muted>");
    expect(rows).toContain("<accent>●</accent> <accent>Alpha");
    expect(rows).toContain("<accent>→</accent> <accent>●</accent> <accent>Beta</accent>");
    expect(rows).toContain("<success>enabled</success>");
    expect(rows).toContain("<warning> · old</warning>");
  });
  it("shows a live status row with the marker count, and wraps prioritized hints", () => {
    const { explorer, onClear } = setup();
    expect(output(explorer)).toContain("│ ── 1/2 tasks · 2 unreviewed ──");
    // Header chrome (filter, tabs, notices) is divided from the list.
    expect(output(explorer)).toMatch(/Snapshot · old +│ \n │ ─+ │ \n │ → /);
    const wide = output(explorer, 200);
    for (const hint of [
      "Enter open",
      "Esc close",
      "Tab view",
      "Ctrl+R mark reviewed",
      "/todo:add add",
      "↑↓ PgUp/PgDn Home/End",
    ])
      expect(wide).toContain(hint);
    // At 80 columns everything still fits across two hint rows.
    expect(output(explorer)).toContain("/todo:add add");
    expect(output(explorer)).toContain("PgUp/PgDn");
    // Narrow: navigation goes first, actions never drop.
    const narrow = output(explorer, 40);
    expect(narrow).toContain("Enter open");
    expect(narrow).not.toContain("PgUp");
    explorer.handleInput("\r");
    expect(onClear).toHaveBeenCalledWith(["a"]);
    explorer.handleInput("\x1b");
    expect(output(explorer)).toContain("1 unreviewed");
    explorer.handleInput("\x12");
    expect(onClear).toHaveBeenLastCalledWith(["b"]);
    expect(output(explorer)).not.toContain("unreviewed");
  });
  it("filters searchable metadata/paste, opens details with a badge header, backs out, clears filter and closes", () => {
    const { explorer, onOpen, done } = setup();
    explorer.render(80);
    explorer.handleInput("\x1b[200~needle\x1b[201~");
    expect(output(explorer)).toContain("Alpha");
    expect(output(explorer)).not.toContain("Beta");
    expect(output(explorer)).toContain("1/1 task · 2 total");
    expect(output(explorer)).toContain("Esc clear filter");
    explorer.handleInput("\r");
    expect(onOpen).toHaveBeenCalledWith("a");
    expect(plain(explorer.render(80))).toContain("Items / Alpha — first");
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
  it("supports tab order, filtered clears and local marker clearing without mutating input", () => {
    const { explorer, onClear, data } = setup();
    explorer.handleInput("\t");
    expect(output(explorer)).not.toContain("Alpha");
    explorer.handleInput("\x12");
    expect(onClear).toHaveBeenCalledWith(["b"]);
    explorer.handleInput("\x12");
    expect(onClear).toHaveBeenCalledOnce();
    expect(data.items[1].marked).toBe(true);
    explorer.handleInput("\t");
    expect(output(explorer)).toContain("No recent tasks");
    explorer.handleInput("\x1b[Z");
    expect(output(explorer)).toContain("Beta");
  });
  it("keeps the full height and blanks the status row while a detail shows every line", () => {
    const { explorer } = setup();
    const rules = () => output(explorer).match(/│ ─{10,} │/g) ?? [];
    expect(explorer.render(80)).toHaveLength(24);
    explorer.handleInput("\x1b[B");
    explorer.handleInput("\r");
    expect(explorer.render(80)).toHaveLength(24);
    expect(output(explorer)).toContain("Beta details");
    // Only the header divider remains; a blank row separates the body from the hints.
    expect(rules()).toHaveLength(1);
    expect(output(explorer)).toMatch(/│ +│ \n │ Esc back/);
    explorer.handleInput("\x1b");
    explorer.handleInput("\x1b[A");
    explorer.handleInput("\r");
    expect(output(explorer)).toMatch(/── 1–\d+\/82 lines ──/);
  });
  it("uses view-level empty text and the noun", () => {
    expect(
      output(setup({ items: [], tabs: undefined, emptyText: "No stash entries." }).explorer),
    ).toContain("No stash entries.");
    expect(output(setup({ items: [], tabs: undefined }).explorer)).toContain("No tasks.");
  });
  it("bounds malicious fields, themed rows and all narrow viewports in both list and detail", () => {
    const { explorer, tui } = setup({
      items: [
        {
          id: "x",
          label: "界👨‍👩‍👧‍👦\nlabel\x1b]52;c;bad\x07",
          detail: long,
          badge: { text: "界 badge" },
        },
      ],
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
    expect(output(explorer)).not.toContain("52;c");
  });
  it("handles wheel selection", () => {
    const { explorer, onOpen } = setup();
    expect(explorer.handleMouse(wheel(1))).toEqual({ handled: true });
    explorer.handleInput("\r");
    expect(onOpen).toHaveBeenCalledWith("b");
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
  it("renders synchronous and asynchronous detail failures with the message only", async () => {
    for (const loadDetail of [
      () => {
        throw new Error("sync\x1b]0;bad\x07");
      },
      () => Promise.reject(new Error("async")),
      () => Promise.reject("plain"),
    ]) {
      const { explorer } = setup({ loadDetail });
      explorer.handleInput("\r");
      await flush();
      expect(output(explorer)).toMatch(/Couldn't load: (sync|async|plain)/);
      expect(output(explorer)).not.toContain("Error:");
      expect(output(explorer)).not.toContain("bad");
      explorer.dispose();
    }
  });
});

it("renders the detail header bold with its badge, and errors in the error tone", async () => {
  const { explorer } = setup({}, tagged);
  explorer.handleInput("\r");
  const detail = explorer.render(300).join("\n");
  expect(detail).toContain("<b>Alpha</b>");
  expect(detail).toContain("<success>enabled</success>");
  const failing = setup({ loadDetail: () => Promise.reject(new Error("nope")) }, tagged).explorer;
  failing.handleInput("\r");
  await flush();
  expect(failing.render(300).join("\n")).toContain("<error>Couldn't load: nope</error>");
});
