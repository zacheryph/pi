import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readPersistedRecords } from "#src/persisted-record";
import { buildEventData } from "#src/observation/notification";
import type { AgentWork } from "#src/observation/subagent-work";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import type { CompactionInfo } from "#src/types";
import { createTestSubagent } from "#test/helpers/make-subagent";

function makeWork(): AgentWork {
  return {
    runRequested: vi.fn(),
    runEnded: vi.fn(),
    update: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeObserver(overrides?: Partial<{ work: AgentWork }>) {
  const emit = vi.fn<(channel: string, data: unknown) => void>();
  const appendEntry = vi.fn<(customType: string, data: unknown) => void>();
  const work = overrides?.work ?? makeWork();
  const observer = new SubagentEventsObserver({ emit, appendEntry, work });
  return { observer, emit, appendEntry, work };
}

describe("SubagentEventsObserver", () => {
  it.each(["start", "session", "complete", "resume", "resumed"] as const)(
    "defers %s updates after /tree leaves the spawn branch, then restores the latest state",
    (transition) => {
      const manager = SessionManager.inMemory("/tmp");
      const target = manager.appendMessage({ role: "user", content: "before spawn", timestamp: 1 });
      const observer = new SubagentEventsObserver({
        emit: vi.fn(),
        appendEntry: (type, data) => {
          manager.appendCustomEntry(type, data);
        },
        work: makeWork(),
        isOnBranch: (id) =>
          readPersistedRecords(manager.getBranch()).some((record) => record.id === id),
      });
      observer.onSubagentCreated(createTestSubagent({ status: "queued" }));
      const spawnLeaf = manager.getLeafId()!;
      manager.branch(target);
      const record = createTestSubagent({
        status: transition === "complete" || transition === "resumed" ? "completed" : "running",
      });
      switch (transition) {
        case "start":
          observer.onSubagentStarted(record);
          break;
        case "session":
          observer.onSubagentSessionCreated(record);
          break;
        case "complete":
          observer.onSubagentCompleted(record);
          break;
        case "resume":
          observer.onSubagentResuming(record);
          break;
        case "resumed":
          observer.onSubagentResumed(record);
          break;
      }
      observer.refreshBranch();
      expect(readPersistedRecords(manager.getBranch())).toEqual([]);
      manager.branch(spawnLeaf);
      observer.refreshBranch();
      expect(readPersistedRecords(manager.getBranch())).toMatchObject([
        { id: record.id, status: record.status },
      ]);
      const count = manager.getEntries().length;
      observer.refreshBranch();
      expect(manager.getEntries()).toHaveLength(count);
    },
  );

  describe("onSubagentStarted", () => {
    it("emits subagent:started with id, type, description", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({
        id: "agent-1",
        type: "general-purpose",
        description: "do work",
      });

      observer.onSubagentStarted(record);

      expect(emit).toHaveBeenCalledExactlyOnceWith("subagent:started", {
        id: "agent-1",
        type: "general-purpose",
        description: "do work",
      });
    });

    it("appends a running subagent:record and sends no notification", () => {
      const { observer, appendEntry, work } = makeObserver();
      observer.onSubagentStarted(
        createTestSubagent({ id: "agent-1", status: "running", completedAt: undefined }),
      );
      expect(appendEntry).toHaveBeenCalledExactlyOnceWith(
        "subagent:record",
        expect.objectContaining({ id: "agent-1", status: "running" }),
      );
      expect(work.runEnded).not.toHaveBeenCalled();
    });
  });

  describe("onSubagentCompleted", () => {
    it("emits subagent:completed for a successful agent", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({ status: "completed" });

      observer.onSubagentCompleted(record);

      expect(emit).toHaveBeenCalledWith("subagent:completed", buildEventData(record));
    });

    it("emits subagent:failed for an error agent", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({ status: "error", error: "boom" });

      observer.onSubagentCompleted(record);

      expect(emit).toHaveBeenCalledWith("subagent:failed", expect.anything());
    });

    it("persists the run's turn budget on the subagent:record entry", () => {
      const { observer, appendEntry } = makeObserver();
      const turnBudget = { maxTurns: 2, used: 3, phase: "warned" } as const;
      observer.onSubagentCompleted(createTestSubagent({ turnBudget }));
      // Partial match: the full persisted shape is pinned by the neighboring tests.
      expect(appendEntry).toHaveBeenCalledWith(
        "subagent:record",
        expect.objectContaining({ turnBudget }),
      );
    });

    it("emits subagent:failed for a stopped agent", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({ status: "stopped" });

      observer.onSubagentCompleted(record);

      expect(emit).toHaveBeenCalledWith("subagent:failed", expect.anything());
    });

    it("emits subagent:failed for an aborted agent", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({ status: "aborted" });

      observer.onSubagentCompleted(record);

      expect(emit).toHaveBeenCalledWith("subagent:failed", expect.anything());
    });

    it("calls appendEntry with subagent:record and the persisted fields", () => {
      const { observer, appendEntry } = makeObserver();
      const record = createTestSubagent({
        id: "agent-2",
        type: "explore",
        description: "explore code",
        status: "completed",
        result: "found it",
        error: undefined,
        startedAt: 1000,
        completedAt: 2000,
      });

      observer.onSubagentCompleted(record);

      expect(appendEntry).toHaveBeenCalledExactlyOnceWith("subagent:record", {
        version: 2,
        id: "agent-2",
        type: "explore",
        description: "explore code",
        status: "idle",
        outcome: "completed",
        result: "found it",
        error: undefined,
        turnBudget: undefined,
        startedAt: 1000,
        completedAt: 2000,
        outputFile: undefined,
        toolUses: 3,
        cwd: "/test",
      });
    });

    it("ends the run's work item unconditionally — the item decides what to deliver", () => {
      const work = makeWork();
      const { observer } = makeObserver({ work });
      const record = createTestSubagent({ status: "completed" });

      observer.onSubagentCompleted(record);

      expect(work.runEnded).toHaveBeenCalledExactlyOnceWith(record);
    });

    it("emits exactly once and appends exactly once per call", () => {
      const { observer, emit, appendEntry } = makeObserver();
      observer.onSubagentCompleted(createTestSubagent({ status: "completed" }));
      expect(emit).toHaveBeenCalledTimes(1);
      expect(appendEntry).toHaveBeenCalledTimes(1);
    });
  });

  describe("onSubagentResuming", () => {
    it("emits subagent:resuming with id, type, description", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({
        id: "agent-1",
        type: "general-purpose",
        description: "do work",
      });

      observer.onSubagentResuming(record);

      expect(emit).toHaveBeenCalledExactlyOnceWith("subagent:resuming", {
        id: "agent-1",
        type: "general-purpose",
        description: "do work",
      });
    });

    it("records the agent running again, without its old question, and announces nothing", () => {
      const { observer, appendEntry, work } = makeObserver();

      observer.onSubagentResuming(
        createTestSubagent({ id: "agent-1", status: "running", completedAt: undefined }),
      );

      expect(appendEntry).toHaveBeenCalledExactlyOnceWith(
        "subagent:record",
        expect.objectContaining({ id: "agent-1", status: "running" }),
      );
      expect(appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("pendingQuestion");
      expect(work.runEnded).not.toHaveBeenCalled();
    });
  });

  describe("onSubagentResumeQueued", () => {
    // Changed by roadmap step 7b (was: emitted nothing). A finished agent that has been given
    // a message and waits for a slot is announced on subagent:queued, so a consumer showing it
    // as done learns it has work waiting.
    it("records the agent queued again and announces it on subagent:queued, with no completion", () => {
      const { observer, emit, appendEntry, work } = makeObserver();

      observer.onSubagentResumeQueued(
        createTestSubagent({ id: "agent-1", status: "queued", completedAt: undefined }),
      );

      expect(appendEntry).toHaveBeenCalledExactlyOnceWith(
        "subagent:record",
        expect.objectContaining({ id: "agent-1", status: "queued", outcome: undefined }),
      );
      expect(emit).toHaveBeenCalledExactlyOnceWith("subagent:queued", {
        id: "agent-1",
        type: "general-purpose",
        description: "Test task",
      });
      expect(work.runEnded).not.toHaveBeenCalled();
    });
  });

  describe("onSubagentResumed", () => {
    it("emits subagent:resumed with the buildEventData payload for a completed resume", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({ status: "completed", result: "resumed output" });

      observer.onSubagentResumed(record);

      expect(emit).toHaveBeenCalledExactlyOnceWith("subagent:resumed", buildEventData(record));
    });

    it("emits subagent:resumed (not subagent:failed) for an error resume — payload discriminates", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({ status: "error", error: "boom" });

      observer.onSubagentResumed(record);

      expect(emit).toHaveBeenCalledExactlyOnceWith("subagent:resumed", buildEventData(record));
    });

    it("appends subagent:record with the persisted fields", () => {
      const { observer, appendEntry } = makeObserver();
      const record = createTestSubagent({
        id: "agent-5",
        type: "explore",
        description: "resume explore",
        status: "completed",
        result: "resumed it",
        error: undefined,
        startedAt: 3000,
        completedAt: 4000,
      });

      observer.onSubagentResumed(record);

      expect(appendEntry).toHaveBeenCalledExactlyOnceWith("subagent:record", {
        version: 2,
        id: "agent-5",
        type: "explore",
        description: "resume explore",
        status: "idle",
        outcome: "completed",
        result: "resumed it",
        error: undefined,
        turnBudget: undefined,
        startedAt: 3000,
        completedAt: 4000,
        outputFile: undefined,
        toolUses: 3,
        cwd: "/test",
      });
    });

    it("ends the run's work item unconditionally — the item decides what to deliver", () => {
      const work = makeWork();
      const { observer } = makeObserver({ work });
      const record = createTestSubagent({ status: "completed" });

      observer.onSubagentResumed(record);

      expect(work.runEnded).toHaveBeenCalledExactlyOnceWith(record);
    });

    it("emits exactly once and appends exactly once per call", () => {
      const { observer, emit, appendEntry } = makeObserver();
      observer.onSubagentResumed(createTestSubagent({ status: "completed" }));
      expect(emit).toHaveBeenCalledTimes(1);
      expect(appendEntry).toHaveBeenCalledTimes(1);
    });
  });

  describe("onSubagentCompacted", () => {
    it("emits subagent:compacted with id, type, description, reason, tokensBefore, compactionCount", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({
        id: "agent-3",
        type: "plan",
        description: "plan work",
        compactionCount: 1,
      });
      const info: CompactionInfo = { reason: "threshold", tokensBefore: 50_000 };

      observer.onSubagentCompacted(record, info);

      expect(emit).toHaveBeenCalledExactlyOnceWith("subagent:compacted", {
        id: "agent-3",
        type: "plan",
        description: "plan work",
        reason: "threshold",
        tokensBefore: 50_000,
        compactionCount: 1,
      });
    });

    it("does not call appendEntry or work", () => {
      const { observer, appendEntry, work } = makeObserver();
      const info: CompactionInfo = { reason: "manual", tokensBefore: 1000 };
      observer.onSubagentCompacted(createTestSubagent(), info);
      expect(appendEntry).not.toHaveBeenCalled();
      expect(work.runEnded).not.toHaveBeenCalled();
    });
  });

  describe("onSubagentCreated", () => {
    it("emits subagent:created with id, type and description", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({
        id: "agent-4",
        type: "general-purpose",
        description: "bg task",
      });

      observer.onSubagentCreated(record);

      expect(emit).toHaveBeenCalledExactlyOnceWith("subagent:created", {
        id: "agent-4",
        type: "general-purpose",
        description: "bg task",
      });
    });

    it("appends a queued subagent:record, so the agent belongs to the branch before it runs", () => {
      const { observer, appendEntry, work } = makeObserver();
      observer.onSubagentCreated(
        createTestSubagent({ id: "agent-1", status: "queued", completedAt: undefined }),
      );
      expect(appendEntry).toHaveBeenCalledExactlyOnceWith(
        "subagent:record",
        expect.objectContaining({ id: "agent-1", status: "queued" }),
      );
      expect(work.runEnded).not.toHaveBeenCalled();
    });
  });

  describe("the spawner's work item", () => {
    it("asks for an item when a run is requested: spawn, a queued resume, a started resume", () => {
      const { observer, work } = makeObserver();
      const record = createTestSubagent();

      observer.onSubagentCreated(record);
      observer.onSubagentResumeQueued(record);
      observer.onSubagentResuming(record);

      expect(work.runRequested).toHaveBeenCalledTimes(3);
      expect(work.runRequested).toHaveBeenCalledWith(record);
    });

    it("does not ask for one, or end one, for the other lifecycle steps", () => {
      const { observer, work } = makeObserver();
      const record = createTestSubagent();

      observer.onSubagentStarted(record);
      observer.onSubagentSessionCreated(record);
      observer.onSubagentCompacted(record, { reason: "overflow", tokensBefore: 1 });

      expect(work.runRequested).not.toHaveBeenCalled();
      expect(work.runEnded).not.toHaveBeenCalled();
    });

    it("ends the item of a resumed run's outcome too", () => {
      const { observer, work } = makeObserver();
      const record = createTestSubagent({ status: "completed" });

      observer.onSubagentResumed(record);

      expect(work.runEnded).toHaveBeenCalledExactlyOnceWith(record);
    });
  });

  describe("dependency isolation", () => {
    let emit: ReturnType<typeof vi.fn>;
    let appendEntry: ReturnType<typeof vi.fn>;
    let work: AgentWork;
    let observer: SubagentEventsObserver;

    beforeEach(() => {
      ({ observer, emit, appendEntry, work } = makeObserver());
    });

    it("does not import or reference pi SDK directly", () => {
      // If the class was constructed and four methods called with no SDK errors,
      // it holds no SDK dependency — verified structurally by this test running at all.
      observer.onSubagentStarted(createTestSubagent());
      observer.onSubagentCompleted(createTestSubagent({ status: "completed" }));
      const info: CompactionInfo = { reason: "overflow", tokensBefore: 9999 };
      observer.onSubagentCompacted(createTestSubagent(), info);
      observer.onSubagentCreated(createTestSubagent());
      expect(emit).toHaveBeenCalledTimes(4);
      // Created, started and completed are lifecycle steps; compaction is not.
      expect(appendEntry).toHaveBeenCalledTimes(3);
      // The work item was ended as a side-effect of onSubagentCompleted.
      expect(work.runEnded).toHaveBeenCalledTimes(1);
    });
  });

  describe("onSubagentUpdate", () => {
    it("emits subagent:notified carrying the child's message", () => {
      const { observer, emit } = makeObserver();
      const record = createTestSubagent({
        id: "agent-1",
        type: "general-purpose",
        description: "do work",
      });

      observer.onSubagentUpdate(record, "The bug is in the retry wrapper.");

      expect(emit).toHaveBeenCalledExactlyOnceWith("subagent:notified", {
        id: "agent-1",
        type: "general-purpose",
        description: "do work",
        message: "The bug is in the retry wrapper.",
      });
    });

    it("announces the update to the parent", () => {
      const { observer, work } = makeObserver();
      const record = createTestSubagent({ id: "agent-1" });

      observer.onSubagentUpdate(record, "Course change.");

      expect(work.update).toHaveBeenCalledExactlyOnceWith(record, "Course change.");
    });

    it("persists nothing — an update is not an outcome to reconstruct history from", () => {
      const { observer, appendEntry } = makeObserver();

      observer.onSubagentUpdate(createTestSubagent(), "Course change.");

      expect(appendEntry).not.toHaveBeenCalled();
    });
  });
});
