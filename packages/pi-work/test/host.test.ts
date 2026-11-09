import { describe, expect, it, vi } from "vitest";
import {
  createWorkHost,
  lostMessage,
  openRecords,
  parseRecord,
  WORK_LOST,
  type BeforeSettleEvent,
  type Completion,
  type SendMode,
  type WorkMessage,
  type WorkRecord,
} from "../src/index.ts";

const DONE: WorkMessage = { customType: "test:done", content: "RESULT" };

/** A host over an in-memory store and a recording wake policy. */
function setup(options: { records?: unknown[]; idle?: boolean } = {}) {
  const records: unknown[] = [...(options.records ?? [])];
  const sent: { messages: WorkMessage[]; mode: SendMode }[] = [];
  let idle = options.idle ?? true;
  let n = 0;
  const onLost = vi.fn();
  const host = createWorkHost({
    store: { read: () => records, append: (record) => void records.push(record) },
    delivery: {
      isIdle: () => idle,
      send: (items: Completion<WorkMessage>[], mode) =>
        void sent.push({ messages: items.map((item) => item.payload), mode }),
    },
    onLost,
    now: () => 1000 + n,
    newId: () => `id${++n}`,
  });
  host.start();
  return {
    host,
    records: records as WorkRecord[],
    sent,
    onLost,
    setIdle: (value: boolean) => void (idle = value),
  };
}

const opened = (id: string, owner = "test", label = "CI"): WorkRecord => ({
  v: 1,
  op: "open",
  id,
  owner,
  kind: "job",
  label,
  at: 1,
});
const closed = (id: string): WorkRecord => ({ v: 1, op: "close", id, reason: "completed", at: 2 });

describe("opening and closing items", () => {
  it("persists an open record and lists the item", () => {
    const { host, records } = setup();
    const item = host.open({ owner: "test", kind: "job", label: "CI", data: { run: 7 } });
    expect(records).toEqual([
      {
        v: 1,
        op: "open",
        id: item.id,
        owner: "test",
        kind: "job",
        label: "CI",
        data: { run: 7 },
        at: expect.any(Number),
      },
    ]);
    expect(host.list()).toEqual([
      {
        id: item.id,
        owner: "test",
        kind: "job",
        label: "CI",
        data: { run: 7 },
        openedAt: expect.any(Number),
      },
    ]);
  });

  it("rejects an item without owner or kind", () => {
    const { host, records } = setup();
    expect(() => host.open({ owner: "", kind: "job", label: "x" })).toThrow(TypeError);
    expect(() => host.open({ owner: "a", kind: "", label: "x" })).toThrow(TypeError);
    expect(records).toEqual([]);
  });

  it("complete delivers the message, closes the item and ignores a second result", () => {
    const { host, records, sent } = setup();
    const item = host.open({ owner: "test", kind: "job", label: "CI" });
    item.complete(DONE);
    item.complete({ customType: "test:done", content: "AGAIN" });
    item.notify({ customType: "test:late", content: "late" });
    item.cancel();
    expect(sent).toEqual([{ messages: [DONE], mode: "wake" }]);
    expect(host.list()).toEqual([]);
    expect(records.at(-1)).toMatchObject({ op: "close", id: item.id, reason: "completed" });
    expect(records.filter((record) => record.op === "close")).toHaveLength(1);
  });

  it("notify delivers without closing", () => {
    const { host, sent } = setup();
    const item = host.open({ owner: "test", kind: "question", label: "answer" });
    item.notify({ customType: "test:ask", content: "which one?" });
    expect(sent).toHaveLength(1);
    expect(host.list()).toHaveLength(1);
    item.complete(DONE);
    expect(sent).toHaveLength(2);
  });

  it("cancel closes without a message", () => {
    const { host, records, sent } = setup();
    const item = host.open({ owner: "test", kind: "job", label: "CI" });
    item.cancel();
    expect(sent).toEqual([]);
    expect(host.list()).toEqual([]);
    expect(records.at(-1)).toMatchObject({ op: "close", reason: "cancelled" });
  });

  it("lists items oldest first", () => {
    const { host } = setup();
    host.open({ owner: "a", kind: "job", label: "one" });
    host.open({ owner: "b", kind: "job", label: "two" });
    expect(host.list().map((item) => item.label)).toEqual(["one", "two"]);
  });
});

describe("wake policy", () => {
  it("wakes when idle and records while a run is active", () => {
    const { host, sent } = setup();
    const a = host.open({ owner: "test", kind: "job", label: "a" });
    const b = host.open({ owner: "test", kind: "job", label: "b" });
    a.complete({ customType: "test:done", content: "a" });
    host.agentStart();
    host.agentSettled();
    host.agentStart();
    host.agentStart();
    b.complete({ customType: "test:done", content: "b" });
    expect(sent.map((s) => s.mode)).toEqual(["wake", "record"]);
  });

  it("records instead of waking while Pi is busy without a run", () => {
    const { host, sent, setIdle } = setup();
    const item = host.open({ owner: "test", kind: "job", label: "a" });
    setIdle(false);
    item.complete(DONE);
    expect(sent.map((s) => s.mode)).toEqual(["record"]);
  });

  it("recognizes delivered messages at the run boundary, and only those", () => {
    const { host } = setup();
    host.open({ owner: "test", kind: "job", label: "a" }).complete(DONE);
    const event = (outcome: string, last: object, pending: object[] = []): BeforeSettleEvent => ({
      outcome,
      context: { contextMessages: [last], pendingMessages: pending },
    });
    const done = { role: "custom", customType: "test:done" };
    expect(host.continuesRun(event("completed", done))).toBe(true);
    expect(host.continuesRun(event("completed", { role: "assistant" }, [done]))).toBe(true);
    expect(host.continuesRun(event("completed", { role: "assistant" }))).toBe(false);
    expect(host.continuesRun(event("completed", { role: "custom", customType: "other" }))).toBe(
      false,
    );
    expect(host.continuesRun(event("aborted", done))).toBe(false);
    expect(host.continuesRun(event("error", done))).toBe(false);
  });
});

describe("startup", () => {
  it("loads only the items still open and skips malformed records", () => {
    const { host } = setup({
      records: [opened("a"), opened("b"), closed("a"), { v: 2 }, null, "x", { v: 1, op: "open" }],
    });
    host.adopt("test", () => true);
    expect(host.list().map((item) => item.id)).toEqual(["b"]);
  });

  it("offers an owner only its own items, and an item stays open when the owner takes it", () => {
    const { host, sent } = setup({ records: [opened("a", "pi-job"), opened("b", "pi-ask")] });
    const seen: string[] = [];
    host.adopt("pi-job", (item) => {
      seen.push(item.id);
      return true;
    });
    expect(seen).toEqual(["a"]);
    host.settleStartup();
    expect(host.list().map((item) => item.id)).toEqual(["a"]);
    expect(sent).toHaveLength(1); // only b was lost
  });

  it("closes unadopted items as lost with one message that starts no turn", () => {
    const { host, records, sent, onLost } = setup({
      records: [opened("a", "pi-job", "CI"), opened("b", "pi-job", "build"), opened("c", "pi-ask")],
    });
    host.adopt("pi-job", (item) => item.id === "a");
    const lost = host.settleStartup();
    expect(lost.map((item) => item.id)).toEqual(["b", "c"]);
    expect(host.list().map((item) => item.id)).toEqual(["a"]);
    expect(
      records.filter((r) => r.op === "close").map((r) => [r.id, (r as { reason: string }).reason]),
    ).toEqual([
      ["b", "lost"],
      ["c", "lost"],
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].mode).toBe("record");
    expect(sent[0].messages[0].customType).toBe(WORK_LOST);
    expect(sent[0].messages[0].content).toContain("2 items");
    expect(onLost).toHaveBeenCalledWith(lost);
    expect(host.settleStartup()).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("records lost work even when the session is idle", () => {
    const { host, sent } = setup({ records: [opened("a")], idle: true });
    host.settleStartup();
    expect(sent.map((s) => s.mode)).toEqual(["record"]);
  });

  it("says nothing when nothing is open", () => {
    const { host, sent, onLost } = setup({ records: [opened("a"), closed("a")] });
    expect(host.settleStartup()).toEqual([]);
    expect(sent).toEqual([]);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("finds nothing to adopt once startup has settled", () => {
    const { host } = setup({ records: [opened("a")] });
    host.settleStartup();
    const adopt = vi.fn(() => true);
    host.adopt("test", adopt);
    expect(adopt).not.toHaveBeenCalled();
  });

  it("does not lose items opened in this instance", () => {
    const { host, sent } = setup();
    host.open({ owner: "test", kind: "job", label: "CI" });
    expect(host.settleStartup()).toEqual([]);
    expect(host.list()).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("a second restart reports nothing again", () => {
    const first = setup({ records: [opened("a")] });
    first.host.settleStartup();
    const second = setup({ records: first.records });
    expect(second.host.settleStartup()).toEqual([]);
    expect(second.sent).toEqual([]);
  });

  it("an adopted item completes like a new one", () => {
    const { host, sent } = setup({ records: [opened("a", "pi-job", "CI")] });
    let adopted: ReturnType<typeof host.open> | undefined;
    host.adopt("pi-job", (item) => ((adopted = item), true));
    expect(adopted).toMatchObject({ id: "a", owner: "pi-job", kind: "job", label: "CI" });
    adopted!.complete(DONE);
    expect(sent).toEqual([{ messages: [DONE], mode: "wake" }]);
    expect(host.list()).toEqual([]);
  });

  it("survives a throwing delivery when reporting lost work", () => {
    const records: unknown[] = [opened("a")];
    const host = createWorkHost({
      store: { read: () => records, append: (r) => void records.push(r) },
      delivery: {
        isIdle: () => true,
        send: () => {
          throw new Error("stale");
        },
      },
    });
    host.start();
    expect(host.settleStartup()).toHaveLength(1);
    expect(host.list()).toEqual([]);
  });
});

describe("disposal", () => {
  it("makes items inert and leaves them persisted for the next instance", () => {
    const { host, records, sent } = setup();
    const item = host.open({ owner: "test", kind: "job", label: "CI" });
    host.dispose();
    item.complete(DONE);
    item.cancel();
    expect(sent).toEqual([]);
    expect(records.filter((r) => r.op === "close")).toEqual([]);
    expect(() => host.open({ owner: "test", kind: "job", label: "x" })).toThrow();
    // The next instance still sees it as open.
    const next = setup({ records });
    next.host.adopt("test", () => true);
    expect(next.host.list().map((i) => i.id)).toEqual([item.id]);
  });
});

describe("persistence format", () => {
  it("parses only well-formed records", () => {
    expect(parseRecord(opened("a"))).toEqual(opened("a"));
    expect(parseRecord(closed("a"))).toEqual(closed("a"));
    expect(parseRecord({ v: 1, op: "close", id: "a", reason: "bogus", at: 1 })).toBeUndefined();
    expect(
      parseRecord({ v: 1, op: "open", id: "a", owner: "", kind: "job", label: "" }),
    ).toBeUndefined();
    expect(
      parseRecord({ v: 1, op: "open", id: "a", owner: "x", kind: "job", label: "" }),
    ).toMatchObject({ label: "", at: 0 });
    expect(parseRecord({ op: "open", id: "a" })).toBeUndefined();
  });

  it("keeps an item open until a close record arrives, whatever the order of other records", () => {
    expect(
      openRecords([opened("a"), opened("b"), closed("b"), closed("zzz")]).map((r) => r.id),
    ).toEqual(["a"]);
  });

  it("describes lost items as bounded data", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: `i${i}`,
      owner: "pi-job",
      kind: "job",
      label: "x".repeat(500),
      openedAt: 1,
    }));
    const message = lostMessage(items);
    const text = message.content as string;
    expect(text).toContain("25 items");
    expect(text).toContain("and 5 more");
    expect(text.length).toBeLessThan(25 * 200);
    expect((message.details as { items: unknown[] }).items).toHaveLength(25);
    expect(lostMessage(items.slice(0, 1)).content).toContain("1 item ");
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });
});
