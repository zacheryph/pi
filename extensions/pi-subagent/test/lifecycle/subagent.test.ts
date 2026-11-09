import { describe, expect, it, vi } from "vitest";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import {
  Subagent,
  type SubagentExecution,
  type SubagentLifecycleObserver,
} from "#src/lifecycle/subagent";
import {
  SubagentSession,
  type TurnLoopOptions,
  type TurnLoopResult,
} from "#src/lifecycle/subagent-session";
import { SubagentState, type SubagentStateInit } from "#src/lifecycle/subagent-state";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import type { RunConfig } from "#src/runtime";
import type { CompactionInfo, SubagentType } from "#src/types";
import { makeModel } from "#test/helpers/make-model";
import { createTestSubagent, makeStubExecution } from "#test/helpers/make-subagent";
import {
  createMockSession,
  createSubagentSessionStub,
  emitResumeUsageAndCompaction,
  toAgentSession,
  toSubagentSession,
} from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createChildLifecycleMock } from "#test/helpers/subagent-session-io";
import { turnLoopResult } from "#test/helpers/turn-loop-result";

const WARNED: TurnBudget = { maxTurns: 5, used: 3, phase: "warned" };
const EXHAUSTED: TurnBudget = { maxTurns: 5, used: 5, phase: "exhausted" };

type SessionFactory = (params: CreateSubagentSessionParams) => Promise<SubagentSession>;

/** Build a factory plus the SubagentSession stub it resolves to. */
function createFactory(): {
  factory: SessionFactory;
  stub: ReturnType<typeof createSubagentSessionStub>;
} {
  const stub = createSubagentSessionStub();
  const factory = vi.fn(async (_params: CreateSubagentSessionParams) => toSubagentSession(stub));
  return { factory, stub };
}

/** A factory resolving to a default (done) SubagentSession stub. */
function defaultFactory(): SessionFactory {
  return createFactory().factory;
}

interface MakeSubagentOptions extends SubagentStateInit {
  id?: string;
  type?: SubagentType;
  description?: string;
  execution?: SubagentExecution;
  /**
   * A caller-owned SubagentState, for tests that mutate it after construction to
   * observe the record delegating live. Wins over the flat state overrides.
   */
  state?: SubagentState;
}

/** Construct a Subagent with default identity and a stub execution, overridable per test. */
function makeSubagent(overrides: MakeSubagentOptions = {}): Subagent {
  const { id, type, description, execution, state, ...stateOverrides } = overrides;
  return new Subagent({
    id: id ?? "1",
    type: type ?? "general-purpose",
    description: description ?? "test",
    execution: execution ?? makeStubExecution(),
    state:
      state ??
      (Object.keys(stateOverrides).length > 0 ? new SubagentState(stateOverrides) : undefined),
  });
}

/** A Subagent wired to a ready session whose messages hold a single user "hi". */
function makeReadySubagent(): { agent: Subagent } {
  const agent = makeSubagent();
  const session = createMockSession();
  session.messages.push({ role: "user", content: "hi" });
  const stub = createSubagentSessionStub(session);
  agent.subagentSession = toSubagentSession(stub);
  return { agent };
}

describe("Subagent — constructor", () => {
  it("sets required fields from init", () => {
    const record = makeSubagent({
      id: "abc-123",
      type: "explore",
      description: "Find stale TODOs",
    });
    expect(record.id).toBe("abc-123");
    expect(record.type).toBe("explore");
    expect(record.description).toBe("Find stale TODOs");
  });

  it("starts with a fresh abort controller and zeroed stats", () => {
    const record = makeSubagent();
    expect(record.abortController).toBeInstanceOf(AbortController);
    // Stats always start at zero — set via mutation methods after construction
    expect(record.toolUses).toBe(0);
    expect(record.compactionCount).toBe(0);
    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
  });

  it("defaults to a fresh queued state when none is supplied", () => {
    const record = makeSubagent();
    expect(record.status).toBe("queued");
    expect(record.result).toBeUndefined();
    expect(record.error).toBeUndefined();
    expect(record.completedAt).toBeUndefined();
    expect(record.promise).toBeUndefined();
    expect(record.subagentSession).toBeUndefined();
  });

  it("always creates its own AbortController", () => {
    const record = makeSubagent();
    expect(record.abortController).toBeInstanceOf(AbortController);
    expect(record.abortController.signal.aborted).toBe(false);
  });

  it("toolCallId reflects execution.parentSession.toolCallId", () => {
    const record = makeSubagent({
      execution: makeStubExecution({ parentSession: { toolCallId: "tc-42" } }),
    });
    expect(record.toolCallId).toBe("tc-42");
  });

  it("toolCallId is undefined when parentSession.toolCallId is absent", () => {
    const record = makeSubagent({
      execution: makeStubExecution({ parentSession: { parentSessionFile: "/sessions/p.jsonl" } }),
    });
    expect(record.toolCallId).toBeUndefined();
  });

  it("toolCallId is undefined when parentSession is absent", () => {
    const record = makeSubagent();
    expect(record.toolCallId).toBeUndefined();
  });
});

describe("convenience getters", () => {
  describe("live-activity getters", () => {
    it("activeTools defaults to an empty map (delegates to SubagentState)", () => {
      const record = makeSubagent();
      expect(record.activeTools.size).toBe(0);
    });

    it("responseText defaults to empty string (delegates to SubagentState)", () => {
      const record = makeSubagent();
      expect(record.responseText).toBe("");
    });

    it("turnBudget reflects state mutations via setTurnBudget", () => {
      const state = new SubagentState();
      const record = makeSubagent({ state });
      state.setTurnBudget({ maxTurns: 10, used: 2, phase: "within" });
      expect(record.turnBudget).toEqual({ maxTurns: 10, used: 2, phase: "within" });
    });

    it("activeTools reflects state mutations via addActiveTool", () => {
      const state = new SubagentState();
      const record = makeSubagent({ state });
      state.addActiveTool("Read");
      expect(record.activeTools.size).toBe(1);
      expect([...record.activeTools.values()]).toContain("Read");
    });

    it("responseText reflects state mutations via appendResponseText", () => {
      const state = new SubagentState();
      const record = makeSubagent({ state });
      state.appendResponseText("Hello");
      expect(record.responseText).toBe("Hello");
    });
  });

  describe("consumption getters", () => {
    it("consumed defaults to false and consumedAt undefined (delegates to SubagentState)", () => {
      const record = makeSubagent();
      expect(record.consumed).toBe(false);
      expect(record.consumedAt).toBeUndefined();
    });

    it("markConsumed delegates to SubagentState", () => {
      const state = new SubagentState({ status: "completed" });
      const record = makeSubagent({ state });
      record.markConsumed(5000);
      expect(record.consumed).toBe(true);
      expect(record.consumedAt).toBe(5000);
      expect(state.consumedAt).toBe(5000);
    });
  });

  describe("outputFile", () => {
    it("returns undefined when subagentSession is not set", () => {
      const record = makeSubagent();
      expect(record.outputFile).toBeUndefined();
    });

    it("returns outputFile from subagentSession when set", () => {
      const record = makeSubagent();
      record.subagentSession = toSubagentSession(
        createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl"),
      );
      expect(record.outputFile).toBe("/path/to/session.jsonl");
    });

    it("returns undefined when subagentSession is set but outputFile is undefined", () => {
      const record = makeSubagent();
      record.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession()));
      expect(record.outputFile).toBeUndefined();
    });
  });
});

describe("Subagent — session-encapsulation methods", () => {
  describe("isSessionReady", () => {
    it("returns false when no subagentSession", () => {
      const agent = makeSubagent();
      expect(agent.isSessionReady()).toBe(false);
    });

    it("returns true when subagentSession is set", () => {
      const agent = makeSubagent();
      agent.subagentSession = toSubagentSession(createSubagentSessionStub());
      expect(agent.isSessionReady()).toBe(true);
    });
  });

  describe("steer", () => {
    it("rejects with the observed status when the agent is not running", async () => {
      const agent = makeSubagent({ status: "completed", result: "done" });
      const stub = createSubagentSessionStub();
      agent.subagentSession = toSubagentSession(stub);
      const outcome = await agent.steer("hello");
      expect(outcome).toEqual({ kind: "rejected", status: "completed" });
      expect(stub.steer).not.toHaveBeenCalled();
      expect(agent.pendingSteerCount).toBe(0);
    });

    it("buffers the message and returns a buffered outcome when the session is not ready", async () => {
      const agent = makeSubagent({ status: "running" });
      const outcome = await agent.steer("hello");
      expect(outcome).toEqual({ kind: "buffered" });
      expect(agent.pendingSteerCount).toBe(1);
    });

    it("delivers to the session and returns a delivered outcome when the session is ready", async () => {
      const agent = makeSubagent({ status: "running" });
      const stub = createSubagentSessionStub();
      agent.subagentSession = toSubagentSession(stub);
      const outcome = await agent.steer("go faster");
      expect(outcome).toEqual({ kind: "delivered" });
      expect(stub.steer).toHaveBeenCalledWith("go faster");
      expect(agent.pendingSteerCount).toBe(0);
    });
  });

  describe("getConversation", () => {
    it("returns undefined when no session", () => {
      const agent = makeSubagent();
      expect(agent.getConversation()).toBeUndefined();
    });

    it("delegates to SubagentSession.getConversation when session is ready", () => {
      const agent = makeSubagent();
      const stub = createSubagentSessionStub();
      stub.getConversation.mockReturnValue("[User]: hi");
      agent.subagentSession = toSubagentSession(stub);
      expect(agent.getConversation()).toBe("[User]: hi");
    });
  });

  describe("getContextPercent", () => {
    it("returns null when no session", () => {
      const agent = makeSubagent();
      expect(agent.getContextPercent()).toBeNull();
    });

    it("delegates to SubagentSession.getContextPercent when session is ready", () => {
      const agent = makeSubagent();
      const stub = createSubagentSessionStub();
      stub.getContextPercent.mockReturnValue(55);
      agent.subagentSession = toSubagentSession(stub);
      expect(agent.getContextPercent()).toBe(55);
    });
  });

  describe("subscribeToUpdates", () => {
    it("returns undefined when no session", () => {
      const agent = makeSubagent();
      expect(agent.subscribeToUpdates(vi.fn())).toBeUndefined();
    });

    it("delegates to SubagentSession.subscribe when session is ready", () => {
      const agent = makeSubagent();
      const stub = createSubagentSessionStub();
      agent.subagentSession = toSubagentSession(stub);
      const fn = vi.fn();
      const unsub = agent.subscribeToUpdates(fn);
      expect(stub.subscribe).toHaveBeenCalledWith(fn);
      expect(typeof unsub).toBe("function");
    });
  });

  describe("agentMessages", () => {
    it("returns empty array when no session", () => {
      const agent = makeSubagent();
      expect(agent.agentMessages).toEqual([]);
    });

    it("delegates to SubagentSession.agentMessages when session is ready", () => {
      const { agent } = makeReadySubagent();
      expect(agent.agentMessages).toEqual([{ role: "user", content: "hi" }]);
    });
  });

  describe("getToolDefinition", () => {
    it("returns undefined when no session", () => {
      const agent = makeSubagent();
      expect(agent.getToolDefinition("read")).toBeUndefined();
    });

    it("delegates to SubagentSession.getToolDefinition when session is ready", () => {
      const agent = makeSubagent();
      const def = { name: "read" };
      const session = createMockSession({ getToolDefinition: vi.fn(() => def) });
      const stub = createSubagentSessionStub(session);
      agent.subagentSession = toSubagentSession(stub);
      expect(agent.getToolDefinition("read")).toBe(def);
    });
  });
});

describe("Subagent — steer buffer", () => {
  it("starts with an empty steer buffer", () => {
    const record = makeSubagent();
    expect(record.pendingSteerCount).toBe(0);
  });
});

describe("Subagent — abort", () => {
  it("fires the AbortController, marks stopped, and returns true when running", () => {
    const record = makeSubagent({ status: "running" });
    expect(record.abort()).toBe(true);
    expect(record.abortController.signal.aborted).toBe(true);
    expect(record.status).toBe("stopped");
  });

  it("marks stopped and returns true even without an AbortController", () => {
    const record = makeSubagent({ status: "running" });
    expect(record.abort()).toBe(true);
    expect(record.status).toBe("stopped");
  });

  it("returns false when already stopped", () => {
    const record = makeSubagent({ status: "stopped" });
    expect(record.abort()).toBe(false);
  });

  it("returns false when completed", () => {
    const record = makeSubagent({ status: "completed" });
    expect(record.abort()).toBe(false);
  });
});

/** Run an agent whose turn loop returns `result`, or rejects with an error. */
async function runTo(
  result: TurnLoopResult | Error,
  observer?: SubagentLifecycleObserver,
): Promise<Subagent> {
  const { factory, stub } = createFactory();
  if (result instanceof Error) stub.runTurnLoop.mockRejectedValue(result);
  else stub.runTurnLoop.mockResolvedValue(result);
  const agent = createRunnableAgent({ createSubagentSession: factory, observer });
  await agent.run();
  return agent;
}

describe("Subagent.run() — terminal transitions", () => {
  it("transitions to completed for a normal result", async () => {
    const record = await runTo(turnLoopResult());
    expect(record.status).toBe("completed");
    expect(record.result).toBe("done");
  });

  it("transitions to aborted, a terminal error, when the harness exhausted the turn budget", async () => {
    const record = await runTo(turnLoopResult({ turnBudget: EXHAUSTED }));
    expect(record.status).toBe("aborted");
    expect(record.isTerminalError()).toBe(true);
  });

  it("transitions to completed, not a terminal error, when the run wrapped up at its turn limit", async () => {
    const record = await runTo(turnLoopResult({ turnBudget: WARNED }));
    expect(record.status).toBe("completed");
    expect(record.isTerminalError()).toBe(false);
  });

  it("fires observer.onRunFinished once on completion and on failure", async () => {
    for (const result of [turnLoopResult(), new Error("boom")]) {
      const onRunFinished = vi.fn();
      const record = await runTo(result, { onRunFinished });
      expect(onRunFinished).toHaveBeenCalledExactlyOnceWith(record);
    }
  });
});

describe("Subagent — abort while queued", () => {
  it("transitions to stopped and records that the agent never started", () => {
    const record = makeSubagent({ status: "queued" });
    expect(record.abort()).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.stoppedWhileQueued).toBe(true);
  });

  it("fires observer.onRunFinished once, like every other terminal transition", () => {
    const onRunFinished = vi.fn();
    const record = makeSubagent({
      status: "queued",
      execution: makeStubExecution({ observer: { onRunFinished } }),
    });
    record.abort();
    expect(onRunFinished).toHaveBeenCalledExactlyOnceWith(record);
  });

  it("leaves stoppedWhileQueued false for a running agent aborted mid-run", () => {
    const record = makeSubagent({ status: "running" });
    expect(record.abort()).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.stoppedWhileQueued).toBe(false);
  });
});

describe("Subagent — disposeSession", () => {
  it("disposes the wrapped SubagentSession", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub();
    record.subagentSession = toSubagentSession(stub);
    await record.disposeSession();
    expect(stub.dispose).toHaveBeenCalledOnce();
  });

  it("resolves only after the child's teardown settles", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub();
    const teardown = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    stub.dispose = vi.fn((): Promise<void> => teardown.promise);
    record.subagentSession = toSubagentSession(stub);

    let settled = false;
    const pending = record.disposeSession().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    teardown.resolve();
    await pending;
    expect(settled).toBe(true);
  });

  it("swallows a failing teardown so the caller's cleanup continues", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub();
    stub.dispose = vi.fn((): Promise<void> => Promise.reject(new Error("teardown failed")));
    record.subagentSession = toSubagentSession(stub);
    await expect(record.disposeSession()).resolves.toBeUndefined();
  });

  it("is a no-op when no session was created", async () => {
    const record = makeSubagent();
    await expect(record.disposeSession()).resolves.toBeUndefined();
  });
});

describe("Subagent — releaseSession", () => {
  it("disposes the wrapped session and clears it (isSessionReady false)", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl");
    record.subagentSession = toSubagentSession(stub);
    await record.releaseSession();
    expect(stub.dispose).toHaveBeenCalledOnce();
    expect(record.isSessionReady()).toBe(false);
  });

  it("captures outputFile so the getter still resolves it after release", async () => {
    const record = makeSubagent();
    record.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl"),
    );
    await record.releaseSession();
    expect(record.outputFile).toBe("/path/to/session.jsonl");
  });

  it("marks the record released, distinct from never having had a session", async () => {
    const record = makeSubagent();
    expect(record.resumeRefusal).toBe("no-session");
    record.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl"),
    );
    await record.releaseSession();
    expect(record.resumeRefusal).toBe("session-released");
  });

  it("clears the session before awaiting teardown, so a racing sweep releases once", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl");
    const teardown = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    stub.dispose = vi.fn((): Promise<void> => teardown.promise);
    record.subagentSession = toSubagentSession(stub);

    const first = record.releaseSession();
    expect(record.isSessionReady()).toBe(false);
    const second = record.releaseSession();

    teardown.resolve();
    await Promise.all([first, second]);
    expect(stub.dispose).toHaveBeenCalledOnce();
  });

  it("is a no-op on a second release — does not re-dispose, keeps the captured outputFile", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl");
    record.subagentSession = toSubagentSession(stub);
    await record.releaseSession();
    await record.releaseSession();
    expect(stub.dispose).toHaveBeenCalledOnce();
    expect(record.outputFile).toBe("/path/to/session.jsonl");
  });

  it("disposeSession after release is a no-op (session already cleared)", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl");
    record.subagentSession = toSubagentSession(stub);
    await record.releaseSession();
    await record.disposeSession();
    expect(stub.dispose).toHaveBeenCalledOnce();
  });

  it("swallows a failing teardown but still marks the session released", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl");
    stub.dispose = vi.fn((): Promise<void> => Promise.reject(new Error("teardown failed")));
    record.subagentSession = toSubagentSession(stub);
    await expect(record.releaseSession()).resolves.toBeUndefined();
    expect(record.resumeRefusal).toBe("session-released");
  });

  it("is a no-op when no session was created", async () => {
    const record = makeSubagent();
    await expect(record.releaseSession()).resolves.toBeUndefined();
    expect(record.resumeRefusal).toBe("no-session");
  });
});

describe("Subagent — model and thinking level", () => {
  const sonnet = { provider: "anthropic", id: "claude-sonnet-5" };

  function withLiveSession(execution?: SubagentExecution) {
    const record = makeSubagent({ execution });
    const session = createMockSession();
    session.model = sonnet;
    session.thinkingLevel = "high";
    record.subagentSession = toSubagentSession(
      createSubagentSessionStub(session, "/path/to/session.jsonl"),
    );
    return { record, session };
  }

  describe("from the live session", () => {
    it("reports the model the child is running, over the spawn override", () => {
      const { record } = withLiveSession(
        makeStubExecution({ model: makeModel({ provider: "openai", id: "gpt-6" }) }),
      );
      expect(record.model).toBe(sonnet);
    });

    it("follows a model the child switches to mid-run", () => {
      const { record, session } = withLiveSession();
      const fallback = { provider: "openai", id: "gpt-6" };
      session.model = fallback;
      expect(record.model).toBe(fallback);
    });

    it("reports the child's thinking level, over the spawn override", () => {
      const { record } = withLiveSession(makeStubExecution({ thinkingLevel: "low" }));
      expect(record.thinkingLevel).toBe("high");
    });
  });

  describe("after the session is released", () => {
    it("retains the model the child last ran", async () => {
      const { record } = withLiveSession();
      await record.releaseSession();
      expect(record.model).toBe(sonnet);
    });

    it("retains the child's last thinking level", async () => {
      const { record } = withLiveSession();
      await record.releaseSession();
      expect(record.thinkingLevel).toBe("high");
    });
  });

  describe("before a session exists", () => {
    it("reports the spawn override", () => {
      const opus = makeModel({ provider: "anthropic", id: "claude-opus-5" });
      const record = makeSubagent({
        execution: makeStubExecution({ model: opus, thinkingLevel: "medium" }),
      });
      expect(record.model).toBe(opus);
      expect(record.thinkingLevel).toBe("medium");
    });

    it("reports nothing for an inherited model and level", () => {
      const record = makeSubagent();
      expect(record.model).toBeUndefined();
      expect(record.thinkingLevel).toBeUndefined();
    });
  });
});

// ── Agent.run() ──────────────────────────────────────────────────────────────

/** Create a complete Agent ready for run(). */
function createRunnableAgent(overrides?: {
  createSubagentSession?: SessionFactory;
  observer?: SubagentLifecycleObserver;
  getRunConfig?: () => RunConfig;
  parentSession?: { toolCallId?: string; parentSessionFile?: string; parentSessionId?: string };
  signal?: AbortSignal;
  cwd?: string;
  maxTurns?: number;
}) {
  const createSubagentSession = overrides?.createSubagentSession ?? defaultFactory();
  const observer = overrides?.observer ?? {};
  return makeSubagent({
    id: "run-1",
    description: "run test",
    execution: {
      createSubagentSession,
      observer,
      snapshot: STUB_SNAPSHOT,
      prompt: "do something",
      getRunConfig: overrides?.getRunConfig,
      parentSession: overrides?.parentSession,
      signal: overrides?.signal,
      ...(overrides?.maxTurns !== undefined ? { maxTurns: overrides.maxTurns } : {}),
      ...(overrides?.cwd ? { cwd: overrides.cwd } : {}),
    },
  });
}

describe("Subagent.run() — happy path", () => {
  it("transitions through running → completed", async () => {
    const agent = createRunnableAgent();
    await agent.run();
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("done");
  });

  it("fires observer callbacks in order: onStarted → onSessionCreated → onRunFinished", async () => {
    const callOrder: string[] = [];
    const observer: SubagentLifecycleObserver = {
      onStarted: () => callOrder.push("started"),
      onSessionCreated: () => callOrder.push("sessionCreated"),
      onRunFinished: () => callOrder.push("runFinished"),
    };
    const agent = createRunnableAgent({ observer });
    await agent.run();
    expect(callOrder).toEqual(["started", "sessionCreated", "runFinished"]);
  });

  it("sets the subagentSession with a session", async () => {
    const agent = createRunnableAgent();
    await agent.run();
    expect(agent.subagentSession).toBeDefined();
    expect(agent.subagentSession!.session).toBeDefined();
  });

  it("flushes pending steers when session is created", async () => {
    // A steer arriving while the agent is running but the session is not yet
    // ready buffers; run() flushes it once the session is created.
    const { stub } = createFactory();
    const created = Promise.withResolvers<SubagentSession>();
    const agent = createRunnableAgent({ createSubagentSession: () => created.promise });
    const run = agent.run();
    void agent.steer("hurry up");
    expect(agent.pendingSteerCount).toBe(1);
    created.resolve(toSubagentSession(stub));
    await run;
    expect(agent.pendingSteerCount).toBe(0);
    expect(stub.steer).toHaveBeenCalledWith("hurry up");
  });
});

describe("Subagent.run() — caller-chosen cwd", () => {
  it("runs the child in the caller's directory", async () => {
    const { factory } = createFactory();
    const agent = createRunnableAgent({ createSubagentSession: factory, cwd: "/worktrees/feat-x" });
    await agent.run();
    const params = (factory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(params.cwd).toBe("/worktrees/feat-x");
    expect(agent.resumeRefusal).toBeUndefined();
  });
});

describe("Subagent — recorded run settings", () => {
  it("reports the turn ceiling the spawn asked for", () => {
    expect(createRunnableAgent({ maxTurns: 9 }).maxTurns).toBe(9);
    expect(createRunnableAgent().maxTurns).toBeUndefined();
  });

  it("knows a caller-chosen directory before the run starts", () => {
    expect(createRunnableAgent({ cwd: "/worktrees/feat-x" }).cwd).toBe("/worktrees/feat-x");
  });

  it("falls back to the parent's directory when the caller chose none", () => {
    expect(createRunnableAgent().cwd).toBe(STUB_SNAPSHOT.cwd);
  });
});

describe("Subagent — resumeRefusal", () => {
  it("refuses nothing for an agent whose session is live", async () => {
    const agent = createRunnableAgent();
    await agent.run();
    expect(agent.resumeRefusal).toBeUndefined();
  });

  it("reports no-session for an agent that never got one", () => {
    expect(makeSubagent().resumeRefusal).toBe("no-session");
  });

  it("reports still-running for a live run whose session is ready", () => {
    expect(createTestSubagent({ status: "running", sessionReady: true }).resumeRefusal).toBe(
      "still-running",
    );
  });

  it("prefers the live run over the missing session it has not created yet", () => {
    expect(createTestSubagent({ status: "running" }).resumeRefusal).toBe("still-running");
  });

  it("leaves a queued agent reporting no-session, which is what it has", () => {
    expect(createTestSubagent({ status: "queued" }).resumeRefusal).toBe("no-session");
  });

  it("reports session-released once the retention sweep has freed the session", async () => {
    const agent = createRunnableAgent();
    await agent.run();
    await agent.releaseSession();
    expect(agent.resumeRefusal).toBe("session-released");
  });

  it("leaves a session-ready test fixture resumable", () => {
    expect(createTestSubagent({ sessionReady: true }).resumeRefusal).toBeUndefined();
  });
});

describe("Subagent.run() — error handling", () => {
  it("transitions to error when the turn loop throws", async () => {
    const { factory, stub } = createFactory();
    stub.runTurnLoop.mockRejectedValue(new Error("turn loop exploded"));
    const agent = createRunnableAgent({ createSubagentSession: factory });
    await agent.run();
    expect(agent.status).toBe("error");
    expect(agent.error).toBe("turn loop exploded");
  });

  it("transitions to error when the factory throws", async () => {
    const factory: SessionFactory = vi.fn().mockRejectedValue(new Error("creation failed"));
    const agent = createRunnableAgent({ createSubagentSession: factory });
    await agent.run();
    expect(agent.status).toBe("error");
    expect(agent.error).toBe("creation failed");
  });
});

describe("Subagent.run() — abort signal forwarding", () => {
  it("wires parent signal so aborting it stops the agent", async () => {
    const parentController = new AbortController();
    const { factory, stub } = createFactory();
    stub.runTurnLoop.mockImplementation(() => {
      parentController.abort();
      return Promise.reject(new Error("aborted"));
    });
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      signal: parentController.signal,
    });
    await agent.run();
    expect(agent.abortController.signal.aborted).toBe(true);
  });
});

describe("Subagent.run() — live turn budget", () => {
  it("shows the budget the turn loop reports while the run is still going", async () => {
    const { factory, stub } = createFactory();
    const gate = Promise.withResolvers<TurnLoopResult>();
    stub.runTurnLoop.mockImplementation((_prompt: string, opts: TurnLoopOptions) => {
      opts.onTurnBudget?.(WARNED);
      return gate.promise;
    });
    const agent = createRunnableAgent({ createSubagentSession: factory });
    const run = agent.run();
    await vi.waitFor(() => expect(stub.runTurnLoop).toHaveBeenCalled());
    expect(agent.status).toBe("running");
    expect(agent.turnBudget).toEqual(WARNED);
    gate.resolve(turnLoopResult({ turnBudget: WARNED }));
    await run;
    expect(agent.turnBudget).toEqual(WARNED);
  });
});

describe("Subagent.run() — RunConfig threading", () => {
  it("passes defaultMaxTurns and wrapUpTurns to runTurnLoop", async () => {
    const { factory, stub } = createFactory();
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      getRunConfig: () => ({ defaultMaxTurns: 10, wrapUpTurns: 3, midRunUpdates: true }),
    });
    await agent.run();
    const turnOpts = stub.runTurnLoop.mock.calls[0][1];
    expect(turnOpts.defaultMaxTurns).toBe(10);
    expect(turnOpts.wrapUpTurns).toBe(3);
  });
});

// ── The child-to-parent channel ────────────────────────────────────────────────

/** A session factory that keeps its Mock type, so tests can read the params it received. */
function createSpyFactory() {
  const stub = createSubagentSessionStub();
  const factory = vi.fn(async (_params: CreateSubagentSessionParams) => toSubagentSession(stub));
  return { factory, stub };
}

describe("Subagent — the mid-run update channel", () => {
  const updatesOn = { defaultMaxTurns: undefined, wrapUpTurns: 5, midRunUpdates: true };

  it("gives a child a way to send its parent an update", async () => {
    const { factory } = createSpyFactory();
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      getRunConfig: () => updatesOn,
    });

    await agent.run();

    expect(factory.mock.calls[0][0].notifyParent).toBeTypeOf("function");
  });

  it("reports a child's update to the lifecycle observer", async () => {
    const { factory } = createSpyFactory();
    const onUpdateSent = vi.fn<(agent: Subagent, message: string) => void>();
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      observer: { onUpdateSent },
      getRunConfig: () => updatesOn,
    });
    await agent.run();

    factory.mock.calls[0][0].notifyParent?.("The bug is in the retry wrapper.");

    expect(onUpdateSent).toHaveBeenCalledWith(agent, "The bug is in the retry wrapper.");
  });

  describe("recording what the child sent", () => {
    it("records the update for the completion message", async () => {
      const { factory } = createSpyFactory();
      const agent = createRunnableAgent({
        createSubagentSession: factory,
        getRunConfig: () => updatesOn,
      });
      await agent.run();

      factory.mock.calls[0][0].notifyParent?.("The bug is in the retry wrapper.");

      // The announcement channel is what decides to announce, and it marks what
      // it delivers. Until then the run owes the message to the completion message.
      expect(agent.runUpdates).toEqual(["The bug is in the retry wrapper."]);
    });

    it("tells the observer, because the update is a fact about the run", async () => {
      const { factory } = createSpyFactory();
      const onUpdateSent = vi.fn<(agent: Subagent, message: string) => void>();
      const agent = createRunnableAgent({
        createSubagentSession: factory,
        observer: { onUpdateSent },
        getRunConfig: () => updatesOn,
      });
      await agent.run();

      factory.mock.calls[0][0].notifyParent?.("The bug is in the retry wrapper.");

      expect(onUpdateSent).toHaveBeenCalledWith(agent, "The bug is in the retry wrapper.");
    });

    it("keeps the channel live across a resume", async () => {
      const { factory } = createSpyFactory();
      const agent = createRunnableAgent({
        createSubagentSession: factory,
        getRunConfig: () => updatesOn,
      });
      await agent.run();
      await agent.resume("keep going");

      factory.mock.calls[0][0].notifyParent?.("The premise is wrong.");

      expect(agent.runUpdates).toEqual(["The premise is wrong."]);
    });
  });

  it("withholds the channel when the operator turned mid-run updates off", async () => {
    const { factory } = createSpyFactory();
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      getRunConfig: () => ({ ...updatesOn, midRunUpdates: false }),
    });

    await agent.run();

    expect(factory.mock.calls[0][0].notifyParent).toBeUndefined();
  });

  it("gives the child the ask-back recorder", async () => {
    const { factory } = createSpyFactory();
    const agent = createRunnableAgent({ createSubagentSession: factory });

    await agent.run();

    expect(factory.mock.calls[0][0].askParent).toBeTypeOf("function");
  });
});

// ── Subagent.start() ───────────────────────────────────────────────────────────

describe("Subagent.start() — promise encapsulation", () => {
  it("stores a run promise that resolves on completion", async () => {
    const agent = createRunnableAgent();
    agent.start();
    expect(agent.promise).toBeInstanceOf(Promise);
    await agent.promise;
    expect(agent.status).toBe("completed");
  });

  it("promise is undefined before start() is called", () => {
    const agent = createRunnableAgent();
    expect(agent.promise).toBeUndefined();
  });

  it("is a no-op when status is stopped (abort-while-queued guard)", async () => {
    const agent = makeSubagent({ status: "stopped", startedAt: 1, completedAt: 1 });
    agent.start();
    await expect(agent.promise).resolves.toBeUndefined();
    expect(agent.status).toBe("stopped");
  });

  it("is a no-op when status is completed", async () => {
    const agent = makeSubagent({
      status: "completed",
      result: "done",
      startedAt: 1,
      completedAt: 2,
    });
    agent.start();
    await expect(agent.promise).resolves.toBeUndefined();
    expect(agent.status).toBe("completed");
  });
});

describe("Subagent.scheduleVia() — eager promise capture", () => {
  it("exposes the scheduler promise before the run starts (queued-awaitable)", async () => {
    const agent = makeSubagent({ status: "queued" });
    const { promise: gate, resolve: openSlot } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    agent.scheduleVia(async (thunk) => {
      await gate;
      await thunk();
    });
    // Promise is captured at schedule time — before the slot opens.
    expect(agent.promise).toBeInstanceOf(Promise);
    expect(agent.status).toBe("queued");
    openSlot();
    await agent.promise;
    expect(agent.status).toBe("completed");
  });

  it("runs guardedRun as the thunk — abort-while-queued is a no-op", async () => {
    const agent = makeSubagent({ status: "queued" });
    let thunkRan = false;
    // Abort before the slot opens, then fire the thunk.
    agent.abort();
    agent.scheduleVia(async (thunk) => {
      thunkRan = true;
      await thunk();
    });
    await agent.promise;
    expect(thunkRan).toBe(true);
    expect(agent.status).toBe("stopped");
  });
});

// ── Agent.resume() ─────────────────────────────────────────────────────────────

/** Create an Agent with a SubagentSession already attached, ready for resume(). */
function createResumableAgent(overrides?: {
  observer?: SubagentLifecycleObserver;
  session?: ReturnType<typeof createMockSession>;
  stub?: ReturnType<typeof createSubagentSessionStub>;
}) {
  const session = overrides?.session ?? createMockSession();
  const stub = overrides?.stub ?? createSubagentSessionStub(session);
  const agent = makeSubagent({
    id: "resume-1",
    description: "resume test",
    execution: makeStubExecution({ observer: overrides?.observer ?? {} }),
    status: "completed",
    result: "first",
  });
  agent.subagentSession = toSubagentSession(stub);
  return { agent, session, stub };
}

/**
 * Run an agent whose turn loop calls `ask_parent`, the way a real child does:
 * through the recorder the assembly factory installed on its session.
 *
 * Returns the recorder too, so a resumed run can ask again on the same session.
 */
async function runAsking(
  opts: Partial<TurnLoopResult> & { responseText: string; question?: string },
) {
  const stub = createSubagentSessionStub();
  let askParent: ((question: string) => void) | undefined;
  const agent = makeSubagent({
    execution: makeStubExecution({
      createSubagentSession: async (params: CreateSubagentSessionParams) => {
        askParent = params.askParent;
        return toSubagentSession(stub);
      },
    }),
  });
  stub.runTurnLoop.mockImplementation(() => {
    if (opts.question !== undefined) askParent?.(opts.question);
    const { question: _question, ...result } = opts;
    return Promise.resolve(turnLoopResult(result));
  });
  await agent.run();
  return { agent, stub, ask: (question: string) => askParent?.(question) };
}

describe("Subagent — ask-back", () => {
  it("hands the session factory a recorder for the child's question", async () => {
    const { factory } = createSpyFactory();
    const agent = createRunnableAgent({ createSubagentSession: factory });

    await agent.run();

    expect(factory.mock.calls[0][0].askParent).toBeTypeOf("function");
  });

  it("keeps only the last question when the child asks twice", async () => {
    const { factory } = createSpyFactory();
    const agent = createRunnableAgent({ createSubagentSession: factory });
    await agent.run();
    const ask = factory.mock.calls[0][0].askParent;

    ask?.("first");
    ask?.("second");

    expect(agent.pendingQuestion).toBe("second");
  });

  it("drops a recorded question when the run fails, so no carrier invites a resume", async () => {
    const { factory, stub } = createSpyFactory();
    stub.runTurnLoop.mockImplementation(() => {
      factory.mock.calls[0][0].askParent?.("Which config wins?");
      return Promise.reject(new Error("boom"));
    });
    const agent = createRunnableAgent({ createSubagentSession: factory });

    await agent.run();

    expect(agent.status).toBe("error");
    expect(agent.pendingQuestion).toBeUndefined();
  });

  it("drops a recorded question when a resumed run fails", async () => {
    const { factory, stub } = createSpyFactory();
    const agent = createRunnableAgent({ createSubagentSession: factory });
    await agent.run();
    stub.resumeTurnLoop.mockImplementation(() => {
      factory.mock.calls[0][0].askParent?.("Which config wins?");
      return Promise.reject(new Error("boom"));
    });

    await agent.resume("continue");

    expect(agent.status).toBe("error");
    expect(agent.pendingQuestion).toBeUndefined();
  });

  it("records a declared question and leaves the result body untouched", async () => {
    const { agent } = await runAsking({
      responseText: "I mapped the configs.",
      question: "Which one is authoritative?",
    });

    expect(agent.pendingQuestion).toBe("Which one is authoritative?");
    // The question never entered the body, so every carrier renders it once,
    // as the affordance.
    expect(agent.result).toBe("I mapped the configs.");
  });

  it("leaves pendingQuestion undefined when the child asked nothing", async () => {
    const { agent } = await runAsking({ responseText: "All done." });

    expect(agent.pendingQuestion).toBeUndefined();
    expect(agent.result).toBe("All done.");
  });

  it("records a question an aborted run declared before it ran out of turns", async () => {
    const { agent } = await runAsking({
      responseText: "",
      question: "Still stuck on which?",
      turnBudget: EXHAUSTED,
    });

    expect(agent.status).toBe("aborted");
    expect(agent.pendingQuestion).toBe("Still stuck on which?");
  });

  it("completes the round trip: ask, answer by resuming, continue", async () => {
    const { agent, stub } = await runAsking({ responseText: "", question: "Which config?" });
    stub.resumeTurnLoop.mockResolvedValue(
      turnLoopResult({ responseText: "Used the project config. Done." }),
    );
    expect(agent.pendingQuestion).toBe("Which config?");

    await agent.resume("The project one.");

    expect(stub.resumeTurnLoop).toHaveBeenCalledWith(
      "The project one.",
      expect.objectContaining({ signal: agent.abortController.signal }),
    );
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("Used the project config. Done.");
    // The question was answered, so it no longer stands.
    expect(agent.pendingQuestion).toBeUndefined();
  });

  it("records a follow-up question a resumed run declares", async () => {
    const { agent, stub, ask } = await runAsking({ responseText: "", question: "Which config?" });
    stub.resumeTurnLoop.mockImplementation(() => {
      ask("And the fallback?");
      return Promise.resolve(turnLoopResult({ responseText: "Thanks." }));
    });

    await agent.resume("The project one.");

    expect(agent.pendingQuestion).toBe("And the fallback?");
    expect(agent.result).toBe("Thanks.");
  });
});

describe("Subagent.resume() — happy path", () => {
  it("transitions to completed and sets result from the resume response", async () => {
    const { agent } = createResumableAgent();
    await agent.resume("continue");
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("resumed");
  });

  it("hands resumeTurnLoop the record's own signal, not the caller's", async () => {
    const { agent, stub } = createResumableAgent();
    const callerSignal = new AbortController().signal;
    await agent.resume("continue", callerSignal);
    expect(stub.resumeTurnLoop).toHaveBeenCalledOnce();
    expect(stub.resumeTurnLoop.mock.calls[0][0]).toBe("continue");
    // The caller's signal is wired through abort(); the loop runs under the
    // record's own lever, so abort(id) reaches it too.
    expect(stub.resumeTurnLoop.mock.calls[0][1].signal).toBe(agent.abortController.signal);
    expect(stub.resumeTurnLoop.mock.calls[0][1].signal).not.toBe(callerSignal);
  });

  it("resets transition state before resuming", async () => {
    const { agent } = createResumableAgent();
    await agent.resume("continue");
    expect(agent.error).toBeUndefined();
  });
});

describe("Subagent.resume() — turn budget", () => {
  it("shows the budget the resumed turn loop reports while the resume is going", async () => {
    const { agent, stub } = createResumableAgent();
    const fresh: TurnBudget = { maxTurns: 5, used: 0, phase: "within" };
    const gate = Promise.withResolvers<TurnLoopResult>();
    stub.resumeTurnLoop.mockImplementation(
      (_prompt: string, { onTurnBudget }: { onTurnBudget?: (budget: TurnBudget) => void }) => {
        onTurnBudget?.(fresh);
        return gate.promise;
      },
    );
    const resumed = agent.resume("continue");
    await vi.waitFor(() => expect(stub.resumeTurnLoop).toHaveBeenCalled());
    expect(agent.turnBudget).toEqual(fresh);
    gate.resolve(turnLoopResult({ turnBudget: fresh }));
    await resumed;
  });

  it("ends aborted, and notifies the observer, when the resume exhausts its budget", async () => {
    const onResumeFinished = vi.fn();
    const { agent, stub } = createResumableAgent({ observer: { onResumeFinished } });
    stub.resumeTurnLoop.mockResolvedValue(
      turnLoopResult({ responseText: "partial", turnBudget: EXHAUSTED }),
    );
    await agent.resume("continue");
    expect(agent.status).toBe("aborted");
    expect(agent.result).toBe("partial");
    expect(onResumeFinished).toHaveBeenCalledOnce();
  });
});

describe("Subagent.resume() — cancellation", () => {
  /**
   * Park the resumed turn loop until its signal fires, recording what it was
   * handed and whether that signal was already spent on arrival.
   */
  function parkResumeUntilSignalled(stub: ReturnType<typeof createSubagentSessionStub>) {
    const gate = Promise.withResolvers<TurnLoopResult>();
    const loop: { signal?: AbortSignal; abortedAtEntry?: boolean; signalled: boolean } = {
      signalled: false,
    };
    stub.resumeTurnLoop.mockImplementation(
      (_prompt: string, { signal }: { signal?: AbortSignal }) => {
        loop.signal = signal;
        loop.abortedAtEntry = signal?.aborted;
        signal?.addEventListener("abort", () => {
          loop.signalled = true;
          gate.resolve(turnLoopResult({ responseText: "partial answer" }));
        });
        return gate.promise;
      },
    );
    return loop;
  }

  it("aborting the record signals the resumed turn loop", async () => {
    const { agent, stub } = createResumableAgent();
    const loop = parkResumeUntilSignalled(stub);

    const resumed = agent.resume("continue");
    expect(agent.abort()).toBe(true);
    await resumed;

    expect(loop.abortedAtEntry).toBe(false);
    expect(loop.signalled).toBe(true);
    expect(agent.status).toBe("stopped");
  });

  it("a caller signal cancels through the record, which reads stopped", async () => {
    const { agent, stub } = createResumableAgent();
    const loop = parkResumeUntilSignalled(stub);
    const caller = new AbortController();

    const resumed = agent.resume("continue", caller.signal);
    caller.abort();
    await resumed;

    expect(loop.signalled).toBe(true);
    expect(agent.status).toBe("stopped");
  });

  it("gives a resume that follows an aborted run a lever that is not already spent", async () => {
    const { agent, stub } = createResumableAgent();
    const parked = parkResumeUntilSignalled(stub);
    const first = agent.resume("start");
    agent.abort();
    await first;
    expect(parked.signalled).toBe(true);
    const spent = agent.abortController;
    expect(spent.signal.aborted).toBe(true);
    const loop = parkResumeUntilSignalled(stub);

    const resumed = agent.resume("continue");
    expect(agent.abort()).toBe(true);
    await resumed;

    expect(loop.signal).not.toBe(spent.signal);
    expect(loop.abortedAtEntry).toBe(false);
    expect(loop.signalled).toBe(true);
  });
});

describe("Subagent.resume() — observer lifecycle", () => {
  it("accumulates usage and compactions from session events during resume", async () => {
    const session = createMockSession();
    const stub = createSubagentSessionStub(session);
    stub.resumeTurnLoop.mockImplementation(async () => {
      emitResumeUsageAndCompaction(session);
      return turnLoopResult({ responseText: "second" });
    });
    const { agent } = createResumableAgent({ session, stub });
    await agent.resume("more");
    expect(agent.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(agent.compactionCount).toBe(1);
  });

  it("forwards compaction events through observer.onCompacted", async () => {
    const session = createMockSession();
    const seen: Array<{ reason: string; tokensBefore: number }> = [];
    const observer: SubagentLifecycleObserver = {
      onCompacted: (_agent: Subagent, info: CompactionInfo) =>
        seen.push({ reason: info.reason, tokensBefore: info.tokensBefore }),
    };
    const stub = createSubagentSessionStub(session);
    stub.resumeTurnLoop.mockImplementation(async () => {
      session.emit({
        type: "compaction_end",
        aborted: false,
        result: { tokensBefore: 123 },
        reason: "threshold",
      });
      return turnLoopResult({ responseText: "second" });
    });
    const { agent } = createResumableAgent({ observer, session, stub });
    await agent.resume("more");
    expect(seen).toEqual([{ reason: "threshold", tokensBefore: 123 }]);
  });

  it("releases the observer subscription after resume completes", async () => {
    const session = createMockSession();
    const { agent } = createResumableAgent({ session });
    await agent.resume("more");
    // Events emitted after resume must not accumulate — subscription released.
    session.emit({ type: "tool_execution_end" });
    expect(agent.toolUses).toBe(0);
  });

  it("fires observer.onResumeStarted once the resumed run is under way", async () => {
    const seen: Array<{ status: string; completedAt: number | undefined }> = [];
    const onResumeStarted = (agent: Subagent) =>
      seen.push({ status: agent.status, completedAt: agent.completedAt });
    const { agent } = createResumableAgent({ observer: { onResumeStarted } });

    await agent.resume("continue");

    // After the rewind, not before it: a subscriber reading the record must see
    // the run that just started, not the outcome of the one it replaced.
    expect(seen).toEqual([{ status: "running", completedAt: undefined }]);
    expect(agent.status).toBe("completed");
  });

  it("fires observer.onResumeStarted even when the resumed run fails", async () => {
    const onResumeStarted = vi.fn();
    const stub = createSubagentSessionStub();
    stub.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
    const { agent } = createResumableAgent({ observer: { onResumeStarted }, stub });

    await agent.resume("continue");

    expect(onResumeStarted).toHaveBeenCalledExactlyOnceWith(agent);
  });

  it("fires observer.onResumeFinished once the resume completes", async () => {
    const onResumeFinished = vi.fn();
    const { agent } = createResumableAgent({ observer: { onResumeFinished } });
    await agent.resume("continue");
    expect(onResumeFinished).toHaveBeenCalledExactlyOnceWith(agent);
    expect(agent.status).toBe("completed");
  });

  it("fires observer.onResumeFinished when the resume errors", async () => {
    const onResumeFinished = vi.fn();
    const stub = createSubagentSessionStub();
    stub.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
    const { agent } = createResumableAgent({ observer: { onResumeFinished }, stub });
    await agent.resume("continue");
    expect(onResumeFinished).toHaveBeenCalledExactlyOnceWith(agent);
    expect(agent.status).toBe("error");
  });
});

// Every other rejection test here stubs runTurnLoop with a vi.fn, so it pins
// how a throw is routed but nothing about what produces one. These wire a real
// SubagentSession over a mock AgentSession so the provider-error read and the
// failRun routing are exercised as one path (#889).
describe("Subagent — provider failures reach the record", () => {
  /**
   * Settle a turn the way the SDK does: append the assistant message to agent
   * state and emit the `message_end` the session's listeners see.
   *
   * `usage` is mandatory rather than decorative — `subscribeSubagentObserver`,
   * which a real Subagent wires over this session, reads `message.usage.input`
   * unguarded. `Agent.handleRunFailure` gives its synthetic failure message
   * `EMPTY_USAGE`, which is what these zeros model.
   */
  function settleWith(
    session: ReturnType<typeof createMockSession>,
    message: Record<string, unknown>,
  ): void {
    session.messages.push(message);
    session.emit({
      type: "message_end",
      message: { usage: { input: 0, output: 0, cacheWrite: 0 }, ...message },
    });
  }

  /** A factory resolving to a real SubagentSession over the given mock session. */
  function realSessionFactory(session: ReturnType<typeof createMockSession>): SessionFactory {
    return vi.fn(
      async (_params: CreateSubagentSessionParams) =>
        new SubagentSession(toAgentSession(session), {
          outputFile: "/sessions/child.jsonl",
          sessionId: "child-1",
          sessionDir: "/sessions",
          agentName: "explore",
          agentMaxTurns: undefined,
          parentContext: undefined,
          lifecycle: createChildLifecycleMock(),
        }),
    );
  }

  it("lands the provider's error on the record instead of a successful empty result", async () => {
    const session = createMockSession();
    session.prompt = vi.fn(async () => {
      settleWith(session, {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "429 rate limit exceeded",
      });
    });
    const agent = createRunnableAgent({ createSubagentSession: realSessionFactory(session) });

    await agent.run();

    expect(agent.status).toBe("error");
    expect(agent.error).toBe("429 rate limit exceeded");
    expect(agent.result).toBeUndefined();
  });

  it("completes normally when the provider did not error", async () => {
    const session = createMockSession();
    session.prompt = vi.fn(async () => {
      settleWith(session, {
        role: "assistant",
        content: [{ type: "text", text: "the answer" }],
        stopReason: "stop",
      });
    });
    const agent = createRunnableAgent({ createSubagentSession: realSessionFactory(session) });

    await agent.run();

    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("the answer");
    expect(agent.error).toBeUndefined();
  });

  // Pi's overflow recovery removes the failed assistant message from agent state
  // before attempting compaction and restores nothing when that attempt fails, so
  // the record must be driven by what the session emitted, not by what survived
  // in its history (#898).
  it("lands the provider's error even when overflow recovery stripped the errored turn", async () => {
    const session = createMockSession();
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "work from an earlier turn" }],
      stopReason: "stop",
    });
    session.prompt = vi.fn(async () => {
      session.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "error",
          errorMessage: "prompt is too long: 210000 tokens > 200000 maximum",
          usage: { input: 0, output: 0, cacheWrite: 0 },
        },
      });
    });
    const agent = createRunnableAgent({ createSubagentSession: realSessionFactory(session) });

    await agent.run();

    expect(agent.status).toBe("error");
    expect(agent.error).toBe("prompt is too long: 210000 tokens > 200000 maximum");
    expect(agent.result).toBeUndefined();
  });

  // The resume half of the same path: a run that succeeded, then a resume whose
  // provider errored. Without the resumeTurnLoop read the record would be marked
  // completed carrying "the first answer" — the previous turn's work, presented
  // as the answer to the resume prompt.
  it("lands a resume's provider error on the record instead of the prior answer", async () => {
    const session = createMockSession();
    session.prompt = vi
      .fn(async () => {
        settleWith(session, {
          role: "assistant",
          content: [{ type: "text", text: "the first answer" }],
          stopReason: "stop",
        });
      })
      .mockImplementationOnce(async () => {
        settleWith(session, {
          role: "assistant",
          content: [{ type: "text", text: "the first answer" }],
          stopReason: "stop",
        });
      })
      .mockImplementationOnce(async () => {
        settleWith(session, {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "error",
          errorMessage: "503 upstream unavailable",
        });
      });
    const agent = createRunnableAgent({ createSubagentSession: realSessionFactory(session) });

    await agent.run();
    expect(agent.status).toBe("completed");

    await agent.resume("and now the other half");

    expect(agent.status).toBe("error");
    expect(agent.error).toBe("503 upstream unavailable");
    expect(agent.result).toBeUndefined();
  });
});

describe("Subagent.resume() — error handling", () => {
  it("transitions to error without throwing when resumeTurnLoop rejects", async () => {
    const stub = createSubagentSessionStub();
    stub.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
    const { agent } = createResumableAgent({ stub });
    await agent.resume("more");
    expect(agent.status).toBe("error");
    expect(agent.error).toBe("resume exploded");
  });

  it("releases the observer subscription after resume errors", async () => {
    const session = createMockSession();
    const stub = createSubagentSessionStub(session);
    stub.resumeTurnLoop.mockRejectedValue(new Error("boom"));
    const { agent } = createResumableAgent({ session, stub });
    await agent.resume("more");
    session.emit({ type: "tool_execution_end" });
    expect(agent.toolUses).toBe(0);
  });

  it("throws when no session exists", async () => {
    const agent = makeSubagent();
    await expect(agent.resume("more")).rejects.toThrow(/missing session/);
  });
});

describe("Subagent.resume() — awaitable handle", () => {
  it("republishes the promise getter for the in-flight resume", async () => {
    const { agent, stub } = createResumableAgent();
    agent.start();
    const firstRun = agent.promise;
    await firstRun;
    const { promise: resuming, resolve: finishResume } = Promise.withResolvers<TurnLoopResult>();
    stub.resumeTurnLoop.mockReturnValue(resuming);

    const returned = agent.resume("continue");

    // The getter must track the live resume, not the settled first-run handle.
    expect(agent.promise).not.toBe(firstRun);
    expect(agent.promise).toBe(returned);

    finishResume(turnLoopResult({ responseText: "resumed late" }));
    await returned;
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("resumed late");
  });
});
