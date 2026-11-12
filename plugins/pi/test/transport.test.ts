import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { serveFeed } from "../server/host.ts";
import { followFeed } from "../server/feed.ts";
import type { HarnessState } from "../shared/state.ts";

// Real socket coverage runs in CI; restricted executors may refuse listen with EPERM.
describe("session feed transport", () => {
  it("sends initial/current state, reconnects and releases its producer subscription", async () => {
    const sessionId = randomUUID();
    let revision = 1;
    const listeners = new Set<() => void>();
    const read = () => ({ version: 1, sessionId, todos: { revision, total: 0, tasks: [] } });
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    let close = await serveFeed(sessionId, read, subscribe);
    const controller = new AbortController();
    const states: HarnessState[] = [];
    let disconnected = false;
    const stop = followFeed(
      sessionId,
      controller.signal,
      (state) => states.push(state),
      () => {
        disconnected = true;
      },
    );
    const until = async (ready: () => boolean) => {
      const deadline = Date.now() + 3500;
      while (!ready()) {
        if (Date.now() > deadline) throw new Error("Feed did not update");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await until(() => states.length === 1);
      expect(states[0]?.todos?.revision).toBe(1);
      revision = 2;
      for (const listener of listeners) listener();
      await until(() => states.length === 2);
      expect(states[1]?.todos?.revision).toBe(2);
      await close();
      expect(listeners.size).toBe(0);
      await until(() => disconnected);
      revision = 3;
      close = await serveFeed(sessionId, read, subscribe);
      await until(() => states.length === 3);
      expect(states[2]?.todos?.revision).toBe(3);
    } finally {
      controller.abort();
      stop();
      await close();
    }
    expect(listeners.size).toBe(0);
  });
});
