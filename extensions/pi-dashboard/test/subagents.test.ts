import { describe, expect, it } from "vitest";
import { SubagentTracker } from "#src/subagents";

describe("SubagentTracker", () => {
  it("follows an agent from queued through running to a result", () => {
    let now = 100;
    const tracker = new SubagentTracker(() => now);
    expect(tracker.section()).toBeUndefined();
    expect(tracker.apply("subagents:created", { id: "a", type: "Explore", description: "Find auth files", isBackground: true })).toBe(true);
    expect(tracker.section()?.agents[0]).toEqual({ id: "a", type: "Explore", description: "Find auth files", state: "queued", since: 100 });
    now = 200;
    tracker.apply("subagents:started", { id: "a", type: "Explore", description: "Find auth files" });
    tracker.apply("subagents:update", { id: "a", message: "found 3 call sites" });
    expect(tracker.section()?.agents[0]).toMatchObject({ state: "running", note: "found 3 call sites", since: 100 });
    tracker.apply("subagents:completed", { id: "a", status: "completed", durationMs: 4200, toolUses: 7, tokens: { input: 1, output: 2, total: 3000 } });
    expect(tracker.section()?.agents[0]).toMatchObject({ state: "completed", durationMs: 4200, toolUses: 7, tokens: 3000 });
  });

  it("maps failures, stops and resumes", () => {
    const tracker = new SubagentTracker(() => 1);
    tracker.apply("subagents:started", { id: "f", type: "Agent", description: "x" });
    tracker.apply("subagents:failed", { id: "f", status: "error", error: "model overloaded" });
    tracker.apply("subagents:started", { id: "s", type: "Agent", description: "y" });
    tracker.apply("subagents:completed", { id: "s", status: "aborted" });
    expect(tracker.section()?.agents.map((agent) => [agent.id, agent.state, agent.note])).toEqual([
      ["s", "stopped", undefined], ["f", "failed", "model overloaded"],
    ]);
    tracker.apply("subagents:resuming", { id: "f" });
    expect(tracker.section()?.agents[0]).toMatchObject({ id: "f", state: "running" });
    expect(tracker.section()?.agents[0]?.note).toBeUndefined();
    tracker.apply("subagents:resumed", { id: "f", status: "completed" });
    expect(tracker.section()?.agents[0]?.state).toBe("completed");
  });

  it("ignores malformed and unrelated events, and does not re-queue a known agent", () => {
    const tracker = new SubagentTracker(() => 1);
    expect(tracker.apply("subagents:started", { type: "Agent" })).toBe(false);
    expect(tracker.apply("subagents:settings_changed", { id: "a" })).toBe(false);
    expect(tracker.apply("subagents:started", null)).toBe(false);
    tracker.apply("subagents:started", { id: "a", type: "Agent", description: "x" });
    expect(tracker.apply("subagents:created", { id: "a" })).toBe(false);
    expect(tracker.section()?.agents[0]?.state).toBe("running");
  });

  it("keeps 20 agents, trimming the oldest finished ones before any running one", () => {
    const tracker = new SubagentTracker(() => 1);
    tracker.apply("subagents:started", { id: "long-runner", type: "Agent", description: "x" });
    for (let index = 0; index < 25; index += 1) {
      tracker.apply("subagents:started", { id: `a${index}`, type: "Agent", description: "x" });
      tracker.apply("subagents:completed", { id: `a${index}`, status: "completed" });
    }
    const ids = tracker.section()!.agents.map((agent) => agent.id);
    expect(ids).toHaveLength(20);
    expect(ids).toContain("long-runner");
    expect(ids[0]).toBe("a24");
  });
});
