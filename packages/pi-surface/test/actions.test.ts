import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fakeEventBus } from "#test-helpers";
import {
  actionRegistry,
  defineAction,
  dispatchAction,
  isJsonObject,
  listActions,
} from "#src/index";

describe("action registry", () => {
  it("defines, lists and dispatches actions with JSON arguments and results", async () => {
    const bus = fakeEventBus();
    const handler = vi.fn(async (args: { name: string }) => ({ greeting: `hi ${args.name}` }));
    defineAction(bus, {
      id: "demo.greet",
      title: "Greet someone",
      parse: (args) => {
        if (!isJsonObject(args)) throw new Error("expected an object");
        if (typeof args.name !== "string") throw new Error("name must be a string");
        return { name: args.name };
      },
      handler,
    });
    defineAction(bus, { id: "demo.noop", title: "Do nothing", handler: () => {} });

    expect(listActions(bus)).toEqual([
      { id: "demo.greet", title: "Greet someone" },
      { id: "demo.noop", title: "Do nothing" },
    ]);
    await expect(dispatchAction(bus, "demo.greet", { name: "Ada" })).resolves.toEqual({
      greeting: "hi Ada",
    });
    expect(handler).toHaveBeenCalledWith({ name: "Ada" });
    await expect(dispatchAction(bus, "demo.noop")).resolves.toBeUndefined();
  });

  it("passes arguments through unchanged without a parser", async () => {
    const bus = fakeEventBus();
    defineAction(bus, { id: "demo.echo", title: "Echo", handler: (args) => args ?? null });
    await expect(dispatchAction(bus, "demo.echo", [1, "two", { three: true }])).resolves.toEqual([
      1,
      "two",
      { three: true },
    ]);
    await expect(dispatchAction(bus, "demo.echo")).resolves.toBeNull();
  });

  it("rejects unknown ids, invalid or non-JSON arguments, and non-JSON results", async () => {
    const bus = fakeEventBus();
    const handler = vi.fn(() => "ok");
    defineAction(bus, {
      id: "demo.strict",
      title: "Strict",
      parse: (args) => {
        if (typeof args !== "number") throw new Error("expected a number");
        return args;
      },
      handler,
    });
    defineAction(bus, {
      id: "demo.leaky",
      title: "Returns a function",
      handler: () => (() => {}) as never,
    });
    defineAction(bus, {
      id: "demo.fails",
      title: "Fails",
      handler: async () => {
        throw new Error("disk full");
      },
    });

    await expect(dispatchAction(bus, "demo.missing")).rejects.toThrow(
      'Unknown action "demo.missing".',
    );
    await expect(dispatchAction(bus, "demo.strict", "seven")).rejects.toThrow(
      'Invalid arguments for "demo.strict": expected a number',
    );
    await expect(dispatchAction(bus, "demo.strict", { when: new Date() } as never)).rejects.toThrow(
      'Arguments for action "demo.strict" are not JSON.',
    );
    await expect(dispatchAction(bus, "demo.strict", Number.NaN)).rejects.toThrow("are not JSON");
    expect(handler).not.toHaveBeenCalled();
    await expect(dispatchAction(bus, "demo.leaky")).rejects.toThrow(
      'Action "demo.leaky" returned a value that is not JSON.',
    );
    await expect(dispatchAction(bus, "demo.fails")).rejects.toThrow("disk full");
  });

  it("validates ids and titles and refuses a second definition of an id on one bus", () => {
    const bus = fakeEventBus();
    const define =
      (id: string, title = "Title") =>
      () =>
        defineAction(bus, { id, title, handler: () => {} });
    for (const id of [
      "stash",
      "Stash.inspect",
      "stash.",
      ".inspect",
      "stash:inspect",
      "stash inspect",
    ])
      expect(define(id), id).toThrow(`Invalid action id "${id}"`);
    expect(define("demo.ok", " ")).toThrow('Action "demo.ok" needs a title.');
    expect(define("git.worktree.remove")).not.toThrow();
    expect(define("todo.review-all")).not.toThrow();
    expect(define("git.worktree.remove")).toThrow(
      'Action "git.worktree.remove" is already defined on this session.',
    );
  });

  it("removes an action with its dispose function, and a registry removes all it defined", async () => {
    const bus = fakeEventBus();
    const remove = defineAction(bus, { id: "demo.one", title: "One", handler: () => 1 });
    const registry = actionRegistry(bus);
    const removeTwo = registry.define({ id: "demo.two", title: "Two", handler: () => 2 });
    registry.define({ id: "demo.three", title: "Three", handler: () => 3 });
    expect(registry.list().map((action) => action.id)).toEqual([
      "demo.one",
      "demo.three",
      "demo.two",
    ]);
    await expect(registry.dispatch("demo.two")).resolves.toBe(2);

    remove();
    removeTwo();
    removeTwo(); // idempotent
    expect(listActions(bus).map((action) => action.id)).toEqual(["demo.three"]);
    registry.dispose();
    expect(listActions(bus)).toEqual([]);
    // Every listener is gone, so nothing leaks across /reload or session shutdown.
    await expect(dispatchAction(bus, "demo.three")).rejects.toThrow("Unknown action");
    // An id can be defined again once removed.
    expect(() =>
      registry.define({ id: "demo.three", title: "Again", handler: () => 3 }),
    ).not.toThrow();
  });

  it("keeps each session's bus separate, on Pi's real event bus", async () => {
    const parent = createEventBus();
    const child = createEventBus();
    defineAction(parent, { id: "demo.where", title: "Where", handler: () => "parent" });
    defineAction(child, { id: "demo.where", title: "Where", handler: () => "child" });
    defineAction(child, { id: "demo.child-only", title: "Child only", handler: () => true });

    await expect(dispatchAction(parent, "demo.where")).resolves.toBe("parent");
    await expect(dispatchAction(child, "demo.where")).resolves.toBe("child");
    await expect(dispatchAction(parent, "demo.child-only")).rejects.toThrow("Unknown action");
    expect(listActions(parent).map((action) => action.id)).toEqual(["demo.where"]);
    child.clear();
    expect(listActions(child)).toEqual([]);
    await expect(dispatchAction(parent, "demo.where")).resolves.toBe("parent");
  });

  it("ignores unrelated traffic on the channel", async () => {
    const bus = fakeEventBus();
    defineAction(bus, { id: "demo.one", title: "One", handler: () => 1 });
    expect(() => bus.emit("surface:actions", null)).not.toThrow();
    expect(() => bus.emit("surface:actions", { version: 99, kind: "list" })).not.toThrow();
    await expect(dispatchAction(bus, "demo.one")).resolves.toBe(1);
  });
});
