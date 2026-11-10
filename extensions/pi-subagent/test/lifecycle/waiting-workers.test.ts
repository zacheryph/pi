import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import { WORK_WAKE_PROMPT } from "#src/lifecycle/run";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { createSubagentSessionStub, openItem, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { turnLoopResult } from "#test/helpers/turn-loop-result";
import { tick } from "../../../../packages/pi-test-helpers/src/wait.ts";

// An idle agent with open work is waiting, not done (roadmap step 9). The work host belongs to
// the child's session; these tests stand in for it through `params.work`, the policy the agent
// hands its host, and through the open items of the session stub.

interface Child {
  params: CreateSubagentSessionParams;
  stub: ReturnType<typeof createSubagentSessionStub>;
}

function harness(limit = 1) {
  const children = new Map<string, Child>();
  const observed = {
    waiting: vi.fn(),
    completed: vi.fn(),
    resumed: vi.fn(),
    queued: vi.fn(),
    resuming: vi.fn(),
  };
  const manager = new SubagentManager({
    registry: new AgentTypeRegistry(() => new Map()),
    limiter: new ConcurrencyLimiter(() => limit),
    createSubagentSession: async (params) => {
      const stub = createSubagentSessionStub();
      children.set(params.agentId!, { params, stub });
      return toSubagentSession(stub);
    },
    observer: {
      onSubagentCreated() {},
      onSubagentStarted() {},
      onSubagentResuming: observed.resuming,
      onSubagentResumeQueued: observed.queued,
      onSubagentCompleted: observed.completed,
      onSubagentResumed: observed.resumed,
      onSubagentCompacted() {},
      onSubagentWaiting: observed.waiting,
    },
  });
  onTestFinished(() => manager.dispose());
  /**
   * Spawn an agent. `prepare` runs before its first turn loop returns, to open the work it
   * leaves running (or script the turn loop).
   */
  const spawn = async (prepare: (child: Child) => void = () => {}, description = "work") => {
    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "work", { description });
    const child = children.get(id)!;
    prepare(child);
    const record = manager.getRecord(id)!;
    await record.promise;
    return { record, ...child };
  };
  return { manager, children, spawn, ...observed };
}

/** Park a child on one open item, as a job it started would. */
const withJob =
  (label = "CI") =>
  (child: Child) =>
    void child.stub.openItems.push(openItem(label));

describe("an agent that ends its run with open work", () => {
  it("goes idle and waiting instead of done, and reports nothing to its spawner", async () => {
    const h = harness();
    const { record } = await h.spawn(withJob("CI"));
    expect(record.status).toBe("idle");
    expect(record.outcome).toBe("completed");
    expect(record.waitingOn).toEqual(["CI"]);
    expect(h.waiting).toHaveBeenCalledTimes(1);
    // No completion: the spawner's item stays open until the agent is done.
    expect(h.completed).not.toHaveBeenCalled();
    expect(h.resumed).not.toHaveBeenCalled();
  });

  it("is done once the same run ends with nothing open", async () => {
    const h = harness();
    const { record } = await h.spawn();
    expect(record.waitingOn).toEqual([]);
    expect(h.waiting).not.toHaveBeenCalled();
    expect(h.completed).toHaveBeenCalledTimes(1);
  });

  it("names everything it waits on, oldest first", async () => {
    const h = harness();
    const { record } = await h.spawn((child) => {
      child.stub.openItems.push(openItem("CI"), openItem("Fix parser (general-purpose agent a1)"));
    });
    expect(record.waitingOn).toEqual(["CI", "Fix parser (general-purpose agent a1)"]);
  });

  it("is not waiting while it runs or while a run is queued for it", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    child.params.work!.wake();
    expect(child.record.status).not.toBe("idle");
    expect(child.record.waitingOn).toEqual([]);
    await child.record.promise;
  });

  it("is told, for every session it asks for, how to reach its work host", async () => {
    const h = harness();
    const child = await h.spawn();
    expect(child.params.work).toEqual({
      wake: expect.any(Function),
      changed: expect.any(Function),
    });
  });
});

describe("waking a waiting agent", () => {
  it("runs it once through the manager when its work reports back, and then it is done", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    // The host's job: the item completed and its message is in the transcript.
    child.stub.openItems.length = 0;
    child.params.work!.wake();
    expect(child.record.status).toBe("running");
    await child.record.promise;
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledTimes(1);
    expect(child.stub.resumeTurnLoop.mock.calls[0][0]).toBe(WORK_WAKE_PROMPT);
    expect(child.record.status).toBe("idle");
    expect(child.record.waitingOn).toEqual([]);
    expect(h.queued).not.toHaveBeenCalled();
    expect(h.resuming).toHaveBeenCalledTimes(1);
    expect(h.resumed).toHaveBeenCalledTimes(1);
    expect(h.waiting).toHaveBeenCalledTimes(1);
  });

  it("goes back to waiting when the run that answers one item leaves another open", async () => {
    const h = harness();
    const child = await h.spawn((c) => c.stub.openItems.push(openItem("CI"), openItem("review")));
    child.stub.openItems.shift();
    child.params.work!.wake();
    await child.record.promise;
    expect(child.record.waitingOn).toEqual(["review"]);
    expect(h.waiting).toHaveBeenCalledTimes(2);
    expect(h.resumed).not.toHaveBeenCalled();
    child.stub.openItems.length = 0;
    child.params.work!.wake();
    await child.record.promise;
    expect(h.resumed).toHaveBeenCalledTimes(1);
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledTimes(2);
  });

  it("queues the wake behind the agents that hold the slots, in order", async () => {
    const h = harness(1);
    const first = await h.spawn(withJob("one"), "first");
    const second = await h.spawn(withJob("two"), "second");
    // A third agent takes the only slot and holds it.
    const blocker = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    const busyId = h.manager.spawn(STUB_SNAPSHOT, "general-purpose", "busy", {
      description: "busy",
    });
    h.children.get(busyId)!.stub.runTurnLoop.mockReturnValue(blocker.promise);
    await tick();
    const busy = h.manager.getRecord(busyId)!;
    expect(busy.status).toBe("running");

    for (const child of [second, first]) {
      child.stub.openItems.length = 0;
      child.params.work!.wake();
    }
    // Neither bypasses the limiter: both are queued, nothing ran, and each shows as queued.
    expect(first.record.status).toBe("queued");
    expect(second.record.status).toBe("queued");
    expect(h.queued).toHaveBeenCalledTimes(2);
    expect(first.stub.resumeTurnLoop).not.toHaveBeenCalled();
    expect(second.stub.resumeTurnLoop).not.toHaveBeenCalled();

    const order: string[] = [];
    first.stub.resumeTurnLoop.mockImplementation(async () => {
      order.push("first");
      return turnLoopResult();
    });
    second.stub.resumeTurnLoop.mockImplementation(async () => {
      order.push("second");
      return turnLoopResult();
    });
    blocker.resolve(turnLoopResult());
    await Promise.all([first.record.promise, second.record.promise]);
    // First come, first served: the one that was woken first runs first.
    expect(order).toEqual(["second", "first"]);
    expect(h.resumed).toHaveBeenCalledTimes(2);
  });

  it("starts one run for several wakes while it waits for its slot", async () => {
    const h = harness(1);
    const child = await h.spawn(withJob());
    const blocker = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    const busyId = h.manager.spawn(STUB_SNAPSHOT, "general-purpose", "busy", {
      description: "busy",
    });
    h.children.get(busyId)!.stub.runTurnLoop.mockReturnValue(blocker.promise);
    await tick();
    child.stub.openItems.length = 0;
    child.params.work!.wake();
    child.params.work!.wake();
    child.params.work!.wake();
    blocker.resolve(turnLoopResult());
    await child.record.promise;
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledTimes(1);
  });

  it("folds a message from its parent into the run its work asked for", async () => {
    const h = harness(1);
    const child = await h.spawn(withJob());
    const blocker = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    const busyId = h.manager.spawn(STUB_SNAPSHOT, "general-purpose", "busy", {
      description: "busy",
    });
    h.children.get(busyId)!.stub.runTurnLoop.mockReturnValue(blocker.promise);
    await tick();
    child.stub.openItems.length = 0;
    child.params.work!.wake();
    expect(child.record.status).toBe("queued");
    const sent = await h.manager.send(child.record.id, "Review the failing check first");
    expect(sent.kind).toBe("joined");
    blocker.resolve(turnLoopResult());
    await child.record.promise;
    const prompt = child.stub.resumeTurnLoop.mock.calls[0][0] as string;
    expect(prompt).toContain(WORK_WAKE_PROMPT);
    expect(prompt).toContain("Review the failing check first");
  });

  it("takes a message from its parent while it waits, as any idle agent does", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    const sent = await h.manager.send(child.record.id, "Skip the watch and report now");
    expect(sent.kind).toBe("started");
    await child.record.promise;
    expect(child.stub.resumeTurnLoop.mock.calls[0][0]).toBe("Skip the watch and report now");
    // Its work is still open, so it is back to waiting and has not reported.
    expect(child.record.waitingOn).toEqual(["CI"]);
    expect(h.resumed).not.toHaveBeenCalled();
  });

  it("answers a message that reaches it as its run ends, in a run of its own right after", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    const run = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    child.stub.resumeTurnLoop.mockReturnValueOnce(run.promise);
    await h.manager.send(child.record.id, "Look again");
    expect(child.record.status).toBe("running");
    // The host found the session settled while the agent's run was still winding down: it asks
    // for a run, and the agent has none to give yet.
    child.stub.openItems.length = 0;
    child.params.work!.wake();
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledTimes(1);
    run.resolve(turnLoopResult());
    await tick();
    await child.record.promise;
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledTimes(2);
    expect(child.stub.resumeTurnLoop.mock.calls[1][0]).toBe(WORK_WAKE_PROMPT);
    expect(child.record.status).toBe("idle");
    expect(h.resumed).toHaveBeenCalled();
  });

  it("gives its answer a fresh turn budget under the spawn's ceiling, like any resume", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    child.stub.openItems.length = 0;
    child.params.work!.wake();
    await child.record.promise;
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledWith(
      WORK_WAKE_PROMPT,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("when the work it waits on changes without a message", () => {
  it("is done when its last item goes away, and reports then", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    expect(h.completed).not.toHaveBeenCalled();
    child.stub.openItems.length = 0; // the item was cancelled: no message, no wake
    child.params.work!.changed();
    expect(h.completed).toHaveBeenCalledTimes(1);
    expect(child.record.waitingOn).toEqual([]);
    // Reported once: a later change does nothing.
    child.params.work!.changed();
    expect(h.completed).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting, and says on what, while something is left", async () => {
    const h = harness();
    const child = await h.spawn((c) => c.stub.openItems.push(openItem("CI"), openItem("review")));
    child.stub.openItems.shift();
    child.params.work!.changed();
    expect(child.record.waitingOn).toEqual(["review"]);
    expect(h.waiting).toHaveBeenCalledTimes(2);
    expect(h.completed).not.toHaveBeenCalled();
  });

  it("ignores changes while it runs: the run decides when it ends", async () => {
    const h = harness();
    const child = await h.spawn();
    child.params.work!.changed();
    expect(h.waiting).not.toHaveBeenCalled();
    expect(h.completed).toHaveBeenCalledTimes(1);
  });
});

describe("a run that does not complete", () => {
  it("does not wait after the turn budget ran out: it is done, and lets go of its work", async () => {
    const h = harness();
    const child = await h.spawn((c) => {
      c.stub.openItems.push(openItem("CI"));
      c.stub.runTurnLoop.mockResolvedValue(
        turnLoopResult({ turnBudget: { phase: "exhausted", used: 2, maxTurns: 2 } }),
      );
    });
    expect(child.record.outcome).toBe("turn-limit");
    expect(h.waiting).not.toHaveBeenCalled();
    expect(h.completed).toHaveBeenCalledTimes(1);
    await tick();
    expect(child.stub.dispose).toHaveBeenCalledTimes(1);
    // Not a stop: the items stay open, so a reopened agent hears its work was lost.
    expect(child.stub.cancelWork).not.toHaveBeenCalled();
    expect(child.stub.openItems).toHaveLength(1);
  });

  it("lets go of its work when the run failed, and keeps the session when nothing was open", async () => {
    const h = harness();
    const failed = await h.spawn((c) => {
      c.stub.openItems.push(openItem("CI"));
      c.stub.runTurnLoop.mockRejectedValue(new Error("boom"));
    });
    await tick();
    expect(failed.record.outcome).toBe("error");
    expect(h.waiting).not.toHaveBeenCalled();
    expect(failed.stub.dispose).toHaveBeenCalledTimes(1);
    expect(failed.stub.cancelWork).not.toHaveBeenCalled();
    expect(failed.stub.openItems).toHaveLength(1);

    const clean = await h.spawn((c) => c.stub.runTurnLoop.mockRejectedValue(new Error("boom")));
    await tick();
    expect(clean.record.outcome).toBe("error");
    expect(clean.stub.dispose).not.toHaveBeenCalled();
  });

  it("reports a question now, as it always has, whatever else it waits on", async () => {
    const h = harness();
    const child = await h.spawn((c) => {
      c.stub.openItems.push(openItem("CI"));
      c.stub.runTurnLoop.mockImplementation(async () => {
        c.params.askParent!("Which branch?");
        return turnLoopResult();
      });
    });
    // Step 10 reworks how a question reaches the parent. Until then it is the completion's
    // business, and holding it back until the work ran out would leave the parent unaware.
    expect(h.completed).toHaveBeenCalledTimes(1);
    expect(h.waiting).not.toHaveBeenCalled();
    expect(child.record.pendingQuestion).toBe("Which branch?");
    // The work is not abandoned: its session stays, and its completion still wakes the agent.
    expect(child.stub.dispose).not.toHaveBeenCalled();
    expect(child.record.hasOpenWork()).toBe(true);
  });
});

describe("stopping a waiting agent", () => {
  it("stops it, reports it stopped, and releases its session so the work stops with it", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    expect(h.manager.abort(child.record.id)).toBe(true);
    expect(child.record.status).toBe("idle");
    expect(child.record.outcome).toBe("stopped");
    expect(child.record.waitingOn).toEqual([]);
    expect(h.completed).toHaveBeenCalledTimes(1);
    await tick();
    expect(child.stub.dispose).toHaveBeenCalledTimes(1);
    // A stop calls off the work it waited on: its items are cancelled, not left open to be
    // reported lost if the agent is ever reopened.
    expect(child.stub.cancelWork).toHaveBeenCalledTimes(1);
    expect(child.stub.openItems).toEqual([]);
    // A late message finds no session to wake: nothing runs.
    child.params.work!.wake();
    await tick();
    expect(child.stub.resumeTurnLoop).not.toHaveBeenCalled();
    // Stopping twice is a no-op.
    expect(h.manager.abort(child.record.id)).toBe(false);
  });

  it("stops a run that was queued for its work too", async () => {
    const h = harness(1);
    const child = await h.spawn(withJob());
    const blocker = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    const busyId = h.manager.spawn(STUB_SNAPSHOT, "general-purpose", "busy", {
      description: "busy",
    });
    h.children.get(busyId)!.stub.runTurnLoop.mockReturnValue(blocker.promise);
    await tick();
    child.params.work!.wake();
    expect(child.record.status).toBe("queued");
    expect(h.manager.abort(child.record.id)).toBe(true);
    blocker.resolve(turnLoopResult());
    await child.record.promise;
    await tick();
    expect(child.record.outcome).toBe("stopped");
    expect(child.stub.resumeTurnLoop).not.toHaveBeenCalled();
    expect(child.stub.dispose).toHaveBeenCalledTimes(1);
    expect(child.stub.openItems).toEqual([]);
  });

  it("stops one that is running again for its work, and lets go of what it still holds", async () => {
    const h = harness();
    const child = await h.spawn((c) => c.stub.openItems.push(openItem("CI"), openItem("review")));
    const run = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    child.stub.resumeTurnLoop.mockReturnValueOnce(run.promise);
    child.stub.openItems.shift();
    child.params.work!.wake();
    expect(child.record.status).toBe("running");
    expect(h.manager.abort(child.record.id)).toBe(true);
    run.resolve(turnLoopResult());
    await child.record.promise;
    await tick();
    expect(child.record.outcome).toBe("stopped");
    expect(child.stub.dispose).toHaveBeenCalledTimes(1);
    expect(child.stub.cancelWork).toHaveBeenCalled();
    expect(child.stub.openItems).toEqual([]);
  });

  it("stops an agent that reported a question while work stayed open, without reporting twice", async () => {
    const h = harness();
    const child = await h.spawn((c) => {
      c.stub.openItems.push(openItem("CI"));
      c.stub.runTurnLoop.mockImplementation(async () => {
        c.params.askParent!("Which branch?");
        return turnLoopResult();
      });
    });
    expect(h.completed).toHaveBeenCalledTimes(1);
    expect(h.manager.abort(child.record.id)).toBe(true);
    expect(child.record.outcome).toBe("stopped");
    expect(h.completed).toHaveBeenCalledTimes(1);
    await tick();
    expect(child.stub.dispose).toHaveBeenCalledTimes(1);
  });

  it("is stopped with everything else when the spawner is interrupted", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    expect(h.manager.abortAll()).toBe(1);
    expect(child.record.outcome).toBe("stopped");
  });
});

describe("retention", () => {
  it("never releases the session of an agent with open work, however long it waits", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const child = await h.spawn(withJob());
      child.record.markConsumed();
      await vi.advanceTimersByTimeAsync(13 * 60 * 60 * 1000);
      expect(child.stub.dispose).not.toHaveBeenCalled();
      expect(child.record.isSessionReady()).toBe(true);
      expect(child.record.waitingOn).toEqual(["CI"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases it once the work is gone and the window has passed", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const child = await h.spawn(withJob());
      child.record.markConsumed();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(child.stub.dispose).not.toHaveBeenCalled();
      child.stub.openItems.length = 0;
      child.params.work!.changed();
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(child.stub.dispose).toHaveBeenCalledTimes(1);
      expect(child.record.isSessionReady()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clearing the records of finished agents", () => {
  it("leaves a waiting agent alone: it reports when its work is done, or when it is stopped", async () => {
    const h = harness();
    const waiting = await h.spawn(withJob());
    const done = await h.spawn();
    await h.manager.clearCompleted();
    expect(h.manager.getRecord(waiting.record.id)).toBe(waiting.record);
    expect(waiting.stub.dispose).not.toHaveBeenCalled();
    expect(h.manager.getRecord(done.record.id)).toBeUndefined();
    // It still ends as any live agent does: its work reports back, and it is done.
    waiting.stub.openItems.length = 0;
    waiting.params.work!.wake();
    await waiting.record.promise;
    expect(h.resumed).toHaveBeenCalledTimes(1);
    // Done, it is cleared like the rest.
    await h.manager.clearCompleted();
    expect(h.manager.getRecord(waiting.record.id)).toBeUndefined();
  });
});

describe("an agent being torn down", () => {
  it("starts no run for a message that arrives while its manager disposes it", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    const teardown = child.record.disposeSession();
    child.stub.openItems.length = 0;
    child.params.work!.wake();
    await teardown;
    await tick();
    expect(child.stub.resumeTurnLoop).not.toHaveBeenCalled();
    expect(child.record.status).toBe("idle");
  });

  it("starts none through the manager's own dispose either", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    const disposing = h.manager.dispose();
    child.params.work!.wake();
    await disposing;
    expect(child.stub.resumeTurnLoop).not.toHaveBeenCalled();
  });
});

describe("an agent that finishes without a run", () => {
  it("is stamped finished when its work ran out, not when its last run settled", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const h = harness();
      const child = await h.spawn(withJob());
      const parkedAt = child.record.completedAt;
      expect(parkedAt).toBe(10_000);
      vi.setSystemTime(70_000);
      child.stub.openItems.length = 0; // cancelled: no message, no run
      child.params.work!.changed();
      expect(child.record.completedAt).toBe(70_000);
      // The completion message reads the whole assignment's duration, and retention starts here.
      const reported = h.completed.mock.calls[0][0] as typeof child.record;
      expect(reported.completedAt! - reported.startedAt).toBeGreaterThanOrEqual(60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
