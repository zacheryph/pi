import { describe, expect, it } from "vitest";
import {
  applyTodoReview,
  createTodoReviewState,
  latestTodoMessage,
  MAX_TASK_MESSAGE_LENGTH,
  MAX_TASK_UPDATES,
  readTodoActivity,
  recordTodoActivity,
  serializeTodoActivity,
  type TodoActivity,
  todoReviewMarks,
  type TodoTaskActivity,
  unreviewedTodoTasks,
  unreviewedTodoUpdates,
} from "#src/activity.ts";
import {
  applyTodoRequest,
  formatTodoContext,
  formatTodoState,
  type TodoRequest,
} from "#src/actions.ts";
import { createEmptyTodoState, type TodoState, TodoValidationError } from "#src/state.ts";

const options = { singleActive: false };
type Session = { state: TodoState; activity: TodoActivity };
function step(session: Session, request: TodoRequest, at: number, by?: "user"): Session {
  const recorded = recordTodoActivity(
    session.state,
    applyTodoRequest(session.state, request, options),
    request.tasks,
    session.activity,
    { at, ...(by ? { by } : {}) },
  );
  return { state: recorded.details, activity: recorded.activity };
}
const empty: Session = { state: createEmptyTodoState(), activity: new Map() };
const planned = step(
  empty,
  {
    action: "upsert",
    tasks: [
      { key: "build", subject: "Build" },
      { key: "verify", subject: "Verify", dependsOn: ["build"] },
    ],
  },
  100,
);

describe("task activity history", () => {
  it("records creation time, status transitions and messages at the recording revision", () => {
    expect(planned.state.revision).toBe(1);
    expect(serializeTodoActivity(planned.activity)).toEqual({
      build: { createdAt: 100, updates: [] },
      verify: { createdAt: 100, updates: [] },
    });
    const started = step(
      planned,
      { action: "upsert", tasks: [{ key: "build", status: "in_progress" }] },
      200,
    );
    const done = step(
      started,
      {
        action: "upsert",
        tasks: [
          { key: "build", status: "completed", message: "  Built with 0 warnings  " },
          { key: "verify", status: "in_progress" },
        ],
      },
      300,
    );
    expect(done.state.revision).toBe(3);
    expect(done.activity.get("build")).toEqual({
      createdAt: 100,
      updates: [
        { revision: 2, at: 200, status: "in_progress", from: "pending" },
        {
          revision: 3,
          at: 300,
          status: "completed",
          from: "in_progress",
          message: "Built with 0 warnings",
        },
      ],
    });
    expect(done.activity.get("verify")?.updates).toEqual([
      { revision: 3, at: 300, status: "in_progress", from: "pending" },
    ]);
    expect(latestTodoMessage("build", done.activity)?.message).toBe("Built with 0 warnings");
    // Earlier history is never shared with later snapshots.
    expect(started.activity.get("build")?.updates).toHaveLength(1);
  });

  it("message-only patch bumps revision and reports the key updated; blank messages are ignored", () => {
    const noted = step(
      planned,
      { action: "upsert", tasks: [{ key: "verify", message: "Waiting on CI" }] },
      200,
    );
    expect(noted.state.revision).toBe(2);
    expect(noted.state.tasks).toEqual(planned.state.tasks);
    expect((noted.state as ReturnType<typeof applyTodoRequest>).change).toEqual({
      added: [],
      updated: ["verify"],
      removed: [],
    });
    expect(noted.activity.get("verify")?.updates).toEqual([
      { revision: 2, at: 200, status: "pending", message: "Waiting on CI" },
    ]);
    const blank = step(
      planned,
      { action: "upsert", tasks: [{ key: "verify", message: " \n " }] },
      200,
    );
    expect(blank.state.revision).toBe(1);
    expect(blank.activity.get("verify")?.updates).toEqual([]);
  });

  it("new non-pending tasks and replace record status; removal and key reuse start fresh", () => {
    const created = step(
      empty,
      {
        action: "replace",
        tasks: [
          { key: "done", subject: "Done", status: "completed", message: "Imported finished work" },
          { key: "open", subject: "Open" },
        ],
      },
      50,
    );
    expect(created.activity.get("done")).toEqual({
      createdAt: 50,
      updates: [{ revision: 1, at: 50, status: "completed", message: "Imported finished work" }],
    });
    const removed = step(created, { action: "remove", keys: ["done"] }, 60);
    expect([...removed.activity.keys()]).toEqual(["open"]);
    const reused = step(
      removed,
      { action: "upsert", tasks: [{ key: "done", subject: "Again" }] },
      70,
    );
    expect(reused.activity.get("done")).toEqual({ createdAt: 70, updates: [] });
    expect(step(reused, { action: "clear" }, 80).activity.size).toBe(0);
  });

  it("marks user-sourced updates and keeps only the newest updates per task", () => {
    let session = planned;
    for (let i = 0; i < MAX_TASK_UPDATES + 3; i++) {
      session = step(
        session,
        { action: "upsert", tasks: [{ key: "build", message: `note ${i}` }] },
        200 + i,
        "user",
      );
    }
    const updates = session.activity.get("build")!.updates;
    expect(updates).toHaveLength(MAX_TASK_UPDATES);
    expect(updates[0].message).toBe("note 3");
    expect(updates.every((update) => update.by === "user")).toBe(true);
    expect(session.activity.get("build")!.createdAt).toBe(100);
  });

  it("rejects oversized or non-string messages without returning partial history", () => {
    const request: TodoRequest = {
      action: "upsert",
      tasks: [{ key: "build", message: "x".repeat(MAX_TASK_MESSAGE_LENGTH + 1) }],
    };
    expect(() => step(planned, request, 1)).toThrow(TodoValidationError);
    expect(() => step(planned, request, 1)).toThrow(/message must be at most 2000 characters/);
    expect(() =>
      step(
        planned,
        { action: "upsert", tasks: [{ key: "build", message: 3 as unknown as string }] },
        1,
      ),
    ).toThrow(/message must be a string/);
    expect(
      step(
        planned,
        {
          action: "upsert",
          tasks: [{ key: "build", message: "x".repeat(MAX_TASK_MESSAGE_LENGTH) }],
        },
        1,
      ).state.revision,
    ).toBe(2);
  });
});

describe("review watermarks", () => {
  const messaged = step(
    step(
      planned,
      { action: "upsert", tasks: [{ key: "build", status: "completed", message: "Built" }] },
      200,
    ),
    {
      action: "upsert",
      tasks: [{ key: "verify", status: "in_progress", message: "Started checks" }],
    },
    300,
  );

  it("flags model messages above the task watermark, newest first; status-only and user updates never", () => {
    const review = createTodoReviewState();
    expect(
      [...unreviewedTodoTasks(messaged.state, messaged.activity, review)].map(([key, update]) => [
        key,
        update.revision,
      ]),
    ).toEqual([
      ["verify", 3],
      ["build", 2],
    ]);
    const user = step(
      messaged,
      { action: "upsert", tasks: [{ key: "build", message: "Checked by hand" }] },
      400,
      "user",
    );
    expect(
      unreviewedTodoUpdates("build", user.activity, review).map((update) => update.message),
    ).toEqual(["Built"]);
    const quiet = step(
      planned,
      { action: "upsert", tasks: [{ key: "build", status: "completed" }] },
      200,
    );
    expect(unreviewedTodoTasks(quiet.state, quiet.activity, review).size).toBe(0);
  });

  it("applies watermarks forward only, per key, and keeps the latest review time", () => {
    let review = applyTodoReview(createTodoReviewState(), { at: 500, tasks: { build: 2 } });
    expect([...unreviewedTodoTasks(messaged.state, messaged.activity, review).keys()]).toEqual([
      "verify",
    ]);
    review = applyTodoReview(review, { at: 400, tasks: { build: 1, verify: 3 } });
    expect(review.at).toBe(500);
    expect(review.tasks.get("build")).toEqual({ revision: 2, at: 500 });
    expect(review.tasks.get("verify")).toEqual({ revision: 3, at: 400 });
    expect(unreviewedTodoTasks(messaged.state, messaged.activity, review).size).toBe(0);
    // A later message at a higher revision is unreviewed again.
    const again = step(
      messaged,
      { action: "upsert", tasks: [{ key: "build", message: "Rebuilt" }] },
      600,
    );
    expect([...unreviewedTodoTasks(again.state, again.activity, review).keys()]).toEqual(["build"]);
  });

  it("ignores malformed review entries and values", () => {
    const review = createTodoReviewState();
    for (const raw of [
      null,
      [],
      { at: 1 },
      { tasks: { build: 1 } },
      { at: -1, tasks: {} },
      { at: Infinity, tasks: {} },
      { at: 1, tasks: [] },
    ]) {
      expect(applyTodoReview(review, raw)).toBe(review);
    }
    const partial = applyTodoReview(review, {
      at: 1,
      tasks: { build: 2, bad: -1, worse: 1.5, worst: "3" },
    });
    expect([...partial.tasks.keys()]).toEqual(["build"]);
  });

  it("builds review marks for all or selected unreviewed tasks", () => {
    const review = createTodoReviewState();
    expect(todoReviewMarks(messaged.state, messaged.activity, review)).toEqual(
      new Map([
        ["verify", 3],
        ["build", 2],
      ]),
    );
    expect(
      todoReviewMarks(messaged.state, messaged.activity, review, ["build", "missing"]),
    ).toEqual(new Map([["build", 2]]));
  });
});

describe("persisted activity", () => {
  const session = step(
    planned,
    { action: "upsert", tasks: [{ key: "build", status: "in_progress", message: "Go" }] },
    200,
  );

  it("round-trips through JSON and drops invalid parts leniently", () => {
    const json = JSON.parse(JSON.stringify(serializeTodoActivity(session.activity)));
    expect(readTodoActivity(json, session.state)).toEqual(session.activity);
    const good = json.build.updates[0];
    const raw = {
      build: {
        createdAt: 100,
        updates: [
          good,
          { ...good, revision: 99 },
          { ...good, revision: 0 },
          { ...good, status: "cancelled" },
          { ...good, from: "done" },
          { ...good, message: 4 },
          { ...good, message: "x".repeat(MAX_TASK_MESSAGE_LENGTH + 1) },
          { ...good, by: "model" },
          { ...good, at: Number.MAX_VALUE },
          null,
        ],
      },
      verify: { createdAt: "yesterday", updates: "none" },
      missing: { createdAt: 1, updates: [] },
      constructor: { createdAt: 1, updates: [] },
    };
    expect(readTodoActivity(raw, session.state)).toEqual(
      new Map<string, TodoTaskActivity>([["build", { createdAt: 100, updates: [good] }]]),
    );
    for (const invalid of [undefined, null, [], "activity"])
      expect(readTodoActivity(invalid, session.state).size).toBe(0);
  });

  it("keeps model output independent of review state and bounded per task", () => {
    const full = formatTodoState(session.state, undefined, session.activity);
    expect(JSON.parse(full).tasks[0]).toMatchObject({ key: "build", lastMessage: "Go" });
    const detail = JSON.parse(formatTodoState(session.state, "build", session.activity)).tasks[0];
    expect(detail).toMatchObject({
      createdAt: new Date(100).toISOString(),
      updates: [
        {
          revision: 2,
          at: new Date(200).toISOString(),
          status: "in_progress",
          from: "pending",
          message: "Go",
        },
      ],
    });
    expect(formatTodoState(session.state)).not.toContain("lastMessage");
    const long = step(
      session,
      { action: "upsert", tasks: [{ key: "verify", message: "m".repeat(500) }] },
      300,
    );
    expect(
      JSON.parse(formatTodoState(long.state, undefined, long.activity)).tasks[1].lastMessage,
    ).toHaveLength(120);
    expect(formatTodoContext(long.state)).not.toContain("mmm");
  });
});
