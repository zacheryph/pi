import { describe, expect, it, vi } from "vitest";
import {
  continuesRun,
  Delivery,
  type Completion,
  type DeliveryHost,
  type SendMode,
} from "#src/index";

function setup() {
  const sent: { ids: string[]; mode: SendMode }[] = [];
  const lost: string[][] = [];
  const state = { idle: true, throws: false };
  const host: DeliveryHost<string> = {
    isIdle: () => {
      if (state.throws) throw new Error("stale");
      return state.idle;
    },
    send: (items, mode) => void sent.push({ ids: items.map((i) => i.payload), mode }),
    lost: (items) => void lost.push(items.map((i) => i.payload)),
  };
  return { delivery: new Delivery<string>(host), sent, lost, state };
}
const item = (payload: string): Completion<string> => ({ completionId: payload, payload });

describe("Delivery", () => {
  it("wakes an idle session and records for a running one", () => {
    const { delivery, sent, state } = setup();
    delivery.add(item("a"));
    state.idle = false; // the wake started a run
    delivery.add(item("b"));
    delivery.onAgentSettled();
    state.idle = true;
    delivery.add(item("c"));
    expect(sent).toEqual([
      { ids: ["a"], mode: "wake" },
      { ids: ["b"], mode: "record" },
      { ids: ["c"], mode: "wake" },
    ]);
  });

  it("records while a run is active even if Pi reports idle between turns", () => {
    const { delivery, sent } = setup();
    delivery.onAgentStart();
    delivery.add(item("a"));
    expect(sent).toEqual([{ ids: ["a"], mode: "record" }]);
  });

  it("holds while suspended and sends one message when rebound", async () => {
    const { delivery, sent } = setup();
    delivery.suspend();
    delivery.add(item("a"));
    delivery.add(item("b"));
    expect(delivery.heldCount).toBe(2);
    delivery.rebind({
      isIdle: () => true,
      send: (items, mode) => void sent.push({ ids: items.map((i) => i.payload), mode }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([{ ids: ["a", "b"], mode: "wake" }]);
  });

  it("stops for good when the host throws, reporting what was not sent", () => {
    const { delivery, sent, lost, state } = setup();
    state.throws = true;
    delivery.add(item("a"));
    expect(delivery.isDisposed).toBe(true);
    expect(lost).toEqual([["a"]]);
    state.throws = false;
    delivery.add(item("b"));
    expect(sent).toEqual([]);
  });

  it("reports whether it accepted a message", () => {
    const { delivery, sent } = setup();
    expect(delivery.add(item("a"))).toBe(true);
    delivery.suspend();
    expect(delivery.add(item("held"))).toBe(true); // kept for the reload handoff
    delivery.dispose();
    expect(delivery.add(item("c"))).toBe(false); // disposed: goes nowhere
    expect(sent).toEqual([{ ids: ["a"], mode: "wake" }]);
  });

  it("refuses the message whose own send failed for good", () => {
    const { delivery, state } = setup();
    state.throws = true;
    expect(delivery.add(item("a"))).toBe(false);
    expect(delivery.add(item("b"))).toBe(false);
  });

  it("accepts a message that went out even when the context goes stale right after", () => {
    let checks = 0;
    const delivery = new Delivery<string>({
      isIdle: () => {
        if (++checks > 1) throw new Error("stale");
        return true;
      },
      send: () => {},
    });
    expect(delivery.add(item("a"))).toBe(true);
    expect(delivery.isDisposed).toBe(true);
  });

  it("reports held items when disposed", () => {
    const { delivery, lost } = setup();
    delivery.suspend();
    delivery.add(item("a"));
    delivery.dispose();
    expect(lost).toEqual([["a"]]);
  });

  it("detects a stale context in isIdle: disposed, nothing sent", () => {
    const { delivery, sent, lost, state } = setup();
    state.throws = true;
    delivery.add(item("a"));
    expect(sent).toEqual([]);
    expect(lost).toEqual([["a"]]);
  });

  it("does not report a send as lost when a later check finds the context stale", () => {
    const sent: string[] = [];
    const lost: string[] = [];
    let checks = 0;
    const delivery = new Delivery<string>({
      isIdle: () => {
        if (++checks > 1) throw new Error("stale");
        return true;
      },
      send: (items) => void sent.push(...items.map((i) => i.payload)),
      lost: (items) => void lost.push(...items.map((i) => i.payload)),
    });
    delivery.add(item("a"));
    expect(sent).toEqual(["a"]);
    expect(lost).toEqual([]);
  });

  it("starts no timer and never resends because time passed", async () => {
    vi.useFakeTimers();
    try {
      const { delivery, sent, state } = setup();
      delivery.add(item("a"));
      delivery.onAgentStart();
      delivery.add(item("b"));
      delivery.onAgentSettled();
      state.idle = true;
      expect(vi.getTimerCount()).toBe(0);
      const before = sent.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a deferred rebind resume a second reload handoff", async () => {
    const { delivery } = setup();
    delivery.suspend();
    delivery.add(item("pending"));
    let sends = 0;
    delivery.rebind({ isIdle: () => true, send: () => void sends++ });
    delivery.suspend();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sends).toBe(0);
    delivery.dispose();
  });
});

describe("continuesRun", () => {
  const isMine = (m: { customType?: string }) => m.customType === "mine";
  const event = (outcome: string, last: object, pending: object[] = []) => ({
    outcome,
    context: { contextMessages: [last], pendingMessages: pending },
  });
  it("continues a completed run whose newest or pending message is delivered", () => {
    expect(continuesRun(event("completed", { customType: "mine" }), isMine)).toBe(true);
    expect(continuesRun(event("completed", {}, [{ customType: "mine" }]), isMine)).toBe(true);
    expect(continuesRun(event("completed", {}), isMine)).toBe(false);
  });
  it("looks past other extensions' custom messages after the work message", () => {
    const run = (...tail: object[]) => ({
      outcome: "completed",
      context: {
        contextMessages: [{ role: "assistant" }, ...tail],
        pendingMessages: [],
      },
    });
    const work = { role: "custom", customType: "mine" };
    const other = { role: "custom", customType: "other:note" };
    expect(continuesRun(run(work, other), isMine)).toBe(true);
    expect(continuesRun(run(work, other, { role: "branchSummary" }), isMine)).toBe(true);
    expect(continuesRun(run(other, work), isMine)).toBe(true);
    // Answered: an assistant message sits between the work message and the end.
    expect(continuesRun(run(work, { role: "assistant" }, other), isMine)).toBe(false);
    expect(continuesRun(run(other), isMine)).toBe(false);
  });
  it("never continues an aborted or failed run", () => {
    expect(continuesRun(event("aborted", { customType: "mine" }), isMine)).toBe(false);
    expect(continuesRun(event("error", { customType: "mine" }), isMine)).toBe(false);
  });
});
