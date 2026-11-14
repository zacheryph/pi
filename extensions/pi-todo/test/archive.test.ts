import { describe, expect, it } from "vitest";
import type { TodoActivity } from "#src/activity";
import {
  applyTodoArchive,
  archiveCompleted,
  type ArchivedTask,
  formatArchivedTask,
  MAX_ARCHIVED_TASKS,
  MAX_RECENT_COMPLETED,
} from "#src/archive";
import { changeLines, syncNote } from "#src/sync";
import { TODO_SCHEMA_VERSION, type TodoDetails, type TodoState, type TodoTask } from "#src/state";
import { started, T0 } from "#test/harness";

const task = (key: string, extra: Partial<TodoTask> = {}): TodoTask => ({
  key,
  subject: `Task ${key}`,
  status: "pending",
  ...extra,
});
const details = (revision: number, tasks: TodoTask[]): TodoDetails => ({
  schemaVersion: TODO_SCHEMA_VERSION,
  revision,
  tasks,
  change: { added: [], updated: [], removed: [] },
});
/** History in which each key became completed at the given revision. */
const completedAt = (entries: Record<string, number>): TodoActivity =>
  new Map(
    Object.entries(entries).map(([key, revision]) => [
      key,
      {
        updates: [
          { revision, at: T0 + revision, status: "completed", from: "in_progress" },
          // A message later does not make it more recent.
          { revision: revision + 100, at: T0, status: "completed", message: `done ${key}` },
        ],
      },
    ]),
  );
const keys = (tasks: readonly { key: string }[]) => tasks.map((candidate) => candidate.key);
const done = (key: string, extra: Partial<TodoTask> = {}) =>
  task(key, { status: "completed", ...extra });

describe("archiveCompleted", () => {
  it("keeps the most recently completed tasks and archives the rest, dropping links to them", () => {
    const completed = Array.from({ length: MAX_RECENT_COMPLETED + 2 }, (_, i) => done(`d${i}`));
    // d0 completed last of all; d1 and d2 first; "after" later still.
    const history = completedAt({
      ...Object.fromEntries(completed.map((candidate, i) => [candidate.key, i === 0 ? 50 : i])),
      after: 60,
    });
    const next = details(20, [
      ...completed,
      task("open", { dependsOn: ["d1", "d0"] }),
      done("after", { dependsOn: ["d2"] }),
    ]);
    const filed = archiveCompleted({
      previous: next,
      previousActivity: history,
      next,
      activity: history,
    });
    expect(keys(filed.archived)).toEqual(["d1", "d2", "d3"]);
    expect(filed.archived[0]).toEqual({
      key: "d1",
      subject: "Task d1",
      revision: 21,
      completedAt: T0 + 1,
      message: "done d1",
    });
    expect(keys(filed.details.tasks)).not.toContain("d1");
    expect(filed.details.tasks.find((candidate) => candidate.key === "open")?.dependsOn).toEqual([
      "d0",
    ]);
    expect(filed.details.tasks.find((candidate) => candidate.key === "after")).toEqual(
      done("after"),
    );
    expect(filed.details.tasks.filter((t) => t.status === "completed")).toHaveLength(
      MAX_RECENT_COMPLETED,
    );
    // The list changed although the request did not: a new revision.
    expect(filed.details.revision).toBe(21);
    expect(filed.details.change.archived).toEqual(["d1", "d2", "d3"]);
    expect([...filed.activity.keys()]).not.toContain("d1");
  });

  it("orders tasks with no recorded completion first, then by list order", () => {
    const tasks = Array.from({ length: MAX_RECENT_COMPLETED + 1 }, (_, i) => done(`d${i}`));
    const next = details(3, tasks);
    const filed = archiveCompleted({
      previous: details(2, []),
      previousActivity: new Map(),
      next,
      activity: new Map(),
    });
    expect(keys(filed.archived)).toEqual(["d0"]);
    expect(filed.details.revision).toBe(3);
    expect(filed.archived[0]).toEqual({ key: "d0", subject: "Task d0", revision: 3 });
  });

  it("archives completed tasks a clear removed, from the history before the change", () => {
    const previous = details(4, [done("old"), task("open")]);
    const filed = archiveCompleted({
      previous,
      previousActivity: completedAt({ old: 2 }),
      next: { ...details(5, [task("open")]), change: { added: [], updated: [], removed: ["old"] } },
      activity: new Map(),
      removed: ["old"],
    });
    expect(filed.archived).toEqual([
      { key: "old", subject: "Task old", revision: 5, completedAt: T0 + 2, message: "done old" },
    ]);
    expect(filed.details.change).toEqual({
      added: [],
      updated: [],
      removed: [],
      archived: ["old"],
    });
  });

  it("leaves a list within the limit alone", () => {
    const next = details(2, [done("a"), task("b")]);
    const filed = archiveCompleted({
      previous: next,
      previousActivity: new Map(),
      next,
      activity: new Map(),
    });
    expect(filed.details).toBe(next);
    expect(filed.archived).toEqual([]);
  });
});

describe("applyTodoArchive", () => {
  const record = (key: string, revision = 1): ArchivedTask => ({
    key,
    subject: `Task ${key}`,
    revision,
  });

  it("replaces a reused key, drops the oldest past the cap, and clears", () => {
    let archive = applyTodoArchive(new Map(), { tasks: [record("a"), record("b")] });
    archive = applyTodoArchive(archive, { tasks: [record("a", 2)] });
    expect([...archive.values()]).toEqual([record("b"), record("a", 2)]);
    archive = applyTodoArchive(archive, {
      tasks: Array.from({ length: MAX_ARCHIVED_TASKS }, (_, i) => record(`t${i}`)),
    });
    expect(archive.size).toBe(MAX_ARCHIVED_TASKS);
    expect(archive.has("b")).toBe(false);
    expect(archive.has("a")).toBe(false);
    expect(applyTodoArchive(archive, { clear: true }).size).toBe(0);
  });

  it("skips malformed records", () => {
    const archive = applyTodoArchive(new Map(), {
      tasks: [
        record("ok"),
        { key: "Bad Key", subject: "x", revision: 1 },
        { key: "nosubject", revision: 1 },
        { key: "norev", subject: "x" },
        { ...record("long"), message: "m".repeat(500), completedAt: -1 },
      ],
    });
    expect([...archive.keys()]).toEqual(["ok", "long"]);
    expect(archive.get("long")?.message).toHaveLength(240);
    expect(archive.get("long")?.completedAt).toBeUndefined();
    expect(applyTodoArchive(archive, "junk")).toEqual(archive);
  });

  it("formats a record for todo_list with its key", () => {
    expect(
      JSON.parse(formatArchivedTask(7, { ...record("a"), completedAt: T0, message: "PR #12" })),
    ).toEqual({
      revision: 7,
      archived: {
        key: "a",
        subject: "Task a",
        status: "completed",
        completedAt: new Date(T0).toISOString(),
        lastMessage: "PR #12",
      },
    });
  });
});

describe("notes and the archive", () => {
  const author = () => undefined;
  const current: TodoState = {
    schemaVersion: TODO_SCHEMA_VERSION,
    revision: 6,
    tasks: [task("b")],
  };

  it("reports a task archived before the model saw it complete, and is silent otherwise", () => {
    const seen = {
      revision: 4,
      tasks: [task("a", { status: "in_progress" }), done("x"), task("b", { dependsOn: ["x"] })],
    };
    const archive = new Map<string, ArchivedTask>([
      ["a", { key: "a", subject: "Task a", revision: 6, message: "merged" }],
      ["x", { key: "x", subject: "Task x", revision: 5 }],
    ]);
    // b lost its link to x only because x left the list: not a change of b.
    expect(changeLines(seen, { ...current }, new Map(), author, archive)).toEqual({
      lines: ['- a: in_progress → completed, archived: "merged"'],
      unchanged: 1,
    });
    // An archived record from before the model's copy is a deletion of a reused key.
    const old = new Map([["a", { key: "a", subject: "Task a", revision: 3 }]]);
    expect(changeLines(seen, { ...current }, new Map(), author, old).lines).toEqual([
      "- a: removed",
      "- x: removed",
    ]);
  });

  it("counts archived tasks in the whole list", () => {
    const archive = new Map([["z", { key: "z", subject: "Task z", revision: 2 }]]);
    const note = syncNote({
      seen: undefined,
      current: { ...current },
      activity: new Map(),
      author,
      archive,
      fullHeader: "H\n",
    });
    expect(JSON.parse(note!.content.slice(2))).toMatchObject({ archivedCompleted: 1 });
  });
});

describe("the extension", () => {
  const complete = (key: string, message?: string) => ({
    action: "upsert" as const,
    tasks: [{ key, status: "completed" as const, ...(message ? { message } : {}) }],
  });

  it("archives the oldest completed task, keeps it readable, and restores the archive", async () => {
    const env = await started();
    const count = MAX_RECENT_COMPLETED + 1;
    await env.execute({
      action: "upsert",
      tasks: Array.from({ length: count }, (_, i) => ({ key: `t${i}`, subject: `Step ${i}` })),
    });
    for (let i = 0; i < count; i++) {
      env.clock.now = T0 + i;
      await env.execute(complete(`t${i}`, `shipped step ${i}`));
    }
    const listed = JSON.parse(await env.text({ action: "list" }));
    expect(listed.tasks.map((t: TodoTask) => t.key)).not.toContain("t0");
    expect(listed.tasks).toHaveLength(MAX_RECENT_COMPLETED);
    expect(listed.archivedCompleted).toBe(1);
    expect(env.archives()).toEqual([
      {
        tasks: [
          {
            key: "t0",
            subject: "Step 0",
            revision: listed.revision,
            completedAt: T0,
            message: "shipped step 0",
          },
        ],
      },
    ]);
    // The journal no longer carries the archived task or its history.
    const journal = (
      env.snapshots().at(-1) as unknown as { data: { tasks: TodoTask[]; activity: object } }
    ).data;
    expect(keys(journal.tasks)).not.toContain("t0");
    expect(journal.activity).not.toHaveProperty("t0");

    const read = await env.execute({ action: "list", key: "t0" });
    expect(JSON.parse(read.content[0]!.type === "text" ? read.content[0]!.text : "")).toEqual({
      revision: listed.revision,
      archived: {
        key: "t0",
        subject: "Step 0",
        status: "completed",
        completedAt: new Date(T0).toISOString(),
        lastMessage: "shipped step 0",
      },
    });
    // Reading writes nothing and is not the whole list.
    expect(read.details).toMatchObject({ key: "t0", revision: listed.revision });

    await env.emit("session_start", { reason: "resume" });
    expect(JSON.parse(await env.text({ action: "list" })).archivedCompleted).toBe(1);
    await expect(env.text({ action: "list", key: "t0" })).resolves.toContain('"archived"');
  });

  it("drops prerequisites on archived tasks, caps open tasks, and clears the archive with the list", async () => {
    const env = await started();
    await env.execute({
      action: "upsert",
      tasks: Array.from({ length: MAX_RECENT_COMPLETED + 1 }, (_, i) => ({
        key: `t${i}`,
        subject: `Step ${i}`,
        status: "completed" as const,
      })),
    });
    expect((await env.state()).tasks.map((t) => t.key)).not.toContain("t0");
    await env.execute({
      action: "upsert",
      tasks: [{ key: "next", subject: "Next", dependsOn: ["t0", "t1"] }],
    });
    expect((await env.state()).tasks.find((t) => t.key === "next")?.dependsOn).toEqual(["t1"]);
    // A key named in the same write is a new task, not the archived one.
    await env.execute({
      action: "upsert",
      tasks: [
        { key: "t0", subject: "Again" },
        { key: "later", subject: "Later", dependsOn: ["t0"] },
      ],
    });
    expect((await env.state()).tasks.find((t) => t.key === "later")?.dependsOn).toEqual(["t0"]);

    const open = (await env.state()).tasks.filter((t) => t.status !== "completed").length;
    await expect(
      env.execute({
        action: "upsert",
        tasks: Array.from({ length: 51 - open }, (_, i) => ({ key: `o${i}`, subject: "Open" })),
      }),
    ).rejects.toThrow(/at most 50 tasks may be pending or in_progress/);

    await env.execute({ action: "clear" });
    expect(env.archives().at(-1)).toEqual({ clear: true });
    await expect(env.execute({ action: "list", key: "t1" })).rejects.toThrow(/unknown task: t1/);
  });

  it("tells the model in a note that a task it saw unfinished was completed and archived", async () => {
    const env = await started();
    const keys = Array.from({ length: MAX_RECENT_COMPLETED + 1 }, (_, i) => `t${i}`);
    env.see(
      await env.execute({
        action: "upsert",
        tasks: keys.map((key) => ({ key, subject: key, status: "in_progress" as const })),
      }),
    );
    // Everything completes before the model looks again: the first in the list is archived at once.
    await env.execute({
      action: "upsert",
      tasks: keys.map((key) => ({
        key,
        status: "completed" as const,
        ...(key === "t0" ? { message: "Done in PR 12" } : {}),
      })),
    });
    const note = await env.sync();
    expect(note).toContain('- t0: in_progress → completed, archived: "Done in PR 12"');
    expect(note).toContain("- t1: in_progress → completed");
  });
});
