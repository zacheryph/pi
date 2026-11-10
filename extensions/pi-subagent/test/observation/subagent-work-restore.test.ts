import { describe, expect, it } from "vitest";
import { SubagentWork, WORK_KIND, WORK_OWNER } from "#src/observation/subagent-work";
import { createTestSubagent } from "#test/helpers/make-subagent";
import {
  createWorkHost,
  type WorkMessage,
  type WorkRecord,
} from "../../../../packages/pi-work/src/index.ts";

// What the spawning session does with the items its previous instance left open (roadmap step 12),
// against the real work host: persisted items, `adopt`, and the lost report at the end of startup.

/** A host over an in-memory transcript; `restart()` is a new instance reading what was persisted. */
function transcript() {
  const records: WorkRecord[] = [];
  const messages: WorkMessage[] = [];
  const instance = () =>
    createWorkHost({
      store: { read: () => records, append: (record) => void records.push(record) },
      delivery: {
        isIdle: () => true,
        send: (items) => items.forEach((item) => messages.push(item.payload)),
        lost: () => {},
      },
    });
  return { records, messages, instance };
}

const closed = (records: WorkRecord[]) =>
  records.flatMap((r) => (r.op === "close" ? [`${r.id}:${r.reason}`] : []));

function previousInstance() {
  const t = transcript();
  const first = t.instance();
  first.start();
  const work = new SubagentWork(() => first);
  for (const id of ["a", "b", "c"])
    work.runRequested(createTestSubagent({ id, status: "running" }));
  work.dispose(); // the shutdown: the items stay open
  const ids = first.list().map((item) => (item.data as { agentId: string }).agentId);
  expect(ids).toEqual(["a", "b", "c"]);
  return t;
}

function nextInstance(t: ReturnType<typeof transcript>) {
  const host = t.instance();
  host.start();
  return { host, work: new SubagentWork(() => host) };
}

describe("SubagentWork across a restart of the spawning session", () => {
  it("adopts the items of the agents it restores, and no others", () => {
    const t = previousInstance();
    const { host, work } = nextInstance(t);
    work.adopt(new Set(["a", "b"]));
    const lost = host.settleStartup();
    // `c` was not restored: nobody took its item, so the host reports it lost, with its own message.
    expect(lost.map((item) => (item.data as { agentId: string }).agentId)).toEqual(["c"]);
    expect(host.list().map((item) => (item.data as { agentId: string }).agentId)).toEqual([
      "a",
      "b",
    ]);
    expect(t.messages.map((m) => m.customType)).toEqual(["work:lost"]);
  });

  it("keeps the item of an agent that goes on, and its completion closes it with the message", () => {
    const t = previousInstance();
    const { host, work } = nextInstance(t);
    work.adopt(new Set(["a"]));
    work.settle({ id: "a", type: "general-purpose", description: "x", continuing: true });
    host.settleStartup();
    expect(host.list()).toHaveLength(1); // `a` stays open; `b` and `c` were lost
    work.runEnded(createTestSubagent({ id: "a", description: "x" }));
    expect(t.messages.at(-1)?.customType).toBe("subagent:completion");
    expect(host.list()).toEqual([]);
  });

  it("cancels the item of an agent that does not go on, with no message of its own", () => {
    const t = previousInstance();
    const { host, work } = nextInstance(t);
    work.adopt(new Set(["a", "b", "c"]));
    work.settle({ id: "a", type: "general-purpose", description: "x", continuing: false });
    work.settle({ id: "b", type: "general-purpose", description: "x", continuing: false });
    host.settleStartup();
    // `c` was adopted and never settled: it is still open, and no message was sent for `a` or `b`.
    expect(closed(t.records)).toEqual([
      expect.stringMatching(/:cancelled$/),
      expect.stringMatching(/:cancelled$/),
    ]);
    expect(t.messages).toEqual([]);
    expect(host.list()).toHaveLength(1);
  });

  it("opens an item for an agent that goes on but had none, so its completion still arrives", () => {
    const t = transcript();
    const { host, work } = nextInstance(t);
    work.adopt(new Set(["a"]));
    work.settle({ id: "a", type: "explore", description: "Audit", continuing: true });
    expect(host.list()).toMatchObject([
      {
        owner: WORK_OWNER,
        kind: WORK_KIND,
        data: { agentId: "a", type: "explore", description: "Audit" },
      },
    ]);
    work.runEnded(createTestSubagent({ id: "a", description: "Audit", type: "explore" }));
    expect(t.messages.map((m) => m.customType)).toEqual(["subagent:completion"]);
    expect(host.list()).toEqual([]);
  });

  it("cancels an extra item an earlier instance left for the same agent", () => {
    const t = transcript();
    const first = t.instance();
    first.start();
    first.open({ owner: WORK_OWNER, kind: WORK_KIND, label: "one", data: { agentId: "a" } });
    first.open({ owner: WORK_OWNER, kind: WORK_KIND, label: "two", data: { agentId: "a" } });
    const { host, work } = nextInstance(t);
    work.adopt(new Set(["a"]));
    work.settle({ id: "a", type: "general-purpose", description: "x", continuing: true });
    host.settleStartup();
    expect(host.list()).toHaveLength(1);
    expect(t.messages).toEqual([]);
  });

  it("does nothing without a host, and nothing once disposed", () => {
    const none = new SubagentWork(() => undefined);
    expect(() => none.adopt(new Set(["a"]))).not.toThrow();
    expect(() =>
      none.settle({ id: "a", type: "general-purpose", description: "x", continuing: true }),
    ).not.toThrow();

    const t = previousInstance();
    const { host, work } = nextInstance(t);
    work.dispose();
    work.adopt(new Set(["a"]));
    work.settle({ id: "a", type: "general-purpose", description: "x", continuing: false });
    expect(host.settleStartup()).toHaveLength(3); // nothing was adopted
  });
});
