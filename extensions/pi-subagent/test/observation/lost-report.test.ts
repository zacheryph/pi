import { describe, expect, it } from "vitest";
import {
  type LostAgent,
  type LostDetails,
  LOST_TYPE,
  lostReport,
} from "#src/observation/lost-report";

const agent = (id: string, extra: Partial<LostAgent> = {}): LostAgent => ({
  id,
  type: "general-purpose",
  description: `Agent ${id}`,
  interrupted: false,
  lost: [],
  waitingOn: [],
  ...extra,
});

describe("lostReport", () => {
  it("is nothing when no agent lost anything", () => {
    expect(lostReport([])).toBeUndefined();
    expect(lostReport([agent("a", { waitingOn: ["answer"] })])).toBeUndefined();
  });

  it("lists each agent that lost work, once, and what it lost and still waits on", () => {
    const message = lostReport([
      agent("a", { lost: [{ kind: "watch", label: "CI" }, { label: "tests" }] }),
      agent("b", { interrupted: true }),
      agent("c", {
        interrupted: true,
        lost: [{ kind: "subagent", label: "Fix" }],
        waitingOn: ["answer"],
      }),
      agent("fine"),
    ])!;
    expect(message.customType).toBe(LOST_TYPE);
    const lines = (message.content as string).split("\n");
    expect(lines[0]).toContain("Subagent work lost: 3 agents lost work");
    expect(lines.slice(1)).toEqual([
      '- a general-purpose "Agent a": lost watch "CI", "tests"',
      '- b general-purpose "Agent b": its run was interrupted and did not finish',
      '- c general-purpose "Agent c": its run was interrupted and did not finish; lost subagent "Fix"; still waiting on "answer"',
    ]);
    expect(message.content).toContain("Nothing was restarted");
    expect(message.details).toMatchObject({
      agents: [{ id: "a" }, { id: "b", interrupted: true }, { id: "c", waitingOn: ["answer"] }],
    });
  });

  it("flattens and clips what an agent wrote, so one agent is one line", () => {
    const message = lostReport([
      agent("a", {
        description: `Line one\n${"x".repeat(200)}\u001b[31mred`,
        lost: [{ kind: "watch", label: `CI\nrun ${"y".repeat(300)}` }],
      }),
    ])!;
    const lines = (message.content as string).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain("\u001b");
    expect(lines[1].length).toBeLessThan(300);
  });

  it("caps the agents and the items it spells out, and counts what it left out", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      agent(`a${i}`, { lost: Array.from({ length: 12 }, (_, j) => ({ label: `item ${j}` })) }),
    );
    const message = lostReport(many)!;
    const lines = (message.content as string).split("\n");
    expect(lines).toHaveLength(1 + 30 + 1);
    expect(lines.at(-1)).toBe("- and 10 more agents");
    expect(lines[1]).toContain("and 4 more");
    const details = message.details as unknown as LostDetails;
    expect(details.totalAgents).toBe(40);
    expect(details.agents).toHaveLength(30);
    expect(details.agents[0].lost).toHaveLength(8);
    expect(details.agents[0].lostCount).toBe(12);
  });

  it("keeps the details small for hostile input: hundreds of agents with hundreds of long items", () => {
    const hostile = Array.from({ length: 500 }, (_, i) =>
      agent(`${i}-${"i".repeat(500)}`, {
        type: "t".repeat(5000),
        description: "d".repeat(5000),
        interrupted: true,
        lost: Array.from({ length: 50 }, () => ({
          kind: "k".repeat(1000),
          label: "x".repeat(10_000),
        })),
        waitingOn: Array.from({ length: 50 }, () => "w".repeat(10_000)),
      }),
    );
    const message = lostReport(hostile)!;
    const details = message.details as unknown as LostDetails;
    expect(details.totalAgents).toBe(500);
    expect(details.agents).toHaveLength(30);
    for (const entry of details.agents) {
      expect(entry.lost).toHaveLength(8);
      expect(entry.lostCount).toBe(50);
      expect(entry.waitingOn).toHaveLength(8);
      expect(entry.waitingOnCount).toBe(50);
      expect(entry.id.length).toBeLessThanOrEqual(40);
      expect(entry.description.length).toBeLessThanOrEqual(200);
      expect(entry.lost[0].label.length).toBeLessThanOrEqual(200);
    }
    expect(JSON.stringify(message.details).length).toBeLessThan(200_000);
    expect((message.content as string).length).toBeLessThan(100_000);
  });

  it("escapes quotes and backslashes in what an agent wrote, so a label cannot end its quoted text early", () => {
    const message = lostReport([
      agent("a", {
        description: 'Fix "the" parser\\',
        lost: [{ kind: "watch", label: 'CI "main" \\ branch' }],
        waitingOn: ['say "hi"'],
      }),
    ])!;
    const text = (message.content as string).split("\n")[1];
    expect(text).toBe(
      '- a general-purpose "Fix \\"the\\" parser\\\\": lost watch "CI \\"main\\" \\\\ branch"; still waiting on "say \\"hi\\""',
    );
    // The data in the details is not escaped: it is data, not text.
    expect((message.details as unknown as LostDetails).agents[0].lost[0].label).toBe(
      'CI "main" \\ branch',
    );
  });

  it("says a timed-out agent could not be reopened, without claiming it lost anything", () => {
    const message = lostReport([
      agent("slow", { timedOut: true }),
      agent("b", { lost: [{ kind: "watch", label: "CI" }] }),
    ])!;
    const content = message.content as string;
    expect(content).toContain("Subagent startup report: 2 agents to report");
    expect(content).toContain("1 lost work or was interrupted, 1 could not be reopened");
    expect(content).toContain("was not checked");
    const lines = content.split("\n");
    expect(lines.find((l) => l.startsWith("- slow"))).toBe(
      '- slow general-purpose "Agent slow": could not be reopened at startup (opening its session took too long), so its work was not checked',
    );
    expect(lines.find((l) => l.startsWith("- slow"))).not.toContain("lost");
    expect((message.details as unknown as LostDetails).agents[0]).toMatchObject({
      id: "slow",
      timedOut: true,
      lostCount: 0,
    });
    // An agent that timed out is reported even though it has nothing else to say.
    expect(lostReport([agent("slow", { timedOut: true })])).toBeDefined();
  });
});
