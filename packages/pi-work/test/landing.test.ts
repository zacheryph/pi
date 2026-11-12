import { describe, expect, it, vi } from "vitest";
import {
  createLandingTracker,
  createWorkHost,
  type Completion,
  type TranscriptEntry,
  type WorkMessage,
  type WorkRecord,
} from "#src/index";

const DONE: WorkMessage = { customType: "test:done", content: "SAME" };
const base: TranscriptEntry[] = [
  { type: "message", id: "m1" },
  { type: "message", id: "m2" },
];
const landed = (id: string, content = "SAME"): TranscriptEntry => ({
  type: "custom_message",
  id,
  customType: "test:done",
  content,
});

/** A host that confirms landing, read through a tracker over a branch the test edits. */
function setup(branch: TranscriptEntry[] = [...base]) {
  const records: WorkRecord[] = [];
  const sent: WorkMessage[][] = [];
  let n = 0;
  const reads = { count: 0 };
  const tracker = createLandingTracker({
    branch: () => {
      reads.count++;
      return branch;
    },
    target: () => host,
  });
  const host = createWorkHost({
    store: { read: () => records, append: (record) => void records.push(record) },
    delivery: {
      isIdle: () => false,
      send: (items: Completion<WorkMessage>[]) => void sent.push(items.map((i) => i.payload)),
    },
    confirmLanding: true,
    landingMark: () => tracker.mark(),
    newId: () => `id${++n}`,
  });
  host.start();
  const closes = () => records.filter((record) => record.op === "close");
  const item = (label = "a") => host.open({ owner: "test", kind: "job", label });
  return { host, tracker, branch, records, closes, sent, item, reads };
}

describe("mark", () => {
  it("is the position after the newest entry and the id of that entry", () => {
    const { tracker } = setup();
    expect(tracker.mark()).toEqual({ index: 2, anchor: "m2" });
  });

  it("is index 0 on an empty transcript", () => {
    const { tracker } = setup([]);
    expect(tracker.mark()).toEqual({ index: 0, anchor: undefined });
  });
});

describe("check", () => {
  it("closes the item when its message appears after the send", () => {
    const { tracker, branch, closes, item } = setup();
    item().complete(DONE);
    expect(closes()).toHaveLength(0);
    branch.push(landed("c1"));
    tracker.check();
    expect(closes()).toHaveLength(1);
  });

  it("does not take an identical message from before the send for the new one", () => {
    const { tracker, branch, closes, item } = setup([...base, landed("old")]);
    item().complete(DONE);
    tracker.check();
    expect(closes()).toHaveLength(0);
    branch.push(landed("new"));
    tracker.check();
    expect(closes()).toHaveLength(1);
  });

  it("takes identical messages in the order they were sent", () => {
    const { tracker, branch, closes, item, host } = setup();
    const one = item("one");
    const two = item("two");
    one.complete(DONE);
    two.complete(DONE);
    branch.push(landed("c1"));
    tracker.check();
    expect(closes().map((record) => record.id)).toEqual([one.id]);
    expect(host.awaitingLanding()).toBe(true);
    branch.push(landed("c2"));
    tracker.check();
    expect(closes().map((record) => record.id)).toEqual([one.id, two.id]);
  });

  it("stops waiting once the leaf has left the branch the message was sent on", () => {
    const { tracker, branch, closes, item, host } = setup();
    item().complete(DONE);
    branch.splice(1, 1, { type: "message", id: "other" }, { type: "message", id: "other2" });
    tracker.check();
    branch.push(landed("c1"));
    tracker.check();
    expect(closes()).toHaveLength(0);
    expect(host.awaitingLanding()).toBe(false);
  });

  it("keeps waiting while no run has settled and the branch is the same", () => {
    const { tracker, item, host } = setup();
    item().complete(DONE);
    tracker.check();
    tracker.observe("turn_start");
    tracker.observe("agent_end");
    expect(host.awaitingLanding()).toBe(true);
  });

  it("stops waiting once a run has settled without the message landing", () => {
    const { tracker, branch, closes, item, host } = setup();
    item().complete(DONE);
    tracker.observe("agent_settled");
    expect(host.awaitingLanding()).toBe(false);
    branch.push(landed("c1"));
    tracker.check();
    expect(closes()).toHaveLength(0);
  });

  it("still closes a message that lands at the end of the settling run", () => {
    const { tracker, branch, closes, item } = setup();
    item().complete(DONE);
    branch.push(landed("c1"));
    tracker.observe("agent_settled");
    expect(closes()).toHaveLength(1);
  });

  it("does nothing while no item waits, and does not read the transcript", () => {
    const { tracker, reads } = setup();
    const before = reads.count;
    tracker.check();
    tracker.observe("turn_start");
    tracker.observe("agent_settled");
    expect(reads.count).toBe(before);
  });

  it("survives a transcript that cannot be read", () => {
    const { item, host, closes } = setup();
    item().complete(DONE);
    const unreadable = createLandingTracker({
      branch: () => {
        throw new Error("stale context");
      },
      target: () => host,
    });
    expect(() => unreadable.check()).not.toThrow();
    expect(closes()).toHaveLength(0);
    expect(host.awaitingLanding()).toBe(true);
  });
});

describe("boundaries", () => {
  it("looks one macrotask after message_end, since the message is written after the event", async () => {
    const { tracker, branch, closes, item } = setup();
    item().complete(DONE);
    tracker.observe("message_end");
    branch.push(landed("c1")); // Pi writes the message after the event reaches listeners
    expect(closes()).toHaveLength(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closes()).toHaveLength(1);
  });

  it("looks one microtask after a send", async () => {
    const { tracker, branch, closes, item } = setup();
    item().complete(DONE);
    branch.push(landed("c1"));
    tracker.sent();
    expect(closes()).toHaveLength(0);
    await Promise.resolve();
    expect(closes()).toHaveLength(1);
  });

  it("reads on every boundary that follows the end of a turn", () => {
    for (const boundary of [
      "turn_start",
      "agent_end",
      "agent_before_settle",
      "session_tree",
      "session_shutdown",
    ] as const) {
      const { tracker, branch, closes, item } = setup();
      item().complete(DONE);
      branch.push(landed("c1"));
      tracker.observe(boundary);
      expect(closes(), boundary).toHaveLength(1);
    }
  });

  it("reads nothing once disposed", async () => {
    const { tracker, branch, closes, item } = setup();
    item().complete(DONE);
    tracker.observe("message_end");
    tracker.dispose();
    branch.push(landed("c1"));
    await new Promise((resolve) => setImmediate(resolve));
    tracker.check();
    tracker.observe("turn_start");
    expect(closes()).toHaveLength(0);
  });
});

describe("unanswered", () => {
  const delivers = (customType: string) => customType === "test:done";
  const tail = (...entries: TranscriptEntry[]) =>
    createLandingTracker({ branch: () => entries, target: () => undefined }).unanswered(delivers);

  it("is true when the newest model context is a delivered message", () => {
    expect(tail(...base, landed("c1"))).toBe(true);
  });

  it("is true when another extension's custom message follows the work message", () => {
    const note: TranscriptEntry = { type: "custom_message", id: "n", customType: "other:note" };
    expect(tail(...base, landed("c1"), note)).toBe(true);
    expect(tail(...base, note, landed("c1"))).toBe(true);
    expect(tail(...base, landed("c1"), { type: "branch_summary", id: "b" })).toBe(true);
  });

  it("is false when an answer sits between the work message and the end", () => {
    const note: TranscriptEntry = { type: "custom_message", id: "n", customType: "other:note" };
    expect(tail(...base, landed("c1"), { type: "message", id: "a" }, note)).toBe(false);
    expect(tail(...base, note)).toBe(false);
  });

  it("is false once an assistant message follows it", () => {
    expect(tail(...base, landed("c1"), { type: "message", id: "m3" })).toBe(false);
  });

  it("looks past records and other entries that are not model context", () => {
    expect(
      tail(...base, landed("c1"), { type: "custom", customType: "work:item" }, { type: "label" }),
    ).toBe(true);
  });

  it("is false for a custom message of a type the host did not deliver", () => {
    expect(tail(...base, { type: "custom_message", customType: "other:note" })).toBe(false);
  });

  it("is false after a compaction", () => {
    expect(tail(landed("c1"), { type: "compaction" })).toBe(false);
  });

  it("is false for an empty transcript and for one that cannot be read", () => {
    expect(tail()).toBe(false);
    const unreadable = createLandingTracker({
      branch: vi.fn(() => {
        throw new Error("stale");
      }),
      target: () => undefined,
    });
    expect(unreadable.unanswered(delivers)).toBe(false);
  });
});
