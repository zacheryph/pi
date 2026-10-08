import { describe, expect, it } from "vitest";
import {
  MAX_TASK_DEPENDENCIES,
  MAX_TODO_TASKS,
  TODO_SCHEMA_VERSION,
  TODO_STATE_CUSTOM_TYPE,
  TODO_TOOL_NAME,
  TodoValidationError,
  cloneTodoState,
  createEmptyTodoState,
  getTodoTasks,
  isTaskBlocked,
  removeCompletedTasks,
  replayTodoState,
  writeTodoSnapshot,
  type TodoSnapshotInput,
  type TodoState,
  type TodoStatus,
  type TodoTaskInput,
} from "../src/state.js";

function task(key: string, overrides: Partial<TodoTaskInput> = {}): TodoTaskInput {
  return { key, subject: `Task ${key}`, status: "pending", ...overrides };
}

function stateWith(tasks: TodoTaskInput[]): TodoState {
  return cloneTodoState(writeTodoSnapshot(createEmptyTodoState(), { tasks }));
}

function customEntry(data: unknown) {
  return { type: "custom", customType: TODO_STATE_CUSTOM_TYPE, data };
}

function toolEntry(details: unknown) {
  return { type: "message", message: { role: "toolResult", toolName: TODO_TOOL_NAME, details } };
}

function replay(entries: unknown[]): TodoState {
  return replayTodoState({
    sessionManager: {
      *getBranch() {
        yield* entries;
      },
    },
  });
}

function expectRejected(state: TodoState, input: TodoSnapshotInput, message: string | RegExp): void {
  const previous = structuredClone(state);
  const originalInput = structuredClone(input);
  expect(() => writeTodoSnapshot(state, input)).toThrow(TodoValidationError);
  expect(() => writeTodoSnapshot(state, input)).toThrow(message);
  expect(state).toEqual(previous);
  expect(input).toEqual(originalInput);
}

describe("writeTodoSnapshot", () => {
  it("starts with an empty versioned state and treats an empty write as unchanged", () => {
    const state = createEmptyTodoState();
    expect(state).toEqual({ schemaVersion: TODO_SCHEMA_VERSION, revision: 0, tasks: [] });
    expect(writeTodoSnapshot(state, { tasks: [] })).toEqual({
      ...state, change: { added: [], updated: [], removed: [] },
    });
  });

  it("normalizes fields and uses stable keys rather than positions for sparse inheritance", () => {
    const initial = writeTodoSnapshot(createEmptyTodoState(), {
      tasks: [
        task(" setup ", { subject: " Set up ", description: " Notes ", status: "completed" }),
        task("build", { subject: " Build ", description: " Details ", dependsOn: [" setup ", "setup"] }),
      ],
    });
    expect(initial.tasks).toEqual([
      { key: "setup", subject: "Set up", description: "Notes", status: "completed" },
      { key: "build", subject: "Build", description: "Details", status: "pending", dependsOn: ["setup"] },
    ]);
    expect(initial.change).toEqual({ added: ["setup", "build"], updated: [], removed: [] });

    const reordered = writeTodoSnapshot(initial, { tasks: [{ key: "build" }, { key: " setup " }] });
    expect(reordered.tasks).toEqual([initial.tasks[1], initial.tasks[0]]);
    expect(reordered.revision).toBe(initial.revision + 1);
    expect(reordered.change).toEqual({ added: [], updated: [], removed: [] });

    const unchanged = writeTodoSnapshot(reordered, { tasks: [{ key: "build" }, { key: "setup" }] });
    expect(unchanged.revision).toBe(reordered.revision);
    expect(unchanged.change).toEqual({ added: [], updated: [], removed: [] });
  });

  it("inherits omitted fields, explicitly clears optional fields, and removes omitted keys", () => {
    const state = stateWith([
      task("setup", { status: "completed" }),
      task("build", { description: "Keep until cleared", dependsOn: ["setup"] }),
      task("obsolete"),
    ]);
    const result = writeTodoSnapshot(state, {
      tasks: [{ key: "build", description: "  ", dependsOn: [] }, task("new")],
    });
    expect(result.tasks).toEqual([
      { key: "build", subject: "Task build", status: "pending" },
      { key: "new", subject: "Task new", status: "pending" },
    ]);
    expect(result.change).toEqual({ added: ["new"], updated: ["build"], removed: ["setup", "obsolete"] });
    expect(result.revision).toBe(state.revision + 1);
  });

  it.each([
    { label: "missing new subject", patch: { key: "new", status: "pending" as const }, message: /subject is required for new task/ },
    { label: "missing new status", patch: { key: "new", subject: "New" }, message: /status is required for new task/ },
    { label: "empty subject", patch: task("new", { subject: "   " }), message: /subject is required/ },
    { label: "invalid key", patch: task("UPPER"), message: /lowercase ASCII/ },
    { label: "long key", patch: task("x".repeat(41)), message: /1-40/ },
    { label: "long subject", patch: task("new", { subject: "x".repeat(161) }), message: /at most 160/ },
    { label: "long description", patch: task("new", { description: "x".repeat(2001) }), message: /at most 2000/ },
    { label: "invalid status", patch: task("new", { status: "cancelled" as TodoStatus }), message: /status is invalid/ },
    { label: "empty dependency", patch: task("new", { dependsOn: [" "] }), message: /cannot contain an empty key/ },
    { label: "invalid dependency key", patch: task("new", { dependsOn: ["UPPER"] }), message: /lowercase ASCII/ },
    { label: "duplicate normalized key", patch: task(" existing "), message: /key is duplicated: existing/ },
  ])("rejects $label atomically after an earlier valid edit", ({ patch, message }) => {
    const state = stateWith([task("existing", { description: "Original" })]);
    expectRejected(state, {
      tasks: [{ key: "existing", subject: "Changed", description: "Changed" }, patch],
    }, message);
  });

  it.each([
    { label: "unknown dependency", tasks: [task("a", { dependsOn: ["missing"] })], message: /references missing task missing/ },
    { label: "self dependency", tasks: [task("a", { dependsOn: [" a "] })], message: /cannot depend on itself/ },
    {
      label: "two-task cycle",
      tasks: [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })],
      message: /dependency cycle detected/,
    },
    {
      label: "indirect cycle",
      tasks: [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["c"] }), task("c", { dependsOn: ["a"] })],
      message: /dependency cycle detected/,
    },
  ])("rejects $label without changing the previous state", ({ tasks, message }) => {
    const state = stateWith([task("existing")]);
    expectRejected(state, { tasks: [{ key: "existing", subject: "Changed" }, ...tasks] }, message);
  });

  it.each(["in_progress", "completed"] as const)("rejects blocked %s work", (status) => {
    const state = stateWith([task("setup"), task("build", { dependsOn: ["setup"] })]);
    expectRejected(state, { tasks: [{ key: "setup" }, { key: "build", status }] }, /dependencies are unresolved: setup/);
  });

  it.each([
    { dependentStatus: "in_progress", prerequisiteStatus: "pending" },
    { dependentStatus: "in_progress", prerequisiteStatus: "in_progress" },
    { dependentStatus: "completed", prerequisiteStatus: "pending" },
    { dependentStatus: "completed", prerequisiteStatus: "in_progress" },
  ] as const)(
    "rejects prerequisite regression to $prerequisiteStatus beneath inherited $dependentStatus work",
    ({ dependentStatus, prerequisiteStatus }) => {
      const state = stateWith([
        task("setup", { status: "completed" }),
        task("build", { status: dependentStatus, dependsOn: ["setup"] }),
      ]);
      expectRejected(state, {
        tasks: [{ key: "setup", status: prerequisiteStatus }, { key: "build" }],
      }, /dependencies are unresolved: setup/);
    },
  );

  it.each(["in_progress", "completed"] as const)("allows simultaneous prerequisite completion and dependent %s", (status) => {
    const state = stateWith([task("setup", { status: "in_progress" }), task("build", { dependsOn: ["setup"] })]);
    const result = writeTodoSnapshot(state, {
      // Dependent comes first: validation must use the complete proposed snapshot.
      tasks: [{ key: "build", status }, { key: "setup", status: "completed" }],
    });
    expect(result.tasks.map((item) => [item.key, item.status])).toEqual([["build", status], ["setup", "completed"]]);
    expect(result.change).toEqual({ added: [], updated: ["build", "setup"], removed: [] });
    expect(result.revision).toBe(state.revision + 1);
    expect(state.tasks.map((item) => item.status)).toEqual(["in_progress", "pending"]);
  });

  it("allows completed history to drop removed completed dependencies", () => {
    const state = stateWith([
      task("setup", { status: "completed" }),
      task("build", { status: "completed", dependsOn: ["setup"] }),
    ]);
    const result = writeTodoSnapshot(state, { tasks: [{ key: "build" }] });
    expect(result.tasks).toEqual([{ key: "build", subject: "Task build", status: "completed" }]);
    expect(result.change).toEqual({ added: [], updated: ["build"], removed: ["setup"] });
  });

  it.each(["pending", "in_progress"] as const)("does not silently drop removed dependencies from %s work", (status) => {
    const state = stateWith([
      task("setup", { status: "completed" }),
      task("build", { status, dependsOn: ["setup"] }),
    ]);
    expectRejected(state, { tasks: [{ key: "build" }] }, /references missing task setup/);
  });

  it("accepts optional or matching baseRevision but rejects stale revisions atomically", () => {
    const state = stateWith([task("existing")]);
    expect(writeTodoSnapshot(state, { tasks: [{ key: "existing" }] }).revision).toBe(state.revision);
    expect(writeTodoSnapshot(state, { tasks: [{ key: "existing" }], baseRevision: state.revision }).revision).toBe(state.revision);
    for (const baseRevision of [state.revision - 1, state.revision + 1]) {
      expectRejected(state, { tasks: [{ key: "existing", subject: "Changed" }], baseRevision },
        `stale todo revision: expected ${baseRevision}, current revision is ${state.revision}`);
    }
  });

  it("accepts the task limit and rejects one extra task without mutation", () => {
    const tasks = Array.from({ length: MAX_TODO_TASKS }, (_, index) => task(`task-${index}`));
    const state = stateWith(tasks);
    expect(state.tasks).toHaveLength(MAX_TODO_TASKS);
    expectRejected(state, { tasks: [...tasks, task("extra")] }, `tasks supports at most ${MAX_TODO_TASKS} items`);
  });

  it("accepts the dependency limit and rejects one extra dependency before deduplication", () => {
    const prerequisites = Array.from({ length: MAX_TASK_DEPENDENCIES }, (_, index) => task(`dep-${index}`));
    const dependsOn = prerequisites.map((item) => item.key);
    const state = stateWith([...prerequisites, task("work", { dependsOn })]);
    expect(state.tasks.at(-1)?.dependsOn).toHaveLength(MAX_TASK_DEPENDENCIES);
    expectRejected(state, {
      tasks: [...prerequisites, task("work", { dependsOn: [...dependsOn, dependsOn[0]!] })],
    }, `dependsOn supports at most ${MAX_TASK_DEPENDENCIES} keys`);
  });
});

describe("isTaskBlocked", () => {
  it("requires every dependency to be completed, including missing prerequisites", () => {
    const state = stateWith([
      task("done", { status: "completed" }),
      task("waiting"),
      task("work", { dependsOn: ["done", "waiting"] }),
    ]);
    const work = state.tasks[2]!;
    expect(isTaskBlocked(state.tasks[0]!, state.tasks)).toBe(false);
    expect(isTaskBlocked(work, state.tasks)).toBe(true);
    const complete = writeTodoSnapshot(state, { tasks: [{ key: "done" }, { key: "waiting", status: "completed" }, { key: "work" }] });
    expect(isTaskBlocked(work, complete.tasks)).toBe(false);
    expect(isTaskBlocked(work, complete.tasks.filter((item) => item.key !== "done"))).toBe(true);
  });
});

describe("removeCompletedTasks", () => {
  it("keeps completed direct blockers of unfinished work and cleans removed dependencies", () => {
    const state = stateWith([
      task("root", { status: "completed" }),
      task("required", { status: "completed", dependsOn: ["root"] }),
      task("waiting", { dependsOn: ["required"] }),
      task("running", { status: "in_progress", dependsOn: ["required"] }),
      task("unneeded", { status: "completed" }),
    ]);
    const original = structuredClone(state);
    const result = removeCompletedTasks(state)!;
    expect(result.tasks).toEqual([
      { key: "required", subject: "Task required", status: "completed" },
      { key: "waiting", subject: "Task waiting", status: "pending", dependsOn: ["required"] },
      { key: "running", subject: "Task running", status: "in_progress", dependsOn: ["required"] },
    ]);
    expect(result.change).toEqual({ added: [], updated: ["required"], removed: ["root", "unneeded"] });
    expect(result.revision).toBe(state.revision + 1);
    expect(state).toEqual(original);
    expect(removeCompletedTasks(result)).toBeUndefined();

    const finished = writeTodoSnapshot(result, { tasks: [{ key: "required" }, { key: "waiting", status: "completed" }, { key: "running", status: "completed" }] });
    expect(removeCompletedTasks(finished)?.tasks).toEqual([]);
  });

  it("returns undefined when nothing can be removed", () => {
    expect(removeCompletedTasks(createEmptyTodoState())).toBeUndefined();
    expect(removeCompletedTasks(stateWith([task("pending")]))).toBeUndefined();
    expect(removeCompletedTasks(stateWith([
      task("required", { status: "completed" }), task("pending", { dependsOn: ["required"] }),
    ]))).toBeUndefined();
  });
});

describe("snapshot isolation", () => {
  it("clones task objects and dependency arrays in state and task accessors", () => {
    const state = stateWith([task("setup"), task("build", { dependsOn: ["setup"] })]);
    const original = structuredClone(state);
    const clone = cloneTodoState(state);
    const tasks = getTodoTasks(state);
    expect(clone).toEqual(state);
    expect(tasks).toEqual(state.tasks);
    expect(clone.tasks).not.toBe(state.tasks);
    for (const copies of [clone.tasks, tasks]) {
      expect(copies[1]).not.toBe(state.tasks[1]);
      expect(copies[1]!.dependsOn).not.toBe(state.tasks[1]!.dependsOn);
      copies[1]!.subject = "Changed";
      copies[1]!.dependsOn!.push("other");
      copies.pop();
    }
    expect(state).toEqual(original);
  });

  it("does not alias snapshot inputs or previous state, including unchanged writes", () => {
    const input = { tasks: [task("setup"), task("build", { dependsOn: ["setup"] })] };
    const first = writeTodoSnapshot(createEmptyTodoState(), input);
    const original = structuredClone(first);
    input.tasks[1]!.dependsOn!.push("other");
    input.tasks[1]!.subject = "Changed input";
    expect(first).toEqual(original);

    const second = writeTodoSnapshot(first, { tasks: [{ key: "setup" }, { key: "build" }] });
    expect(second.revision).toBe(first.revision);
    expect(second.tasks[1]).not.toBe(first.tasks[1]);
    expect(second.tasks[1]!.dependsOn).not.toBe(first.tasks[1]!.dependsOn);
    second.tasks[1]!.dependsOn!.push("other");
    second.tasks[1]!.subject = "Changed output";
    expect(first).toEqual(original);
  });
});

describe("replayTodoState", () => {
  it("returns empty state when the active branch contains no valid todo checkpoint", () => {
    expect(replay([])).toEqual(createEmptyTodoState());
    expect(replay([null, {}, { type: "compaction" }, toolEntry({})])).toEqual(createEmptyTodoState());
  });

  it("uses the latest valid entry in branch order, not the highest revision or entry kind", () => {
    const highRevision = { ...stateWith([task("old")]), revision: 100 };
    const custom = { ...stateWith([task("custom")]), revision: 2 };
    const details = writeTodoSnapshot(createEmptyTodoState(), { tasks: [task("tool")] });
    expect(replay([toolEntry(highRevision), customEntry(custom)])).toEqual(custom);
    expect(replay([customEntry(custom), toolEntry(details)])).toEqual(cloneTodoState(details));
    expect(replay([toolEntry(details), customEntry(custom)])).toEqual(custom);
    expect(replay([
      toolEntry(details),
      { type: "custom_message", customType: TODO_STATE_CUSTOM_TYPE, details: custom },
    ])).toEqual(custom);
  });

  it("only reads getBranch, preserving branch-local state rather than abandoned entries", () => {
    const branchState = stateWith([task("branch")]);
    const abandoned = stateWith([task("abandoned")]);
    const restored = replayTodoState({
      sessionManager: {
        getBranch: () => [customEntry(branchState)],
        getEntries: () => [customEntry(branchState), toolEntry(abandoned)],
      } as { getBranch(): Iterable<unknown> },
    });
    expect(restored).toEqual(branchState);
  });

  it.each([
    { label: "foreign custom type", entry: (state: TodoState) => ({ type: "custom", customType: "foreign-todo-state", data: state }) },
    { label: "foreign custom message", entry: (state: TodoState) => ({ type: "custom_message", customType: "foreign-todo-state", details: state }) },
    { label: "foreign tool", entry: (state: TodoState) => ({ type: "message", message: { role: "toolResult", toolName: "foreign_todo", details: state } }) },
    { label: "wrong role", entry: (state: TodoState) => ({ type: "message", message: { role: "assistant", toolName: TODO_TOOL_NAME, details: state } }) },
    { label: "custom details instead of data", entry: (state: TodoState) => ({ type: "custom", customType: TODO_STATE_CUSTOM_TYPE, details: state }) },
    { label: "custom message data instead of details", entry: (state: TodoState) => ({ type: "custom_message", customType: TODO_STATE_CUSTOM_TYPE, data: state }) },
    { label: "tool content instead of details", entry: (state: TodoState) => ({ type: "message", message: { role: "toolResult", toolName: TODO_TOOL_NAME, content: JSON.stringify(state) } }) },
  ])("ignores $label without replacing valid state", ({ entry }) => {
    const state = stateWith([task("valid")]);
    expect(replay([customEntry(state), entry(stateWith([task("ignored")]))])).toEqual(state);
  });

  it.each([
    { label: "null", data: null },
    { label: "unsupported schema", data: { schemaVersion: 999, revision: 1, tasks: [] } },
    { label: "negative revision", data: { revision: -1 } },
    { label: "fractional revision", data: { revision: 1.5 } },
    { label: "unsafe revision", data: { revision: Number.MAX_SAFE_INTEGER + 1 } },
    { label: "missing tasks", data: { tasks: undefined } },
    { label: "non-array tasks", data: { tasks: {} } },
    { label: "null task", data: { tasks: [null] } },
    { label: "missing task subject", data: { tasks: [{ key: "a", status: "pending" }] } },
    { label: "invalid status", data: { tasks: [task("a", { status: "cancelled" as TodoStatus })] } },
    { label: "non-string description", data: { tasks: [{ ...task("a"), description: 1 }] } },
    { label: "non-array dependencies", data: { tasks: [{ ...task("a"), dependsOn: "b" }] } },
    { label: "non-string dependency", data: { tasks: [{ ...task("a"), dependsOn: [1] }] } },
    { label: "duplicate keys", data: { tasks: [task("a"), task(" a ")] } },
    { label: "missing dependency", data: { tasks: [task("a", { dependsOn: ["missing"] })] } },
    { label: "self dependency", data: { tasks: [task("a", { dependsOn: ["a"] })] } },
    { label: "cycle", data: { tasks: [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })] } },
    { label: "blocked active task", data: { tasks: [task("a"), task("b", { status: "in_progress", dependsOn: ["a"] })] } },
    { label: "blocked completed task", data: { tasks: [task("a"), task("b", { status: "completed", dependsOn: ["a"] })] } },
    { label: "too many tasks", data: { tasks: Array.from({ length: MAX_TODO_TASKS + 1 }, (_, index) => task(`task-${index}`)) } },
    { label: "too many dependencies", data: { tasks: [task("a", { dependsOn: Array(MAX_TASK_DEPENDENCIES + 1).fill("b") }), task("b")] } },
  ])("ignores malformed $label in both custom checkpoints and tool details", ({ data }) => {
    const state = stateWith([task("valid")]);
    const malformed = data === null ? null : { schemaVersion: TODO_SCHEMA_VERSION, revision: 10, tasks: [], ...data };
    expect(replay([customEntry(state), customEntry(malformed), toolEntry(malformed)])).toEqual(state);
  });

  it("returns fresh snapshots without aliasing persisted branch entries or other replays", () => {
    const persisted = stateWith([task("setup"), task("build", { dependsOn: ["setup"] })]);
    const original = structuredClone(persisted);
    const entries = [customEntry(persisted)];
    const first = replay(entries);
    const second = replay(entries);
    expect(first.tasks[1]).not.toBe(persisted.tasks[1]);
    expect(first.tasks[1]!.dependsOn).not.toBe(persisted.tasks[1]!.dependsOn);
    first.tasks[1]!.subject = "Changed";
    first.tasks[1]!.dependsOn!.push("other");
    first.tasks.pop();
    expect(persisted).toEqual(original);
    expect(second).toEqual(original);
    expect(replay(entries)).toEqual(original);
  });
});
