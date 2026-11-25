import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { SubagentSnapshot } from "#src/observation/snapshot";
import { subagentExplorerModel } from "#src/ui/subagent-explorer";

const registry = new AgentTypeRegistry(() => new Map());
const NOW = 1_000_000;

function agent(
  overrides: Partial<SubagentSnapshot["agents"][number]> = {},
): SubagentSnapshot["agents"][number] {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Fix the retry loop",
    state: "completed",
    waitingOn: [],
    error: undefined,
    startedAt: NOW - 90_000,
    completedAt: NOW - 30_000,
    live: false,
    toolUses: 4,
    ...overrides,
  };
}

describe("subagentExplorerModel", () => {
  it("lists every agent on the branch with its state and facts inline", () => {
    const model = subagentExplorerModel(
      {
        agents: [
          agent({
            id: "run",
            state: "running",
            completedAt: undefined,
            note: "reading the queue",
            tokens: 1200,
          }),
          agent({ id: "bad", state: "error", note: "rate limited" }),
          agent(),
        ],
      },
      registry,
    );
    expect(model.title).toBe("Subagents");
    expect(model.items.map((item) => [item.id, item.badge])).toEqual([
      // Running lives in this process: a saved list reads "stopped" (see pi-surface's `live`).
      ["run", { text: "running", tone: "accent", live: { text: "stopped", tone: "dim" } }],
      ["bad", { text: "error", tone: "error" }],
      ["a1", { text: "done", tone: "success" }],
    ]);
    expect(model.items[0]!.label).toEqual([
      { text: "agent", tone: "accent" },
      { text: " — Fix the retry loop", tone: "muted" },
    ]);
    expect(model.items[0]!.detail).toEqual([
      {
        fields: [
          ["Agent", "agent"],
          ["Id", "run"],
          ["State", { text: "running", tone: "accent" }],
          ["Started", new Date(NOW - 90_000).toISOString()],
          ["Tool uses", "4"],
          ["Tokens", "1200"],
        ],
      },
      { heading: "Latest update" },
      { text: "reading the queue" },
      {
        text: "subagent_get reports its result; /subagent:sessions shows its transcript.",
        tone: "muted",
      },
    ]);
    expect(model.items[1]!.detail).toContainEqual({ text: "rate limited", tone: "error" });
    // A finished run's duration; a running one has none, as it would be stale once read.
    expect(model.items[2]!.detail).toContainEqual({
      fields: expect.arrayContaining([["Duration", "60.0s"]]),
    });
    expect(model.tabs).toEqual([
      { label: "All", ids: ["run", "bad", "a1"] },
      {
        label: "Active",
        ids: ["run"],
        emptyText: "No subagent is running, queued or waiting.",
      },
    ]);
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  it("says when the branch has no subagents", () => {
    const model = subagentExplorerModel({ agents: [] }, registry);
    expect(model.items).toEqual([]);
    expect(model.emptyText).toBe("No subagents on this branch.");
  });
});
