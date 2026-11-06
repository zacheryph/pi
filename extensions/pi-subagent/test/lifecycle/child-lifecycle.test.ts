import { describe, expect, it, vi } from "vitest";
import {
  type ChildLifecyclePublisher,
  type ChildPrepareEvent,
  createChildLifecyclePublisher,
  SUBAGENT_CHILD_BOUND,
  SUBAGENT_CHILD_PREPARE,
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
  it("emits subagent:session:spawning with the agent identity", () => {
    const { emit, publisher } = setup();

    publisher.spawning({ agentName: "explore", parentSessionId: "parent-42" });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_SPAWNING, {
      agentName: "explore",
      parentSessionId: "parent-42",
    });
  });

  it("emits subagent:session:created with the child session id", () => {
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

  it("emits subagent:session:completed with the run outcome", () => {
    const { emit, publisher } = setup();

    const event = childCompletedEvent({
      sessionDir: "/sessions/child-abc",
      turnBudget: { maxTurns: 2, used: 3, phase: "warned" },
    });
    publisher.completed(event);

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_COMPLETED, event);
  });

  it("emits subagent:session:bound with the child session id", () => {
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

  it("emits subagent:session:disposed with the child session id", () => {
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
    expect(SUBAGENT_CHILD_SPAWNING).toBe("subagent:session:spawning");
    expect(SUBAGENT_CHILD_SESSION_CREATED).toBe("subagent:session:created");
    expect(SUBAGENT_CHILD_BOUND).toBe("subagent:session:bound");
    expect(SUBAGENT_CHILD_COMPLETED).toBe("subagent:session:completed");
    expect(SUBAGENT_CHILD_DISPOSED).toBe("subagent:session:disposed");
  });
});

describe("handoff tool preparation", () => {
  const input = {
    agentName: "explore",
    agentId: "worker",
    toolCallId: "spawn-call",
    parentSessionId: "parent",
    cwd: "/workspace",
    handoff: { todo: { keys: ["audit"] } },
  };

  it("collects and deduplicates synchronous contributions without interpreting handoff keys", () => {
    const emit = vi.fn((_channel: string, data: unknown) => {
      const event = data as ChildPrepareEvent;
      expect(event).toMatchObject(input);
      event.requireTools(["todo_list", "todo_upsert"]);
      event.requireTools(["todo_list", "other_tool"]);
    });
    expect(createChildLifecyclePublisher(emit).prepare(input)).toEqual([
      "todo_list",
      "todo_upsert",
      "other_tool",
    ]);
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_PREPARE, expect.any(Object));
  });

  it("returns no requirements without a contributor and snapshots before asynchronous contributions", () => {
    expect(setup().publisher.prepare(input)).toEqual([]);
    let late: ChildPrepareEvent["requireTools"] = () => {};
    const publisher = createChildLifecyclePublisher((_channel, data) => {
      late = (data as ChildPrepareEvent).requireTools;
    });
    const required = publisher.prepare(input);
    late(["edit"]);
    expect(required).toEqual([]);
  });

  it.each(["all", "none", "-bash", "+edit", "mcp__server__*", "tool?", "", " read"])(
    "rejects selectors and malformed names: %j",
    (name) => {
      const publisher = createChildLifecyclePublisher((_channel, data) => {
        (data as ChildPrepareEvent).requireTools([name]);
      });
      expect(() => publisher.prepare(input)).toThrow("invalid tool name");
    },
  );
});

describe("normalizeHandoff", () => {
  it("copies and deep-freezes any JSON object, without interpreting its keys", () => {
    const input = {
      todos: { keys: ["auth-audit"], scope: "ledger" },
      review: { ticket: "AUTH-12", strict: true },
    };
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
    expect(normalizeHandoff({ at: new Date(0), skip: undefined, fn: () => 1 })).toEqual({
      handoff: { at: "1970-01-01T00:00:00.000Z" },
    });
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
    expect(normalizeHandoff({ blob: "x".repeat(MAX_HANDOFF_BYTES) })).toEqual({
      error: expect.stringMatching(/limit is 16384/),
    });
  });
});
