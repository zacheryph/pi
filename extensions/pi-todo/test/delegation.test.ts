import {
  createEventBus,
  SessionManager,
  type ContextEvent,
  type ContextEventResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionEvent,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_TREE_KEY } from "../../../packages/pi-session-tree/src/index.ts";
import todoExtension from "#src/index";
import type { TodoRequest } from "#src/actions";
import { TODO_CLAIMS_TYPE } from "#src/claims";
import { DEFAULT_CONFIG, type TodoConfig } from "#src/config";
import { TODO_SNAPSHOT_EVENT, type TodoSnapshotEvent } from "#src/events";
import { replayTodoSession } from "#src/replay";
import type { TodoDetails } from "#src/state";

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global in tests
  delete (globalThis as Record<symbol, unknown>)[SESSION_TREE_KEY];
});

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
const CONTEXT_TYPE = "pi-personal:todo-context";

/** One Pi session with pi-todo loaded and its own real event bus. */
function session(config: Partial<TodoConfig> = {}) {
  const manager = SessionManager.inMemory("/todo-delegation");
  const bus = createEventBus();
  const tools: ToolDefinition<TSchema, TodoDetails>[] = [];
  const handlers = new Map<string, Handler[]>();
  const snapshots: TodoSnapshotEvent[] = [];
  bus.on(TODO_SNAPSHOT_EVENT, (data) => {
    snapshots.push(data as TodoSnapshotEvent);
  });
  const pi = {
    registerTool: vi.fn((tool: ToolDefinition<TSchema, TodoDetails>) => tools.push(tool)),
    registerCommand: vi.fn(),
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    }),
    appendEntry: vi.fn((type: string, data: unknown) => {
      manager.appendCustomEntry(type, data);
    }),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    events: { emit: bus.emit, on: bus.on },
  };
  todoExtension(pi as unknown as ExtensionAPI, {
    loadConfig: () => ({ ...DEFAULT_CONFIG, ...config }),
    saveConfig: vi.fn(),
    now: () => 1_000,
  });
  const ctx = {
    cwd: "/todo-delegation",
    mode: "print",
    hasUI: false,
    ui: { notify: vi.fn(), setWidget: vi.fn() },
    sessionManager: manager,
  } as unknown as ExtensionContext & ExtensionToolContext;
  const emit = async (name: string, event: object = { type: name }) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? [])
      result = await handler(event as ExtensionEvent, ctx);
    return result;
  };
  const execute = (request: TodoRequest) =>
    tools[0].execute("call", request, undefined, undefined, ctx);
  const text = async (request: TodoRequest) =>
    (await execute(request)).content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  const tasks = async () =>
    JSON.parse(await text({ action: "list" })).tasks as {
      key: string;
      status: string;
      dependsOn?: string[];
    }[];
  const context = async () => {
    const result = (await emit("context", {
      type: "context",
      messages: [] satisfies ContextEvent["messages"],
    })) as ContextEventResult | undefined;
    const message = result?.messages?.find(
      (m) => m.role === "custom" && m.customType === CONTEXT_TYPE,
    );
    return message && "content" in message && typeof message.content === "string"
      ? message.content
      : undefined;
  };
  return {
    id: manager.getSessionId(),
    manager,
    bus,
    pi,
    emit,
    execute,
    text,
    tasks,
    context,
    snapshots,
  };
}
type Session = ReturnType<typeof session>;

/** Plan the parent's tasks: a, b, c (c depends on nothing), d completed. */
async function planned(config: Partial<TodoConfig> = {}) {
  const parent = session(config);
  await parent.emit("session_start");
  await parent.execute({
    action: "upsert",
    tasks: [
      { key: "a", subject: "Audit auth" },
      { key: "b", subject: "Write tests" },
      { key: "c", subject: "Ship" },
      { key: "d", subject: "Done already", status: "completed" },
    ],
  });
  return parent;
}

const handoffCall = (toolCallId: string, todos: unknown) => ({
  type: "tool_call",
  toolName: "subagent",
  toolCallId,
  input: { prompt: "x", description: "x", subagent_type: "general-purpose", handoff: { todos } },
});

/** What pi-subagents does: veto check, session-created on the parent's bus, then the child starts. */
async function spawn(
  parent: Session,
  todos: { keys: string[]; scope?: string },
  agentId = "a3f2b1c4-0000-0000",
  config: Partial<TodoConfig> = {},
) {
  const toolCallId = `call-${agentId}`;
  const blocked = await parent.emit("tool_call", handoffCall(toolCallId, todos));
  expect(blocked).toBeUndefined();
  const child = session(config);
  parent.bus.emit("subagents:child:session-created", {
    sessionId: child.id,
    parentSessionId: parent.id,
    agentId,
    toolCallId,
    handoff: { todos, review: { other: "data" } },
  });
  await child.emit("session_start");
  return child;
}

const claimEntries = (s: Session) =>
  s.manager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === TODO_CLAIMS_TYPE)
    .map((entry) => (entry as { data: unknown }).data);

describe("handing tasks to a subagent", () => {
  it("vetoes a spawn whose handoff.todos cannot be claimed", async () => {
    const parent = await planned();
    const veto = async (todos: unknown, id = "call") =>
      parent.emit("tool_call", handoffCall(id, todos)) as Promise<
        { block?: boolean; reason?: string } | undefined
      >;
    expect(await veto({ keys: ["zzz"] })).toEqual({
      block: true,
      reason: "Cannot hand off todo tasks: unknown task: zzz",
    });
    expect(await veto({ keys: ["d"] })).toEqual({
      block: true,
      reason: "Cannot hand off todo tasks: already completed: d",
    });
    expect(await veto(["a"])).toMatchObject({
      block: true,
      reason: expect.stringContaining("handoff.todos must be"),
    });
    expect(await veto({ keys: ["a"], scope: "everything" })).toMatchObject({
      block: true,
      reason: expect.stringContaining("scope"),
    });
    expect(await veto({ keys: [] })).toMatchObject({
      block: true,
      reason: expect.stringContaining("at least one"),
    });
    // Two calls in one turn: the first reserves its keys before either child exists.
    expect(await veto({ keys: ["a"] }, "call-1")).toBeUndefined();
    expect(await veto({ keys: ["a", "b"] }, "call-2")).toEqual({
      block: true,
      reason: "Cannot hand off todo tasks: already handed to a (a subagent being started)",
    });
    // A failed spawn frees its reservation.
    await parent.emit("tool_result", {
      type: "tool_result",
      toolCallId: "call-1",
      input: {},
      content: [],
      isError: true,
    });
    expect(await veto({ keys: ["a", "b"] }, "call-3")).toBeUndefined();
    // Other tools and handoffs without todos are not pi-todo's business.
    expect(
      await parent.emit("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "x",
        input: { handoff: { todos: 7 } },
      }),
    ).toBeUndefined();
    expect(
      await parent.emit("tool_call", {
        type: "tool_call",
        toolName: "subagent",
        toolCallId: "y",
        input: { handoff: { review: 1 } },
      }),
    ).toBeUndefined();
  });

  it("binds a claim whose spawn reports a different call id than the reservation", async () => {
    const parent = await planned();
    expect(
      await parent.emit("tool_call", handoffCall("call-outer/1", { keys: ["a"] })),
    ).toBeUndefined();
    const child = session();
    parent.bus.emit("subagents:child:session-created", {
      sessionId: child.id,
      parentSessionId: parent.id,
      agentId: "nested-agent",
      toolCallId: "call-other",
      handoff: { todos: { keys: ["a"] } },
    });
    await child.emit("session_start");
    expect((await child.tasks()).map((task) => task.key)).toEqual(["a"]);
  });

  it("refuses keys a live subagent already holds", async () => {
    const parent = await planned();
    await spawn(parent, { keys: ["a"] });
    expect(await parent.emit("tool_call", handoffCall("call-x", { keys: ["a"] }))).toEqual({
      block: true,
      reason: "Cannot hand off todo tasks: already handed to a (agent a3f2b1c4)",
    });
  });

  it("journals the claim before the child starts and shows the child only its tasks", async () => {
    const parent = await planned();
    const child = await spawn(parent, { keys: ["a", "b"] });
    expect(claimEntries(parent)).toEqual([
      {
        op: "claim",
        agent: "a3f2b1c4-0000-0000",
        session: child.id,
        scope: "assigned",
        keys: ["a", "b"],
        at: 1_000,
      },
    ]);
    expect((await child.tasks()).map((task) => task.key)).toEqual(["a", "b"]);
    expect(await child.context()).toMatch(
      /^Your parent session handed you these tasks\. .*"key":"a".*"key":"b"/s,
    );
    expect(await child.context()).not.toContain('"key":"c"');
    expect(parent.snapshots.at(-1)?.tasks.map((task) => [task.key, task.claimedBy])).toEqual([
      ["a", "a3f2b1c4-0000-0000"],
      ["b", "a3f2b1c4-0000-0000"],
      ["c", undefined],
      ["d", undefined],
    ]);
  });

  it("lands the child's updates and new tasks in the parent's list, attributed and flagged", async () => {
    const parent = await planned();
    const child = await spawn(parent, { keys: ["a"] });

    await child.execute({
      action: "upsert",
      tasks: [
        { key: "a", status: "completed", message: "No issues in the session cookie path." },
        { key: "a-followup", subject: "Rotate signing key", dependsOn: ["a"] },
      ],
    });

    const plan = replayTodoSession({ sessionManager: parent.manager });
    expect(plan.state.tasks.map((task) => [task.key, task.status])).toEqual([
      ["a", "completed"],
      ["b", "pending"],
      ["c", "pending"],
      ["d", "completed"],
      ["a-followup", "pending"],
    ]);
    expect(plan.activity.get("a")?.updates.at(-1)).toMatchObject({
      status: "completed",
      message: "No issues in the session cookie path.",
      agent: "a3f2b1c4-0000-0000",
    });
    expect(plan.claims.get("a3f2b1c4-0000-0000")?.keys).toEqual(["a", "a-followup"]);
    expect(parent.snapshots.at(-1)?.tasks.find((task) => task.key === "a")).toMatchObject({
      unreviewed: 1,
      claimedBy: "a3f2b1c4-0000-0000",
    });
    expect((await child.tasks()).map((task) => task.key)).toEqual(["a", "a-followup"]);
    // The parent's next request sees the change; nothing was written to the child's own list.
    expect(await parent.context()).toContain('"key":"a-followup"');
    expect(replayTodoSession({ sessionManager: child.manager }).state.tasks).toEqual([]);
  });

  it("refuses writes outside the claim, replace, and clearing everything", async () => {
    const parent = await planned();
    const child = await spawn(parent, { keys: ["a"] });
    await expect(
      child.execute({ action: "upsert", tasks: [{ key: "c", status: "in_progress" }] }),
    ).rejects.toThrow("task c is not assigned to you");
    await expect(
      child.execute({ action: "upsert", tasks: [{ key: "c", dependsOn: ["a"] }] }),
    ).rejects.toThrow("task c is not assigned to you");
    await expect(child.execute({ action: "remove", keys: ["b"] })).rejects.toThrow(
      "task b is not assigned to you",
    );
    await expect(child.execute({ action: "replace", tasks: [] })).rejects.toThrow(
      "replace is not available",
    );
    await expect(child.execute({ action: "clear", scope: "all" })).rejects.toThrow(
      "only clear completed",
    );
    await expect(child.execute({ action: "list", key: "c" })).rejects.toThrow("unknown task: c");
    expect((await parent.tasks()).map((task) => task.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("clears and removes only the child's own tasks", async () => {
    const parent = await planned();
    const child = await spawn(parent, { keys: ["a", "b"] });
    await child.execute({ action: "upsert", tasks: [{ key: "a", status: "completed" }] });
    await child.execute({ action: "clear", scope: "completed" });
    expect((await parent.tasks()).map((task) => task.key)).toEqual(["b", "c", "d"]);
    await child.execute({ action: "remove", keys: ["b"] });
    expect((await parent.tasks()).map((task) => task.key)).toEqual(["c", "d"]);
  });

  it("with a ledger claim, reads the whole list and may only add prerequisites to other tasks", async () => {
    const parent = await planned();
    const child = await spawn(parent, { keys: ["a"], scope: "ledger" });
    expect((await child.tasks()).map((task) => task.key)).toEqual(["a", "b", "c", "d"]);
    expect(await child.context()).toContain("You may read its whole list");

    await child.execute({
      action: "upsert",
      tasks: [
        { key: "db-migration", subject: "Migrate sessions table" },
        { key: "c", dependsOn: ["db-migration"] },
      ],
    });

    const plan = replayTodoSession({ sessionManager: parent.manager });
    expect(plan.state.tasks.find((task) => task.key === "c")?.dependsOn).toEqual(["db-migration"]);
    expect(plan.activity.get("c")?.updates.at(-1)).toMatchObject({
      message: "Prerequisite added by a subagent: db-migration",
      agent: "a3f2b1c4-0000-0000",
    });
    expect(parent.snapshots.at(-1)?.tasks.find((task) => task.key === "c")).toMatchObject({
      unreviewed: 1,
      blocked: true,
    });
    await expect(
      child.execute({ action: "upsert", tasks: [{ key: "c", dependsOn: [] }] }),
    ).rejects.toThrow("you may only add prerequisites");
    await expect(
      child.execute({ action: "upsert", tasks: [{ key: "c", subject: "Renamed" }] }),
    ).rejects.toThrow("not assigned to you");
    await expect(
      child.execute({ action: "upsert", tasks: [{ key: "b", status: "completed" }] }),
    ).rejects.toThrow("not assigned to you");
  });

  it("turns prerequisite additions off with childPrerequisites", async () => {
    const parent = await planned({ childPrerequisites: false });
    const child = await spawn(parent, { keys: ["a"], scope: "ledger" });
    await expect(
      child.execute({ action: "upsert", tasks: [{ key: "c", dependsOn: ["a"] }] }),
    ).rejects.toThrow(/^task c is not assigned to you$/);
  });

  it("checks baseRevision per task, so other tasks' changes do not make a write stale", async () => {
    const parent = await planned();
    const child = await spawn(parent, { keys: ["a"] });
    const read = JSON.parse(await child.text({ action: "list" })).revision as number;
    await parent.execute({ action: "upsert", tasks: [{ key: "c", status: "in_progress" }] });
    await child.execute({
      action: "upsert",
      baseRevision: read,
      tasks: [{ key: "a", status: "in_progress" }],
    });
    const after = JSON.parse(await child.text({ action: "list" })).revision as number;
    await parent.execute({
      action: "upsert",
      tasks: [{ key: "a", description: "Also check the CSRF token" }],
    });
    await expect(
      child.execute({
        action: "upsert",
        baseRevision: after,
        tasks: [{ key: "a", status: "completed" }],
      }),
    ).rejects.toThrow(/stale todo revision: task a changed at revision \d+, after \d+/);
  });

  it("releases the claim when the agent ends, flagging tasks left in progress, and reclaims on resume", async () => {
    const parent = await planned();
    const child = await spawn(parent, { keys: ["a", "b"] });
    await child.execute({ action: "upsert", tasks: [{ key: "a", status: "in_progress" }] });

    parent.bus.emit("subagents:failed", { id: "a3f2b1c4-0000-0000", status: "error" });

    const plan = replayTodoSession({ sessionManager: parent.manager });
    expect(plan.claims.size).toBe(0);
    expect(plan.activity.get("a")?.updates.at(-1)).toMatchObject({
      message: "agent a3f2b1c4 ended (failed) with this task in progress",
    });
    expect(plan.activity.get("b")?.updates ?? []).toEqual([]);
    await expect(
      child.execute({ action: "upsert", tasks: [{ key: "a", status: "completed" }] }),
    ).rejects.toThrow("no tasks are assigned to you any more");

    parent.bus.emit("subagents:resuming", { id: "a3f2b1c4-0000-0000" });
    await child.execute({ action: "upsert", tasks: [{ key: "a", status: "completed" }] });
    expect((await parent.tasks()).find((task) => task.key === "a")?.status).toBe("completed");
    expect(claimEntries(parent).map((entry) => (entry as { op: string }).op)).toEqual([
      "claim",
      "release",
      "claim",
    ]);
  });

  it("releases claims replayed at a later session start, since no subagent survives one", async () => {
    const parent = await planned();
    await spawn(parent, { keys: ["a"] });
    const resumed = session();
    for (const entry of parent.manager.getBranch())
      resumed.manager.appendCustomEntry(
        (entry as { customType: string }).customType,
        (entry as { data: unknown }).data,
      );
    await resumed.emit("session_start");
    expect(replayTodoSession({ sessionManager: resumed.manager }).claims.size).toBe(0);
  });

  it("reconciles stale claims, reservations and revisions after tree navigation", async () => {
    const parent = await planned();
    const fork = parent.manager.getLeafId()!;
    const oldAgent = "old-agent";
    await spawn(parent, { keys: ["a"] }, oldAgent);
    // Record a newer per-key revision on this branch.
    await parent.execute({
      action: "upsert",
      tasks: [{ key: "a", description: "Old branch edit" }],
    });
    const claimedBranch = parent.manager.getLeafId()!;
    // Also leave a same-turn spawn reservation that must not leak to another branch.
    expect(
      await parent.emit("tool_call", handoffCall("reserved-b", { keys: ["b"] })),
    ).toBeUndefined();

    parent.manager.branch(fork);
    await parent.emit("session_tree");
    expect(replayTodoSession({ sessionManager: parent.manager }).claims.size).toBe(0);
    expect(await parent.emit("tool_call", handoffCall("new-b", { keys: ["b"] }))).toBeUndefined();
    const child = await spawn(parent, { keys: ["a"] }, "new-agent");
    const baseRevision = JSON.parse(await child.text({ action: "list" })).revision as number;
    // The old branch's lastChange must not reject an edit against this branch.
    await child.execute({
      action: "upsert",
      baseRevision,
      tasks: [{ key: "a", status: "in_progress" }],
    });

    // Revisiting a branch whose journal ends with a claim must release it.
    parent.manager.branch(claimedBranch);
    await parent.emit("session_tree");
    expect(replayTodoSession({ sessionManager: parent.manager }).claims.size).toBe(0);
    expect(
      parent.snapshots.at(-1)?.tasks.find((task) => task.key === "a")?.claimedBy,
    ).toBeUndefined();
    // The release must not make an old agent eligible to reclaim this branch.
    parent.bus.emit("subagents:resuming", { id: oldAgent });
    expect(replayTodoSession({ sessionManager: parent.manager }).claims.size).toBe(0);
    expect(
      await parent.emit("tool_call", handoffCall("after-rewind", { keys: ["a"] })),
    ).toBeUndefined();
  });

  it("works locally when nothing was handed over, and refuses to hand delegated tasks on", async () => {
    const parent = await planned();
    const plain = session();
    parent.bus.emit("subagents:child:session-created", {
      sessionId: plain.id,
      parentSessionId: parent.id,
      agentId: "plain-agent",
      toolCallId: "call-plain",
    });
    await plain.emit("session_start");
    await plain.execute({ action: "upsert", tasks: [{ key: "own", subject: "My own notes" }] });
    expect((await plain.tasks()).map((task) => task.key)).toEqual(["own"]);
    expect((await parent.tasks()).map((task) => task.key)).toEqual(["a", "b", "c", "d"]);

    const child = await spawn(parent, { keys: ["a"] });
    expect(await child.emit("tool_call", handoffCall("call-nested", { keys: ["a"] }))).toEqual({
      block: true,
      reason: expect.stringContaining("not supported yet"),
    });
  });
});
