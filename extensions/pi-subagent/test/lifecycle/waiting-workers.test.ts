import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import { WORK_WAKE_PROMPT } from "#src/lifecycle/run";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { createSubagentSessionStub, openItem, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { turnLoopResult } from "#test/helpers/turn-loop-result";
import { tick } from "#test-helpers";

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
    question: vi.fn(),
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
      onSubagentQuestion: observed.question,
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

/** A child that asks its parent a question while a watch is still open: the question is an item. */
const asking =
  (question = "Which branch?", extra: (child: Child) => void = () => {}) =>
  (child: Child) => {
    extra(child);
    child.stub.runTurnLoop.mockImplementation(async () => {
      // What pi-ask does in the child: open the question item, then tell the parent.
      child.stub.openItems.push(openItem("answer", "q1", "question"));
      child.params.announceQuestion!(question);
      return turnLoopResult();
    });
  };
const askingWithJob = (question?: string) => asking(question, withJob("CI"));

/** Park a child on one open item, as a job it started would. */
const withJob =
  (label = "CI") =>
  (child: Child) =>
    void child.stub.openItems.push(openItem(label));

/**
 * The agent was told, once and before its session was released, that these items were called off
 * (roadmap step 11): without it a reopened agent still believes it will be woken for them.
 */
function expectToldOnce(child: Child, labels: string[]) {
  expect(child.stub.reportCalledOff).toHaveBeenCalledTimes(1);
  expect(child.stub.reportCalledOff.mock.calls[0][0].map((item) => item.label)).toEqual(labels);
  expect(child.stub.reportCalledOff.mock.invocationCallOrder[0]).toBeLessThan(
    child.stub.dispose.mock.invocationCallOrder[0],
  );
}

/** Told once, the session still live. */
function expectToldOnceLive(child: Child, labels: string[]) {
  expect(child.stub.reportCalledOff).toHaveBeenCalledTimes(1);
  expect(child.stub.reportCalledOff.mock.calls[0][0].map((item) => item.label)).toEqual(labels);
}

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
      lost: expect.any(Function),
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
    // Rewritten by roadmap step 11 (was: the items stayed open in the transcript, so a reopened
    // agent heard its work was lost). A released session never has open work: the end of the
    // assignment calls it off first, like a stop does.
    expect(child.stub.cancelWork).toHaveBeenCalledTimes(1);
    expect(child.stub.openItems).toEqual([]);
    expectToldOnce(child, ["CI"]);
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
    // Rewritten by roadmap step 11 (was: left open to be reported lost): called off, then released.
    expect(failed.stub.cancelWork).toHaveBeenCalledTimes(1);
    expect(failed.stub.openItems).toEqual([]);
    expectToldOnce(failed, ["CI"]);

    const clean = await h.spawn((c) => c.stub.runTurnLoop.mockRejectedValue(new Error("boom")));
    await tick();
    expect(clean.record.outcome).toBe("error");
    expect(clean.stub.dispose).not.toHaveBeenCalled();
    // Nothing was open, so there is nothing to tell it.
    expect(clean.stub.reportCalledOff).not.toHaveBeenCalled();
  });
});

// Roadmap step 10: a question the child asks its parent is an item in the child's host, like a job.
describe("an agent that asks its parent a question", () => {
  it("is idle and waiting on `answer`, and the parent hears the question once", async () => {
    const h = harness();
    const child = await h.spawn(asking());
    expect(child.record.status).toBe("idle");
    expect(child.record.outcome).toBe("completed");
    expect(child.record.waitingOn).toEqual(["answer"]);
    expect(h.waiting).toHaveBeenCalledTimes(1);
    expect(h.question).toHaveBeenCalledExactlyOnceWith(child.record, "Which branch?");
    // Not done: nothing is reported to the spawner, which waits on the answer.
    expect(h.completed).not.toHaveBeenCalled();
    expect(child.stub.dispose).not.toHaveBeenCalled();
  });

  it("keeps its session however long it waits for the answer", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const child = await h.spawn(asking());
      child.record.markConsumed();
      await vi.advanceTimersByTimeAsync(13 * 60 * 60 * 1000);
      expect(child.stub.dispose).not.toHaveBeenCalled();
      expect(child.record.isSessionReady()).toBe(true);
      expect(child.record.waitingOn).toEqual(["answer"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is answered by the parent's message: the message is the run's prompt, and the question closes", async () => {
    const h = harness();
    const child = await h.spawn(asking());
    const outcome = await child.record.send("Use Postgres.");
    expect(outcome).toEqual({ kind: "started", relaunched: false });
    expect(child.stub.answerQuestions).toHaveBeenCalled();
    expect(child.stub.openItems).toEqual([]);
    await child.record.promise;
    expect(child.stub.resumeTurnLoop).toHaveBeenCalledTimes(1);
    expect(child.stub.resumeTurnLoop.mock.calls[0][0]).toBe("Use Postgres.");
    // Closing the question did not read as the end of the agent's work: one report, at the end.
    expect(h.completed).not.toHaveBeenCalled();
    expect(h.resumed).toHaveBeenCalledTimes(1);
    expect(child.record.waitingOn).toEqual([]);
  });

  it("does not report the agent done when the answer closes its last item", async () => {
    const h = harness();
    const child = await h.spawn(asking());
    const run = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    child.stub.resumeTurnLoop.mockReturnValueOnce(run.promise);
    await child.record.send("Use Postgres.");
    // The question is closed and the run is under way: the agent is running, not finished.
    expect(child.stub.openItems).toEqual([]);
    expect(child.record.status).toBe("running");
    expect(h.resumed).not.toHaveBeenCalled();
    run.resolve(turnLoopResult());
    await child.record.promise;
    expect(h.resumed).toHaveBeenCalledTimes(1);
  });

  // Decided here: a job completing wakes an agent that also waits on a question. The completion
  // is a message the agent can act on, whatever the parent has not yet answered. The wake does not
  // answer the question: it stays open (the child's own transcript shows the ask unanswered), the
  // run ends, and the agent is waiting again until every item is closed.
  it("with a job also open: the job's completion wakes it, the question stays open", async () => {
    const h = harness();
    const child = await h.spawn(askingWithJob());
    expect(child.record.waitingOn).toEqual(["CI", "answer"]);
    expect(h.question).toHaveBeenCalledTimes(1);

    // The job completes: the host removes its item, writes the message, and asks for a run.
    child.stub.openItems.splice(
      child.stub.openItems.findIndex((item) => item.label === "CI"),
      1,
    );
    child.params.work!.wake();
    expect(child.record.status).toBe("running");
    await child.record.promise;
    expect(child.stub.resumeTurnLoop.mock.calls[0][0]).toBe(WORK_WAKE_PROMPT);
    // Still waiting, now only on the answer; not done, not reported, and the parent is not told twice.
    expect(child.record.status).toBe("idle");
    expect(child.record.waitingOn).toEqual(["answer"]);
    expect(h.completed).not.toHaveBeenCalled();
    expect(h.resumed).not.toHaveBeenCalled();
    expect(h.question).toHaveBeenCalledTimes(1);
    expect(h.waiting).toHaveBeenCalledTimes(2);

    // The answer closes the question item only, and ends the wait.
    await child.record.send("Use Postgres.");
    await child.record.promise;
    expect(child.stub.resumeTurnLoop.mock.calls[1][0]).toBe("Use Postgres.");
    expect(child.record.waitingOn).toEqual([]);
    expect(h.resumed).toHaveBeenCalledTimes(1);
  });

  it("is answered by a message while a job is open: the question closes, the job stays", async () => {
    const h = harness();
    const child = await h.spawn(askingWithJob());
    const run = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    child.stub.resumeTurnLoop.mockReturnValueOnce(run.promise);
    await child.record.send("Use Postgres.");
    expect(child.stub.openItems.map((item) => item.label)).toEqual(["CI"]);
    run.resolve(turnLoopResult());
    await child.record.promise;
    // The run ended with the watch still open: the agent waits on it, and is not done.
    expect(child.record.waitingOn).toEqual(["CI"]);
    expect(h.completed).not.toHaveBeenCalled();
    expect(h.resumed).not.toHaveBeenCalled();
  });

  it("closes the question when a message joins the run that is queued for it", async () => {
    const h = harness(1);
    const child = await h.spawn(askingWithJob());
    const blocker = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    const busyId = h.manager.spawn(STUB_SNAPSHOT, "general-purpose", "busy", {
      description: "busy",
    });
    h.children.get(busyId)!.stub.runTurnLoop.mockReturnValue(blocker.promise);
    await tick();
    child.params.work!.wake();
    expect(child.record.status).toBe("queued");
    expect(await child.record.send("Use Postgres.")).toEqual({ kind: "joined" });
    expect(child.stub.openItems.map((item) => item.label)).toEqual(["CI"]);
    blocker.resolve(turnLoopResult());
    await child.record.promise;
    expect(child.stub.resumeTurnLoop.mock.calls[0][0]).toContain("Use Postgres.");
  });

  it("closes the question when the message steers the run the question was asked in", async () => {
    const h = harness();
    const blocker = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    const id = h.manager.spawn(STUB_SNAPSHOT, "general-purpose", "work", { description: "work" });
    const child = h.children.get(id)!;
    child.stub.runTurnLoop.mockReturnValue(blocker.promise);
    await tick();
    // pi-ask opened the question and told the parent; the run is still finishing its tool batch.
    child.stub.openItems.push(openItem("answer", "q1", "question"));
    const record = h.manager.getRecord(id)!;
    expect(record.status).toBe("running");
    expect(await record.send("Use Postgres.")).toEqual({ kind: "steered", delivery: "delivered" });
    expect(child.stub.steer).toHaveBeenCalledWith("Use Postgres.");
    expect(child.stub.openItems).toEqual([]);
    blocker.resolve(turnLoopResult());
    await record.promise;
    expect(record.waitingOn).toEqual([]);
    expect(h.waiting).not.toHaveBeenCalled();
  });

  it("does not keep a question open on an agent that failed: it is called off and nothing waits", async () => {
    const h = harness();
    const child = await h.spawn((c) => {
      asking()(c);
      c.stub.runTurnLoop.mockImplementation(async () => {
        c.stub.openItems.push(openItem("answer", "q1", "question"));
        c.params.announceQuestion!("Which branch?");
        throw new Error("boom");
      });
    });
    await tick();
    expect(child.record.outcome).toBe("error");
    expect(h.waiting).not.toHaveBeenCalled();
    expect(h.completed).toHaveBeenCalledTimes(1);
    // Rewritten by roadmap step 11 (was: the session was released with the question left open in
    // its transcript, for the next message to close). The failure ends the assignment: the
    // question is called off with the rest, then the session is released.
    expect(child.stub.cancelWork).toHaveBeenCalledTimes(1);
    expect(child.stub.openItems).toEqual([]);
    expect(child.stub.dispose).toHaveBeenCalledTimes(1);
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
    // It is told what was called off, so a reopened agent does not wait for it.
    expectToldOnce(child, ["CI"]);
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
    // Written once, after the stopped run unwound (a message sent mid-run would be held by Pi),
    // and before the release.
    expectToldOnce(child, ["review"]);
  });

  it("tells a stopped agent what was called off even when new input reaches it before its run unwound", async () => {
    const h = harness();
    const child = await h.spawn(withJob("CI"));
    const run = Promise.withResolvers<ReturnType<typeof turnLoopResult>>();
    child.stub.resumeTurnLoop.mockReturnValueOnce(run.promise);
    child.params.work!.wake();
    expect(h.manager.abort(child.record.id)).toBe(true);
    // Not told yet: the stopped run is still unwinding, and a message sent now would be held.
    expect(child.stub.reportCalledOff).not.toHaveBeenCalled();
    // The parent's message starts the next run on the same live session: nothing releases it,
    // so the agent is told as that run is requested.
    child.stub.resumeTurnLoop.mockResolvedValueOnce(turnLoopResult());
    await h.manager.send(child.record.id, "Carry on without CI.");
    expectToldOnceLive(child, ["CI"]);
    run.resolve(turnLoopResult());
    await child.record.promise;
    await tick();
    expect(child.stub.reportCalledOff).toHaveBeenCalledTimes(1); // once, not again at the release
  });

  // Rewritten by roadmap step 10 (was: "stops an agent that reported a question while work
  // stayed open, without reporting twice"). A question no longer reports the agent: it waits like
  // any other open item, so the stop is the one report.
  it("stops an agent waiting on a question and a job, reporting once", async () => {
    const h = harness();
    const child = await h.spawn(askingWithJob());
    expect(h.completed).not.toHaveBeenCalled();
    expect(h.manager.abort(child.record.id)).toBe(true);
    expect(child.record.outcome).toBe("stopped");
    expect(h.completed).toHaveBeenCalledTimes(1);
    await tick();
    expect(child.stub.dispose).toHaveBeenCalledTimes(1);
    // Both are called off, so a reopened agent is told nothing was lost.
    expect(child.stub.openItems).toEqual([]);
  });

  it("is stopped with everything else when the spawner is interrupted", async () => {
    const h = harness();
    const child = await h.spawn(withJob());
    expect(h.manager.abortAll()).toBe(1);
    expect(child.record.outcome).toBe("stopped");
  });
});

// Roadmap step 11: one rule for every release. A session is released only for an agent that is
// done (idle with no open work, `Subagent.isDone`), once its window has passed, and the window
// starts when the last item closed. The default windows apply: 10 minutes after the parent read
// the result with `subagent_get`, 12 hours otherwise.
describe("retention", () => {
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;

  /** Run `body` on fake timers (the sweep is the manager's own interval). */
  async function onFakeTimers(body: () => Promise<void>) {
    vi.useFakeTimers();
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  }

  /** One item of every kind a child can wait on. */
  const kinds = [
    ["a job", () => openItem("CI", "j1", "job")],
    ["a watch", () => openItem("CI", "w1", "watch")],
    [
      "an agent of its own",
      () => openItem("Fix parser (general-purpose agent a1)", "a1", "subagent"),
    ],
    ["a question", () => openItem("answer", "q1", "question")],
  ] as const;

  it("never releases the session of an agent with open work, however long it waits", async () => {
    await onFakeTimers(async () => {
      const h = harness();
      const child = await h.spawn(withJob());
      // The sweep does not even ask for a release (`releaseSession` would refuse it, too).
      const release = vi.spyOn(child.record, "releaseSession");
      await vi.advanceTimersByTimeAsync(13 * HOUR);
      expect(release).not.toHaveBeenCalled();
      expect(child.stub.dispose).not.toHaveBeenCalled();
      expect(child.record.isSessionReady()).toBe(true);
      expect(child.record.waitingOn).toEqual(["CI"]);
    });
  });

  it("keeps a waiting agent through every sweep and every clearCompleted", async () => {
    await onFakeTimers(async () => {
      const h = harness();
      const child = await h.spawn(withJob());
      const done = await h.spawn();
      for (let minute = 1; minute <= 25 * 60; minute++) {
        await vi.advanceTimersByTimeAsync(MINUTE); // one sweep a minute, for 25 hours
        if (minute % 7 === 0) await h.manager.clearCompleted();
      }
      expect(h.manager.getRecord(child.record.id)).toBe(child.record);
      expect(child.stub.dispose).not.toHaveBeenCalled();
      expect(child.record.isSessionReady()).toBe(true);
      expect(child.record.waitingOn).toEqual(["CI"]);
      // The done agent beside it was not spared: it was released at its window, then cleared.
      expect(h.manager.getRecord(done.record.id)).toBeUndefined();
      expect(done.stub.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe.each(kinds)("with %s open", (_label, makeItem) => {
    it("keeps the session however long it waits, then releases it a window after the item closes", async () => {
      await onFakeTimers(async () => {
        const h = harness();
        const child = await h.spawn((c) => c.stub.openItems.push(makeItem()));
        await vi.advanceTimersByTimeAsync(30 * HOUR); // well past the 12 hour cap
        expect(child.stub.dispose).not.toHaveBeenCalled();
        expect(child.record.isSessionReady()).toBe(true);

        // The item closes without a message (cancelled, lost): the agent is done now.
        child.stub.openItems.length = 0;
        child.params.work!.changed();
        expect(child.record.status).toBe("idle");
        expect(child.record.isDone()).toBe(true);
        // The wait does not count toward the window, which starts at this moment.
        await vi.advanceTimersByTimeAsync(2 * MINUTE);
        expect(child.stub.dispose).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(11 * HOUR);
        expect(child.stub.dispose).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2 * HOUR);
        expect(child.stub.dispose).toHaveBeenCalledTimes(1);
        expect(child.record.isSessionReady()).toBe(false);
        // Released, not forgotten: the record stays, and the agent takes a message.
        expect(h.manager.getRecord(child.record.id)).toBe(child.record);
        expect(child.record.sendRefusal).toBe("session-released");
      });
    });

    it("is released on the short window when the parent read its result once it was done", async () => {
      await onFakeTimers(async () => {
        const h = harness();
        const child = await h.spawn((c) => c.stub.openItems.push(makeItem()));
        await vi.advanceTimersByTimeAsync(5 * HOUR);
        child.stub.openItems.length = 0;
        child.params.work!.changed();
        child.record.markConsumed();
        await vi.advanceTimersByTimeAsync(9 * MINUTE);
        expect(child.stub.dispose).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3 * MINUTE);
        expect(child.stub.dispose).toHaveBeenCalledTimes(1);
      });
    });

    it("is not cleared by clearCompleted while it waits, and is once it is done", async () => {
      const h = harness();
      const child = await h.spawn((c) => c.stub.openItems.push(makeItem()));
      await h.manager.clearCompleted();
      expect(h.manager.getRecord(child.record.id)).toBe(child.record);
      expect(child.stub.dispose).not.toHaveBeenCalled();
      child.stub.openItems.length = 0;
      child.params.work!.changed();
      await h.manager.clearCompleted();
      expect(h.manager.getRecord(child.record.id)).toBeUndefined();
      expect(child.stub.dispose).toHaveBeenCalledTimes(1);
    });
  });

  it("holds the session until the last of two kinds of item closes, then for the window", async () => {
    await onFakeTimers(async () => {
      const h = harness();
      const job = openItem("CI", "j1", "job");
      const question = openItem("answer", "q1", "question");
      const child = await h.spawn((c) => c.stub.openItems.push(job, question));
      await vi.advanceTimersByTimeAsync(13 * HOUR);
      expect(child.stub.dispose).not.toHaveBeenCalled();

      // The job's gone; the question is still open, so the agent waits on it alone.
      child.stub.openItems.splice(child.stub.openItems.indexOf(job), 1);
      child.params.work!.changed();
      expect(child.record.waitingOn).toEqual(["answer"]);
      await vi.advanceTimersByTimeAsync(13 * HOUR);
      expect(child.stub.dispose).not.toHaveBeenCalled();
      await h.manager.clearCompleted();
      expect(h.manager.getRecord(child.record.id)).toBe(child.record);

      // The question closes too (the parent's answer, a stop): now the window runs.
      child.stub.openItems.length = 0;
      child.params.work!.changed();
      await vi.advanceTimersByTimeAsync(11 * HOUR);
      expect(child.stub.dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(child.stub.dispose).toHaveBeenCalledTimes(1);
    });
  });

  it("holds the session for an agent of its own and a watch open together, whichever closes last", async () => {
    await onFakeTimers(async () => {
      const h = harness();
      const watchItem = openItem("CI", "w1", "watch");
      const nested = openItem("Fix parser (general-purpose agent a1)", "a1", "subagent");
      const child = await h.spawn((c) => c.stub.openItems.push(watchItem, nested));
      child.stub.openItems.splice(child.stub.openItems.indexOf(nested), 1); // the worker finished
      child.params.work!.changed();
      await vi.advanceTimersByTimeAsync(20 * HOUR);
      expect(child.stub.dispose).not.toHaveBeenCalled();
      child.stub.openItems.length = 0; // the watch closes last
      child.params.work!.changed();
      await vi.advanceTimersByTimeAsync(13 * HOUR);
      expect(child.stub.dispose).toHaveBeenCalledTimes(1);
    });
  });

  it("does not shorten the window for a result read while the agent still waited", async () => {
    await onFakeTimers(async () => {
      const h = harness();
      const child = await h.spawn(withJob());
      // A read of a waiting agent is not a read of a finished result.
      child.record.markConsumed();
      child.stub.openItems.length = 0;
      child.params.work!.changed();
      expect(child.record.consumed).toBe(false);
      await vi.advanceTimersByTimeAsync(11 * MINUTE);
      expect(child.stub.dispose).not.toHaveBeenCalled();
    });
  });

  it("releases a done agent after its window, and keeps its record", async () => {
    await onFakeTimers(async () => {
      const h = harness();
      const child = await h.spawn();
      await vi.advanceTimersByTimeAsync(11 * HOUR);
      expect(child.record.isSessionReady()).toBe(true);
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(child.record.isSessionReady()).toBe(false);
      expect(child.record.sendRefusal).toBe("session-released");
      expect(h.manager.getRecord(child.record.id)).toBe(child.record);
    });
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
