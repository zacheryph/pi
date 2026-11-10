import { describe, expect, it } from "vitest";
import {
  type PersistedSubagentRecord,
  readPersistedRecords,
  readPersistedRuns,
  type SessionEntryLike,
  SUBAGENT_RECORD_ENTRY,
  toPersistedRecord,
} from "#src/persisted-record";
import { createTestSubagent } from "#test/helpers/make-subagent";

function persistedRecord(
  overrides: Partial<PersistedSubagentRecord> = {},
): PersistedSubagentRecord {
  return {
    version: 2,
    id: "run-1",
    type: "explore",
    description: "map the module",
    status: "idle",
    outcome: "completed",
    result: "done",
    error: undefined,
    turnBudget: undefined,
    startedAt: 1000,
    completedAt: 4000,
    outputFile: "/tasks/run-1.jsonl",
    toolUses: 7,
    ...overrides,
  };
}

function recordEntry(data: unknown): SessionEntryLike {
  return { type: "custom", customType: SUBAGENT_RECORD_ENTRY, data };
}

describe("toPersistedRecord", () => {
  it("copies the persisted fields off the record, and no others", () => {
    const turnBudget = { maxTurns: 5, used: 2, phase: "within" } as const;
    const record = createTestSubagent({
      id: "agent-9",
      type: "explore",
      description: "map the module",
      status: "error",
      result: "partial",
      error: "boom",
      turnBudget,
      startedAt: 1000,
      completedAt: 2500,
      toolUses: 7,
      sessionReady: true,
      outputFile: "/tasks/a.jsonl",
    });

    expect(toPersistedRecord(record)).toStrictEqual({
      version: 2,
      id: "agent-9",
      type: "explore",
      description: "map the module",
      status: "idle",
      outcome: "error",
      result: "partial",
      error: "boom",
      turnBudget,
      startedAt: 1000,
      completedAt: 2500,
      outputFile: "/tasks/a.jsonl",
      toolUses: 7,
      // The attached session stub reports its thinking level.
      thinkingLevel: "off",
      // The parent's directory: the spawn chose none.
      cwd: "/test",
    });
  });

  it("writes a run in flight with no outcome: it has not ended yet", () => {
    const running = createTestSubagent({ status: "running" });
    expect(toPersistedRecord(running)).toMatchObject({ status: "running", outcome: undefined });
  });

  it("records the model label, thinking level, turn ceiling and directory", () => {
    const record = toPersistedRecord({
      ...persistedRecord(),
      model: { provider: "anthropic", id: "claude-x" },
      thinkingLevel: "high",
      maxTurns: 12,
      cwd: "/work/tree",
    });
    expect(record).toMatchObject({
      model: "anthropic/claude-x",
      thinkingLevel: "high",
      maxTurns: 12,
      cwd: "/work/tree",
    });
  });

  it("leaves unknown optional fields off the entry instead of writing undefined", () => {
    const record = toPersistedRecord({ ...persistedRecord(), model: undefined });
    for (const key of ["model", "thinkingLevel", "maxTurns", "cwd"]) {
      expect(record).not.toHaveProperty(key);
    }
  });
});

describe("waitingOn", () => {
  /** A record as the writer copies from it: no version, and the model not yet a label. */
  const source = (overrides: Partial<PersistedSubagentRecord> = {}) => {
    const { version: _version, model: _model, ...rest } = persistedRecord(overrides);
    return rest;
  };
  it("records what an idle agent waits on, and leaves it out for an agent that waits on nothing", () => {
    const waiting = createTestSubagent({
      status: "idle",
      outcome: "completed",
      sessionReady: true,
    });
    expect(toPersistedRecord(waiting)).not.toHaveProperty("waitingOn");
    expect(toPersistedRecord({ ...source(), waitingOn: ["CI", "answer"] })).toMatchObject({
      waitingOn: ["CI", "answer"],
    });
    expect(toPersistedRecord({ ...source(), waitingOn: [] })).not.toHaveProperty("waitingOn");
  });

  it("is never recorded for an agent with a run in flight", () => {
    expect(
      toPersistedRecord({
        ...source({ status: "running", outcome: undefined }),
        waitingOn: ["CI"],
      }),
    ).not.toHaveProperty("waitingOn");
  });

  it("is read back, and a record without it, or with a malformed one, is still valid", () => {
    const entries = [
      recordEntry({ ...persistedRecord({ id: "a" }), waitingOn: ["CI"] }),
      recordEntry(persistedRecord({ id: "b" })),
      recordEntry({ ...persistedRecord({ id: "c" }), waitingOn: [1, "x"] }),
    ];
    const byId = Object.fromEntries(readPersistedRecords(entries).map((r) => [r.id, r]));
    expect(byId.a.waitingOn).toEqual(["CI"]);
    expect(byId.b).not.toHaveProperty("waitingOn");
    expect(byId.c).toBeDefined();
    expect(byId.c).not.toHaveProperty("waitingOn");
  });
});

describe("readPersistedRecords", () => {
  it("folds every lifecycle step into the last one per id", () => {
    const entries = [
      recordEntry(
        persistedRecord({
          status: "running",
          outcome: undefined,
          result: undefined,
          completedAt: undefined,
        }),
      ),
      recordEntry(persistedRecord()),
      recordEntry(
        persistedRecord({ id: "run-2", startedAt: 2000, status: "running", outcome: undefined }),
      ),
      // A resume runs again.
      recordEntry(
        persistedRecord({ status: "running", outcome: undefined, completedAt: undefined }),
      ),
    ];
    const records = readPersistedRecords(entries);
    expect(records.map((record) => [record.id, record.status])).toEqual([
      ["run-2", "running"],
      ["run-1", "running"],
    ]);
  });

  it("reads an entry written before the optional fields existed", () => {
    const [record] = readPersistedRecords([recordEntry(persistedRecord())]);
    expect(record).toStrictEqual(persistedRecord());
  });

  it("returns every optional field it validated", () => {
    const full = {
      ...persistedRecord(),
      outcome: "turn-limit",
      model: "anthropic/claude-x",
      thinkingLevel: "medium",
      maxTurns: 4,
      cwd: "/w",
    };
    expect(readPersistedRecords([recordEntry(full)])).toStrictEqual([full]);
  });

  // Roadmap step 10 removed the field: a question is an open item in the agent's own transcript,
  // not an outcome the parent's record carries. Records written before it may still hold one (any
  // type), and are read like every other record, without it.
  it("tolerates and ignores the question an earlier version recorded", () => {
    for (const pendingQuestion of ["Which DB?", 7, null, { text: "Which DB?" }]) {
      const [record] = readPersistedRecords([
        recordEntry({ ...persistedRecord(), pendingQuestion }),
      ]);
      expect(record).toStrictEqual(persistedRecord());
      expect(record).not.toHaveProperty("pendingQuestion");
    }
  });

  it("writes no question, whatever a source object carries", () => {
    const record = toPersistedRecord({
      ...persistedRecord(),
      pendingQuestion: "Postgres or SQLite?",
    } as never);
    expect(record).not.toHaveProperty("pendingQuestion");
  });

  it("treats JSON nulls as absent", () => {
    const [record] = readPersistedRecords([
      recordEntry({ ...persistedRecord(), result: null, error: null, completedAt: null }),
    ]);
    expect(record).toMatchObject({ result: undefined, error: undefined, completedAt: undefined });
  });

  it.each([
    ["a model object", { model: { provider: "a", id: "b" } }],
    ["a string turn ceiling", { maxTurns: "12" }],
    ["a numeric directory", { cwd: 1 }],
    ["a string completion time", { completedAt: "later" }],
    ["a string turn budget", { turnBudget: "lots" }],
    ["a numeric result", { result: 42 }],
    ["an idle agent with no outcome", { outcome: undefined }],
    ["an idle agent with an unknown outcome", { outcome: "vanished" }],
    ["a version from the future", { version: 3 }],
    ["a version 2 entry still using a version 1 status", { status: "completed" }],
  ])("skips an entry with %s", (_label, override) => {
    expect(readPersistedRecords([recordEntry({ ...persistedRecord(), ...override })])).toEqual([]);
  });

  it("keeps the last valid record when a later entry for the id is malformed", () => {
    const entries = [
      recordEntry(persistedRecord({ outcome: "stopped" })),
      recordEntry({ ...persistedRecord(), status: "bogus" }),
    ];
    expect(readPersistedRecords(entries).map((record) => record.outcome)).toEqual(["stopped"]);
  });
});

describe("readPersistedRuns", () => {
  const summary = {
    id: "run-1",
    type: "explore",
    description: "map the module",
    status: "idle",
    outcome: "completed",
    startedAt: 1000,
    completedAt: 4000,
    outputFile: "/tasks/run-1.jsonl",
    toolUses: 7,
  };

  it("returns nothing for no entries", () => {
    expect(readPersistedRuns([])).toEqual([]);
  });

  describe("filtering", () => {
    it("reads only subagent:record custom entries", () => {
      const entries: SessionEntryLike[] = [
        // A valid record shape under another customType must not be read as a run.
        { type: "custom", customType: "other", data: persistedRecord({ id: "foreign" }) },
        { type: "message", data: persistedRecord({ id: "message" }) },
        recordEntry(persistedRecord()),
      ];
      expect(readPersistedRuns(entries)).toStrictEqual([summary]);
    });
  });

  describe("repeated ids", () => {
    it("keeps the last entry for an id, so a resumed run reports its latest outcome", () => {
      const entries = [
        recordEntry(persistedRecord()),
        recordEntry(persistedRecord({ outcome: "error", error: "boom" })),
      ];
      expect(readPersistedRuns(entries)).toStrictEqual([{ ...summary, outcome: "error" }]);
    });
  });

  describe("validation", () => {
    it("skips an entry written before the entry recorded toolUses", () => {
      const { toolUses: _toolUses, outputFile: _outputFile, ...preUpgrade } = persistedRecord();
      expect(readPersistedRuns([recordEntry(preUpgrade)])).toEqual([]);
    });

    it("skips an entry whose status is not a subagent status", () => {
      expect(readPersistedRuns([recordEntry({ ...persistedRecord(), status: "bogus" })])).toEqual(
        [],
      );
    });

    it("skips an entry with no data", () => {
      expect(readPersistedRuns([recordEntry(undefined)])).toEqual([]);
    });

    it("keeps a run that recorded no transcript", () => {
      const runs = readPersistedRuns([
        recordEntry(persistedRecord({ outputFile: undefined, completedAt: undefined })),
      ]);
      expect(runs).toStrictEqual([{ ...summary, outputFile: undefined, completedAt: undefined }]);
    });
  });

  describe("order", () => {
    it("returns runs newest first", () => {
      const entries = [
        recordEntry(persistedRecord({ id: "older", startedAt: 1000 })),
        recordEntry(persistedRecord({ id: "newer", startedAt: 2000 })),
      ];
      expect(readPersistedRuns(entries).map((run) => run.id)).toEqual(["newer", "older"]);
    });
  });

  it("reads back what toPersistedRecord wrote", () => {
    const record = createTestSubagent({
      id: "round-trip",
      type: "explore",
      description: "map the module",
      status: "completed",
      startedAt: 1000,
      completedAt: 4000,
      toolUses: 7,
      sessionReady: true,
      outputFile: "/tasks/round-trip.jsonl",
    });
    expect(readPersistedRuns([recordEntry(toPersistedRecord(record))])).toStrictEqual([
      { ...summary, id: "round-trip", outputFile: "/tasks/round-trip.jsonl" },
    ]);
  });
});

describe("version 1 records", () => {
  // Entries as the version 1 writer saved them: six statuses, no `version`, no `outcome`.
  const v1 = {
    id: "old-1",
    type: "explore",
    description: "map the module",
    status: "completed",
    result: "done",
    turnBudget: undefined,
    startedAt: 1000,
    completedAt: 4000,
    outputFile: "/tasks/old-1.jsonl",
    toolUses: 7,
  };

  it.each([
    ["completed", "idle", "completed"],
    ["aborted", "idle", "turn-limit"],
    ["error", "idle", "error"],
    ["stopped", "idle", "stopped"],
    // The process that wrote a queued or running record is gone by the time anyone reads it back.
    ["queued", "idle", "interrupted"],
    ["running", "idle", "interrupted"],
  ])("reads status %s as %s with outcome %s", (legacy, status, outcome) => {
    const [record] = readPersistedRecords([recordEntry({ ...v1, status: legacy })]);
    expect(record).toMatchObject({ version: 2, id: "old-1", status, outcome });
    expect(readPersistedRuns([recordEntry({ ...v1, status: legacy })])).toStrictEqual([
      {
        id: "old-1",
        type: "explore",
        description: "map the module",
        status,
        outcome,
        startedAt: 1000,
        completedAt: 4000,
        toolUses: 7,
        outputFile: "/tasks/old-1.jsonl",
      },
    ]);
  });

  it("keeps everything else a version 1 entry recorded", () => {
    const entry = {
      ...v1,
      status: "error",
      error: "boom",
      model: "anthropic/claude-x",
      thinkingLevel: "high",
      maxTurns: 6,
      cwd: "/w",
      turnBudget: { maxTurns: 6, used: 6, phase: "exhausted" },
    };
    expect(readPersistedRecords([recordEntry(entry)])).toStrictEqual([
      {
        ...entry,
        version: 2,
        status: "idle",
        outcome: "error",
      },
    ]);
  });

  it("reads an entry from before the optional fields were added", () => {
    const [record] = readPersistedRecords([recordEntry(v1)]);
    expect(record).toStrictEqual({
      version: 2,
      ...v1,
      status: "idle",
      outcome: "completed",
      error: undefined,
    });
  });

  it("lets a version 2 entry that follows a version 1 one in the same session win", () => {
    const entries = [
      recordEntry({ ...v1, status: "running", completedAt: undefined }),
      recordEntry(persistedRecord({ id: "old-1", outcome: "completed", result: "resumed" })),
    ];
    expect(readPersistedRecords(entries)).toMatchObject([
      { id: "old-1", status: "idle", outcome: "completed", result: "resumed" },
    ]);
  });

  it("skips a version 1 entry with a status the old writer never wrote", () => {
    expect(readPersistedRecords([recordEntry({ ...v1, status: "idle" })])).toEqual([]);
    expect(readPersistedRecords([recordEntry({ ...v1, status: "toString" })])).toEqual([]);
  });
});
