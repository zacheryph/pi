import { afterEach, describe, expect, it } from "vitest";
import { treeService } from "#src/index";
import {
  CHILD_SESSION_CREATED,
  CHILD_SESSION_DISPOSED,
  node,
  service,
} from "../../pi-session-tree/src/index.ts";
import { fakePi } from "../../pi-test-helpers/src/fake-pi.ts";
import { resetSessionTree } from "../../pi-test-helpers/src/globals.ts";

afterEach(resetSessionTree);

const NAME = "example:service";

interface Example {
  adopt(value: string): boolean;
}

const sessionCtx = (id: string) => ({ sessionManager: { getSessionId: () => id } });

/** One session's copy of an extension that offers an `Example`. */
function instance() {
  const fake = fakePi();
  const adopted: string[] = [];
  const api: Example = {
    adopt: (value) => {
      adopted.push(value);
      return true;
    },
  };
  const tree = treeService(fake.api, NAME, api);
  return { fake, api, adopted, tree };
}

describe("treeService", () => {
  it("provides the service from session_start until session_shutdown", async () => {
    const { fake, api, tree } = instance();
    expect(tree.sessionId()).toBeUndefined();
    await fake.emit("session_start", {}, sessionCtx("s1"));
    expect(tree.sessionId()).toBe("s1");
    expect(service("s1", NAME)).toBe(api);
    await fake.emit("session_shutdown");
    expect(tree.sessionId()).toBeUndefined();
    expect(service("s1", NAME)).toBeUndefined();
  });

  it("re-provides on a second session_start without leaving the first id's entry", async () => {
    const { fake, api } = instance();
    await fake.emit("session_start", {}, sessionCtx("s1"));
    await fake.emit("session_start", {}, sessionCtx("s2"));
    expect(service("s1", NAME)).toBeUndefined();
    expect(service("s2", NAME)).toBe(api);
  });

  it("calls the parent's copy once pi-subagent links the child", async () => {
    const parent = instance();
    const child = instance();
    await parent.fake.emit("session_start", {}, sessionCtx("parent"));
    parent.fake.events.emit(CHILD_SESSION_CREATED, {
      sessionId: "child",
      parentSessionId: "parent",
      agentId: "agent-1",
    });
    await child.fake.emit("session_start", {}, sessionCtx("child"));

    expect(child.tree.node()).toMatchObject({ parent: "parent", agentId: "agent-1" });
    expect(child.tree.parent((api) => api.adopt("record"))).toEqual({ ok: true, value: true });
    expect(parent.adopted).toEqual(["record"]);

    parent.fake.events.emit(CHILD_SESSION_DISPOSED, { sessionId: "child" });
    expect(node("child")).toBeUndefined();
  });

  it("reports a missing parent outside a session, at the top, or while the parent reloads", async () => {
    const parent = instance();
    const child = instance();
    expect(child.tree.parent((api) => api.adopt("x"))).toEqual({ ok: false, reason: "missing" });
    await parent.fake.emit("session_start", {}, sessionCtx("parent"));
    expect(parent.tree.parent((api) => api.adopt("x"))).toEqual({ ok: false, reason: "missing" });
    parent.fake.events.emit(CHILD_SESSION_CREATED, {
      sessionId: "child",
      parentSessionId: "parent",
    });
    await child.fake.emit("session_start", {}, sessionCtx("child"));
    await parent.fake.emit("session_shutdown");
    expect(child.tree.parent((api) => api.adopt("x"))).toEqual({ ok: false, reason: "missing" });
    expect(parent.adopted).toEqual([]);
  });

  it("returns a throwing parent call as an error", async () => {
    const parent = instance();
    const child = instance();
    await parent.fake.emit("session_start", {}, sessionCtx("parent"));
    parent.fake.events.emit(CHILD_SESSION_CREATED, {
      sessionId: "child",
      parentSessionId: "parent",
    });
    await child.fake.emit("session_start", {}, sessionCtx("child"));
    const error = new Error("stale");
    expect(
      child.tree.parent(() => {
        throw error;
      }),
    ).toEqual({ ok: false, reason: "error", error });
  });

  it("after a reload the new instance's service replaces the old, whose shutdown is a no-op", async () => {
    const old = instance();
    await old.fake.emit("session_start", {}, sessionCtx("s1"));
    const reloaded = instance();
    await reloaded.fake.emit("session_start", {}, sessionCtx("s1"));
    expect(service("s1", NAME)).toBe(reloaded.api);
    await old.fake.emit("session_shutdown");
    expect(service("s1", NAME)).toBe(reloaded.api);
    await reloaded.fake.emit("session_shutdown");
    expect(service("s1", NAME)).toBeUndefined();
  });
});
