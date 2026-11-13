import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fakeEventBus } from "#test-helpers";
import {
  announceView,
  defineView,
  listViews,
  onViewChanged,
  readView,
  VIEW_CHANGED_EVENT,
  viewRegistry,
  type ExplorerModel,
  type WidgetModel,
} from "#src/index";

const widget: WidgetModel = {
  title: { label: "Todos", icon: "☰" },
  meta: [[{ text: "1/2", tone: "muted" }]],
  rows: [{ left: "a: Task a", right: [[{ text: "▸ in_progress", tone: "accent" }]] }],
};
const explorer: ExplorerModel = {
  title: "Todos",
  items: [{ id: "a", label: "a: Task a" }],
  loadDetail: { action: "todo.inspect" },
};

describe("view registry", () => {
  it("defines, lists and reads views; reads build the current model", () => {
    const bus = fakeEventBus();
    let rows = widget.rows;
    defineView(bus, {
      id: "todo.widget",
      kind: "widget",
      title: "Tasks",
      model: () => ({ ...widget, rows }),
    });
    defineView(bus, {
      id: "todo.explorer",
      kind: "explorer",
      title: "Todos",
      model: () => explorer,
    });
    defineView(bus, {
      id: "demo.detail",
      kind: "detail",
      title: "About",
      model: () => ({ title: "About", content: [{ heading: "Hi" }] }),
    });

    expect(listViews(bus)).toEqual([
      { id: "demo.detail", kind: "detail", title: "About" },
      { id: "todo.explorer", kind: "explorer", title: "Todos" },
      { id: "todo.widget", kind: "widget", title: "Tasks" },
    ]);
    expect(readView(bus, "todo.explorer")).toEqual(explorer);
    expect(readView(bus, "todo.widget")).toEqual(widget);
    rows = [];
    expect(readView(bus, "todo.widget")).toEqual({ ...widget, rows: [] });
    // A model round-trips through JSON unchanged.
    const read = readView(bus, "todo.explorer");
    expect(JSON.parse(JSON.stringify(read))).toEqual(read);
  });

  it("reads nothing from a view with nothing to show, and rejects unknown ids", () => {
    const bus = fakeEventBus();
    defineView(bus, { id: "todo.widget", kind: "widget", title: "Tasks", model: () => undefined });
    expect(readView(bus, "todo.widget")).toBeUndefined();
    expect(() => readView(bus, "todo.missing")).toThrow('Unknown view "todo.missing".');
  });

  it("rejects a model that is not JSON, and passes on a provider's error", () => {
    const bus = fakeEventBus();
    defineView(bus, {
      id: "demo.leaky",
      kind: "explorer",
      title: "Leaky",
      model: () => ({ ...explorer, loadDetail: (() => []) as never }),
    });
    defineView(bus, {
      id: "demo.dated",
      kind: "detail",
      title: "Dated",
      model: () => ({ title: "x", content: "y", when: new Date() }) as never,
    });
    defineView(bus, {
      id: "demo.list",
      kind: "widget",
      title: "Array",
      model: () => [] as never,
    });
    defineView(bus, {
      id: "demo.fails",
      kind: "widget",
      title: "Fails",
      model: () => {
        throw new Error("state not loaded");
      },
    });
    for (const id of ["demo.leaky", "demo.dated", "demo.list"])
      expect(() => readView(bus, id), id).toThrow(
        `View "${id}" returned a model that is not JSON.`,
      );
    expect(() => readView(bus, "demo.fails")).toThrow("state not loaded");
    // A throwing provider does not break the bus for the others.
    expect(listViews(bus)).toHaveLength(4);
  });

  it("validates ids, kinds and titles, and refuses a second definition of an id", () => {
    const bus = fakeEventBus();
    const define = (id: string, kind = "widget", title = "Title") =>
      defineView(bus, { id, kind: kind as never, title, model: () => undefined });
    for (const id of ["todo", "Todo.widget", "todo.", "todo:widget"])
      expect(() => define(id), id).toThrow(`Invalid view id "${id}"`);
    expect(() => define("todo.list", "table")).toThrow(
      'View "todo.list" has unknown kind "table".',
    );
    expect(() => define("todo.list", "explorer", "")).toThrow('View "todo.list" needs a title.');
    define("todo.list", "explorer");
    expect(() => define("todo.list", "explorer")).toThrow(
      'View "todo.list" is already defined on this session.',
    );
  });

  it("announces a view when it is defined and whenever its provider says it changed", () => {
    const bus = fakeEventBus();
    const changed = vi.fn();
    const off = onViewChanged(bus, changed);
    const views = viewRegistry(bus);
    views.define({ id: "todo.widget", kind: "widget", title: "Tasks", model: () => widget });
    expect(changed).toHaveBeenLastCalledWith("todo.widget");
    views.changed("todo.widget");
    announceView(bus, "stash.explorer");
    expect(changed.mock.calls).toEqual([["todo.widget"], ["todo.widget"], ["stash.explorer"]]);
    // Malformed traffic on the channel is ignored.
    bus.emit(VIEW_CHANGED_EVENT, { version: 99, id: "x" });
    bus.emit(VIEW_CHANGED_EVENT, null);
    expect(changed).toHaveBeenCalledTimes(3);
    off();
    views.changed("todo.widget");
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("removes views on dispose, and a disposed registry announces nothing", () => {
    const bus = fakeEventBus();
    const views = viewRegistry(bus);
    const remove = views.define({
      id: "todo.widget",
      kind: "widget",
      title: "W",
      model: () => widget,
    });
    views.define({ id: "todo.explorer", kind: "explorer", title: "E", model: () => explorer });
    remove();
    remove(); // idempotent
    expect(views.list().map((view) => view.id)).toEqual(["todo.explorer"]);
    views.dispose();
    expect(listViews(bus)).toEqual([]);
    expect(() => views.read("todo.explorer")).toThrow("Unknown view");
    const emitted = bus.emitted.length;
    views.changed("todo.explorer");
    expect(bus.emitted).toHaveLength(emitted);
    // An id can be defined again once removed.
    expect(() =>
      views.define({ id: "todo.explorer", kind: "explorer", title: "E", model: () => explorer }),
    ).not.toThrow();
  });

  it("keeps each session's bus separate, on Pi's real event bus", () => {
    const parent = createEventBus();
    const child = createEventBus();
    defineView(parent, { id: "todo.widget", kind: "widget", title: "W", model: () => widget });
    defineView(child, {
      id: "todo.widget",
      kind: "widget",
      title: "W",
      model: () => ({ ...widget, rows: [] }),
    });
    const heard = vi.fn();
    onViewChanged(parent, heard);
    announceView(child, "todo.widget");
    expect(heard).not.toHaveBeenCalled();
    expect(readView(parent, "todo.widget")).toEqual(widget);
    expect(readView(child, "todo.widget")).toEqual({ ...widget, rows: [] });
    child.clear();
    expect(listViews(child)).toEqual([]);
    expect(listViews(parent)).toHaveLength(1);
  });
});
