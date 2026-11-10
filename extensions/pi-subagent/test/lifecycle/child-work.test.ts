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

interface Entry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  content?: unknown;
  details?: unknown;
}

type Listener = (event: { type: string; aborted?: boolean }) => void;

/**
 * A session that records what the host writes, and reports the events it is told to. It writes
 * the way Pi does: a message sent while the session is idle is appended to the transcript at
 * once, one sent while it runs is held until `endTurn()`.
 */
function fixture(options: { entries?: unknown[] } = {}) {
  let counter = 0;
  const entry = (fields: Omit<Entry, "id">): Entry => ({ id: `e${++counter}`, ...fields });
  const entries: Entry[] = (options.entries ?? []).map((data) =>
    entry({ type: "custom", customType: WORK_ENTRY, data }),
  );
  const sent: SentMessage[] = [];
  const held: SentMessage["message"][] = [];
  const append = (message: SentMessage["message"]) =>
    entries.push(
      entry({
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        details: message.details,
      }),
    );
  const listeners = new Set<Listener>();
  const session = {
    isIdle: true as boolean,
    sendCustomMessage: vi.fn(
      async (message: SentMessage["message"], opts: SentMessage["options"]) => {
        sent.push({ message, options: opts });
        if (session.isIdle) append(message);
        else held.push(message);
      },
    ),
    subscribe: vi.fn((listener: Listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    }),
  } satisfies ChildWorkSession;
  const policy = { wake: vi.fn(), changed: vi.fn() };
  const store = {
    getBranch: () => entries,
    appendCustomEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push(entry({ type: "custom", customType, data }));
      return "entry";
    }),
  };
  const work = new ChildWork({ sessionId: "child-1", session, store, policy });
  const emit = (type: string, extra: { aborted?: boolean } = {}) => {
    for (const listener of listeners) listener({ type, ...extra });
  };
  /** The turn ends: Pi appends what it held. */
  const endTurn = () => {
    for (const message of held.splice(0)) append(message);
    emit("turn_start");
  };
  /** The model answers: an assistant message is appended. */
  const answer = () => void entries.push(entry({ type: "message" }));
  const records = () =>
    entries.filter((e) => e.customType === WORK_ENTRY).map((e) => e.data as { op: string });
  const closes = () => records().filter((record) => record.op === "close");
  const microtasks = () => new Promise((resolve) => setImmediate(resolve));
  return {
    work,
    session,
    policy,
    store,
    sent,
    held,
    entries,
    emit,
    endTurn,
    answer,
    records,
    closes,
    microtasks,
    listeners,
  };
}

describe("providing the host", () => {
  it("offers the host under the child's session id, and withdraws it with the session", () => {
    const { work } = fixture();
    expect(service<WorkHost>("child-1", WORK_SERVICE)).toBe(work.host);
    work.dispose();
    expect(service<WorkHost>("child-1", WORK_SERVICE)).toBeUndefined();
  });

  it("persists open items as custom entries in the child's own session file", async () => {
    const { work, store, records, microtasks } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    expect(store.appendCustomEntry).toHaveBeenCalledWith(
      WORK_ENTRY,
      expect.objectContaining({ op: "open", id: item.id, label: "CI" }),
    );
    expect(work.openItems().map((view) => view.label)).toEqual(["CI"]);
    item.complete(DONE);
    // The item reads as closed at once; its close record follows once the message is in the file.
    expect(work.openItems()).toEqual([]);
    await microtasks();
    expect(records().at(-1)).toMatchObject({ op: "close", id: item.id, reason: "completed" });
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

  it("closes the item once the message is in the transcript", async () => {
    const { work, closes, microtasks } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    item.complete(DONE);
    await microtasks();
    expect(closes()).toHaveLength(1);
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

describe("answering the child's questions", () => {
  it("closes the question items and leaves the others open, with no message", () => {
    const { work, sent, policy, closes } = fixture();
    work.host.open({ owner: "pi-job", kind: "watch", label: "CI" });
    work.host.open({ owner: "pi-ask", kind: "question", label: "answer" });
    work.host.open({ owner: "pi-ask", kind: "question", label: "answer" });
    policy.changed.mockClear();

    expect(work.answerQuestions()).toBe(2);

    expect(work.openItems().map((view) => view.kind)).toEqual(["watch"]);
    expect(closes()).toMatchObject([{ reason: "cancelled" }, { reason: "cancelled" }]);
    // The answer reaches the child as the run's prompt, not as a work message; no wake.
    expect(sent).toEqual([]);
    expect(policy.wake).not.toHaveBeenCalled();
    expect(policy.changed).toHaveBeenCalledTimes(1);
  });

  it("closes nothing when the child asked nothing", () => {
    const { work, policy } = fixture();
    work.host.open({ owner: "pi-job", kind: "watch", label: "CI" });
    policy.changed.mockClear();
    expect(work.answerQuestions()).toBe(0);
    expect(work.openItems()).toHaveLength(1);
    expect(policy.changed).not.toHaveBeenCalled();
  });

  it("closes a question its owner adopted after a reopen, so the next start does not find it", () => {
    const { work, closes } = fixture({
      entries: [
        { v: 1, op: "open", id: "q1", owner: "pi-ask", kind: "question", label: "answer", at: 1 },
      ],
    });
    work.host.adopt("pi-ask", () => true);
    work.settleStartup();
    expect(work.openItems().map((view) => view.id)).toEqual(["q1"]);
    expect(work.answerQuestions()).toBe(1);
    expect(work.openItems()).toEqual([]);
    expect(closes()).toMatchObject([{ id: "q1", reason: "cancelled" }]);
  });

  it("does nothing once the session is gone", () => {
    const { work } = fixture();
    work.host.open({ owner: "pi-ask", kind: "question", label: "answer" });
    work.dispose();
    expect(work.answerQuestions()).toBe(0);
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

describe("landing confirmation", () => {
  it("keeps a message Pi holds mid-run open on disk until the turn ends and it is in the transcript", async () => {
    const { work, session, closes, emit, endTurn, microtasks } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    session.isIdle = false;
    emit("agent_start");
    item.complete(DONE);
    // Closed for the agent (it no longer waits on it), not yet closed on disk.
    expect(work.openItems()).toEqual([]);
    await microtasks();
    emit("message_end");
    await microtasks();
    expect(closes()).toEqual([]);

    endTurn();
    expect(closes()).toHaveLength(1);
    expect(closes()[0]).toMatchObject({ reason: "completed" });
  });

  it("leaves the item open on disk when the process dies before the turn ends, so a restart reports it lost", async () => {
    const { work, session, entries, emit, microtasks } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    session.isIdle = false;
    emit("agent_start");
    item.complete(DONE);
    await microtasks();
    // What a kill -9 right now leaves behind: the open record, and no message, and no close.
    const onDisk = entries.filter((e) => e.type === "custom").map((e) => e.data);
    expect(onDisk).toHaveLength(1);
    work.dispose();
    resetSessionTree();

    const restarted = fixture({ entries: onDisk });
    expect(restarted.work.openItems().map((view) => view.id)).toEqual([item.id]);
    restarted.work.settleStartup();
    expect(restarted.closes()[0]).toMatchObject({ id: item.id, reason: "lost" });
    expect(restarted.sent.map((entry) => entry.message.customType)).toEqual([WORK_LOST]);
    expect(restarted.entries.some((e) => e.customType === DONE.customType)).toBe(false);
  });

  it("stops waiting for a message that did not land by the time the run settled", async () => {
    const { work, session, closes, emit, held, endTurn, microtasks } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    session.isIdle = false;
    emit("agent_start");
    item.complete(DONE);
    held.length = 0; // Pi dropped it (a stale session)
    emit("agent_settled");
    await microtasks();
    endTurn();
    expect(closes()).toEqual([]);
  });

  it("does not take an identical message that landed before the send for the held one", async () => {
    const { work, session, closes, emit, endTurn, microtasks } = fixture();
    const first = work.host.open({ owner: "test", kind: "job", label: "a" });
    const second = work.host.open({ owner: "test", kind: "job", label: "b" });
    first.complete(DONE);
    await microtasks();
    expect(closes()).toHaveLength(1);

    session.isIdle = false;
    emit("agent_start");
    second.complete(DONE); // byte-identical, held by Pi
    await microtasks();
    emit("turn_start");
    emit("agent_end");
    expect(closes()).toHaveLength(1);
    endTurn();
    expect(closes()).toHaveLength(2);
  });

  it("reads the transcript only while an item waits", async () => {
    const { work, store, emit, microtasks } = fixture();
    const reads = vi.spyOn(store, "getBranch");
    emit("turn_start");
    emit("agent_end");
    emit("message_end");
    await microtasks();
    expect(reads).not.toHaveBeenCalled();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    item.complete(DONE);
    await microtasks();
    expect(reads).toHaveBeenCalled();
  });

  it("closes a landed item at shutdown", () => {
    const { work, session, closes, held, entries, emit } = fixture();
    const item = work.host.open({ owner: "test", kind: "job", label: "CI" });
    session.isIdle = false;
    emit("agent_start");
    item.complete(DONE);
    const message = held.pop()!;
    entries.push({
      id: "landed",
      type: "custom_message",
      customType: message.customType,
      content: message.content,
      details: message.details,
    });
    work.dispose();
    expect(closes()).toHaveLength(1);
  });
});

describe("a message that arrives after the run's last chance to continue", () => {
  const settle = (f: ReturnType<typeof fixture>, extra: { aborted?: boolean } = {}) => {
    f.session.isIdle = true;
    f.emit("agent_settled", extra);
  };

  it("asks the agent for a run when the transcript ends with a work message nobody answered", () => {
    const f = fixture();
    const item = f.work.host.open({ owner: "test", kind: "job", label: "CI" });
    f.session.isIdle = false;
    f.emit("agent_start");
    f.answer(); // the model's last answer
    item.complete(DONE); // too late for agent_before_settle to continue
    f.endTurn(); // Pi appends it when the run winds down
    expect(f.policy.wake).not.toHaveBeenCalled(); // the session counted as busy
    settle(f);
    expect(f.policy.wake).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing when the model answered the message", () => {
    const f = fixture();
    const item = f.work.host.open({ owner: "test", kind: "job", label: "CI" });
    f.session.isIdle = false;
    f.emit("agent_start");
    item.complete(DONE);
    f.endTurn();
    f.answer(); // the continuation
    settle(f);
    expect(f.policy.wake).not.toHaveBeenCalled();
  });

  it("asks for nothing after a stopped run: the message waits for the next run", () => {
    const f = fixture();
    const item = f.work.host.open({ owner: "test", kind: "job", label: "CI" });
    f.session.isIdle = false;
    f.emit("agent_start");
    f.answer();
    item.complete(DONE);
    f.endTurn();
    settle(f, { aborted: true });
    expect(f.policy.wake).not.toHaveBeenCalled();
  });

  it("asks for nothing for a message the host did not deliver", () => {
    const f = fixture();
    f.session.isIdle = false;
    f.emit("agent_start");
    f.answer();
    f.entries.push({ id: "x", type: "custom_message", customType: "other:note", content: "hi" });
    settle(f);
    expect(f.policy.wake).not.toHaveBeenCalled();
  });

  it("is not fooled by entries that are not model context after the message", () => {
    const f = fixture();
    const item = f.work.host.open({ owner: "test", kind: "job", label: "CI" });
    f.session.isIdle = false;
    f.emit("agent_start");
    f.answer();
    item.complete(DONE);
    f.endTurn();
    f.work.host.open({ owner: "test", kind: "job", label: "later" }); // a record entry after it
    settle(f);
    expect(f.policy.wake).toHaveBeenCalledTimes(1);
  });
});
