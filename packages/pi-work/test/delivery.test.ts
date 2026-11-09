import { describe, expect, it } from "vitest";
import {
  continuesRun,
  Delivery,
  type Completion,
  type DeliveryHost,
  type SendMode,
} from "../src/index.ts";

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

  it("reports held items when disposed", () => {
    const { delivery, lost } = setup();
    delivery.suspend();
    delivery.add(item("a"));
    delivery.dispose();
    expect(lost).toEqual([["a"]]);
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
  it("never continues an aborted or failed run", () => {
    expect(continuesRun(event("aborted", { customType: "mine" }), isMine)).toBe(false);
    expect(continuesRun(event("error", { customType: "mine" }), isMine)).toBe(false);
  });
});
