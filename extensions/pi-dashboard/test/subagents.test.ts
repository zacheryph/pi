import { describe, expect, it } from "vitest";
import { SUBAGENT_CHANNELS, SubagentTracker } from "#src/subagents";

describe("SubagentTracker", () => {
  it("follows an agent from queued through running to a result", () => {
    let now = 100;
    const tracker = new SubagentTracker(() => now);
    expect(tracker.section()).toBeUndefined();
    expect(
      tracker.apply("subagent:created", {
        id: "a",
        type: "Explore",
        description: "Find auth files",
      }),
    ).toBe(true);
    expect(tracker.section()?.agents[0]).toEqual({
      id: "a",
      type: "Explore",
      description: "Find auth files",
      state: "queued",
      since: 100,
    });
    now = 200;
    tracker.apply("subagent:started", {
      id: "a",
      type: "Explore",
      description: "Find auth files",
    });
    tracker.apply("subagent:notified", { id: "a", message: "found 3 call sites" });
    expect(tracker.section()?.agents[0]).toMatchObject({
      state: "running",
      note: "found 3 call sites",
      since: 100,
    });
    tracker.apply("subagent:completed", {
      id: "a",
      status: "completed",
      durationMs: 4200,
      toolUses: 7,
      tokens: { input: 1, output: 2, total: 3000 },
    });
    expect(tracker.section()?.agents[0]).toMatchObject({
      state: "completed",
      durationMs: 4200,
      toolUses: 7,
      tokens: 3000,
    });
  });

  it("maps failures, stops and resumes", () => {
    const tracker = new SubagentTracker(() => 1);
    tracker.apply("subagent:started", { id: "f", type: "Agent", description: "x" });
    tracker.apply("subagent:failed", { id: "f", status: "error", error: "model overloaded" });
    tracker.apply("subagent:started", { id: "s", type: "Agent", description: "y" });
    tracker.apply("subagent:completed", { id: "s", status: "aborted" });
    expect(tracker.section()?.agents.map((agent) => [agent.id, agent.state, agent.note])).toEqual([
      ["s", "stopped", undefined],
      ["f", "failed", "model overloaded"],
    ]);
    tracker.apply("subagent:resuming", { id: "f" });
    expect(tracker.section()?.agents[0]).toMatchObject({ id: "f", state: "running" });
    expect(tracker.section()?.agents[0]?.note).toBeUndefined();
    tracker.apply("subagent:resumed", { id: "f", status: "completed" });
    expect(tracker.section()?.agents[0]?.state).toBe("completed");
  });

  it("shows a finished agent given a message as queued until its run starts", () => {
    const tracker = new SubagentTracker(() => 1);
    tracker.apply("subagent:started", { id: "d", type: "Agent", description: "x" });
    tracker.apply("subagent:failed", { id: "d", status: "error", error: "model overloaded" });
    expect(tracker.section()?.agents[0]).toMatchObject({
      state: "failed",
      note: "model overloaded",
    });

    expect(tracker.apply("subagent:queued", { id: "d", type: "Agent", description: "x" })).toBe(
      true,
    );
    expect(tracker.section()?.agents[0]).toMatchObject({ id: "d", state: "queued" });
    expect(tracker.section()?.agents[0]?.note).toBeUndefined();

    tracker.apply("subagent:resuming", { id: "d" });
    expect(tracker.section()?.agents[0]?.state).toBe("running");
    tracker.apply("subagent:resumed", { id: "d", status: "completed" });
    expect(tracker.section()?.agents[0]?.state).toBe("completed");
  });

  it("ignores malformed and unrelated events, and does not re-queue a known agent", () => {
    const tracker = new SubagentTracker(() => 1);
    expect(tracker.apply("subagent:started", { type: "Agent" })).toBe(false);
    expect(tracker.apply("subagent:settings:changed", { id: "a" })).toBe(false);
    expect(tracker.apply("subagent:started", null)).toBe(false);
    tracker.apply("subagent:started", { id: "a", type: "Agent", description: "x" });
    expect(tracker.apply("subagent:created", { id: "a" })).toBe(false);
    expect(tracker.section()?.agents[0]?.state).toBe("running");
  });

  it("keeps 20 agents, trimming the oldest finished ones before any running one", () => {
    const tracker = new SubagentTracker(() => 1);
    tracker.apply("subagent:started", { id: "long-runner", type: "Agent", description: "x" });
    for (let index = 0; index < 25; index += 1) {
      tracker.apply("subagent:started", { id: `a${index}`, type: "Agent", description: "x" });
      tracker.apply("subagent:completed", { id: `a${index}`, status: "completed" });
    }
    const ids = tracker.section()!.agents.map((agent) => agent.id);
    expect(ids).toHaveLength(20);
    expect(ids).toContain("long-runner");
    expect(ids[0]).toBe("a24");
  });
});

describe("a waiting agent", () => {
  it("is idle on open work, named by its note, until its work reports back", () => {
    let now = 100;
    const tracker = new SubagentTracker(() => now);
    tracker.apply("subagent:created", { id: "w", type: "Agent", description: "Review CI" });
    tracker.apply("subagent:started", { id: "w" });
    expect(tracker.apply("subagent:waiting", { id: "w", reason: "CI checks" })).toBe(true);
    expect(tracker.section()?.agents[0]).toMatchObject({
      id: "w",
      state: "waiting",
      note: "CI checks",
      since: 100,
    });

    // What it waits on changed: the note follows.
    now = 200;
    tracker.apply("subagent:waiting", { id: "w", reason: "CI checks, review" });
    expect(tracker.section()?.agents[0]?.note).toBe("CI checks, review");

    // The work reported back: queued for a slot, running, then done.
    tracker.apply("subagent:queued", { id: "w" });
    expect(tracker.section()?.agents[0]).toMatchObject({ state: "queued" });
    expect(tracker.section()?.agents[0]?.note).toBeUndefined();
    tracker.apply("subagent:resuming", { id: "w" });
    expect(tracker.section()?.agents[0]?.state).toBe("running");
    tracker.apply("subagent:resumed", { id: "w", status: "completed", durationMs: 5 });
    expect(tracker.section()?.agents[0]).toMatchObject({ state: "completed", durationMs: 5 });
    expect(tracker.section()?.agents[0]?.note).toBeUndefined();
  });

  it("keeps waiting agents when trimming the oldest finished ones", () => {
    const tracker = new SubagentTracker(() => 1);
    tracker.apply("subagent:waiting", { id: "keep", reason: "CI" });
    for (let i = 0; i < 25; i++) {
      tracker.apply("subagent:started", { id: `f${i}`, type: "Agent", description: "x" });
      tracker.apply("subagent:completed", { id: `f${i}`, status: "completed" });
    }
    const ids = tracker.section()?.agents.map((agent) => agent.id) ?? [];
    expect(ids).toContain("keep");
    expect(ids).toHaveLength(20);
  });

  it("has a note only when it says what it waits on, and clips and ignores junk", () => {
    const tracker = new SubagentTracker(() => 1);
    tracker.apply("subagent:waiting", { id: "w", reason: "x".repeat(1000) });
    expect(tracker.section()?.agents[0]?.note?.length).toBeLessThanOrEqual(300);
    tracker.apply("subagent:waiting", { id: "w", reason: 5 });
    expect(tracker.section()?.agents[0]?.note).toBeUndefined();
    expect(tracker.apply("subagent:waiting", { reason: "no id" })).toBe(false);
  });
});

describe("a waiting agent's note", () => {
  it("is cleared when it finishes without an error, as it is when it runs again", () => {
    const tracker = new SubagentTracker(() => 1);
    for (const [channel, data] of [
      ["subagent:completed", { status: "completed" }],
      ["subagent:resumed", { status: "completed" }],
      ["subagent:failed", { status: "error" }],
    ] as const) {
      const id = channel;
      tracker.apply("subagent:waiting", { id, reason: "CI" });
      // The last item was cancelled: the agent finished with no run in between.
      tracker.apply(channel, { id, ...data });
      expect(tracker.section()?.agents.find((agent) => agent.id === id)?.note).toBeUndefined();
    }
  });

  it("is replaced by the error of a failure", () => {
    const tracker = new SubagentTracker(() => 1);
    tracker.apply("subagent:waiting", { id: "f", reason: "CI" });
    tracker.apply("subagent:failed", { id: "f", status: "error", error: "boom" });
    expect(tracker.section()?.agents[0]).toMatchObject({ state: "failed", note: "boom" });
  });

  it("is followed on the bus: the dashboard subscribes to the waiting channel", () => {
    expect(SUBAGENT_CHANNELS).toContain("subagent:waiting");
  });
});
