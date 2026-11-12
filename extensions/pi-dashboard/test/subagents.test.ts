import type { SubagentSnapshot } from "../../pi-subagent/src/observation/snapshot.ts";
import { describe, expect, it } from "vitest";
import { SubagentTracker } from "#src/subagents";

type Agent = SubagentSnapshot["agents"][number];
const agent = (
  id: string,
  state: Agent["state"] = "completed",
  extra: Partial<Agent> = {},
): Agent => ({
  id,
  state,
  type: "explore",
  description: "Find auth files",
  startedAt: 100,
  completedAt: undefined,
  waitingOn: [],
  error: undefined,
  live: true,
  toolUses: 0,
  ...extra,
});
const snapshot = (agents: Agent[]): SubagentSnapshot => ({ version: 1, agents });

describe("subagent snapshots", () => {
  it("accepts a historical roster on first load, then replaces it on branch changes", () => {
    const tracker = new SubagentTracker();
    tracker.apply(snapshot([agent("old", "completed", { completedAt: 900, toolUses: 7 })]));
    expect(tracker.section()?.agents).toEqual([
      {
        id: "old",
        type: "explore",
        description: "Find auth files",
        state: "completed",
        since: 100,
        durationMs: 800,
        toolUses: 7,
      },
    ]);
    tracker.apply(snapshot([agent("other", "running")]));
    expect(tracker.section()?.agents.map((a) => a.id)).toEqual(["other"]);
    tracker.apply(snapshot([]));
    expect(tracker.section()).toBeUndefined();
  });

  it("uses authoritative waiting, resumed and terminal state without earlier events", () => {
    const tracker = new SubagentTracker();
    tracker.apply(snapshot([agent("w", "waiting", { note: "CI, answer" })]));
    expect(tracker.section()?.agents[0]).toMatchObject({ state: "waiting", note: "CI, answer" });
    tracker.apply(snapshot([agent("w", "queued")]));
    expect(tracker.section()?.agents[0]).toMatchObject({ state: "queued" });
    expect(tracker.section()?.agents[0].note).toBeUndefined();
    tracker.apply(snapshot([agent("w", "error", { note: "boom" })]));
    expect(tracker.section()?.agents[0]).toMatchObject({ state: "failed", note: "boom" });
    tracker.apply(snapshot([agent("w", "interrupted")]));
    expect(tracker.section()?.agents[0]).toMatchObject({
      state: "stopped",
      note: "Run interrupted",
    });
  });

  it("guards versions, bounds strings, and isolates its stored value", () => {
    const tracker = new SubagentTracker();
    tracker.apply(snapshot([agent("a", "running", { note: "x".repeat(1000) })]));
    for (const junk of [undefined, { version: 2 } as unknown as SubagentSnapshot]) {
      expect(tracker.apply(junk)).toBe(false);
      expect(tracker.section()?.agents[0].id).toBe("a");
    }
    expect(tracker.section()?.agents[0].note?.length).toBeLessThanOrEqual(300);
    tracker.section()!.agents[0].description = "changed";
    expect(tracker.section()?.agents[0].description).toBe("Find auth files");
  });

  it("caps finished rows without dropping active or waiting agents", () => {
    const tracker = new SubagentTracker();
    tracker.apply(
      snapshot([
        ...Array.from({ length: 30 }, (_, i) => agent(`done-${i}`)),
        agent("running", "running"),
        agent("waiting", "waiting"),
        agent("queued", "queued"),
      ]),
    );
    const ids = tracker.section()!.agents.map((a) => a.id);
    expect(ids).toHaveLength(20);
    expect(ids).toEqual(expect.arrayContaining(["running", "waiting", "queued"]));
  });
});
