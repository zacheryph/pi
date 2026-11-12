import { describe, expect, it } from "vitest";
import { flushMicrotasks, sleep, tick, waitFor } from "#src/index";

describe("waitFor", () => {
  it("returns the first truthy value", async () => {
    let n = 0;
    await expect(waitFor(() => (++n >= 3 ? n : undefined), { interval: 1 })).resolves.toBe(3);
  });

  it("names what it waited for when it times out", async () => {
    await expect(
      waitFor(() => false, { timeout: 20, interval: 5, what: "the hub" }),
    ).rejects.toThrow(/waiting for the hub/);
  });
});

describe("timing", () => {
  it("flushes chained microtasks", async () => {
    let done = false;
    void Promise.resolve()
      .then(() => undefined)
      .then(() => {
        done = true;
      });
    await flushMicrotasks();
    expect(done).toBe(true);
  });

  it("tick runs after pending microtasks, sleep after its delay", async () => {
    const order: string[] = [];
    void Promise.resolve().then(() => order.push("microtask"));
    await tick();
    order.push("tick");
    const started = Date.now();
    await sleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    expect(order).toEqual(["microtask", "tick"]);
  });
});
