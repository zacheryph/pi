import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  STASH_PREVIEW_REQUEST,
  type StashPreviewRequest,
  type StashPreviewResult,
} from "#stash/events";
import {
  actionRegistry,
  defineAction,
  defineView,
  isJsonObject,
  viewRegistry,
  type ExplorerModel,
  type WidgetModel,
} from "#surface";
import todoExtension from "#todo/index";
import { todoSettings } from "#todo/config";
import { TODO_SNAPSHOT_EVENT, type TodoSnapshotEvent } from "#todo/events";
import { fakeEventBus, fakePi } from "#test-helpers";
import { readPreview, readTodoHistory } from "#src/sections";
import { PresentationService } from "#src/service";

const widget: WidgetModel = { title: "Tasks", rows: [{ left: "a: Task a" }] };
const explorer: ExplorerModel = {
  title: "Todos",
  items: [{ id: "a", label: "a: Task a" }],
  loadDetail: { action: "todo.inspect" },
};

/** A session bus with one widget view, one explorer view and one action. */
function session() {
  const bus = fakeEventBus();
  const views = viewRegistry(bus);
  let rows = widget.rows;
  views.define({
    id: "todo.widget",
    kind: "widget",
    title: "Tasks",
    model: () => (rows.length ? { ...widget, rows } : undefined),
  });
  views.define({ id: "todo.explorer", kind: "explorer", title: "Todos", model: () => explorer });
  const actions = actionRegistry(bus);
  actions.define({
    id: "todo.inspect",
    title: "Show a task",
    parse: (args) => {
      if (!isJsonObject(args) || typeof args.id !== "string") throw new Error("expected { id }");
      return { id: args.id };
    },
    handler: ({ id }) => [{ heading: id }],
  });
  actions.define({ id: "todo.noop", title: "Nothing", handler: () => {} });
  return {
    bus,
    views,
    actions,
    setRows: (next: WidgetModel["rows"]) => {
      rows = next;
      views.changed("todo.widget");
    },
  };
}

describe("presentation views and actions", () => {
  it("lists views in the snapshot, with the current model of each widget only", () => {
    const { bus, setRows } = session();
    const service = new PresentationService(bus);
    expect(service.snapshot().views).toEqual([
      { id: "todo.explorer", kind: "explorer", title: "Todos" },
      { id: "todo.widget", kind: "widget", title: "Tasks", model: widget },
    ]);
    // A detached copy, like every other section.
    service.snapshot().views[1]!.model!.rows = [];
    expect(service.snapshot().views[1]!.model).toEqual(widget);
    setRows([]);
    expect(service.snapshot().views[1]).toEqual({
      id: "todo.widget",
      kind: "widget",
      title: "Tasks",
    });
    service.dispose();
  });

  it("reports a failing or non-JSON widget in its entry without failing the snapshot", () => {
    const bus = fakeEventBus();
    defineView(bus, {
      id: "demo.broken",
      kind: "widget",
      title: "Broken",
      model: () => {
        throw new Error("not loaded");
      },
    });
    defineView(bus, {
      id: "demo.leaky",
      kind: "widget",
      title: "Leaky",
      model: () => ({ ...widget, rows: [{ left: (() => "x") as never }] }),
    });
    const service = new PresentationService(bus);
    expect(service.snapshot().views).toEqual([
      { id: "demo.broken", kind: "widget", title: "Broken", error: "not loaded" },
      {
        id: "demo.leaky",
        kind: "widget",
        title: "Leaky",
        error: 'View "demo.leaky" returned a model that is not JSON.',
      },
    ]);
  });

  it("tells subscribers when a widget view changes, not when an explorer does", () => {
    const { bus, views, setRows } = session();
    const service = new PresentationService(bus);
    const listener = vi.fn();
    service.subscribe(listener);
    setRows([{ left: "b: Task b" }]);
    expect(listener).toHaveBeenCalledTimes(1);
    views.changed("todo.explorer");
    views.changed("todo.missing");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.snapshot().views[1]!.model!.rows).toEqual([{ left: "b: Task b" }]);
    service.dispose();
    setRows([{ left: "c" }]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("serves view, actions and action requests", async () => {
    const { bus } = session();
    const service = new PresentationService(bus);
    await expect(service.request({ command: "view", id: "todo.explorer" })).resolves.toEqual(
      explorer,
    );
    await expect(service.request({ command: "view", id: "todo.widget" })).resolves.toEqual(widget);
    await expect(service.request({ command: "view", id: "todo.gone" })).rejects.toThrow(
      'Unknown view "todo.gone".',
    );
    await expect(service.request({ command: "actions" })).resolves.toEqual([
      { id: "todo.inspect", title: "Show a task" },
      { id: "todo.noop", title: "Nothing" },
    ]);
    await expect(
      service.request({ command: "action", id: "todo.inspect", args: { id: "a" } }),
    ).resolves.toEqual([{ heading: "a" }]);
    await expect(service.request({ command: "action", id: "todo.noop" })).resolves.toBeNull();
    await expect(service.request({ command: "action", id: "todo.inspect" })).rejects.toThrow(
      'Invalid arguments for "todo.inspect": expected { id }',
    );
    await expect(service.request({ command: "action", id: "todo.gone" })).rejects.toThrow(
      'Unknown action "todo.gone".',
    );
  });

  it("returns null for a view with nothing to show", async () => {
    const { bus, setRows } = session();
    setRows([]);
    const service = new PresentationService(bus);
    await expect(service.request({ command: "view", id: "todo.widget" })).resolves.toBeNull();
  });

  it("keeps reading live views after reset, and offers nothing after dispose", async () => {
    const { bus, views, actions } = session();
    const service = new PresentationService(bus);
    service.reset();
    expect(service.snapshot().views).toHaveLength(2);
    await expect(service.request({ command: "actions" })).resolves.toHaveLength(2);
    // The producer's own shutdown removes its views; the service holds no copy.
    views.dispose();
    actions.dispose();
    expect(service.snapshot().views).toEqual([]);
    service.dispose();
    expect(service.snapshot().views).toEqual([]);
    for (const request of [
      { command: "view", id: "todo.widget" },
      { command: "actions" },
      { command: "action", id: "todo.noop" },
    ] as const)
      await expect(service.request(request)).rejects.toThrow("disposed");
  });

  it("offers nothing when the bus has been retired", () => {
    const { bus } = session();
    const service = new PresentationService(bus);
    bus.emit.mockImplementation(() => {
      throw new Error("ctx is stale");
    });
    expect(service.snapshot().views).toEqual([]);
  });

  it("keeps two sessions' views apart", () => {
    const one = session();
    const other = fakeEventBus();
    defineView(other, {
      id: "stash.explorer",
      kind: "explorer",
      title: "Stash",
      model: () => explorer,
    });
    expect(new PresentationService(one.bus).snapshot().views.map((view) => view.id)).toEqual([
      "todo.explorer",
      "todo.widget",
    ]);
    expect(new PresentationService(other).snapshot().views.map((view) => view.id)).toEqual([
      "stash.explorer",
    ]);
  });
});

describe("requests that predate actions", () => {
  it("todo-history returns what the snapshot-based request returned, through pi-todo's action", async () => {
    const bus = fakeEventBus();
    const manager = SessionManager.inMemory("/presentation-test");
    const fake = fakePi({
      events: bus,
      appendEntry: vi.fn((type: string, data: unknown) => manager.appendCustomEntry(type, data)),
    });
    const ctx = {
      cwd: "/presentation-test",
      mode: "print",
      hasUI: false,
      ui: { notify: vi.fn() },
      sessionManager: manager,
    } as unknown as ExtensionContext;
    let clock = 1_000;
    todoExtension(fake.api, { loadConfig: () => todoSettings.defaults(), now: () => clock++ });
    const service = new PresentationService(bus);
    await fake.emit("session_start", { reason: "startup" }, ctx);
    const upsert = (tasks: unknown[]) =>
      fake.tool("todo_upsert").execute("call", { tasks }, undefined, undefined, ctx);
    await upsert([{ key: "a", subject: "A" }]);
    for (let n = 0; n < 12; n++)
      await upsert([
        { key: "a", status: n % 2 ? "pending" : "in_progress", message: `step ${n}\u0007` },
      ]);

    const event = bus.published(TODO_SNAPSHOT_EVENT).at(-1) as TodoSnapshotEvent;
    const before = readTodoHistory(event, "a");
    expect(before?.updates).toHaveLength(10);
    await expect(service.request({ command: "todo-history", key: "a" })).resolves.toEqual(before);
    await expect(service.request({ command: "todo-history", key: "zz" })).rejects.toThrow(
      'No task "zz" on this branch.',
    );
    // The action is pi-todo's own, so a reset service still answers.
    service.reset();
    await expect(service.request({ command: "todo-history", key: "a" })).resolves.toEqual(before);
    // Its views reach the snapshot too.
    expect(service.snapshot().views.map((view) => view.id)).toEqual([
      "todo.explorer",
      "todo.widget",
    ]);
    await fake.emit("session_shutdown", {}, ctx);
    await expect(service.request({ command: "todo-history", key: "a" })).rejects.toThrow(
      'No task "a" on this branch.',
    );
  });

  it("stash-preview returns what the stash:preview request returned, through stash.preview", async () => {
    const bus = fakeEventBus();
    const service = new PresentationService(bus);
    await expect(service.request({ command: "stash-preview", name: "notes" })).rejects.toThrow(
      "pi-stash did not answer; is it loaded?",
    );
    // pi-stash answers both from one function (its own tests hold it to that).
    const preview = (name: unknown): StashPreviewResult =>
      name === "notes"
        ? {
            ok: true,
            handle: "stash:notes@0123456789ab",
            lines: ["first", "x".repeat(3_000), ...Array.from({ length: 300 }, String)],
            total: 302,
            complete: false,
          }
        : {
            ok: false,
            error: `No stash entry named "${String(name)}" on this branch.${"!".repeat(600)}`,
          };
    bus.on(STASH_PREVIEW_REQUEST, (data) => {
      const request = data as StashPreviewRequest;
      request.respond(preview(request.name));
    });
    defineAction(bus, {
      id: "stash.preview",
      title: "Preview",
      handler: (args) => {
        const result = preview(isJsonObject(args) ? args.name : undefined);
        if (!result.ok) throw new Error(result.error);
        const { ok: _ok, ...head } = result;
        return head;
      },
    });
    const old = (name: string) => {
      let reply: StashPreviewResult | undefined;
      bus.emit(STASH_PREVIEW_REQUEST, {
        name,
        respond: (value: StashPreviewResult) => (reply = value),
      });
      return readPreview(reply);
    };
    await expect(service.request({ command: "stash-preview", name: "notes" })).resolves.toEqual(
      old("notes"),
    );
    const error = old("gone");
    expect(typeof error === "string" && error.length).toBe(500);
    await expect(service.request({ command: "stash-preview", name: "gone" })).rejects.toThrow(
      new Error(error as string),
    );
  });
});
