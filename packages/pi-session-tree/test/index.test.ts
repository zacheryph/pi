import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ancestors,
  call,
  callAsync,
  CHILD_SESSION_CREATED,
  CHILD_SESSION_DISPOSED,
  children,
  descendants,
  forget,
  link,
  node,
  parentOf,
  provide,
  root,
  service,
  SESSION_TREE_KEY,
  sessionTree,
  trackChildren,
} from "#src/index";

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global in tests
  delete (globalThis as Record<symbol, unknown>)[SESSION_TREE_KEY];
});

/** An extension's view of one session's real Pi event bus. */
function sessionBus() {
  const bus = createEventBus();
  return {
    bus,
    pi: {
      events: {
        on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler),
      },
    },
  };
}

describe("registry", () => {
  it("is created once and shared through globalThis", () => {
    const tree = sessionTree();
    expect(sessionTree()).toBe(tree);
    expect((globalThis as Record<symbol, unknown>)[SESSION_TREE_KEY]).toBe(tree);
  });

  it("replaces a value of another shape under its key", () => {
    (globalThis as Record<symbol, unknown>)[SESSION_TREE_KEY] = { version: 0, nodes: [] };
    const tree = sessionTree();
    expect(tree.version).toBe(1);
    expect(tree.nodes).toBeInstanceOf(Map);
  });

  it("is shared by separately loaded copies of this module", async () => {
    link("child", { parent: "root" });
    vi.resetModules();
    const copy = await import("#src/index");
    expect(copy.parentOf("child")).toBe("root");
  });
});

describe("links and navigation", () => {
  // root → a → a1 → a1x ; root → b
  function build() {
    link("a", { parent: "root" });
    link("b", { parent: "root" });
    link("a1", { parent: "a", agentId: "explore-1" });
    link("a1x", { parent: "a1" });
  }

  it("walks ancestors nearest first and finds the root", () => {
    build();
    expect(parentOf("a1x")).toBe("a1");
    expect(ancestors("a1x")).toEqual(["a1", "a", "root"]);
    expect(root("a1x")).toBe("root");
    expect(root("root")).toBe("root");
    expect(ancestors("root")).toEqual([]);
  });

  it("lists children and descendants breadth first", () => {
    build();
    expect(children("root")).toEqual(["a", "b"]);
    expect(descendants("root")).toEqual(["a", "b", "a1", "a1x"]);
    expect(descendants("a1x")).toEqual([]);
  });

  it("keeps omitted fields when a link is updated", () => {
    link("c", {
      parent: "root",
      agentId: "agent-1",
      handoff: { todos: { keys: ["x"], scope: "assigned" } },
    });
    link("c", { agentId: "agent-1" });
    expect(node("c")).toMatchObject({
      parent: "root",
      agentId: "agent-1",
      handoff: { todos: { keys: ["x"], scope: "assigned" } },
    });
  });

  it("refuses a session as its own parent and stops on cycles", () => {
    link("self", { parent: "self" });
    expect(parentOf("self")).toBeUndefined();
    link("x", { parent: "y" });
    link("y", { parent: "x" });
    expect(ancestors("x")).toEqual(["y"]);
    expect(descendants("x")).toEqual(["y"]);
  });

  it("forgets a node while its children keep their parent id", () => {
    build();
    forget("a1");
    expect(node("a1")).toBeUndefined();
    expect(children("a")).toEqual([]);
    expect(parentOf("a1x")).toBe("a1");
  });
});

describe("services", () => {
  it("provides, finds and withdraws a service", () => {
    const api = { adopt: vi.fn() };
    const dispose = provide("root", "pi-stash", api);
    expect(service<typeof api>("root", "pi-stash")).toBe(api);
    expect(service("root", "pi-todo")).toBeUndefined();
    dispose();
    expect(service("root", "pi-stash")).toBeUndefined();
  });

  it("returns nothing across the reload gap and the old disposer cannot remove the new instance", () => {
    const before = { name: "before" };
    const after = { name: "after" };
    const disposeBefore = provide("root", "pi-todo", before);
    disposeBefore(); // session_shutdown {reason: "reload"}
    expect(service("root", "pi-todo")).toBeUndefined();
    provide("root", "pi-todo", after); // new factory's session_start
    disposeBefore();
    expect(service("root", "pi-todo")).toBe(after);
  });

  it("replaces an instance that never disposed, and its disposer no longer applies", () => {
    const disposeStale = provide("root", "pi-todo", { name: "stale" });
    const fresh = { name: "fresh" };
    provide("root", "pi-todo", fresh);
    disposeStale();
    expect(service("root", "pi-todo")).toBe(fresh);
  });

  it("calls a live service and reports missing or failing ones without throwing", () => {
    provide("root", "pi-stash", { count: () => 3 });
    provide("root", "pi-todo", {
      mutate: () => {
        throw new Error("This extension ctx is stale");
      },
    });

    expect(call<{ count(): number }, number>("root", "pi-stash", (api) => api.count())).toEqual({
      ok: true,
      value: 3,
    });
    expect(call("root", "pi-dashboard", () => 1)).toEqual({ ok: false, reason: "missing" });
    const failed = call<{ mutate(): void }, void>("root", "pi-todo", (api) => api.mutate());
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.reason).toBe("error");
  });

  it("keeps services on a node when its link is recorded later", () => {
    const api = {};
    provide("child", "pi-stash", api);
    link("child", { parent: "root" });
    expect(service("child", "pi-stash")).toBe(api);
  });
});

describe("asynchronous services", () => {
  const stale = () => new Error("This extension ctx is stale");

  it("callAsync resolves a value and reports a missing service", async () => {
    provide("root", "pi-todo", { mutate: async () => 7 });
    await expect(
      callAsync<{ mutate(): Promise<number> }, Promise<number>>("root", "pi-todo", (api) =>
        api.mutate(),
      ),
    ).resolves.toEqual({ ok: true, value: 7 });
    await expect(callAsync("root", "pi-stash", () => 1)).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("callAsync turns a rejected promise into an error result", async () => {
    provide("root", "pi-todo", { mutate: () => Promise.reject(stale()) });
    const result = await callAsync<{ mutate(): Promise<void> }, Promise<void>>(
      "root",
      "pi-todo",
      (api) => api.mutate(),
    );
    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(
      result.ok === false && result.reason === "error" && (result.error as Error).message,
    ).toMatch(/stale/);
  });

  it("callAsync catches a stale context that throws inside an async function", async () => {
    const ctx = {
      get sessionManager(): never {
        throw stale();
      },
    };
    provide("root", "pi-todo", { mutate: async () => ctx.sessionManager });
    const result = await callAsync<{ mutate(): Promise<unknown> }, Promise<unknown>>(
      "root",
      "pi-todo",
      (api) => api.mutate(),
    );
    expect(result).toMatchObject({ ok: false, reason: "error" });
  });

  it("call refuses a promise instead of reporting success, without an unhandled rejection", async () => {
    provide("root", "pi-todo", { mutate: () => Promise.reject(stale()) });
    const result = call<{ mutate(): Promise<void> }, Promise<void>>("root", "pi-todo", (api) =>
      api.mutate(),
    );
    expect(result.ok).toBe(false);
    expect(
      result.ok === false && result.reason === "error" && (result.error as Error).message,
    ).toMatch(/callAsync/);
    // Let the rejected promise settle; vitest fails the run on an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("session cleanup", () => {
  it("leaves no node behind for successive top-level sessions", () => {
    for (const id of ["session-1", "session-2", "session-3"]) {
      // session_start: two extensions provide; session_shutdown: both withdraw.
      const withdrawStash = provide(id, "pi-stash", {});
      const withdrawTodo = provide(id, "pi-todo", {});
      withdrawStash();
      expect(node(id)).toBeDefined();
      withdrawTodo();
    }
    expect(sessionTree().nodes.size).toBe(0);
  });

  it("keeps a linked child's node until pi-subagents reports it disposed", () => {
    const parent = sessionBus();
    trackChildren(parent.pi);
    parent.bus.emit(CHILD_SESSION_CREATED, {
      sessionId: "child",
      parentSessionId: "root",
      agentId: "a3f2",
    });
    const withdraw = provide("child", "pi-stash", {});

    withdraw(); // child session_shutdown runs before child:disposed
    expect(node("child")).toMatchObject({ parent: "root", agentId: "a3f2" });

    parent.bus.emit(CHILD_SESSION_DISPOSED, { sessionId: "child" });
    expect(node("child")).toBeUndefined();
  });

  it("drops a withdrawn top-level node without losing its children's links", () => {
    const withdrawRoot = provide("root", "pi-stash", {});
    link("child", { parent: "root" });
    provide("child", "pi-stash", {});

    withdrawRoot();

    expect(node("root")).toBeUndefined();
    expect(ancestors("child")).toEqual(["root"]);
    expect(service("child", "pi-stash")).toBeDefined();
  });
});

describe("trackChildren", () => {
  it("links a child before the child's session_start runs", () => {
    const parent = sessionBus();
    trackChildren(parent.pi);

    // pi-subagents emits session-created on the parent's bus, then binds the
    // child, whose session_start reads the link.
    parent.bus.emit(CHILD_SESSION_CREATED, {
      sessionId: "child",
      parentSessionId: "root",
      agentId: "a3f2",
    });
    const seenAtSessionStart = { parent: parentOf("child"), agent: node("child")?.agentId };

    expect(seenAtSessionStart).toEqual({ parent: "root", agent: "a3f2" });
  });

  it("records the handoff and forgets the child once disposed", () => {
    const parent = sessionBus();
    trackChildren(parent.pi);
    const handoff = { todos: { keys: ["auth-audit"], scope: "assigned" as const } };

    parent.bus.emit(CHILD_SESSION_CREATED, {
      sessionId: "child",
      parentSessionId: "root",
      handoff,
    });
    expect(node("child")?.handoff).toEqual(handoff);

    parent.bus.emit(CHILD_SESSION_DISPOSED, { sessionId: "child" });
    expect(node("child")).toBeUndefined();
  });

  it("is idempotent when several extensions track the same session", () => {
    const parent = sessionBus();
    trackChildren(parent.pi);
    trackChildren(parent.pi);

    parent.bus.emit(CHILD_SESSION_CREATED, { sessionId: "child", parentSessionId: "root" });
    expect(children("root")).toEqual(["child"]);
    parent.bus.emit(CHILD_SESSION_DISPOSED, { sessionId: "child" });
    parent.bus.emit(CHILD_SESSION_DISPOSED, { sessionId: "child" });
    expect(children("root")).toEqual([]);
  });

  it("ignores malformed payloads and stops after unsubscribing", () => {
    const parent = sessionBus();
    const stop = trackChildren(parent.pi);

    parent.bus.emit(CHILD_SESSION_CREATED, undefined);
    parent.bus.emit(CHILD_SESSION_CREATED, { sessionId: 42 });
    parent.bus.emit(CHILD_SESSION_CREATED, {
      sessionId: "child",
      parentSessionId: 7,
      handoff: ["not", "an", "object"],
    });
    expect(node("child")).toMatchObject({ id: "child" });
    expect(node("child")?.parent).toBeUndefined();
    expect(node("child")?.handoff).toBeUndefined();
    expect(sessionTree().nodes.size).toBe(1);

    stop();
    parent.bus.emit(CHILD_SESSION_CREATED, { sessionId: "later", parentSessionId: "root" });
    expect(node("later")).toBeUndefined();
  });

  it("builds a three-level chain from each session's own bus", () => {
    const rootBus = sessionBus();
    const childBus = sessionBus();
    trackChildren(rootBus.pi);
    trackChildren(childBus.pi);

    rootBus.bus.emit(CHILD_SESSION_CREATED, { sessionId: "child", parentSessionId: "root" });
    childBus.bus.emit(CHILD_SESSION_CREATED, { sessionId: "grandchild", parentSessionId: "child" });

    expect(ancestors("grandchild")).toEqual(["child", "root"]);
    expect(descendants("root")).toEqual(["child", "grandchild"]);
  });
});
