import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import { createChildLifecycleMock } from "#test/helpers/subagent-session-io";
import { childCompletedEvent } from "#test/helpers/turn-loop-result";

// ── Session mock factory ───────────────────────────────────────────────────────

/**
 * Subscribable session stub whose `prompt()` appends a final assistant message.
 * `listeners` lets tests drive turn_end events for turn-limit assertions.
 */
function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  /** Teardown call order — the shutdown emit must precede session disposal. */
  const calls: string[] = [];
  const session = {
    messages: [] as unknown[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      // A real remover, not a no-op: `listeners` is what pins whether a
      // subscription the session owns for its whole life is actually released.
      return () => {
        const at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      };
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    sendCustomMessage: vi.fn((_message: unknown, _options?: { triggerTurn?: boolean }): Promise<void> => Promise.resolve()),
    dispose: vi.fn(() => {
      calls.push("dispose");
    }),
    hasExtensionHandlers: vi.fn((_eventType: string): boolean => true),
    extensionRunner: {
      emit: vi.fn((_event: unknown): Promise<unknown> => {
        calls.push("emit");
        return Promise.resolve(undefined);
      }),
    },
    getSessionStats: vi.fn(() => ({
      tokens: { input: 100, output: 50, cacheWrite: 10 },
      contextUsage: { percent: 42 },
    })),
    getToolDefinition: vi.fn((_name: string): unknown => undefined),
    model: undefined as { provider: string; id: string } | undefined,
    thinkingLevel: "off",
  };
  return { session, listeners, calls };
}

/** Broadcast an arbitrary session event to every subscriber of a `createSession` stub. */
function emit(listeners: Array<(e: any) => void>, event: unknown) {
  for (const l of listeners) l(event);
}

/**
 * How one turn ended, as Pi's `turn_end` reports it: the assistant message's
 * `stopReason` and how many tool results the turn produced. The default is a
 * successful turn that ran a tool, so the agent loop would continue.
 */
interface TurnSpec {
  stopReason?: string;
  toolResults?: number;
}

function emitTurnStart(listeners: Array<(e: any) => void>) {
  emit(listeners, { type: "turn_start" });
}

function emitTurnEnd(listeners: Array<(e: any) => void>, { stopReason = "toolUse", toolResults = 1 }: TurnSpec = {}) {
  emit(listeners, {
    type: "turn_end",
    message: { role: "assistant", stopReason },
    toolResults: Array.from({ length: toolResults }, () => ({ role: "toolResult" })),
  });
}

/**
 * Program session.prompt to run turns, each a `turn_start` then a `turn_end`,
 * then settle the run with a final assistant message. A number runs that many
 * default turns; an array spells out how each turn ended. The turns are the
 * meaningful input that drives the boundary each turn-limit test asserts on.
 *
 * A session abort ends the run the way Pi's does: no further turn completes.
 */
function programTurns(
  session: ReturnType<typeof createSession>["session"],
  listeners: ReturnType<typeof createSession>["listeners"],
  turns: number | TurnSpec[],
  finalText = "done",
) {
  const specs = typeof turns === "number" ? Array.from({ length: turns }, (): TurnSpec => ({})) : turns;
  session.prompt = vi.fn(async () => {
    for (const spec of specs) {
      if (session.abort.mock.calls.length > 0) break;
      emitTurnStart(listeners);
      emitTurnEnd(listeners, spec);
    }
    session.messages.push({ role: "assistant", content: [{ type: "text", text: finalText }] });
  });
}

/**
 * The assistant message Pi appends when a provider fails a turn.
 *
 * Both SDK paths produce this shape: the agent loop returns the provider's
 * errored message, and `Agent.handleRunFailure` synthesises one with empty text
 * content. Neither throws, which is what made a failed turn indistinguishable
 * from a quiet one (#889).
 */
function providerErrorMessage(errorMessage?: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

/**
 * Usage every real assistant message carries. `Agent.handleRunFailure` gives its
 * synthetic failure message `EMPTY_USAGE`, and `subscribeSubagentObserver` reads
 * `message.usage.input` unguarded, so an emitted `message_end` without this
 * field throws inside any fixture that wires a real Subagent over the session.
 */
const EMPTY_USAGE = { input: 0, output: 0, cacheWrite: 0 };

/**
 * Program session.prompt to settle the run by appending raw messages, emitting
 * the `message_end` the SDK emits for each one.
 *
 * Both halves are modelled deliberately: the event is what the session's own
 * listeners see, and the push is the agent state a later collaborator may
 * rewrite. A failure fixture that models only the state half cannot express a
 * turn whose error was stripped before the run settled (#898).
 */
function programMessages(
  session: ReturnType<typeof createSession>["session"],
  listeners: ReturnType<typeof createSession>["listeners"],
  messages: Array<Record<string, unknown>>,
) {
  session.prompt = vi.fn(async () => {
    for (const message of messages) {
      session.messages.push(message);
      emit(listeners, { type: "message_end", message: { usage: EMPTY_USAGE, ...message } });
    }
  });
}

/**
 * Program session.prompt to emit an errored `message_end` whose message never
 * reaches `session.messages`.
 *
 * This is the sequence Pi produces when a context overflow triggers recovery:
 * `_checkCompaction` removes the failed assistant message from agent state
 * before attempting compaction, and restores nothing when that attempt fails
 * (#898). The event is emitted before any of that runs.
 */
function programStrippedFailure(
  session: ReturnType<typeof createSession>["session"],
  listeners: ReturnType<typeof createSession>["listeners"],
  errorMessage: string,
) {
  session.prompt = vi.fn(async () => {
    emit(listeners, {
      type: "message_end",
      message: { usage: EMPTY_USAGE, ...providerErrorMessage(errorMessage) },
    });
  });
}

/** Build a SubagentSession around a session stub with default meta. */
function makeSubagentSession(
  session: ReturnType<typeof createSession>["session"],
  metaOverrides?: Partial<{
    outputFile: string | undefined;
    sessionId: string;
    sessionDir: string;
    agentName: string;
    agentMaxTurns: number | undefined;
    parentContext: string | undefined;
    lifecycle: ReturnType<typeof createChildLifecycleMock>;
  }>,
) {
  const lifecycle = metaOverrides?.lifecycle ?? createChildLifecycleMock();
  const hasOutputFile = metaOverrides != null && "outputFile" in metaOverrides;
  const sub = new SubagentSession(session as unknown as AgentSession, {
    outputFile: hasOutputFile ? metaOverrides.outputFile : "/sessions/child.jsonl",
    sessionId: metaOverrides?.sessionId ?? "child-session-default",
    sessionDir: metaOverrides?.sessionDir ?? "/sessions/dir",
    agentName: metaOverrides?.agentName ?? "Explore",
    agentMaxTurns: metaOverrides?.agentMaxTurns,
    parentContext: metaOverrides?.parentContext,
    lifecycle,
  });
  return { sub, lifecycle };
}

let lifecycle: ReturnType<typeof createChildLifecycleMock>;

beforeEach(() => {
  lifecycle = createChildLifecycleMock();
});

describe("SubagentSession — accessors", () => {
  it("exposes the wrapped session and outputFile", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { outputFile: "/out.jsonl" });
    expect(sub.session).toBe(session);
    expect(sub.outputFile).toBe("/out.jsonl");
  });

  it("returns undefined outputFile when none was persisted", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { outputFile: undefined });
    expect(sub.outputFile).toBeUndefined();
  });

  describe("model and thinking level", () => {
    it("reports the wrapped session's current model", () => {
      const { session } = createSession("X");
      const { sub } = makeSubagentSession(session);
      const sonnet = { provider: "anthropic", id: "claude-sonnet-5" };
      session.model = sonnet;
      expect(sub.model).toBe(sonnet);
    });

    it("follows a model the wrapped session switches to", () => {
      const { session } = createSession("X");
      const { sub } = makeSubagentSession(session);
      session.model = { provider: "anthropic", id: "claude-sonnet-5" };
      const fallback = { provider: "openai", id: "gpt-6" };
      session.model = fallback;
      expect(sub.model).toBe(fallback);
    });

    it("reports the wrapped session's current thinking level", () => {
      const { session } = createSession("X");
      const { sub } = makeSubagentSession(session);
      session.thinkingLevel = "high";
      expect(sub.thinkingLevel).toBe("high");
    });
  });
});

describe("SubagentSession — runTurnLoop response capture", () => {
  it("returns the final assistant text even when no text_delta events streamed", async () => {
    const { session } = createSession("LOCKED");
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("Say LOCKED", {});
    expect(result.responseText).toBe("LOCKED");
  });

  it("captures streamed text_delta events as the response", async () => {
    const { session, listeners } = createSession("FALLBACK");
    session.prompt = vi.fn(async () => {
      for (const l of listeners) {
        l({ type: "message_start" });
        l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
        l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
      }
    });
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("go", {});
    expect(result.responseText).toBe("hello world");
  });

  it("prepends parentContext to the prompt", async () => {
    const { session } = createSession("DONE");
    const { sub } = makeSubagentSession(session, { parentContext: "CTX\n" });
    await sub.runTurnLoop("the task", {});
    expect(session.prompt).toHaveBeenCalledWith("CTX\nthe task");
  });
});

describe("SubagentSession — runTurnLoop turn budget", () => {
  describe("ceiling", () => {
    it("stops the run after the ceiling turn when that turn ran tools", async () => {
      const { session, listeners } = createSession("done");
      programTurns(session, listeners, 5);
      const { sub } = makeSubagentSession(session);
      const result = await sub.runTurnLoop("go", { maxTurns: 3, wrapUpTurns: 1 });
      expect(session.abort).toHaveBeenCalledOnce();
      expect(result.turnBudget).toEqual({ maxTurns: 3, used: 3, phase: "exhausted" });
    });

    it("lets a final answer on the ceiling turn end the run without a stop", async () => {
      const { session, listeners } = createSession("done");
      programTurns(session, listeners, [{}, {}, { stopReason: "stop", toolResults: 0 }]);
      const { sub } = makeSubagentSession(session);
      const result = await sub.runTurnLoop("go", { maxTurns: 3, wrapUpTurns: 1 });
      expect(session.abort).not.toHaveBeenCalled();
      expect(result.turnBudget).toEqual({ maxTurns: 3, used: 3, phase: "warned" });
    });

    it("stops a turn that starts past the ceiling", async () => {
      const { session, listeners } = createSession("done");
      // The ceiling turn answered, yet another turn starts (a steer queued on it).
      session.prompt = vi.fn(async () => {
        emitTurnStart(listeners);
        emitTurnEnd(listeners);
        emitTurnStart(listeners);
        emitTurnEnd(listeners, { stopReason: "stop", toolResults: 0 });
        emitTurnStart(listeners);
      });
      const { sub } = makeSubagentSession(session);
      const result = await sub.runTurnLoop("go", { maxTurns: 2, wrapUpTurns: 1 });
      expect(session.abort).toHaveBeenCalledOnce();
      expect(result.turnBudget).toEqual({ maxTurns: 2, used: 2, phase: "exhausted" });
    });

    it("does not count a turn whose response errored", async () => {
      const { session, listeners } = createSession("done");
      programTurns(session, listeners, [{}, { stopReason: "error", toolResults: 0 }, { stopReason: "stop", toolResults: 0 }]);
      const { sub } = makeSubagentSession(session);
      const result = await sub.runTurnLoop("go", { maxTurns: 5, wrapUpTurns: 1 });
      expect(result.turnBudget).toEqual({ maxTurns: 5, used: 2, phase: "within" });
    });
  });

  describe("warning", () => {
    it("warns with a context-only message once wrapUpTurns turns remain, never through a steer", async () => {
      const { session, listeners } = createSession("done");
      programTurns(session, listeners, [{}, {}, {}, { stopReason: "stop", toolResults: 0 }]);
      const { sub } = makeSubagentSession(session);
      const result = await sub.runTurnLoop("go", { maxTurns: 5, wrapUpTurns: 2 });
      expect(session.sendCustomMessage).toHaveBeenCalledOnce();
      expect(session.sendCustomMessage).toHaveBeenCalledWith(
        {
          customType: "subagents:turn-budget-warning",
          content:
            "Turn budget: you have 2 turns left, including this one. The harness stops you after that. Finish your work and give your final answer within that budget.",
          display: true,
        },
        { triggerTurn: false },
      );
      expect(session.steer).not.toHaveBeenCalled();
      expect(result.turnBudget).toEqual({ maxTurns: 5, used: 4, phase: "warned" });
    });

    it("states the budget before the first turn when every turn is a wrap-up turn", async () => {
      const { session, listeners } = createSession("done");
      programTurns(session, listeners, [{ stopReason: "stop", toolResults: 0 }]);
      session.prompt.mockImplementationOnce(async () => {
        expect(session.sendCustomMessage).toHaveBeenCalledOnce();
        emitTurnStart(listeners);
        emitTurnEnd(listeners, { stopReason: "stop", toolResults: 0 });
      });
      const { sub } = makeSubagentSession(session);
      const result = await sub.runTurnLoop("go", { maxTurns: 2, wrapUpTurns: 2 });
      expect(session.sendCustomMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("you have 2 turns left") }),
        { triggerTurn: false },
      );
      expect(result.turnBudget).toEqual({ maxTurns: 2, used: 1, phase: "warned" });
    });
  });

  describe("reporting", () => {
    it("reports the budget before the first turn and after each turn", async () => {
      const { session, listeners } = createSession("done");
      programTurns(session, listeners, 2);
      const { sub } = makeSubagentSession(session);
      const reports: unknown[] = [];
      await sub.runTurnLoop("go", { maxTurns: 4, wrapUpTurns: 2, onTurnBudget: (budget) => reports.push(budget) });
      expect(reports).toEqual([
        { maxTurns: 4, used: 0, phase: "within" },
        { maxTurns: 4, used: 1, phase: "within" },
        { maxTurns: 4, used: 2, phase: "warned" },
      ]);
    });

    it("counts an unlimited run's turns without warning or stopping it", async () => {
      const { session, listeners } = createSession("done");
      programTurns(session, listeners, 4);
      const { sub } = makeSubagentSession(session);
      const result = await sub.runTurnLoop("go", {});
      expect(result.turnBudget).toEqual({ used: 4, phase: "within" });
      expect(session.sendCustomMessage).not.toHaveBeenCalled();
      expect(session.abort).not.toHaveBeenCalled();
    });
  });

  describe("limit precedence", () => {
    it("per-call maxTurns takes precedence over agentMaxTurns and defaultMaxTurns", async () => {
      const { session, listeners } = createSession("done");
      programTurns(session, listeners, 1);
      const { sub } = makeSubagentSession(session, { agentMaxTurns: 7 });
      const result = await sub.runTurnLoop("go", { maxTurns: 3, defaultMaxTurns: 9 });
      expect(result.turnBudget.maxTurns).toBe(3);
    });

    it("falls back to agentMaxTurns when no per-call maxTurns is set", async () => {
      const { session, listeners } = createSession("done");
      programTurns(session, listeners, 1);
      const { sub } = makeSubagentSession(session, { agentMaxTurns: 7 });
      const result = await sub.runTurnLoop("go", { defaultMaxTurns: 9 });
      expect(result.turnBudget.maxTurns).toBe(7);
    });

    it("falls back to defaultMaxTurns when neither per-call nor agentMaxTurns is set", async () => {
      const { session, listeners } = createSession("done");
      programTurns(session, listeners, 1);
      const { sub } = makeSubagentSession(session);
      const result = await sub.runTurnLoop("go", { defaultMaxTurns: 9 });
      expect(result.turnBudget.maxTurns).toBe(9);
    });
  });
});

describe("SubagentSession — runTurnLoop parent abort signal", () => {
  it("aborts the session when the parent signal fires mid-prompt", async () => {
    const controller = new AbortController();
    const { session } = createSession("X");
    // prompt stays in flight until the parent signal aborts.
    session.prompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const { sub } = makeSubagentSession(session);
    const promise = sub.runTurnLoop("go", { signal: controller.signal });
    controller.abort();
    await promise;
    expect(session.abort).toHaveBeenCalled();
  });

  it("does not abort the session when the parent signal never fires", async () => {
    const controller = new AbortController();
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    await sub.runTurnLoop("go", { signal: controller.signal });
    expect(session.abort).not.toHaveBeenCalled();
  });
});

describe("SubagentSession — runTurnLoop lifecycle events", () => {
  it("emits completed with the run outcome on the success path", async () => {
    const { session } = createSession("OK");
    const { sub } = makeSubagentSession(session, { sessionDir: "/d", agentName: "Explore", lifecycle });
    await sub.runTurnLoop("go", {});
    expect(lifecycle.completed).toHaveBeenCalledOnce();
    expect(lifecycle.completed).toHaveBeenCalledWith(
      childCompletedEvent({ sessionDir: "/d", agentName: "Explore", turnBudget: { used: 0, phase: "within" } }),
    );
  });

  it("emits completed with the run's turn budget and no turn-limit flags", async () => {
    const { session, listeners } = createSession("done");
    programTurns(session, listeners, 3);
    const { sub } = makeSubagentSession(session, { sessionDir: "/d", agentName: "Explore", lifecycle });
    await sub.runTurnLoop("go", { maxTurns: 5, wrapUpTurns: 2 });
    expect(lifecycle.completed).toHaveBeenCalledWith({
      sessionDir: "/d",
      agentName: "Explore",
      turnBudget: { maxTurns: 5, used: 3, phase: "warned" },
    });
  });

  it("releases its turn-outcome subscription on dispose", async () => {
    const { session, listeners } = createSession("X");
    const { sub } = makeSubagentSession(session);
    expect(listeners).toHaveLength(1);
    await sub.dispose();
    expect(listeners).toHaveLength(0);
  });

  it("does not emit disposed from runTurnLoop (disposal is separate)", async () => {
    const { session } = createSession("OK");
    const { sub } = makeSubagentSession(session, { lifecycle });
    await sub.runTurnLoop("go", {});
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });

  it("skips completed when prompt throws and does not emit disposed", async () => {
    const { session } = createSession("OK");
    session.prompt = vi.fn().mockRejectedValue(new Error("prompt failed"));
    const { sub } = makeSubagentSession(session, { lifecycle });
    await expect(sub.runTurnLoop("go", {})).rejects.toThrow("prompt failed");
    expect(lifecycle.completed).not.toHaveBeenCalled();
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });
});

describe("SubagentSession — runTurnLoop provider failures", () => {
  it("rejects with the provider's error message when the last turn errored", async () => {
    const { session, listeners } = createSession("unused");
    programMessages(session, listeners, [providerErrorMessage("429 rate limit exceeded")]);
    const { sub } = makeSubagentSession(session);
    await expect(sub.runTurnLoop("go", {})).rejects.toThrow("429 rate limit exceeded");
  });

  it("rejects with a fallback when the errored turn carries no message", async () => {
    const { session, listeners } = createSession("unused");
    programMessages(session, listeners, [providerErrorMessage()]);
    const { sub } = makeSubagentSession(session);
    await expect(sub.runTurnLoop("go", {})).rejects.toThrow(
      "provider reported an error with no message",
    );
  });

  it("does not emit completed for a run whose provider errored", async () => {
    const { session, listeners } = createSession("unused");
    programMessages(session, listeners, [providerErrorMessage("boom")]);
    const { sub } = makeSubagentSession(session, { lifecycle });
    await expect(sub.runTurnLoop("go", {})).rejects.toThrow("boom");
    expect(lifecycle.completed).not.toHaveBeenCalled();
  });

  it("resolves normally when the last turn was aborted rather than errored", async () => {
    const { session, listeners } = createSession("unused");
    programMessages(session, listeners, [
      { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" },
    ]);
    const { sub } = makeSubagentSession(session, { lifecycle });
    const result = await sub.runTurnLoop("go", {});
    expect(result.responseText).toBe("partial");
    expect(lifecycle.completed).toHaveBeenCalledOnce();
  });

  // The package's own fixtures push assistant messages carrying no stopReason
  // at all, so an absent field must read as "not a failure" rather than being
  // assumed present.
  it("resolves normally when the last assistant message carries no stopReason", async () => {
    const { session } = createSession("ALL DONE");
    const { sub } = makeSubagentSession(session, { lifecycle });
    const result = await sub.runTurnLoop("go", {});
    expect(result.responseText).toBe("ALL DONE");
    expect(lifecycle.completed).toHaveBeenCalledOnce();
  });

  // Pi removes a retried error from agent state before retrying, so an errored
  // message that is no longer last is one the retry budget rescued.
  it("resolves normally when an errored turn was followed by a clean one", async () => {
    const { session, listeners } = createSession("unused");
    programMessages(session, listeners, [
      providerErrorMessage("transient stream drop"),
      { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" },
    ]);
    const { sub } = makeSubagentSession(session, { lifecycle });
    const result = await sub.runTurnLoop("go", {});
    expect(result.responseText).toBe("recovered");
    expect(lifecycle.completed).toHaveBeenCalledOnce();
  });

  // The failure is read from the event stream rather than from session history,
  // so a turn error Pi's overflow recovery already stripped still fails the run
  // instead of reporting an earlier turn's work as the answer (#898).
  it("rejects when overflow recovery stripped the errored turn before the run settled", async () => {
    const { session, listeners } = createSession("unused");
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "work from an earlier turn" }],
      stopReason: "stop",
    });
    programStrippedFailure(session, listeners, "prompt is too long: 210000 tokens > 200000 maximum");
    const { sub } = makeSubagentSession(session, { lifecycle });
    await expect(sub.runTurnLoop("go", {})).rejects.toThrow("prompt is too long");
    expect(lifecycle.completed).not.toHaveBeenCalled();
  });

  // The other half of the same sequence: when the compaction succeeds, the
  // continued turn emits its own clean message_end and the run recovered.
  it("resolves when overflow recovery stripped the errored turn and the retry succeeded", async () => {
    const { session, listeners } = createSession("unused");
    const recovered = {
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
      stopReason: "stop",
    };
    session.prompt = vi.fn(async () => {
      emit(listeners, {
        type: "message_end",
        message: { usage: EMPTY_USAGE, ...providerErrorMessage("context overflow") },
      });
      session.messages.push(recovered);
      emit(listeners, { type: "message_end", message: { usage: EMPTY_USAGE, ...recovered } });
    });
    const { sub } = makeSubagentSession(session, { lifecycle });
    const result = await sub.runTurnLoop("go", {});
    expect(result.responseText).toBe("recovered");
    expect(lifecycle.completed).toHaveBeenCalledOnce();
  });
});

describe("SubagentSession — resumeTurnLoop", () => {
  it("re-prompts the session and returns the final assistant text", async () => {
    const { session } = createSession("RESUMED");
    const { sub } = makeSubagentSession(session);
    const result = await sub.resumeTurnLoop("Continue", {});
    expect(session.prompt).toHaveBeenCalledWith("Continue");
    expect(result).toEqual({ responseText: "RESUMED", turnBudget: { used: 0, phase: "within" } });
  });

  it("does not emit completed or disposed", async () => {
    const { session } = createSession("RESUMED");
    const { sub } = makeSubagentSession(session, { lifecycle });
    await sub.resumeTurnLoop("Continue", {});
    expect(lifecycle.completed).not.toHaveBeenCalled();
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });

  // The same fail-open the initial run carried: a resume whose provider errors
  // would otherwise be marked completed, carrying stale text from the turn
  // before the failure (#889).
  it("rejects with the provider's error message when the resumed turn errored", async () => {
    const { session, listeners } = createSession("unused");
    programMessages(session, listeners, [providerErrorMessage("401 invalid api key")]);
    const { sub } = makeSubagentSession(session);
    await expect(sub.resumeTurnLoop("Continue", {})).rejects.toThrow("401 invalid api key");
  });

  it("does not report an earlier turn's text as the resumed answer", async () => {
    const { session, listeners } = createSession("unused");
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "work from the turn before the failure" }],
      stopReason: "stop",
    });
    programMessages(session, listeners, [providerErrorMessage("stream disconnected")]);
    const { sub } = makeSubagentSession(session);
    await expect(sub.resumeTurnLoop("Continue", {})).rejects.toThrow("stream disconnected");
  });

  it("rejects when overflow recovery stripped the resumed turn's error", async () => {
    const { session, listeners } = createSession("unused");
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "work from the turn before the failure" }],
      stopReason: "stop",
    });
    programStrippedFailure(session, listeners, "503 upstream unavailable");
    const { sub } = makeSubagentSession(session);
    await expect(sub.resumeTurnLoop("Continue", {})).rejects.toThrow("503 upstream unavailable");
  });

  // `AgentSession.prompt()` resolves without running a turn when an extension
  // command matches, when an `input` handler reports the prompt handled, or
  // when the message is queued while streaming. A resume on an agent whose
  // earlier run failed is not refused, so on those paths the session's own
  // terminal state is the only answer available (#898).
  it("rejects when the resume ran no turn and the session's last turn had errored", async () => {
    const { session } = createSession("unused");
    session.messages.push(providerErrorMessage("429 rate limit exceeded"));
    session.prompt = vi.fn(async () => {});
    const { sub } = makeSubagentSession(session);
    await expect(sub.resumeTurnLoop("/skill:audit go", {})).rejects.toThrow(
      "429 rate limit exceeded",
    );
  });

  // The composed case: the earlier run's failure was never in `session.messages`
  // to begin with, because Pi's overflow recovery stripped it. A history read at
  // the resume's start cannot see it either, so the outcome is tracked for the
  // session's lifetime rather than re-derived per call (#898).
  it("rejects when a stripped earlier failure is followed by a resume that runs no turn", async () => {
    const { session, listeners } = createSession("unused");
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "work from an earlier turn" }],
      stopReason: "stop",
    });
    programStrippedFailure(session, listeners, "prompt is too long: 210000 tokens > 200000 maximum");
    const { sub } = makeSubagentSession(session);
    await expect(sub.runTurnLoop("go", {})).rejects.toThrow("prompt is too long");

    session.prompt = vi.fn(async () => {});
    await expect(sub.resumeTurnLoop("/skill:audit go", {})).rejects.toThrow("prompt is too long");
  });

  it("resolves when the resume's own turn succeeded after an earlier failure", async () => {
    const { session, listeners } = createSession("unused");
    session.messages.push(providerErrorMessage("429 rate limit exceeded"));
    programMessages(session, listeners, [
      { role: "assistant", content: [{ type: "text", text: "the second answer" }], stopReason: "stop" },
    ]);
    const { sub } = makeSubagentSession(session);
    await expect(sub.resumeTurnLoop("Continue", {})).resolves.toEqual({ responseText: "the second answer", turnBudget: { used: 0, phase: "within" } });
  });

  it("resolves normally when the resumed turn did not error", async () => {
    const { session } = createSession("RESUMED");
    const { sub } = makeSubagentSession(session);
    await expect(sub.resumeTurnLoop("Continue", {})).resolves.toEqual({ responseText: "RESUMED", turnBudget: { used: 0, phase: "within" } });
  });
});

describe("SubagentSession — resumeTurnLoop turn budget", () => {
  it("gives a resume a fresh budget with the original run's ceiling", async () => {
    const { session, listeners } = createSession("done");
    programTurns(session, listeners, 5);
    const { sub } = makeSubagentSession(session);
    const first = await sub.runTurnLoop("go", { maxTurns: 3, wrapUpTurns: 1 });
    expect(first.turnBudget.phase).toBe("exhausted");

    session.abort.mockClear();
    programTurns(session, listeners, [{}, { stopReason: "stop", toolResults: 0 }]);
    const reports: unknown[] = [];
    const resumed = await sub.resumeTurnLoop("Continue", { onTurnBudget: (budget) => reports.push(budget) });
    expect(reports[0]).toEqual({ maxTurns: 3, used: 0, phase: "within" });
    expect(resumed.turnBudget).toEqual({ maxTurns: 3, used: 2, phase: "within" });
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("stops a resume at the original run's ceiling", async () => {
    const { session, listeners } = createSession("done");
    programTurns(session, listeners, 1);
    const { sub } = makeSubagentSession(session);
    await sub.runTurnLoop("go", { maxTurns: 2, wrapUpTurns: 1 });

    programTurns(session, listeners, 4);
    const resumed = await sub.resumeTurnLoop("Continue", {});
    expect(session.abort).toHaveBeenCalledOnce();
    expect(resumed.turnBudget).toEqual({ maxTurns: 2, used: 2, phase: "exhausted" });
  });
});

describe("SubagentSession — steer", () => {
  it("delegates the message to the live session", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    await sub.steer("hurry up");
    expect(session.steer).toHaveBeenCalledWith("hurry up");
  });
});

describe("SubagentSession — delegate methods", () => {
  it("getConversation returns formatted text from session messages", () => {
    const { session } = createSession("X");
    session.messages.push({ role: "user", content: "Hello" });
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "World" }],
    });
    const { sub } = makeSubagentSession(session);
    const conv = sub.getConversation();
    expect(conv).toContain("[User]: Hello");
    expect(conv).toContain("[Assistant");
    expect(conv).toContain("World");
  });

  it("getContextPercent returns the session context percent", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    expect(sub.getContextPercent()).toBe(42);
  });

  it("getContextPercent returns null when getSessionStats is unavailable", () => {
    const { session } = createSession("X");
    session.getSessionStats = vi.fn(() => { throw new Error("no stats"); });
    const { sub } = makeSubagentSession(session);
    expect(sub.getContextPercent()).toBeNull();
  });

  it("subscribe delegates to the underlying session", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    const fn = vi.fn();
    const unsub = sub.subscribe(fn);
    expect(session.subscribe).toHaveBeenCalledWith(fn);
    expect(typeof unsub).toBe("function");
  });

  it("getSessionStats delegates to the underlying session", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    const stats = sub.getSessionStats();
    expect(session.getSessionStats).toHaveBeenCalled();
    expect(stats.tokens.input).toBe(100);
  });

  it("messages returns the underlying session messages", () => {
    const { session } = createSession("X");
    session.messages.push({ role: "user", content: "hi" });
    const { sub } = makeSubagentSession(session);
    expect(sub.messages).toBe(session.messages);
  });

  it("agentMessages returns the underlying session messages typed", () => {
    const { session } = createSession("X");
    session.messages.push({ role: "user", content: "hi" });
    const { sub } = makeSubagentSession(session);
    expect(sub.agentMessages).toBe(session.messages);
  });

  it("getToolDefinition delegates to the underlying session", () => {
    const { session } = createSession("X");
    const def = { name: "read" };
    session.getToolDefinition = vi.fn(() => def);
    const { sub } = makeSubagentSession(session);
    expect(sub.getToolDefinition("read")).toBe(def);
    expect(session.getToolDefinition).toHaveBeenCalledWith("read");
  });
});

describe("SubagentSession — dispose", () => {
  it("disposes the session and emits disposed with the child session id", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { sessionId: "child-session-abc", lifecycle });
    await sub.dispose();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledWith({ sessionId: "child-session-abc" });
  });

  it("emits session_shutdown to the child's extensions before disposing the session", async () => {
    const { session, calls } = createSession("X");
    const { sub } = makeSubagentSession(session);
    await sub.dispose();
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(calls).toEqual(["emit", "dispose"]);
  });

  it("unregisters the child only after its shutdown handlers have run", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { lifecycle });
    session.extensionRunner.emit = vi.fn((_event: unknown): Promise<unknown> => {
      expect(lifecycle.disposed).not.toHaveBeenCalled();
      return Promise.resolve(undefined);
    });
    await sub.dispose();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
  });

  it("disposes a child whose extensions registered no shutdown handler", async () => {
    const { session, calls } = createSession("X");
    session.hasExtensionHandlers = vi.fn((_eventType: string): boolean => false);
    const { sub } = makeSubagentSession(session, { lifecycle });
    await sub.dispose();
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(calls).toEqual(["dispose"]);
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
  });

  it("is idempotent: a second dispose neither re-emits nor re-disposes", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { lifecycle });
    await sub.dispose();
    await sub.dispose();
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
  });

  it("guards re-entry before its first await, so concurrent disposes emit once", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { lifecycle });
    await Promise.all([sub.dispose(), sub.dispose()]);
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
