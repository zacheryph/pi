import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fakeEventBus } from "#test-helpers";
import {
  batchViews,
  collectViews,
  defineView,
  listViews,
  onViewChanged,
  viewRegistry,
  type ActionBus,
  type ViewEntry,
  type WidgetModel,
} from "#src/index";

const widget: WidgetModel = { title: "W", rows: [{ left: "a" }] };

/** Collects on every announcement, as an adapter with no batching would. */
function collectOnChange(bus: ActionBus) {
  const deliveries: string[][] = [];
  onViewChanged(bus, () => deliveries.push(collectViews(bus).map((view) => view.id)));
  return deliveries;
}

describe("view lifecycle announcements", () => {
  it("announces a definition after it is readable: the first publication carries it", () => {
    const bus = createEventBus();
    const deliveries = collectOnChange(bus);
    defineView(bus, { id: "todo.widget", kind: "widget", title: "T", model: () => widget });
    expect(deliveries).toEqual([["todo.widget"]]);
  });

  it("announces a removal after the view has gone, so the next collection omits it", () => {
    const bus = createEventBus();
    const views = viewRegistry(bus);
    views.define({ id: "todo.widget", kind: "widget", title: "T", model: () => widget });
    const removeExplorer = views.define({
      id: "todo.explorer",
      kind: "explorer",
      title: "E",
      model: () => ({ title: "E", items: [] }),
    });
    const removeOther = defineView(bus, {
      id: "git.widget",
      kind: "widget",
      title: "G",
      model: () => widget,
    });
    const heard = vi.fn();
    onViewChanged(bus, heard);
    const deliveries = collectOnChange(bus);
    removeExplorer();
    removeOther();
    expect(heard.mock.calls).toEqual([["todo.explorer"], ["git.widget"]]);
    expect(deliveries).toEqual([["git.widget", "todo.widget"], ["todo.widget"]]);
    // Removal is idempotent and announces once.
    removeExplorer();
    removeOther();
    expect(heard).toHaveBeenCalledTimes(2);
    // The registry no longer owns it: `changed` stays silent.
    views.changed("todo.explorer");
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("disposes without announcing, so a closing session does not send an empty snapshot", () => {
    const bus = fakeEventBus();
    const views = viewRegistry(bus);
    views.define({ id: "todo.widget", kind: "widget", title: "T", model: () => widget });
    views.define({
      id: "todo.summary",
      kind: "summary",
      title: "S",
      model: () => ({ counts: [] }),
    });
    const heard = vi.fn();
    onViewChanged(bus, heard);
    views.dispose();
    expect(heard).not.toHaveBeenCalled();
    expect(listViews(bus)).toEqual([]);
  });

  it("reload: the same bus is disposed and defined again, and the redefinition is published", () => {
    const bus = createEventBus();
    const deliveries = collectOnChange(bus);
    // One factory run of an extension: session_start defines, session_shutdown disposes.
    const load = (ids: string[]) => {
      const views = viewRegistry(bus);
      views.dispose();
      for (const id of ids) views.define({ id, kind: "widget", title: id, model: () => widget });
      return views;
    };
    const first = load(["todo.widget", "todo.old"]);
    first.dispose();
    // A late change from the old load reaches nobody.
    first.changed("todo.widget");
    load(["todo.widget"]);
    // The old load's last view vanishes with the new load's first publication.
    expect(deliveries).toEqual([["todo.widget"], ["todo.old", "todo.widget"], ["todo.widget"]]);
  });

  it("session replacement: each session's bus collects only its own views", () => {
    const old = createEventBus();
    const next = createEventBus();
    defineView(old, { id: "todo.widget", kind: "widget", title: "Old", model: () => widget });
    const heard = vi.fn();
    onViewChanged(old, heard);
    defineView(next, { id: "todo.widget", kind: "widget", title: "New", model: () => widget });
    expect(heard).not.toHaveBeenCalled();
    expect(collectViews(next).map((view: ViewEntry) => view.title)).toEqual(["New"]);
    expect(collectViews(old).map((view: ViewEntry) => view.title)).toEqual(["Old"]);
  });

  it("drops a removal's announcement on a bus Pi has retired", () => {
    const bus = fakeEventBus();
    const remove = defineView(bus, {
      id: "todo.widget",
      kind: "widget",
      title: "T",
      model: () => widget,
    });
    const views = viewRegistry(bus);
    const removeOwned = views.define({
      id: "todo.explorer",
      kind: "explorer",
      title: "E",
      model: () => ({ title: "E", items: [] }),
    });
    // What Pi's stale extension API does after shutdown or reload.
    bus.emit.mockImplementation(() => {
      throw new Error("ctx is stale");
    });
    expect(() => remove()).not.toThrow();
    expect(() => removeOwned()).not.toThrow();
    expect(() => views.dispose()).not.toThrow();
  });

  it("an adapter's batcher hears a removal and its next flush leaves the view out", () => {
    const bus = createEventBus();
    const remove = defineView(bus, {
      id: "todo.widget",
      kind: "widget",
      title: "T",
      model: () => widget,
    });
    const sent: string[][] = [];
    let fire: (() => void) | undefined;
    const batcher = batchViews(bus, {
      delayMs: 10,
      flush: () => sent.push(collectViews(bus).map((view) => view.id)),
      timers: {
        setTimeout: (callback) => (fire = callback),
        clearTimeout: () => (fire = undefined),
      },
    });
    remove();
    fire?.();
    expect(sent).toEqual([["todo.widget"], []]);
    batcher.dispose();
  });
});
