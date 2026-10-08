import { describe, expect, it } from "vitest";
import { replayTaskState, TODO_JOURNAL_TYPE } from "#src/replay";
import { createEmptyTodoState, TODO_STATE_CUSTOM_TYPE, writeTodoSnapshot } from "#src/state";

const one = writeTodoSnapshot(createEmptyTodoState(), { tasks: [{ key: "first", subject: "First", status: "pending" }] });
const two = writeTodoSnapshot(one, { tasks: [] });
const local = (data: unknown) => ({ type: "custom", customType: TODO_JOURNAL_TYPE, data });
const result = (details: unknown) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details } });
const replay = (branch: unknown[]) => replayTaskState({ sessionManager: { getBranch: () => branch } });

describe("authoritative local checkpoint replay", () => {
  it("uses current branch's last local journal even when old direct result arrives last", () => {
    expect(replay([local(one), local(two), result(one)])).toMatchObject({ revision: 2, tasks: [] });
  });
  it("falls back to upstream tool details/custom entries only before local journaling", () => {
    expect(replay([result(one)])).toMatchObject({ revision: 1, tasks: one.tasks });
    expect(replay([{ type: "custom", customType: TODO_STATE_CUSTOM_TYPE, data: one }])).toMatchObject({ revision: 1 });
  });
  it("ignores malformed local snapshots without discarding earlier valid checkpoint", () => {
    for (const invalid of [null, { ...two, revision: -1 }, { ...one, tasks: [{ key: "broken" }] },
      { ...one, revision: 0, tasks: [{ key: "x", subject: "X", status: "pending", dependsOn: ["x"] }] }]) {
      expect(replay([local(one), local(invalid)])).toMatchObject({ revision: 1, tasks: one.tasks });
    }
  });
  it("accepts zero/empty checkpoint and isolates restored snapshots", () => {
    expect(replay([local(createEmptyTodoState()), result(one)])).toMatchObject({ revision: 0, tasks: [] });
    const restored = replay([local(one)]);
    restored.tasks[0].subject = "Changed";
    expect(one.tasks[0].subject).toBe("First");
  });
  it("does not recover abandoned state outside supplied branch", () => {
    expect(replay([])).toEqual(createEmptyTodoState());
    expect(replay([local(one)])).toMatchObject({ revision: 1 });
    expect(replay([local(two)])).toMatchObject({ revision: 2, tasks: [] });
  });
});
