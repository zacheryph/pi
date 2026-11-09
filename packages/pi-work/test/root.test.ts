import { afterEach, describe, expect, it, vi } from "vitest";
import { fakePi } from "../../pi-test-helpers/src/fake-pi.ts";
import { resetSessionTree } from "../../pi-test-helpers/src/globals.ts";
import { provide, service } from "../../pi-session-tree/src/index.ts";
import {
  ensureWorkHost,
  WORK_ENTRY,
  WORK_LOST,
  WORK_SERVICE,
  type WorkHost,
  type WorkRecord,
} from "../src/index.ts";

afterEach(resetSessionTree);

/** A session context for the handlers; `branch` is what `getBranch()` returns. */
function context(options: { id?: string; idle?: boolean; branch?: unknown[] } = {}) {
  const state = { idle: options.idle ?? true };
  return {
    state,
    ctx: {
      isIdle: () => state.idle,
      ui: { notify: vi.fn() },
      sessionManager: {
        getSessionId: () => options.id ?? "s1",
        getBranch: () => options.branch ?? [],
      },
    },
  };
}

const entry = (record: WorkRecord) => ({ type: "custom", customType: WORK_ENTRY, data: record });
const openRecord = (id: string, owner = "test"): WorkRecord => ({
  v: 1,
  op: "open",
  id,
  owner,
  kind: "job",
  label: "CI",
  at: 1,
});

describe("ensureWorkHost", () => {
  it("provides the root host at session_start and withdraws it at shutdown", async () => {
    const h = fakePi();
    const work = ensureWorkHost(h.api);
    const { ctx } = context();
    expect(work.host()).toBeUndefined();
    await h.emit("session_start", { reason: "startup" }, ctx);
    const host = work.host()!;
    expect(host).toBe(service("s1", WORK_SERVICE));
    await h.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(work.host()).toBeUndefined();
    expect(service("s1", WORK_SERVICE)).toBeUndefined();
  });

  it("returns the same access for the same pi, and shares the host between extensions", async () => {
    const a = fakePi();
    const b = fakePi();
    expect(ensureWorkHost(a.api)).toBe(ensureWorkHost(a.api));
    const first = ensureWorkHost(a.api);
    const second = ensureWorkHost(b.api);
    const { ctx } = context();
    await a.emit("session_start", { reason: "startup" }, ctx);
    await b.emit("session_start", { reason: "startup" }, ctx);
    expect(second.host()).toBe(first.host());
    // The second extension provided nothing, so only the first one withdraws it.
    await b.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(first.host()).toBeDefined();
    await a.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(first.host()).toBeUndefined();
  });

  it("keeps a host that someone else offers for the session", async () => {
    const offered: WorkHost = { open: vi.fn(), adopt: vi.fn(), list: () => [] };
    provide("s1", WORK_SERVICE, offered);
    const h = fakePi();
    const work = ensureWorkHost(h.api);
    await h.emit("session_start", { reason: "startup" }, context().ctx);
    expect(work.host()).toBe(offered);
    await h.emit("resources_discover", { reason: "startup" }, context().ctx);
    await h.emit("session_shutdown", { reason: "quit" }, context().ctx);
    expect(service("s1", WORK_SERVICE)).toBe(offered);
  });

  it("forwards run boundaries to an offered host that wants them", async () => {
    const hooks = { agentStart: vi.fn(), agentSettled: vi.fn(), continuesRun: vi.fn(() => true) };
    provide("s1", WORK_SERVICE, { open: vi.fn(), adopt: vi.fn(), list: () => [], ...hooks });
    const h = fakePi();
    ensureWorkHost(h.api);
    const { ctx } = context();
    await h.emit("session_start", { reason: "startup" }, ctx);
    await h.emit("agent_start", {}, ctx);
    expect(hooks.agentStart).toHaveBeenCalled();
    const event = { outcome: "completed", continue: false, context: {} };
    expect(await h.emit("agent_before_settle", event, ctx)).toEqual({ continue: true });
    expect(await h.emit("agent_before_settle", { ...event, continue: true }, ctx)).toBeUndefined();
    await h.emit("agent_settled", {}, ctx);
    expect(hooks.agentSettled).toHaveBeenCalled();
  });

  it("persists items as custom entries and restores them from the branch", async () => {
    const h = fakePi();
    const work = ensureWorkHost(h.api);
    const { ctx } = context({ branch: [entry(openRecord("old")), { type: "message" }] });
    await h.emit("session_start", { reason: "resume" }, ctx);
    const adopted: string[] = [];
    work.host()!.adopt("test", (item) => (adopted.push(item.id), true));
    expect(adopted).toEqual(["old"]);
    const item = work.host()!.open({ owner: "test", kind: "job", label: "new" });
    expect(h.pi.appendEntry).toHaveBeenCalledWith(
      WORK_ENTRY,
      expect.objectContaining({ v: 1, op: "open", id: item.id }),
    );
  });

  it("sends a completion with triggerTurn true when idle and false while a run is active", async () => {
    const h = fakePi();
    const work = ensureWorkHost(h.api);
    const { ctx, state } = context();
    await h.emit("session_start", { reason: "startup" }, ctx);
    const a = work.host()!.open({ owner: "test", kind: "job", label: "a" });
    const b = work.host()!.open({ owner: "test", kind: "job", label: "b" });
    a.complete({ customType: "test:done", content: "A", details: { n: 1 } });
    expect(h.pi.sendMessage).toHaveBeenLastCalledWith(
      { customType: "test:done", content: "A", display: true, details: { n: 1 } },
      { triggerTurn: true },
    );
    state.idle = false; // the wake started a run
    await h.emit("agent_start", {}, ctx);
    b.complete({ customType: "test:done", content: "B" });
    expect(h.pi.sendMessage).toHaveBeenLastCalledWith(
      { customType: "test:done", content: "B", display: true },
      { triggerTurn: false },
    );
    // The run does not end before the model answers it.
    const event = (last: object) => ({
      outcome: "completed",
      continue: false,
      context: { contextMessages: [last], pendingMessages: [] },
    });
    expect(
      await h.emit("agent_before_settle", event({ role: "custom", customType: "test:done" }), ctx),
    ).toEqual({
      continue: true,
    });
    expect(await h.emit("agent_before_settle", event({ role: "assistant" }), ctx)).toBeUndefined();
    await h.emit("agent_settled", {}, ctx);
  });

  it("settles startup after every session_start handler, not before", async () => {
    const h = fakePi();
    const work = ensureWorkHost(h.api);
    const { ctx } = context({ branch: [entry(openRecord("a")), entry(openRecord("b", "slow"))] });
    // An owner that registers after ensureWorkHost and adopts asynchronously.
    h.pi.on("session_start", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      work.host()!.adopt("slow", () => true);
    });
    await h.emit("session_start", { reason: "reload" }, ctx);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(
      work
        .host()!
        .list()
        .map((i) => i.id),
    ).toEqual(["a", "b"]);

    await h.emit("resources_discover", { reason: "reload" }, ctx);
    expect(
      work
        .host()!
        .list()
        .map((i) => i.id),
    ).toEqual(["b"]);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: WORK_LOST, display: true }),
      { triggerTurn: false },
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("closed as lost"),
      "warning",
    );
    expect(h.pi.appendEntry).toHaveBeenCalledWith(
      WORK_ENTRY,
      expect.objectContaining({ op: "close", id: "a", reason: "lost" }),
    );

    // The fallback and later events do not report it again.
    await h.emit("before_agent_start", {}, ctx);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("falls back to the first agent start when no resources_discover arrives", async () => {
    const h = fakePi();
    ensureWorkHost(h.api);
    const { ctx } = context({ branch: [entry(openRecord("a"))] });
    await h.emit("session_start", { reason: "startup" }, ctx);
    await h.emit("before_agent_start", {}, ctx);
    expect(h.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: WORK_LOST }),
      { triggerTurn: false },
    );
  });

  it("never settles a host it did not provide", async () => {
    const offered: WorkHost = { open: vi.fn(), adopt: vi.fn(), list: () => [] };
    provide("s1", WORK_SERVICE, offered);
    const h = fakePi();
    ensureWorkHost(h.api);
    const { ctx } = context({ branch: [entry(openRecord("a"))] });
    await h.emit("session_start", { reason: "startup" }, ctx);
    await h.emit("resources_discover", {}, ctx);
    await h.emit("before_agent_start", {}, ctx);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
  });
});

describe("waiting for a completion to land", () => {
  const DONE = { customType: "test:done", content: "SAME" };
  const landed = (id: string, content = "SAME") => ({
    type: "custom_message",
    id,
    customType: "test:done",
    content,
  });
  const base = [
    { type: "message", id: "m1" },
    { type: "message", id: "m2" },
  ];
  const closesOf = (h: ReturnType<typeof fakePi>) =>
    h.pi.appendEntry.mock.calls.filter(([, data]) => (data as WorkRecord).op === "close");

  async function started(branch: unknown[]) {
    const h = fakePi();
    const work = ensureWorkHost(h.api);
    const { ctx } = context({ branch });
    await h.emit("session_start", { reason: "startup" }, ctx);
    const item = work.host()!.open({ owner: "test", kind: "job", label: "a" });
    return { h, work, ctx, item, branch };
  }

  it("closes the item when its message appears after the send", async () => {
    const { h, ctx, item, branch } = await started([...base]);
    item.complete(DONE);
    branch.push(landed("c1"));
    await h.emit("turn_start", {}, ctx);
    expect(closesOf(h)).toHaveLength(1);
  });

  it("does not take an identical message from before the send for the new one", async () => {
    const { h, ctx, item, branch } = await started([...base, landed("old")]);
    item.complete(DONE);
    await new Promise((resolve) => setImmediate(resolve));
    await h.emit("turn_start", {}, ctx);
    await h.emit(
      "agent_before_settle",
      {
        outcome: "completed",
        continue: false,
        context: { contextMessages: [], pendingMessages: [] },
      },
      ctx,
    );
    expect(closesOf(h)).toHaveLength(0);
    branch.push(landed("new"));
    await h.emit("turn_start", {}, ctx);
    expect(closesOf(h)).toHaveLength(1);
  });

  it("stops waiting once the leaf has left the branch the message was sent on", async () => {
    const { h, work, ctx, item, branch } = await started([...base]);
    item.complete(DONE);
    branch.splice(1, 1, { type: "message", id: "other" }, { type: "message", id: "other2" });
    await h.emit("session_tree", {}, ctx);
    // Even an identical message that shows up later closes nothing: the item stays open on disk.
    branch.push(landed("c1"));
    await h.emit("turn_start", {}, ctx);
    expect(closesOf(h)).toHaveLength(0);
    expect((work.host() as unknown as { awaitingLanding(): boolean }).awaitingLanding()).toBe(
      false,
    );
  });

  it("stops waiting once a run has settled without the message landing", async () => {
    const { h, work, ctx, item, branch } = await started([...base]);
    item.complete(DONE);
    await h.emit("agent_settled", {}, ctx);
    const host = work.host() as unknown as { awaitingLanding(): boolean };
    expect(host.awaitingLanding()).toBe(false);
    branch.push(landed("c1"));
    await h.emit("turn_start", {}, ctx);
    expect(closesOf(h)).toHaveLength(0);
  });

  it("still closes a message that lands at the end of the settling run", async () => {
    const { h, ctx, item, branch } = await started([...base]);
    item.complete(DONE);
    branch.push(landed("c1")); // appended when the turn ended, before agent_settled
    await h.emit("agent_settled", {}, ctx);
    expect(closesOf(h)).toHaveLength(1);
  });

  it("keeps waiting while no run has settled and the branch is the same", async () => {
    const { h, work, ctx, item } = await started([...base]);
    item.complete(DONE);
    await h.emit("turn_start", {}, ctx);
    await h.emit("agent_end", {}, ctx);
    expect((work.host() as unknown as { awaitingLanding(): boolean }).awaitingLanding()).toBe(true);
  });
});
