import { onTestFinished, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { turnLoopResult } from "#test/helpers/turn-loop-result";
import { waitTool } from "#src/session/wait-tool";

import { tick } from "../../../../packages/pi-test-helpers/src/wait.ts";

function harness() {
  const children = new Map<
    string,
    { params: CreateSubagentSessionParams; stub: ReturnType<typeof createSubagentSessionStub> }
  >();
  const waiting = vi.fn();
  const completed = vi.fn();
  const manager = new SubagentManager({
    registry: new AgentTypeRegistry(() => new Map()),
    limiter: new ConcurrencyLimiter(() => 1),
    createSubagentSession: async (params) => {
      const stub = createSubagentSessionStub();
      children.set(params.agentId!, { params, stub });
      return toSubagentSession(stub);
    },
    observer: {
      onSubagentCreated() {},
      onSubagentStarted() {},
      onSubagentResuming() {},
      onSubagentCompleted: completed,
      onSubagentResumed: completed,
      onSubagentCompacted() {},
      onSubagentWaiting: waiting,
    },
  });
  onTestFinished(() => manager.dispose());
  const spawn = async (
    prepare: (child: NonNullable<ReturnType<typeof children.get>>) => void = () => {},
  ) => {
    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "work", {
      description: "work",
      background: true,
    });
    // Creation is synchronous until the factory's first await; configure before prompting.
    const child = children.get(id)!;
    prepare(child);
    const record = manager.getRecord(id)!;
    await record.promise;
    return { record, ...child };
  };
  return { manager, children, spawn, waiting, completed };
}

describe("waiting workers", () => {
  it("automatically parks for background work without announcing completion, then completes after a managed wake", async () => {
    const h = harness();
    let pending = true;
    const child = await h.spawn(({ params }) =>
      params.activation!.track(() => (pending ? "CI" : undefined)),
    );
    expect(child.record.status).toBe("waiting");
    expect(child.record.waitingReason).toBe("CI");
    expect(child.record.isActive()).toBe(true);
    expect(h.waiting).toHaveBeenCalledOnce();
    expect(h.completed).not.toHaveBeenCalled();
    pending = false;
    const deliver = vi.fn();
    child.params.activation!.enqueue(deliver);
    await child.record.promise;
    expect(deliver).toHaveBeenCalledOnce();
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledOnce();
    expect(child.record.status).toBe("completed");
    expect(h.completed).toHaveBeenCalledOnce();
  });

  it("releases its slot, queues behind existing work, and merges completions with parent guidance", async () => {
    const h = harness();
    const child = await h.spawn(({ params }) => params.activation!.wait("instructions"));
    const blocker = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    const blockerId = h.manager.spawn(STUB_SNAPSHOT, "general-purpose", "busy", {
      description: "busy",
      background: true,
    });
    await tick();
    const busy = h.children.get(blockerId)!;
    // The default stub may already have settled; instead hold a managed resume in the shared limiter.
    const busyRecord = h.manager.getRecord(blockerId)!;
    await busyRecord.promise;
    busy.stub.resumeTurnLoop.mockImplementationOnce(async () => {
      busy.params.activation!.wait("hold");
      return turnLoopResult();
    });
    await h.manager.resume(blockerId, "park");
    busy.stub.resumeTurnLoop.mockImplementation(() => blocker.promise);
    await busyRecord.steer("occupy");
    await tick();
    expect(busyRecord.status).toBe("running");
    const delivered: string[] = [];
    child.params.activation!.enqueue(() => delivered.push("one"));
    child.params.activation!.enqueue(() => delivered.push("two"));
    const wake = h.manager.startResume(child.record.id, "Review the failing check first");
    expect(wake.kind).toBe("started");
    expect(child.record.status).toBe("queued");
    expect(delivered).toEqual([]);
    expect(child.stub.resumeTurnLoop).not.toHaveBeenCalled();
    blocker.resolve(turnLoopResult());
    await child.record.promise;
    expect(delivered).toEqual(["one", "two"]);
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledOnce();
    expect(child.stub.resumeTurnLoop.mock.calls[0][0]).toContain("Review the failing check first");
  });

  it("latches a completion arriving before the initial prompt returns", async () => {
    const h = harness();
    const deliver = vi.fn();
    const child = await h.spawn(({ params, stub }) => {
      stub.runTurnLoop.mockImplementation(async () => {
        params.activation!.enqueue(deliver);
        return turnLoopResult();
      });
    });
    await child.record.promise;
    expect(deliver).toHaveBeenCalledOnce();
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledOnce();
    expect(child.record.status).toBe("completed");
  });

  it("supports explicit wait without jobs and wakes through parent steering", async () => {
    const h = harness();
    const child = await h.spawn(({ params, stub }) => {
      stub.runTurnLoop.mockImplementation(async () => {
        const tool = waitTool(params.activation!);
        await tool.execute(
          "wait",
          { reason: "Need approval" },
          new AbortController().signal,
          undefined,
          {} as never,
        );
        return turnLoopResult();
      });
    });
    expect(child.record.status).toBe("waiting");
    await child.record.steer("Proceed with the change");
    await child.record.promise;
    expect(child.record.status).toBe("completed");
    expect(child.stub.resumeTurnLoop.mock.calls[0][0]).toContain("Proceed with the change");
  });

  it("stops waiting workers, disposes their resources, and rejects late completions", async () => {
    const h = harness();
    const child = await h.spawn(({ params }) => params.activation!.wait("CI"));
    expect(h.manager.abort(child.record.id)).toBe(true);
    const deliver = vi.fn();
    child.params.activation!.enqueue(deliver);
    await tick();
    expect(child.record.status).toBe("stopped");
    expect(child.stub.dispose).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(child.stub.resumeTurnLoop).not.toHaveBeenCalled();
  });

  it("does not park or wake after exhausting the turn budget", async () => {
    const h = harness();
    const child = await h.spawn(({ params, stub }) => {
      params.activation!.wait("CI");
      stub.runTurnLoop.mockResolvedValue(
        turnLoopResult({ turnBudget: { phase: "exhausted", used: 2, maxTurns: 2 } }),
      );
    });
    expect(child.record.status).toBe("aborted");
    child.params.activation!.enqueue(vi.fn());
    await tick();
    expect(child.stub.resumeTurnLoop).not.toHaveBeenCalled();
  });
});

it("cancels a queued activation before admission and discards its inbox", async () => {
  const h = harness();
  const child = await h.spawn(({ params }) => params.activation!.wait("guidance"));
  const deliver = vi.fn();
  child.params.activation!.enqueue(deliver);
  expect(child.record.status).toBe("queued");
  expect(h.manager.abort(child.record.id)).toBe(true);
  await child.record.promise;
  expect(child.record.status).toBe("stopped");
  expect(child.stub.dispose).toHaveBeenCalledOnce();
  expect(deliver).not.toHaveBeenCalled();
  expect(child.stub.resumeTurnLoop).not.toHaveBeenCalled();
});

it("retains waiting sessions past completed-session retention and clearCompleted", async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    const child = await h.spawn(({ params }) => params.activation!.wait("guidance"));
    child.record.markConsumed();
    await vi.advanceTimersByTimeAsync(13 * 60 * 60 * 1000);
    await h.manager.clearCompleted();
    expect(h.manager.getRecord(child.record.id)).toBe(child.record);
    expect(child.record.status).toBe("waiting");
    expect(child.stub.dispose).not.toHaveBeenCalled();
    await h.manager.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("honors a foreground resume's cancellation while its activation is queued", async () => {
  const h = harness();
  const child = await h.spawn(({ params }) => params.activation!.wait("instructions"));
  const controller = new AbortController();
  const resumed = h.manager.startResume(child.record.id, "continue", {
    signal: controller.signal,
    claimOutcome: true,
  });
  expect(resumed.kind).toBe("started");
  controller.abort();
  await child.record.promise;
  expect(child.record.status).toBe("stopped");
  expect(child.stub.resumeTurnLoop).not.toHaveBeenCalled();
});

describe("review fixes", () => {
  it("a result wait that starts while an activation is queued reports that activation's outcome", async () => {
    const h = harness();
    const child = await h.spawn(({ params }) => params.activation!.wait("CI"));
    child.stub.resumeTurnLoop.mockResolvedValueOnce(turnLoopResult({ responseText: "final" }));
    child.params.activation!.enqueue(() => {});
    expect(child.record.status).toBe("queued");
    const wait = await child.record.waitUntilSettled(new AbortController().signal);
    expect(wait).toEqual({ kind: "settled" });
    expect(child.record.status).toBe("completed");
    expect(child.record.result).toBe("final");
  });

  it("a result wait follows an activation that parks and queues another", async () => {
    const h = harness();
    const child = await h.spawn(({ params }) => params.activation!.wait("CI"));
    const second = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    // The first activation parks again on a new completion; the second one finishes.
    child.stub.resumeTurnLoop.mockImplementationOnce(async () => {
      child.params.activation!.enqueue(() => {});
      return turnLoopResult({ responseText: "between" });
    });
    child.stub.resumeTurnLoop.mockReturnValueOnce(second.promise);
    child.params.activation!.enqueue(() => {});
    let outcome: unknown;
    const wait = child.record.waitUntilSettled(new AbortController().signal).then((w) => {
      outcome = w;
    });
    await tick();
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledTimes(2);
    expect(outcome).toBeUndefined();
    second.resolve(turnLoopResult({ responseText: "final" }));
    await wait;
    expect(outcome).toEqual({ kind: "settled" });
    expect(child.record.result).toBe("final");
  });

  it("a result wait on a parked agent with nothing queued returns at once", async () => {
    const h = harness();
    const child = await h.spawn(({ params }) => params.activation!.wait("guidance"));
    await expect(child.record.waitUntilSettled(new AbortController().signal)).resolves.toEqual({
      kind: "unsettled",
    });
  });

  it("keeps a failed child's session for retention when it has no pending work", async () => {
    const h = harness();
    const child = await h.spawn(({ params, stub }) => {
      params.activation!.track(() => undefined);
      stub.runTurnLoop.mockRejectedValue(new Error("boom"));
    });
    await tick();
    expect(child.record.status).toBe("error");
    expect(child.stub.dispose).not.toHaveBeenCalled();
  });

  it("releases a failed child's session when its background work is still pending", async () => {
    const h = harness();
    const child = await h.spawn(({ params, stub }) => {
      params.activation!.track(() => "CI");
      stub.runTurnLoop.mockRejectedValue(new Error("boom"));
    });
    await tick();
    expect(child.record.status).toBe("error");
    expect(child.stub.dispose).toHaveBeenCalledOnce();
  });

  it("a throwing delivery does not fail the activation or skip the others", async () => {
    const h = harness();
    const child = await h.spawn(({ params }) => params.activation!.wait("CI"));
    const later = vi.fn();
    expect(
      child.params.activation!.enqueue(() => {
        throw new Error("stale context");
      }),
    ).toBe(true);
    child.params.activation!.enqueue(later);
    await child.record.promise;
    expect(later).toHaveBeenCalledOnce();
    expect(child.record.status).toBe("completed");
  });

  it("refuses a completion once the child cannot be activated", async () => {
    const h = harness();
    const child = await h.spawn(({ params }) => params.activation!.wait("CI"));
    h.manager.abort(child.record.id);
    expect(child.params.activation!.enqueue(vi.fn())).toBe(false);
  });

  it("asks the parent a question raised while jobs run, and keeps it across job activations", async () => {
    const h = harness();
    let pending = true;
    const child = await h.spawn(({ params, stub }) => {
      params.activation!.track(() => (pending ? "CI" : undefined));
      stub.runTurnLoop.mockImplementation(async () => {
        params.askParent!("Which branch?");
        return turnLoopResult();
      });
    });
    expect(child.record.status).toBe("waiting");
    expect(child.record.guidanceRequest).toBe("Question: Which branch?");

    // A job completion activates the child; the question still stands and is not asked twice.
    child.params.activation!.enqueue(() => {});
    await child.record.promise;
    expect(child.record.status).toBe("waiting");
    expect(child.record.pendingQuestion).toBe("Which branch?");
    expect(child.record.guidanceRequest).toBeUndefined();

    // Parent guidance answers it.
    pending = false;
    await child.record.steer("Use main");
    await child.record.promise;
    expect(child.record.status).toBe("completed");
    expect(child.record.pendingQuestion).toBeUndefined();
  });
});
