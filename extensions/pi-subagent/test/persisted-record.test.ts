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
    id: "run-1",
    type: "Explore",
    description: "map the module",
    status: "completed",
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
      type: "Explore",
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
      id: "agent-9",
      type: "Explore",
      description: "map the module",
      status: "error",
      result: "partial",
      error: "boom",
      turnBudget,
      startedAt: 1000,
      completedAt: 2500,
      outputFile: "/tasks/a.jsonl",
      toolUses: 7,
      // The attached session stub reports its thinking level.
      thinkingLevel: "off",
    });
  });

  it("records the question, model label, thinking level, turn ceiling and directory", () => {
    const record = toPersistedRecord({
      ...persistedRecord(),
      pendingQuestion: "Postgres or SQLite?",
      model: { provider: "anthropic", id: "claude-x" },
      thinkingLevel: "high",
      maxTurns: 12,
      cwd: "/work/tree",
    });
    expect(record).toMatchObject({
      pendingQuestion: "Postgres or SQLite?",
      model: "anthropic/claude-x",
      thinkingLevel: "high",
      maxTurns: 12,
      cwd: "/work/tree",
    });
  });

  it("leaves unknown optional fields off the entry instead of writing undefined", () => {
    const record = toPersistedRecord({ ...persistedRecord(), model: undefined });
    for (const key of ["pendingQuestion", "model", "thinkingLevel", "maxTurns", "cwd"]) {
      expect(record).not.toHaveProperty(key);
    }
  });
});

describe("readPersistedRecords", () => {
  it("folds every lifecycle step into the last one per id", () => {
    const entries = [
      recordEntry(
        persistedRecord({ status: "running", result: undefined, completedAt: undefined }),
      ),
      recordEntry(persistedRecord({ status: "completed", pendingQuestion: "Which DB?" })),
      recordEntry(persistedRecord({ id: "run-2", startedAt: 2000, status: "running" })),
      // A resume clears the question and runs again.
      recordEntry(persistedRecord({ status: "running", completedAt: undefined })),
    ];
    const records = readPersistedRecords(entries);
    expect(records.map((record) => [record.id, record.status])).toEqual([
      ["run-2", "running"],
      ["run-1", "running"],
    ]);
    expect(records[1]).not.toHaveProperty("pendingQuestion");
  });

  it("reads an entry written before the optional fields existed", () => {
    const [record] = readPersistedRecords([recordEntry(persistedRecord())]);
    expect(record).toStrictEqual(persistedRecord());
  });

  it("returns every optional field it validated", () => {
    const full = {
      ...persistedRecord(),
      pendingQuestion: "Which DB?",
      model: "anthropic/claude-x",
      thinkingLevel: "medium",
      maxTurns: 4,
      cwd: "/w",
    };
    expect(readPersistedRecords([recordEntry(full)])).toStrictEqual([full]);
  });

  it("treats JSON nulls as absent", () => {
    const [record] = readPersistedRecords([
      recordEntry({ ...persistedRecord(), result: null, error: null, completedAt: null }),
    ]);
    expect(record).toMatchObject({ result: undefined, error: undefined, completedAt: undefined });
  });

  it.each([
    ["a numeric question", { pendingQuestion: 7 }],
    ["a model object", { model: { provider: "a", id: "b" } }],
    ["a string turn ceiling", { maxTurns: "12" }],
    ["a numeric directory", { cwd: 1 }],
    ["a string completion time", { completedAt: "later" }],
    ["a string turn budget", { turnBudget: "lots" }],
    ["a numeric result", { result: 42 }],
  ])("skips an entry with %s", (_label, override) => {
    expect(readPersistedRecords([recordEntry({ ...persistedRecord(), ...override })])).toEqual([]);
  });

  it("keeps the last valid record when a later entry for the id is malformed", () => {
    const entries = [
      recordEntry(persistedRecord({ status: "completed" })),
      recordEntry({ ...persistedRecord(), status: "bogus" }),
    ];
    expect(readPersistedRecords(entries).map((record) => record.status)).toEqual(["completed"]);
  });
});

describe("readPersistedRuns", () => {
  const summary = {
    id: "run-1",
    type: "Explore",
    description: "map the module",
    status: "completed",
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
        recordEntry(persistedRecord({ status: "completed" })),
        recordEntry(persistedRecord({ status: "error", error: "boom" })),
      ];
      expect(readPersistedRuns(entries)).toStrictEqual([{ ...summary, status: "error" }]);
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
      type: "Explore",
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
