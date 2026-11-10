import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildWork, type ChildWorkSession } from "#src/lifecycle/child-work";
import { service } from "../../../../packages/pi-session-tree/src/index.ts";
import { resetSessionTree } from "../../../../packages/pi-test-helpers/src/globals.ts";
import {
  WORK_ENTRY,
  WORK_LOST,
  WORK_SERVICE,
  type WorkHost,
  type WorkMessage,
} from "../../../../packages/pi-work/src/index.ts";

// The managed host of a child session: the contract on a child's own session file, where a
// message is written into the transcript at once and an idle child is woken by asking its agent
// for a run, never by the message itself.

afterEach(resetSessionTree);

const DONE: WorkMessage = { customType: "test:done", content: "CI passed", details: { n: 1 } };

interface SentMessage {
  message: { customType: string; content: unknown; display: boolean; details?: unknown };
  options: { triggerTurn: boolean };
}

/** A session that records what the host writes, and reports the events it is told to. */
function fixture(options: { entries?: unknown[] } = {}) {
  const entries: { type: string; customType?: string; data?: unknown }[] = (
    options.entries ?? []
  ).map((data) => ({ type: "custom", customType: WORK_ENTRY, data }));
  const sent: SentMessage[] = [];
  const listeners = new Set<(event: { type: string }) => void>();
  const session = {
    isIdle: true as boolean,
    sendCustomMessage: vi.fn(
      async (message: SentMessage["message"], opts: SentMessage["options"]) => {
        sent.push({ message, options: opts });
      },
    ),
    subscribe: vi.fn((listener: (event: { type: string }) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    }),
  } satisfies ChildWorkSession;
  const policy = { wake: vi.fn(), changed: vi.fn() };
  const store = {
    getBranch: () => entries,
    appendCustomEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
      return "entry";
    }),
  };
  const work = new ChildWork({ sessionId: "child-1", session, store, policy });
  const emit = (type: string) => {
    for (const listener of listeners) listener({ type });
  };
  const records = () =>
    entries.filter((entry) => entry.customType === WORK_ENTRY).map((entry) => entry.data);
  return { work, session, policy, store, sent, emit, records, listeners };
}

describe("providing the host", () => {
  it("offers the host under the child's session id, and withdraws it with the session", () => {
    const { work } = fixture();
    expect(service<WorkHost>("child-1", WORK_SERVICE)).toBe(work.host);
    work.dispose();
    expect(service<WorkHost>("child-1", WORK_SERVICE)).toBeUndefined();
  });

  it("persists open items as custom entries in the child's own session file", () => {
    const { work, store, records } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    expect(store.appendCustomEntry).toHaveBeenCalledWith(
      WORK_ENTRY,
      expect.objectContaining({ op: "open", id: item.id, label: "CI" }),
    );
    expect(work.openItems().map((view) => view.label)).toEqual(["CI"]);
    item.complete(DONE);
    expect(records().at(-1)).toMatchObject({ op: "close", id: item.id, reason: "completed" });
    expect(work.openItems()).toEqual([]);
  });

  it("stops listening to the session and goes inert once disposed", () => {
    const { work, listeners } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    work.dispose();
    expect(listeners.size).toBe(0);
    expect(work.openItems()).toEqual([]);
    item.complete(DONE);
    expect(() => work.host.open({ owner: "test", kind: "job", label: "late" })).toThrow();
  });
});

describe("a message for an idle child", () => {
  it("is written into the transcript without a trigger, then the agent is asked for a run", () => {
    const { work, sent, policy } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    item.complete(DONE);
    // Written at once, and not a trigger: no message starts a run by itself.
    expect(sent).toEqual([
      {
        message: { ...DONE, display: true },
        options: { triggerTurn: false },
      },
    ]);
    expect(policy.wake).toHaveBeenCalledTimes(1);
  });

  it("closes the item once the message is written, since the transcript is the inbox", () => {
    const { work, records } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    item.complete(DONE);
    expect(records().filter((record) => (record as { op: string }).op === "close")).toHaveLength(1);
  });

  it("asks for a run for each message that finds the session idle, which the agent folds into one", () => {
    const { work, sent, policy } = fixture();
    const a = work.host.open({ owner: "test", kind: "job", label: "a" });
    const b = work.host.open({ owner: "test", kind: "job", label: "b" });
    a.complete({ customType: "test:done", content: "A" });
    b.complete({ customType: "test:done", content: "B" });
    expect(sent.map((entry) => entry.message.content)).toEqual(["A", "B"]);
    // Asking twice is harmless: a run already queued or running ignores the second request.
    expect(policy.wake).toHaveBeenCalledTimes(2);
  });
});

describe("a message for a running child", () => {
  it("is recorded for the end of the turn and asks for no run", () => {
    const { work, session, sent, policy, emit } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    session.isIdle = false;
    emit("agent_start");
    item.complete(DONE);
    expect(sent).toHaveLength(1);
    expect(sent[0].options).toEqual({ triggerTurn: false });
    expect(policy.wake).not.toHaveBeenCalled();
  });

  it("wakes again for a message that arrives after the run settled", () => {
    const { work, session, policy, emit } = fixture();
    const a = work.host.open({ owner: "test", kind: "job", label: "a" });
    const b = work.host.open({ owner: "test", kind: "job", label: "b" });
    emit("agent_start");
    session.isIdle = false;
    a.complete({ customType: "test:done", content: "A" });
    expect(policy.wake).not.toHaveBeenCalled();
    emit("agent_settled");
    session.isIdle = true;
    b.complete({ customType: "test:done", content: "B" });
    expect(policy.wake).toHaveBeenCalledTimes(1);
  });

  it("recognizes its own messages at the run boundary, so the run answers them", () => {
    const { work } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    item.complete(DONE);
    const event = (customType: string) => ({
      outcome: "completed",
      context: {
        contextMessages: [{ role: "custom", customType }],
        pendingMessages: [],
      },
    });
    expect(work.host.continuesRun(event("test:done"))).toBe(true);
    expect(work.host.continuesRun(event("other"))).toBe(false);
  });
});

describe("changes", () => {
  it("tells the agent when the open items change, after the wake", () => {
    const { work, policy } = fixture();
    const order: string[] = [];
    policy.wake.mockImplementation(() => order.push("wake"));
    policy.changed.mockImplementation(() => order.push("changed"));
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    item.complete(DONE);
    expect(order).toEqual(["changed", "wake", "changed"]);
  });

  it("does not tell it about a notification", () => {
    const { work, policy } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    policy.changed.mockClear();
    item.notify({ customType: "test:progress", content: "halfway" });
    expect(policy.changed).not.toHaveBeenCalled();
    expect(work.openItems()).toHaveLength(1);
  });
});

describe("a reopened child", () => {
  const leftOpen = {
    v: 1,
    op: "open",
    id: "old",
    owner: "pi-job",
    kind: "watch",
    label: "CI",
    at: 1,
  };

  it("offers items an earlier instance left open to their owner, and reports the rest lost", () => {
    const { work, sent, policy, records } = fixture({ entries: [leftOpen] });
    expect(work.openItems().map((view) => view.id)).toEqual(["old"]);
    work.settleStartup();
    expect(work.openItems()).toEqual([]);
    expect(records().at(-1)).toMatchObject({ op: "close", id: "old", reason: "lost" });
    // One lost message, recorded without a trigger and without waking anything.
    expect(sent).toHaveLength(1);
    expect(sent[0].message.customType).toBe(WORK_LOST);
    expect(sent[0].options).toEqual({ triggerTurn: false });
    expect(policy.wake).not.toHaveBeenCalled();
  });

  it("keeps an item its owner adopts", () => {
    const { work, sent } = fixture({ entries: [leftOpen] });
    work.host.adopt("pi-job", () => true);
    work.settleStartup();
    expect(work.openItems().map((view) => view.id)).toEqual(["old"]);
    expect(sent).toEqual([]);
  });

  it("settles nothing once the session is gone", () => {
    const { work, sent } = fixture({ entries: [leftOpen] });
    work.dispose();
    work.settleStartup();
    expect(sent).toEqual([]);
  });
});
