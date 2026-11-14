import { describe, expect, it } from "vitest";
import type { TodoActivity } from "#src/activity";
import { TODO_SCHEMA_VERSION, type TodoState, type TodoTask } from "#src/state";
import {
  type BranchEntry,
  changeLines,
  readSeenList,
  seenOnBranch,
  syncNote,
  TODO_SYNC_TYPE,
} from "#src/sync";

const task = (key: string, extra: Partial<TodoTask> = {}): TodoTask => ({
  key,
  subject: `Task ${key}`,
  status: "pending",
  ...extra,
});
const list = (revision: number, tasks: TodoTask[]): TodoState => ({
  schemaVersion: TODO_SCHEMA_VERSION,
  revision,
  tasks,
});
const result = (id: string, revision: number, extra: Partial<BranchEntry["message"]> = {}) => ({
  type: "message",
  id,
  message: {
    role: "toolResult",
    toolName: "todo_upsert",
    isError: false,
    details: list(revision, [task("a")]),
    content: [{ type: "text", text: "{}" }],
    ...extra,
  },
});
const note = (id: string, revision: number): BranchEntry => ({
  type: "custom_message",
  id,
  customType: TODO_SYNC_TYPE,
  details: { seen: { revision, tasks: [task("a")] } },
});
const user = (id: string): BranchEntry => ({ type: "message", id, message: { role: "user" } });
const compaction = (id: string, firstKeptEntryId: string): BranchEntry => ({
  type: "compaction",
  id,
  firstKeptEntryId,
});

describe("seenOnBranch", () => {
  it("takes the newest whole-list todo result or note", () => {
    expect(seenOnBranch([result("r1", 1), note("n2", 2)])?.revision).toBe(2);
    expect(seenOnBranch([note("n2", 2), result("r3", 3)])?.revision).toBe(3);
    expect(seenOnBranch([user("u")])).toBeUndefined();
  });

  it.each<[string, Partial<BranchEntry["message"]>]>([
    ["a failed call", { isError: true }],
    ["another tool", { toolName: "codemode" }],
    ["one task's details", { details: { ...list(2, [task("a")]), key: "a" } }],
    [
      "a truncated result",
      { content: [{ type: "text", text: "{...\n[Output truncated. Use todo_list" }] },
    ],
  ])("skips %s", (_name, extra) => {
    expect(seenOnBranch([result("r1", 1), result("r2", 2, extra)])?.revision).toBe(1);
  });

  it("sees only what a compaction kept", () => {
    const branch = [result("r1", 1), user("u2"), result("r3", 3), user("u4")];
    // Kept from u2: r3 is still in context.
    expect(seenOnBranch([...branch, compaction("c", "u2")])?.revision).toBe(3);
    // Kept from u4: both results were summarized away.
    expect(seenOnBranch([...branch, compaction("c", "u4")])).toBeUndefined();
    // Nothing kept.
    expect(seenOnBranch([...branch, compaction("c", "c")])).toBeUndefined();
    // A note after the compaction is in context.
    expect(seenOnBranch([...branch, compaction("c", "u4"), note("n", 5)])?.revision).toBe(5);
  });
});

describe("readSeenList", () => {
  it("rejects malformed lists", () => {
    expect(readSeenList({ revision: -1, tasks: [] })).toBeUndefined();
    expect(readSeenList({ revision: 1, tasks: [{ key: "a", subject: "A", status: "odd" }] })).toBe(
      undefined,
    );
    expect(readSeenList({ revision: 1, tasks: [task("a", { dependsOn: ["b"] })] })).toEqual({
      revision: 1,
      tasks: [task("a", { dependsOn: ["b"] })],
    });
  });
});

describe("changeLines and syncNote", () => {
  const activity: TodoActivity = new Map([
    [
      "a",
      {
        updates: [
          { revision: 1, at: 1, status: "pending", message: "old" },
          { revision: 3, at: 3, status: "completed", from: "pending", agent: "a3f2b1c4-9d8e" },
        ],
      },
    ],
  ]);
  const author = (update: { agent?: string }) =>
    update.agent ? `by agent ${update.agent.slice(0, 8)}` : undefined;

  it("describes each change once, with the latest message since the model looked", () => {
    const seen = { revision: 2, tasks: [task("a"), task("b"), task("gone")] };
    const current = list(3, [
      task("a", { status: "completed" }),
      task("b", { subject: "Renamed", description: "new" }),
      task("c"),
    ]);
    expect(changeLines(seen, current, activity, author)).toEqual({
      lines: [
        "- a: pending → completed, by agent a3f2b1c4",
        '- b: subject now "Renamed", description changed',
        '- c: added, pending: "Task c"',
        "- gone: removed",
      ],
      unchanged: 0,
    });
  });

  it("writes nothing when the model has the current list", () => {
    const current = list(3, [task("a")]);
    expect(
      syncNote({ seen: current, current, activity: new Map(), author, fullHeader: "H\n" }),
    ).toBeUndefined();
    // An untouched, empty list has nothing to restore either.
    expect(
      syncNote({
        seen: undefined,
        current: list(0, []),
        activity: new Map(),
        author,
        fullHeader: "H\n",
      }),
    ).toBeUndefined();
  });

  it("sends the whole list when the changes would be longer", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      task(`t-${i}`, { description: "d".repeat(80) }),
    );
    const changed = list(2, [{ ...many[0]!, status: "in_progress" }, ...many.slice(1)]);
    const short = syncNote({
      seen: { revision: 1, tasks: many },
      current: changed,
      activity: new Map(),
      author,
      fullHeader: "H\n",
    });
    expect(short?.content).toMatch(/^Todo list changed[^]*7 other tasks unchanged/);
    const current = list(2, [task("x", { subject: "s".repeat(150) })]);
    const whole = syncNote({
      seen: { revision: 1, tasks: Array.from({ length: 30 }, (_, i) => task(`old-${i}`)) },
      current,
      activity: new Map(),
      author,
      fullHeader: "H\n",
    });
    expect(whole?.content).toMatch(/^H\n\{"revision":2/);
    expect(whole?.details.seen).toEqual({ revision: 2, tasks: current.tasks });
  });
});
