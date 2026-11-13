import { describe, expect, it, vi } from "vitest";
import { defineAction, type ActionBus, type ExplorerModel } from "#surface";
import { Explorer, showExplorer, snapshotExplorer, type ExplorerView } from "#src/explorer";
import { fakeEventBus } from "#test-helpers";
import { flush, keys, plain, surface, theme } from "#test/helpers";

const CTRL_R = "\x12";

function model(extra: Partial<ExplorerModel> = {}): ExplorerModel {
  return {
    title: "Items",
    items: [
      { id: "a", label: "Alpha", marked: true },
      { id: "b", label: "Beta", marked: true },
    ],
    marker: {
      label: "unreviewed",
      clearAction: "mark reviewed",
      onClear: { action: "demo.review" },
    },
    onOpen: { action: "demo.open", args: { from: "test" } },
    loadDetail: { action: "demo.detail", args: { depth: 2 } },
    ...extra,
  };
}

function setup(view: ExplorerView = model(), actions?: ActionBus) {
  const tui = surface();
  const explorer = new Explorer({ tui, theme, keys: keys(), view, done: vi.fn(), actions });
  return { explorer, tui };
}

describe("Explorer with action references", () => {
  it("dispatches loadDetail, onOpen and onClear through the session bus with their context", async () => {
    const bus = fakeEventBus();
    const detail = vi.fn((args: unknown) => [
      { heading: `Detail for ${(args as { id: string }).id}` },
    ]);
    const open = vi.fn(),
      review = vi.fn();
    defineAction(bus, { id: "demo.detail", title: "Detail", handler: detail });
    defineAction(bus, { id: "demo.open", title: "Open", handler: open });
    defineAction(bus, { id: "demo.review", title: "Review", handler: review });
    const { explorer, tui } = setup(model(), bus);

    expect(detail).not.toHaveBeenCalled();
    explorer.handleInput("\r");
    expect(plain(explorer.render(80))).toContain("Loading…");
    await flush();
    expect(detail).toHaveBeenCalledWith({ depth: 2, id: "a" });
    expect(open).toHaveBeenCalledWith({ from: "test", id: "a" });
    expect(review).toHaveBeenCalledWith({ ids: ["a"] });
    expect(plain(explorer.render(80))).toContain("Detail for a");
    expect(tui.requestRender).toHaveBeenCalled();

    explorer.handleInput("\x1b");
    explorer.handleInput(CTRL_R);
    await flush();
    expect(review).toHaveBeenLastCalledWith({ ids: ["b"] });
    expect(plain(explorer.render(80))).toContain("Ctrl+R mark reviewed");
  });

  it("shows a failed or malformed action result in place, like a failed loader", async () => {
    const bus = fakeEventBus();
    defineAction(bus, {
      id: "demo.detail",
      title: "Detail",
      handler: () => {
        throw new Error("gone");
      },
    });
    defineAction(bus, { id: "demo.shape", title: "Wrong shape", handler: () => ({ nope: 1 }) });
    const failed = setup(model({ onOpen: undefined, marker: undefined }), bus).explorer;
    failed.handleInput("\r");
    await flush();
    expect(plain(failed.render(80))).toContain("Couldn't load: gone");

    const wrong = setup(
      model({ onOpen: undefined, marker: undefined, loadDetail: { action: "demo.shape" } }),
      bus,
    ).explorer;
    wrong.handleInput("\r");
    await flush();
    expect(plain(wrong.render(80))).toContain(
      'Couldn\'t load: action "demo.shape" returned no detail content',
    );

    const missing = setup(model({ onOpen: undefined, marker: undefined }), fakeEventBus()).explorer;
    missing.handleInput("\r");
    await flush();
    expect(plain(missing.render(80))).toContain('Couldn\'t load: Unknown action "demo.detail".');
  });

  it("reports a missing bus in place, and drops failures of fire-and-forget actions", async () => {
    const { explorer } = setup(model());
    explorer.handleInput("\r");
    await flush();
    expect(plain(explorer.render(80))).toContain(
      'Couldn\'t load: no action registry for "demo.detail"',
    );
    explorer.handleInput("\x1b");
    expect(() => explorer.handleInput(CTRL_R)).not.toThrow();
    await flush();
  });

  it("keeps callbacks working beside references, and snapshots references", () => {
    const onClear = vi.fn();
    const view: ExplorerView = {
      ...model({ onOpen: undefined }),
      marker: { label: "unreviewed", onClear },
    };
    const { explorer } = setup(view, fakeEventBus());
    explorer.handleInput(CTRL_R);
    expect(onClear).toHaveBeenCalledWith(["a", "b"]);

    const source = model();
    const snapshot = snapshotExplorer(source);
    (source.loadDetail!.args as { depth: number }).depth = 9;
    expect(snapshot.loadDetail).toEqual({ action: "demo.detail", args: { depth: 2 } });
  });

  it("passes the bus through showExplorer without handing it to the modal options", async () => {
    const bus = fakeEventBus();
    const custom = vi.fn(async () => undefined);
    await showExplorer(
      { mode: "tui", hasUI: true, ui: { custom, notify: vi.fn() } } as never,
      model(),
      { command: "/demo", actions: bus },
    );
    expect(custom).toHaveBeenCalledOnce();
    expect(custom.mock.calls[0]).not.toContainEqual(expect.objectContaining({ actions: bus }));
  });
});
