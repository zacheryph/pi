import { describe, expect, it } from "vitest";
import {
  type DisplayStatus,
  displayStatus,
  isActiveStatus,
  isFailureOutcome,
  isRunningStatus,
  isTerminalErrorStatus,
  type RunOutcome,
  SubagentState,
  type SubagentStateInit,
  type SubagentStatus,
} from "#src/lifecycle/subagent-state";
import type { TurnBudget } from "#src/lifecycle/turn-limits";

const ALL_STATUSES: SubagentStatus[] = ["queued", "running", "idle"];
const ALL_OUTCOMES: RunOutcome[] = ["completed", "turn-limit", "error", "stopped", "interrupted"];
const ALL_DISPLAY_STATUSES: DisplayStatus[] = [
  "queued",
  "running",
  "completed",
  "aborted",
  "stopped",
  "error",
];

describe("SubagentState — constructor", () => {
  it("defaults status to 'queued'", () => {
    const state = new SubagentState();
    expect(state.status).toBe("queued");
  });

  it("defaults startedAt to Date.now() when not provided", () => {
    const before = Date.now();
    const state = new SubagentState();
    const after = Date.now();
    expect(state.startedAt).toBeGreaterThanOrEqual(before);
    expect(state.startedAt).toBeLessThanOrEqual(after);
  });

  it("defaults numeric counters to zero", () => {
    const state = new SubagentState();
    expect(state.toolUses).toBe(0);
    expect(state.compactionCount).toBe(0);
    expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
  });

  it("defaults live-activity fields", () => {
    const state = new SubagentState();
    expect(state.responseText).toBe("");
    expect(state.activeTools.size).toBe(0);
  });

  it("passes through optional transition fields", () => {
    const state = new SubagentState({
      status: "idle",
      outcome: "error",
      result: "done",
      error: "oops",
      startedAt: 1000,
      completedAt: 2000,
    });
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("error");
    expect(state.result).toBe("done");
    expect(state.error).toBe("oops");
    expect(state.startedAt).toBe(1000);
    expect(state.completedAt).toBe(2000);
  });

  it("has no outcome while a run is queued or running, whatever the init says", () => {
    expect(new SubagentState().outcome).toBeUndefined();
    expect(new SubagentState({ status: "running", outcome: "error" }).outcome).toBeUndefined();
  });

  it("defaults an idle agent's outcome to completed: an idle agent has finished a run", () => {
    expect(new SubagentState({ status: "idle" }).outcome).toBe("completed");
  });

  it("leaves optional fields undefined when not provided", () => {
    const state = new SubagentState();
    expect(state.result).toBeUndefined();
    expect(state.error).toBeUndefined();
    expect(state.completedAt).toBeUndefined();
  });
});

describe("SubagentState — constructor full-value seeding", () => {
  it("seeds stats fields", () => {
    const state = new SubagentState({
      toolUses: 4,
      lifetimeUsage: { input: 100, output: 200, cacheWrite: 30 },
      compactionCount: 2,
    });
    expect(state.toolUses).toBe(4);
    expect(state.lifetimeUsage).toEqual({ input: 100, output: 200, cacheWrite: 30 });
    expect(state.compactionCount).toBe(2);
  });

  it("copies lifetimeUsage so mutating the source does not change state", () => {
    const source = { input: 10, output: 20, cacheWrite: 5 };
    const state = new SubagentState({ lifetimeUsage: source });
    source.input = 999;
    expect(state.lifetimeUsage).toEqual({ input: 10, output: 20, cacheWrite: 5 });
  });

  it("seeds live-activity fields", () => {
    const state = new SubagentState({
      activeTools: ["read", "bash"],
      responseText: "partial output",
    });
    expect([...state.activeTools.values()]).toEqual(["read", "bash"]);
    expect(state.responseText).toBe("partial output");
  });

  it("seeds activeTools by name and stays removable by name", () => {
    const state = new SubagentState({ activeTools: ["read", "read"] });
    expect(state.activeTools.size).toBe(2);
    state.removeActiveTool("read");
    expect(state.activeTools.size).toBe(1);
    expect([...state.activeTools.values()]).toEqual(["read"]);
  });
});

describe("SubagentState — markRunning", () => {
  it("sets status to 'running' and updates startedAt", () => {
    const state = new SubagentState({ status: "queued", startedAt: 1000 });
    state.markRunning(2000);
    expect(state.status).toBe("running");
    expect(state.startedAt).toBe(2000);
  });

  it("clears the outcome of the run before", () => {
    const state = new SubagentState({ status: "idle", outcome: "error" });
    state.markRunning(2000);
    expect(state.outcome).toBeUndefined();
  });
});

describe("SubagentState — markCompleted", () => {
  it("goes idle with outcome completed, sets result and completedAt", () => {
    const state = new SubagentState({ status: "running" });
    state.markCompleted("all done", 5000);
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("completed");
    expect(state.result).toBe("all done");
    expect(state.completedAt).toBe(5000);
  });

  it("defaults completedAt to Date.now() when not provided", () => {
    const state = new SubagentState({ status: "running" });
    const before = Date.now();
    state.markCompleted("done");
    const after = Date.now();
    expect(state.completedAt).toBeGreaterThanOrEqual(before);
    expect(state.completedAt).toBeLessThanOrEqual(after);
  });

  it("preserves existing completedAt (??= semantics)", () => {
    const state = new SubagentState({ status: "running", completedAt: 1000 });
    state.markCompleted("done", 9999);
    expect(state.completedAt).toBe(1000);
  });

  it("keeps the outcome stopped when a stop came first, but still sets result and completedAt", () => {
    const state = new SubagentState({ status: "idle", outcome: "stopped", completedAt: 1000 });
    state.markCompleted("late result", 2000);
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("stopped");
    expect(state.result).toBe("late result");
    expect(state.completedAt).toBe(1000);
  });
});

describe("SubagentState — markTurnLimit", () => {
  it("goes idle with outcome turn-limit, with result and completedAt", () => {
    const state = new SubagentState({ status: "running" });
    state.markTurnLimit("partial result", 3000);
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("turn-limit");
    expect(state.result).toBe("partial result");
    expect(state.completedAt).toBe(3000);
  });

  it("keeps the outcome stopped when a stop came first, but still sets result", () => {
    const state = new SubagentState({ status: "idle", outcome: "stopped", completedAt: 500 });
    state.markTurnLimit("partial", 2000);
    expect(state.outcome).toBe("stopped");
    expect(state.result).toBe("partial");
    expect(state.completedAt).toBe(500);
  });
});

describe("SubagentState — markError", () => {
  it("goes idle with outcome error and formats Error objects to .message", () => {
    const state = new SubagentState({ status: "running" });
    state.markError(new Error("something broke"), 6000);
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("error");
    expect(state.error).toBe("something broke");
    expect(state.completedAt).toBe(6000);
  });

  it("formats non-Error values with String()", () => {
    const state = new SubagentState({ status: "running" });
    state.markError(42, 6000);
    expect(state.error).toBe("42");
  });

  it("keeps the outcome stopped when a stop came first, but still sets error and completedAt", () => {
    const state = new SubagentState({ status: "idle", outcome: "stopped", completedAt: 1000 });
    state.markError(new Error("late error"), 2000);
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("stopped");
    expect(state.error).toBe("late error");
    expect(state.completedAt).toBe(1000);
  });

  it("preserves existing completedAt (??= semantics)", () => {
    const state = new SubagentState({ status: "running", completedAt: 1000 });
    state.markError(new Error("err"), 9999);
    expect(state.completedAt).toBe(1000);
  });
});

describe("SubagentState — markStopped", () => {
  it("ends the run: idle with outcome stopped, and completedAt", () => {
    const state = new SubagentState({ status: "running" });
    state.markStopped(7000);
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("stopped");
    expect(state.completedAt).toBe(7000);
  });

  it("defaults completedAt to Date.now() when not provided", () => {
    const state = new SubagentState({ status: "running" });
    const before = Date.now();
    state.markStopped();
    const after = Date.now();
    expect(state.completedAt).toBeGreaterThanOrEqual(before);
    expect(state.completedAt).toBeLessThanOrEqual(after);
  });

  it("overwrites any previous outcome — no guard", () => {
    const state = new SubagentState({ status: "idle", outcome: "completed" });
    state.markStopped(8000);
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("stopped");
  });

  it("leaves stoppedWhileQueued false — the agent had started", () => {
    const state = new SubagentState({ status: "running" });
    state.markStopped(8000);
    expect(state.stoppedWhileQueued).toBe(false);
  });
});

describe("SubagentState — stopQueued", () => {
  it("leaves the agent idle with outcome stopped, and sets completedAt", () => {
    const state = new SubagentState({ status: "queued" });
    state.stopQueued(7000);
    expect(state.status).toBe("idle");
    expect(state.outcome).toBe("stopped");
    expect(state.completedAt).toBe(7000);
  });

  it("records that the agent never started", () => {
    const state = new SubagentState({ status: "queued" });
    expect(state.stoppedWhileQueued).toBe(false);
    state.stopQueued(7000);
    expect(state.stoppedWhileQueued).toBe(true);
  });

  it("defaults completedAt to Date.now() when not provided", () => {
    const state = new SubagentState({ status: "queued" });
    const before = Date.now();
    state.stopQueued();
    const after = Date.now();
    expect(state.completedAt).toBeGreaterThanOrEqual(before);
    expect(state.completedAt).toBeLessThanOrEqual(after);
  });

  it("stops an already-running agent without claiming it never started", () => {
    const state = new SubagentState({ status: "running" });
    state.stopQueued(7000);
    expect(state.outcome).toBe("stopped");
    expect(state.stoppedWhileQueued).toBe(false);
  });

  it("seeds stoppedWhileQueued from init", () => {
    const state = new SubagentState({
      status: "idle",
      outcome: "stopped",
      stoppedWhileQueued: true,
    });
    expect(state.stoppedWhileQueued).toBe(true);
  });
});

describe("SubagentState — incrementToolUses", () => {
  it("starts at 0 and increments by 1 each call", () => {
    const state = new SubagentState();
    expect(state.toolUses).toBe(0);
    state.incrementToolUses();
    expect(state.toolUses).toBe(1);
    state.incrementToolUses();
    expect(state.toolUses).toBe(2);
  });
});

describe("SubagentState — addUsage", () => {
  it("accumulates usage deltas into lifetimeUsage", () => {
    const state = new SubagentState();
    expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    state.addUsage({ input: 100, output: 50, cacheWrite: 10 });
    expect(state.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });
    state.addUsage({ input: 200, output: 80, cacheWrite: 20 });
    expect(state.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
  });
});

describe("SubagentState — incrementCompactions", () => {
  it("starts at 0 and increments by 1 each call", () => {
    const state = new SubagentState();
    expect(state.compactionCount).toBe(0);
    state.incrementCompactions();
    expect(state.compactionCount).toBe(1);
    state.incrementCompactions();
    expect(state.compactionCount).toBe(2);
  });
});

describe("SubagentState — markQueued", () => {
  it("queues the agent again with a new startedAt and no outcome", () => {
    const state = new SubagentState({ status: "idle", outcome: "completed", startedAt: 1000 });
    state.markQueued(9000);
    expect(state.status).toBe("queued");
    expect(state.outcome).toBeUndefined();
    expect(state.startedAt).toBe(9000);
  });

  it("clears completedAt, result, and error: they belong to the run it replaces", () => {
    const state = new SubagentState({
      status: "idle",
      outcome: "error",
      result: "old result",
      error: "old error",
      completedAt: 5000,
    });
    state.markQueued(9000);
    expect(state.completedAt).toBeUndefined();
    expect(state.result).toBeUndefined();
    expect(state.error).toBeUndefined();
  });

  it("clears consumedAt so a resumed run's result is unread again", () => {
    const state = new SubagentState({ status: "idle", consumedAt: 5000 });
    state.markQueued(9000);
    expect(state.consumedAt).toBeUndefined();
    expect(state.consumed).toBe(false);
  });

  it("forgets that an earlier run was stopped before it started", () => {
    const state = new SubagentState({ status: "queued" });
    state.stopQueued(1000);
    state.markQueued(9000);
    expect(state.stoppedWhileQueued).toBe(false);
  });
});

describe("SubagentState — turn budget", () => {
  const WITHIN: TurnBudget = { maxTurns: 5, used: 1, phase: "within" };
  const WARNED: TurnBudget = { maxTurns: 5, used: 3, phase: "warned" };
  const EXHAUSTED: TurnBudget = { maxTurns: 5, used: 5, phase: "exhausted" };

  it("has no budget until a run's turn loop reports one", () => {
    expect(new SubagentState().turnBudget).toBeUndefined();
  });

  it("seeds the budget from init", () => {
    expect(new SubagentState({ turnBudget: WARNED }).turnBudget).toEqual(WARNED);
  });

  it("records each budget the running turn loop reports", () => {
    const state = new SubagentState({ status: "running" });
    state.setTurnBudget(WITHIN);
    expect(state.turnBudget).toEqual(WITHIN);
    state.setTurnBudget(WARNED);
    expect(state.turnBudget).toEqual(WARNED);
  });

  it("keeps the live budget through a terminal transition", () => {
    const state = new SubagentState({ status: "running" });
    state.setTurnBudget(EXHAUSTED);
    state.markTurnLimit("partial", 5000);
    expect(state.turnBudget).toEqual(EXHAUSTED);
  });

  it("a stop during the warned phase keeps stopped and the budget the loop reached", () => {
    const state = new SubagentState({ status: "running" });
    state.setTurnBudget(WARNED);
    state.markStopped(500);
    state.markCompleted("late", 2000);
    expect(state.outcome).toBe("stopped");
    expect(state.turnBudget).toEqual(WARNED);
  });

  it("markQueued clears the budget, which belongs to the run that produced it", () => {
    const state = new SubagentState({ status: "idle", turnBudget: WARNED });
    state.markQueued(9000);
    expect(state.turnBudget).toBeUndefined();
  });
});

describe("SubagentState — consumption", () => {
  it("defaults to not consumed", () => {
    const state = new SubagentState();
    expect(state.consumed).toBe(false);
    expect(state.consumedAt).toBeUndefined();
  });

  it("markConsumed sets consumedAt and flips consumed true", () => {
    const state = new SubagentState({ status: "idle" });
    state.markConsumed(5000);
    expect(state.consumed).toBe(true);
    expect(state.consumedAt).toBe(5000);
  });

  it("markConsumed defaults consumedAt to Date.now() when not provided", () => {
    const state = new SubagentState({ status: "idle" });
    const before = Date.now();
    state.markConsumed();
    const after = Date.now();
    expect(state.consumedAt).toBeGreaterThanOrEqual(before);
    expect(state.consumedAt).toBeLessThanOrEqual(after);
  });

  it("markConsumed keeps the first read time (idempotent ??=)", () => {
    const state = new SubagentState({ status: "idle" });
    state.markConsumed(5000);
    state.markConsumed(9999);
    expect(state.consumedAt).toBe(5000);
  });

  it("seeds consumedAt from the constructor", () => {
    const state = new SubagentState({ status: "idle", consumedAt: 4200 });
    expect(state.consumed).toBe(true);
    expect(state.consumedAt).toBe(4200);
  });

  it("forgets a read made while the agent still waited when its work runs out", () => {
    // Finishing without a run re-stamps the end time (retention starts there); a read from before
    // was of an unfinished result and must not pick the short window.
    const state = new SubagentState({ status: "idle", completedAt: 1000, consumedAt: 2000 });
    state.markFinishedWithoutRun(9000);
    expect(state.completedAt).toBe(9000);
    expect(state.consumed).toBe(false);
  });
});

describe("SubagentState — activeTools", () => {
  it("defaults to an empty map", () => {
    const state = new SubagentState();
    expect(state.activeTools.size).toBe(0);
  });

  it("addActiveTool adds a tool by name", () => {
    const state = new SubagentState();
    state.addActiveTool("Read");
    expect(state.activeTools.size).toBe(1);
    expect([...state.activeTools.values()]).toContain("Read");
  });

  it("addActiveTool assigns unique keys for concurrent same-name tools", () => {
    const state = new SubagentState();
    state.addActiveTool("Read");
    state.addActiveTool("Read");
    expect(state.activeTools.size).toBe(2);
    expect([...state.activeTools.values()]).toEqual(["Read", "Read"]);
    const keys = [...state.activeTools.keys()];
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("removeActiveTool removes the first matching tool by name", () => {
    const state = new SubagentState();
    state.addActiveTool("Read");
    state.addActiveTool("Write");
    state.removeActiveTool("Read");
    expect(state.activeTools.size).toBe(1);
    expect([...state.activeTools.values()]).toContain("Write");
    expect([...state.activeTools.values()]).not.toContain("Read");
  });

  it("removeActiveTool removes only one entry when two same-name tools are active", () => {
    const state = new SubagentState();
    state.addActiveTool("Read");
    state.addActiveTool("Read");
    state.removeActiveTool("Read");
    expect(state.activeTools.size).toBe(1);
    expect([...state.activeTools.values()]).toEqual(["Read"]);
  });

  it("removeActiveTool is a no-op when the tool is not active", () => {
    const state = new SubagentState();
    state.addActiveTool("Read");
    state.removeActiveTool("Write"); // not present
    expect(state.activeTools.size).toBe(1);
  });

  it("activeTools getter returns a ReadonlyMap", () => {
    const state = new SubagentState();
    state.addActiveTool("Read");
    const tools = state.activeTools;
    // Verify it's a Map (ReadonlyMap is Map at runtime)
    expect(tools).toBeInstanceOf(Map);
    expect(tools.size).toBe(1);
  });
});

describe("SubagentState — responseText", () => {
  it("defaults to an empty string", () => {
    const state = new SubagentState();
    expect(state.responseText).toBe("");
  });

  it("appendResponseText concatenates text deltas", () => {
    const state = new SubagentState();
    state.appendResponseText("Hello ");
    state.appendResponseText("world");
    expect(state.responseText).toBe("Hello world");
  });

  it("resetResponseText clears accumulated text", () => {
    const state = new SubagentState();
    state.appendResponseText("previous text");
    state.resetResponseText();
    expect(state.responseText).toBe("");
  });

  it("appendResponseText works after a reset", () => {
    const state = new SubagentState();
    state.appendResponseText("first message");
    state.resetResponseText();
    state.appendResponseText("second message");
    expect(state.responseText).toBe("second message");
  });
});

describe("SubagentState — classification predicates", () => {
  const active = new Set<SubagentStatus | DisplayStatus>(["running", "queued"]);
  const terminalError = new Set<SubagentStatus | DisplayStatus>(["error", "stopped", "aborted"]);
  const running = new Set<SubagentStatus | DisplayStatus>(["running"]);

  describe("exported status-level functions, over statuses and display labels alike", () => {
    for (const status of [...ALL_STATUSES, ...ALL_DISPLAY_STATUSES]) {
      it(`isActiveStatus("${status}") is ${active.has(status)}`, () => {
        expect(isActiveStatus(status)).toBe(active.has(status));
      });
      it(`isTerminalErrorStatus("${status}") is ${terminalError.has(status)}`, () => {
        expect(isTerminalErrorStatus(status)).toBe(terminalError.has(status));
      });
      it(`isRunningStatus("${status}") is ${running.has(status)}`, () => {
        expect(isRunningStatus(status)).toBe(running.has(status));
      });
    }
  });

  describe("isFailureOutcome", () => {
    for (const outcome of ALL_OUTCOMES) {
      it(`is ${outcome !== "completed"} for "${outcome}"`, () => {
        expect(isFailureOutcome(outcome)).toBe(outcome !== "completed");
      });
    }
    it("is false while there is no outcome", () => {
      expect(isFailureOutcome(undefined)).toBe(false);
    });
  });

  describe("instance predicates follow the status and the last outcome", () => {
    for (const status of ["queued", "running"] as const) {
      it(`"${status}": active, never a terminal error, steerable only when running`, () => {
        const state = new SubagentState({ status });
        expect(state.isActive()).toBe(true);
        expect(state.isTerminalError()).toBe(false);
        expect(state.isRunning()).toBe(status === "running");
        expect(state.canBeSteered()).toBe(status === "running");
      });
    }
    for (const outcome of ALL_OUTCOMES) {
      it(`idle after "${outcome}": not active, not steerable, terminal error is ${outcome !== "completed"}`, () => {
        const state = new SubagentState({ status: "idle", outcome });
        expect(state.isActive()).toBe(false);
        expect(state.isRunning()).toBe(false);
        expect(state.canBeSteered()).toBe(false);
        expect(state.isTerminalError()).toBe(outcome !== "completed");
      });
    }
  });
});

describe("displayStatus — today's labels derived from status and outcome", () => {
  const cases: Array<[SubagentStatus, RunOutcome | undefined, DisplayStatus]> = [
    ["queued", undefined, "queued"],
    ["running", undefined, "running"],
    ["idle", "completed", "completed"],
    ["idle", "turn-limit", "aborted"],
    ["idle", "error", "error"],
    ["idle", "stopped", "stopped"],
    // A run a reload cut short has always read as stopped once its record was rebuilt.
    ["idle", "interrupted", "stopped"],
  ];
  for (const [status, outcome, label] of cases) {
    it(`${status} + ${outcome ?? "no outcome"} reads "${label}"`, () => {
      expect(displayStatus(status, outcome)).toBe(label);
      expect(new SubagentState({ status, outcome }).displayStatus).toBe(label);
    });
  }
});

describe("SubagentState — run updates", () => {
  it("starts with none", () => {
    expect(new SubagentState().runUpdates).toEqual([]);
  });

  it("keeps the order the child sent them in", () => {
    const state = new SubagentState();

    state.recordUpdate("The bug is in the retry wrapper.");
    state.recordUpdate("The fixture is stale too.");

    expect(state.runUpdates).toEqual([
      "The bug is in the retry wrapper.",
      "The fixture is stale too.",
    ]);
  });

  it("drops the previous run's updates when a fresh run starts", () => {
    const state = new SubagentState();
    state.recordUpdate("From the first run.");

    state.markRunning(1000);

    expect(state.runUpdates).toEqual([]);
  });

  it("drops the previous run's updates when a resume is queued", () => {
    const state = new SubagentState();
    state.recordUpdate("From the run being resumed.");

    state.markQueued(2000);

    expect(state.runUpdates).toEqual([]);
  });

  it("cannot be seeded from a rehydrated record", () => {
    // Transient runtime state: a rehydrated record has
    // no run to have produced it.
    const state = new SubagentState({ runUpdates: ["seeded"] } as unknown as SubagentStateInit);

    expect(state.runUpdates).toEqual([]);
  });

  describe("the announcement latch", () => {
    it("omits a message the announcement channel delivered", () => {
      const state = new SubagentState();
      state.recordUpdate("Announced already.");
      state.recordUpdate("Still owed to the completion message.");

      state.markUpdateAnnounced("Announced already.");

      expect(state.runUpdates).toEqual(["Still owed to the completion message."]);
    });

    it("marks the first unannounced copy, leaving a later duplicate owed", () => {
      const state = new SubagentState();
      state.recordUpdate("Same finding twice.");
      state.recordUpdate("Same finding twice.");

      state.markUpdateAnnounced("Same finding twice.");

      expect(state.runUpdates).toEqual(["Same finding twice."]);
    });

    it("ignores a message this run never produced", () => {
      const state = new SubagentState();
      state.recordUpdate("From this run.");

      state.markUpdateAnnounced("From a run that was reset.");

      expect(state.runUpdates).toEqual(["From this run."]);
    });
  });
});
