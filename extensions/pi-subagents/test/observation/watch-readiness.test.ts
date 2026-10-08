import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager, type SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import { CompositeSubagentObserver } from "#src/observation/composite-subagent-observer";
import type { AgentSessionEvent } from "#src/types";
import { createSessionFactory } from "#test/helpers/manager-stubs";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { turnLoopResult } from "#test/helpers/turn-loop-result";

function observer(overrides: Partial<SubagentManagerObserver> = {}): SubagentManagerObserver {
  return {
    onSubagentStarted() {}, onSubagentCompleted() {}, onSubagentResuming() {},
    onSubagentResumed() {}, onSubagentCompacted() {}, onSubagentCreated() {}, ...overrides,
  };
}

describe("watch readiness through manager and composite observer", () => {
  it.each([false, true])("subscribes before the first event (foreground: %s) without suppressing spawn observer", async foreground => {
    const { factory, stub, session } = createSessionFactory();
    const received: AgentSessionEvent[] = [];
    const order: string[] = [];
    let unsubscribe: (() => void) | undefined;
    const manager = new SubagentManager({
      createSubagentSession: factory, baseCwd: "/repo", limiter: new ConcurrencyLimiter(() => 4),
      registry: new AgentTypeRegistry(() => new Map()),
      observer: new CompositeSubagentObserver([observer(), observer({
        onSubagentSessionCreated(record) {
          order.push("ready");
          unsubscribe = record.subscribeToUpdates(event => received.push(event));
        },
      })]),
    });
    stub.runTurnLoop.mockImplementation(async () => {
      order.push("prompt");
      session.emit({ type: "tool_execution_start", toolCallId: "first", toolName: "read", args: { path: "a.ts" } });
      return turnLoopResult({ responseText: "done" });
    });
    try {
      const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "work", {
        description: "watch", background: { kind: "explicit", isBackground: !foreground },
        observer: { onSessionCreated: () => { order.push("spawn-ready"); } },
      });
      await manager.getRecord(id)!.promise;
      expect(order).toEqual(["ready", "spawn-ready", "prompt"]);
      expect(received[0]).toMatchObject({ type: "tool_execution_start", toolCallId: "first" });
      expect(manager.getRecord(id)!.status).toBe("completed");
    } finally { unsubscribe?.(); await manager.dispose(); }
  });

  it("isolates manager-wide readiness faults from child execution and per-spawn callback", async () => {
    const { factory } = createSessionFactory();
    const perSpawn = vi.fn();
    const manager = new SubagentManager({
      createSubagentSession: factory, baseCwd: "/repo", limiter: new ConcurrencyLimiter(() => 4),
      registry: new AgentTypeRegistry(() => new Map()),
      observer: observer({ onSubagentSessionCreated: () => { throw new Error("broken viewer"); } }),
    });
    try {
      const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "work", {
        description: "watch", background: { kind: "explicit", isBackground: true },
        observer: { onSessionCreated: perSpawn },
      });
      await manager.getRecord(id)!.promise;
      expect(perSpawn).toHaveBeenCalledTimes(1);
      expect(manager.getRecord(id)!.status).toBe("completed");
    } finally { await manager.dispose(); }
  });
});
