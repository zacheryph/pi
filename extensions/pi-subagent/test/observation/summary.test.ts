import { describe, expect, it } from "vitest";
import { isViewModel, settleViews, type SummaryModel } from "#surface";
import type { SubagentSnapshot } from "#src/observation/snapshot";
import { subagentSummaryModel, summaryProfile } from "#src/observation/summary";
import type { RosterState } from "#src/roster";

const NOW = 1_000_000;

function agent(id: string, state: RosterState): SubagentSnapshot["agents"][number] {
  return {
    id,
    type: "general-purpose",
    description: `Agent ${id}`,
    state,
    waitingOn: state === "waiting" ? ["job"] : [],
    error: state === "error" ? "boom" : undefined,
    startedAt: NOW - 60_000,
    completedAt: ["running", "queued", "waiting"].includes(state) ? undefined : NOW - 1_000,
    live: ["running", "queued", "waiting"].includes(state),
    toolUses: 1,
  };
}

const snapshot = (...states: RosterState[]): SubagentSnapshot => ({
  agents: states.map((state, index) => agent(`a${index}`, state)),
});
const counts = (model: SummaryModel) =>
  Object.fromEntries(model.counts.map((count) => [count.key, count.value]));

describe("subagentSummaryModel", () => {
  it("counts every state, zeros included, so no subagent reads zeros rather than no view", () => {
    const empty = subagentSummaryModel(snapshot());
    expect(isViewModel("summary", empty)).toBe(true);
    expect(counts(empty)).toEqual({
      running: 0,
      queued: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      stopped: 0,
      total: 0,
    });
    expect(empty.profile).toBeUndefined();
    expect(empty.active).toBeUndefined();
  });

  it("counts the whole branch: every roster state lands in one count", () => {
    const model = subagentSummaryModel(
      snapshot(
        "running",
        "running",
        "queued",
        "waiting",
        "completed",
        "error",
        "aborted",
        "stopped",
        "interrupted",
      ),
    );
    expect(counts(model)).toEqual({
      running: 2,
      queued: 1,
      waiting: 1,
      completed: 1,
      failed: 1,
      stopped: 3,
      total: 9,
    });
    // The newest running agent, first in roster order, named as the widget names its type.
    expect(
      subagentSummaryModel(snapshot("running"), undefined, (type) => `<${type}>`).active,
    ).toEqual({ id: "a0", label: "<general-purpose>: Agent a0", live: true });
  });

  it("marks only running, queued and waiting as live: settled, they read 0 and history stays", () => {
    const model = subagentSummaryModel(snapshot("running", "queued", "waiting", "completed"), {
      name: "orchestrate",
      displayName: "Orchestrator",
      description: "Plans and delegates",
    });
    expect(model.counts.filter((count) => count.live).map((count) => count.key)).toEqual([
      "running",
      "queued",
      "waiting",
    ]);
    const [settled] = settleViews(
      [{ id: "subagent.summary", kind: "summary", title: "Subagents", model }],
      NOW,
    );
    const after = settled!.model as SummaryModel;
    expect(isViewModel("summary", after)).toBe(true);
    expect(counts(after)).toEqual({
      running: 0,
      queued: 0,
      waiting: 0,
      completed: 1,
      failed: 0,
      stopped: 0,
      total: 4,
    });
    expect(JSON.stringify(after)).not.toContain('"live"');
    // The running agent was active; settled, nothing is.
    expect(model.active).toMatchObject({ id: "a0", live: true });
    expect(after.active).toBeUndefined();
    // `total` stays: less the live counts, it is the finished agents, those that stopped with
    // the process included, as the settled widget and explorer read them "stopped".
    const finished = (c: Record<string, number>) => c.total! - c.running! - c.queued! - c.waiting!;
    expect(finished(counts(model))).toBe(1);
    expect(finished(counts(after))).toBe(4);
    // The profile is the session's, saved with it: it survives.
    expect(after.profile).toEqual({
      name: "orchestrate",
      label: "Orchestrator",
      description: "Plans and delegates",
    });
  });

  it("carries the main agent's profile even with no subagents", () => {
    const model = subagentSummaryModel(snapshot(), {
      name: "reviewer",
      description: "Reviews changes",
    });
    expect(model.profile).toEqual({ name: "reviewer", description: "Reviews changes" });
    expect(counts(model).total).toBe(0);
  });
});

describe("summaryProfile", () => {
  it("leaves out a display name equal to the name, and empty text", () => {
    expect(summaryProfile({ name: " plan ", displayName: "plan", description: " " })).toEqual({
      name: "plan",
    });
    expect(summaryProfile({ name: "  ", description: "x" })).toBeUndefined();
  });
});
