import { describe, expect, it, vi } from "vitest";
import {
  type ChildLifecyclePublisher,
  createChildLifecyclePublisher,
  SUBAGENT_CHILD_BOUND,
  SUBAGENT_CHILD_COMPLETED,
  SUBAGENT_CHILD_DISPOSED,
  SUBAGENT_CHILD_SESSION_CREATED,
  SUBAGENT_CHILD_SPAWNING,
  MAX_HANDOFF_BYTES,
  normalizeHandoff,
} from "#src/lifecycle/child-lifecycle";
import { childCompletedEvent } from "#test/helpers/turn-loop-result";

function setup(): {
  emit: ReturnType<typeof vi.fn>;
  publisher: ChildLifecyclePublisher;
} {
  const emit = vi.fn<(channel: string, data: unknown) => void>();
  const publisher = createChildLifecyclePublisher(emit);
  return { emit, publisher };
}

describe("createChildLifecyclePublisher", () => {
  it("emits subagents:child:spawning with the agent identity", () => {
    const { emit, publisher } = setup();

    publisher.spawning({ agentName: "Explore", parentSessionId: "parent-42" });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_SPAWNING, {
      agentName: "Explore",
      parentSessionId: "parent-42",
    });
  });

  it("emits subagents:child:session-created with the child session id", () => {
    const { emit, publisher } = setup();

    publisher.sessionCreated({
      sessionId: "child-session-abc",
      parentSessionId: "parent-42",
    });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: "child-session-abc",
      parentSessionId: "parent-42",
    });
  });

  it("emits subagents:child:completed with the run outcome", () => {
    const { emit, publisher } = setup();

    const event = childCompletedEvent({ sessionDir: "/sessions/child-abc", turnBudget: { maxTurns: 2, used: 3, phase: "warned" } });
    publisher.completed(event);

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_COMPLETED, event);
  });

  it("emits subagents:child:bound with the child session id", () => {
    const { emit, publisher } = setup();

    publisher.bound({
      sessionId: "child-session-abc",
      parentSessionId: "parent-42",
    });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_BOUND, {
      sessionId: "child-session-abc",
      parentSessionId: "parent-42",
    });
  });

  it("emits subagents:child:disposed with the child session id", () => {
    const { emit, publisher } = setup();

    publisher.disposed({ sessionId: "child-session-abc" });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_DISPOSED, {
      sessionId: "child-session-abc",
    });
  });

  it("passes an undefined parentSessionId through unchanged", () => {
    const { emit, publisher } = setup();

    publisher.spawning({ agentName: "general-purpose", parentSessionId: undefined });

    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_SPAWNING, {
      agentName: "general-purpose",
      parentSessionId: undefined,
    });
  });

  it("exposes the canonical channel-name strings", () => {
    expect(SUBAGENT_CHILD_SPAWNING).toBe("subagents:child:spawning");
    expect(SUBAGENT_CHILD_SESSION_CREATED).toBe("subagents:child:session-created");
    expect(SUBAGENT_CHILD_BOUND).toBe("subagents:child:bound");
    expect(SUBAGENT_CHILD_COMPLETED).toBe("subagents:child:completed");
    expect(SUBAGENT_CHILD_DISPOSED).toBe("subagents:child:disposed");
  });
});

describe("normalizeHandoff", () => {
  it("copies and deep-freezes any JSON object, without interpreting its keys", () => {
    const input = { todos: { keys: ["auth-audit"], scope: "ledger" }, review: { ticket: "AUTH-12", strict: true } };
    const result = normalizeHandoff(input);
    expect(result).toEqual({ handoff: input });
    const handoff = "handoff" in result ? result.handoff! : {};
    expect(handoff).not.toBe(input);
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.todos)).toBe(true);
    expect(Object.isFrozen((handoff.todos as { keys: string[] }).keys)).toBe(true);
    input.review.ticket = "changed later";
    expect((handoff.review as { ticket: string }).ticket).toBe("AUTH-12");
  });

  it("keeps only JSON data", () => {
    expect(normalizeHandoff({ at: new Date(0), skip: undefined, fn: () => 1 })).toEqual({ handoff: { at: "1970-01-01T00:00:00.000Z" } });
  });

  it("hands over nothing when there is nothing to hand over", () => {
    expect(normalizeHandoff(undefined)).toEqual({});
    expect(normalizeHandoff(null)).toEqual({});
    expect(normalizeHandoff({})).toEqual({});
  });

  it("refuses values that are not a JSON object within the cap", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of ["todos", 7, ["a"], circular, { big: 1n }]) {
      expect(normalizeHandoff(value)).toEqual({ error: expect.stringContaining("handoff") });
    }
    expect(normalizeHandoff({ blob: "x".repeat(MAX_HANDOFF_BYTES) })).toEqual({ error: expect.stringMatching(/limit is 16384/) });
  });
});
