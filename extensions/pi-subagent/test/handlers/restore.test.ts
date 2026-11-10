import { describe, expect, it, vi } from "vitest";
import { StartupRestore, type StartupRestoreDeps } from "#src/handlers/restore";
import type { RestoredAgent } from "#src/lifecycle/subagent-manager";
import type { PersistedSubagentRecord } from "#src/persisted-record";

// The startup of the spawning session: adopt the spawner's items first, restore the agents, settle
// each item, and tell the parent once. Which session starts decides whether any of it happens.

const waiting = (id: string): PersistedSubagentRecord => ({
  version: 2,
  id,
  type: "general-purpose",
  description: `Agent ${id}`,
  status: "idle",
  outcome: "completed",
  result: undefined,
  error: undefined,
  turnBudget: undefined,
  startedAt: 1,
  completedAt: 2,
  outputFile: `/t/${id}.jsonl`,
  toolUses: 0,
  waitingOn: ["CI"],
});
const done = (id: string): PersistedSubagentRecord => {
  const { waitingOn: _waitingOn, ...rest } = waiting(id);
  return rest;
};
const running = (id: string): PersistedSubagentRecord => ({
  ...done(id),
  status: "running",
  outcome: undefined,
});

const found = (id: string, extra: Partial<RestoredAgent> = {}): RestoredAgent => ({
  id,
  type: "general-purpose",
  description: `Agent ${id}`,
  interrupted: false,
  lost: [],
  waitingOn: [],
  woken: false,
  continuing: false,
  ...extra,
});

function setup(records: PersistedSubagentRecord[], restored: RestoredAgent[] = []) {
  const order: string[] = [];
  const deps = {
    manager: {
      restore: vi.fn(async () => {
        order.push("restore");
        return restored;
      }),
    },
    work: {
      adopt: vi.fn(() => void order.push("adopt")),
      settle: vi.fn(() => void order.push("settle")),
    },
    readRecords: vi.fn(() => records),
    isChild: vi.fn(() => false),
    report: vi.fn(() => void order.push("report")),
  } satisfies StartupRestoreDeps;
  return { deps, order, handler: new StartupRestore(deps) };
}

describe("StartupRestore", () => {
  it("adopts the items before it restores, settles each agent, then reports once", async () => {
    const { deps, order, handler } = setup(
      [waiting("a"), done("b"), running("c")],
      [found("a", { continuing: true, waitingOn: ["CI"] }), found("c", { interrupted: true })],
    );
    await handler.handleSessionStart({ reason: "reload" }, {});

    // Only agents that were waiting or mid-run are looked at; the done one is not.
    expect(deps.work.adopt).toHaveBeenCalledWith(new Set(["a", "c"]));
    expect(deps.manager.restore).toHaveBeenCalledWith({
      records: [waiting("a"), done("b"), running("c")],
      startReason: "reload",
    });
    expect(order).toEqual(["adopt", "restore", "settle", "settle", "report"]);
    expect(deps.report).toHaveBeenCalledTimes(1);
    const [message] = deps.report.mock.calls[0] as unknown as [
      { customType: string; content: string },
    ];
    expect(message.customType).toBe("subagent:lost");
    expect(message.content).toContain("Subagent work lost: 1 agent");
    expect(message.content).toContain("c general-purpose");
    expect(message.content).not.toContain("- a ");
  });

  it("reports an agent that could not be reopened in time, once, without calling its work lost", async () => {
    const { deps, handler } = setup(
      [waiting("slow")],
      [found("slow", { unreachable: "timed-out" })],
    );
    await handler.handleSessionStart({ reason: "reload" }, {});
    expect(deps.work.settle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "slow", continuing: false }),
    );
    expect(deps.report).toHaveBeenCalledTimes(1);
    const [message] = deps.report.mock.calls[0] as unknown as [{ content: string }];
    expect(message.content).toContain("- slow general-purpose");
    expect(message.content).toContain("could not be reopened at startup");
    expect(message.content).not.toContain("lost watch");
  });

  it("says nothing when nothing was lost", async () => {
    const { deps, handler } = setup([waiting("a")], [found("a", { continuing: true })]);
    await handler.handleSessionStart({ reason: "reload" }, {});
    expect(deps.report).not.toHaveBeenCalled();
  });

  it.each([
    ["startup", "resume"],
    ["resume", "resume"],
    ["reload", "reload"],
  ])("a %s start reopens the agents as a %s", async (reason, startReason) => {
    const { deps, handler } = setup([waiting("a")]);
    await handler.handleSessionStart({ reason }, {});
    expect(deps.manager.restore).toHaveBeenCalledWith(expect.objectContaining({ startReason }));
  });

  it.each(["new", "fork"])(
    "a %s start restores nothing and adopts nothing: the agents are the source session's",
    async (reason) => {
      const { deps, handler } = setup([waiting("a")]);
      await handler.handleSessionStart({ reason }, {});
      expect(deps.manager.restore).not.toHaveBeenCalled();
      expect(deps.work.adopt).not.toHaveBeenCalled();
      expect(deps.report).not.toHaveBeenCalled();
    },
  );

  it("a delegated session restores nothing: its own subagents end with the reload that ended it", async () => {
    const { deps, handler } = setup([waiting("a")]);
    deps.isChild.mockReturnValue(true);
    await handler.handleSessionStart({ reason: "reload" }, {});
    expect(deps.manager.restore).not.toHaveBeenCalled();
    expect(deps.work.adopt).not.toHaveBeenCalled();
  });

  it("does nothing for a branch with no agent to restore, or no session", async () => {
    const { deps, handler } = setup([done("a")]);
    await handler.handleSessionStart({ reason: "reload" }, {});
    deps.readRecords.mockReturnValue(undefined as never);
    await handler.handleSessionStart({ reason: "reload" }, {});
    expect(deps.work.adopt).not.toHaveBeenCalled();
    expect(deps.manager.restore).not.toHaveBeenCalled();
  });

  it("settles every adopted item as not continuing when the restore itself fails", async () => {
    const { deps, handler } = setup([waiting("a"), running("b")]);
    deps.manager.restore.mockRejectedValue(new Error("boom"));
    await handler.handleSessionStart({ reason: "reload" }, {});
    expect(deps.work.settle).toHaveBeenCalledTimes(2);
    expect(deps.work.settle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", continuing: false }),
    );
    expect(deps.work.settle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b", continuing: false }),
    );
    expect(deps.report).not.toHaveBeenCalled();
  });
});
