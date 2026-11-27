// The `waiting` status: a task only the user can move on.
import { describe, expect, it } from "vitest";
import { createEmptyTodoState, writeTodoSnapshot, type TodoState } from "#src/state";
import { orderedTodoTasks, renderTodoText, todoWidgetModel } from "#src/ui/render";
import { dispatchAction, isViewModel, readView, type AttentionModel } from "#surface";
import { started, T0 } from "#test/harness";

const WAIT = "Choose staging or prod in the deploy settings";

function plan(): TodoState {
  return writeTodoSnapshot(createEmptyTodoState(), {
    tasks: [
      { key: "done", subject: "Done", status: "completed" },
      { key: "next", subject: "Next", status: "pending" },
      { key: "host", subject: "Pick a host", status: "waiting" },
      { key: "deploy", subject: "Deploy", status: "pending", dependsOn: ["host"] },
      { key: "work", subject: "Work", status: "in_progress" },
    ],
  });
}

describe("setting a task waiting", () => {
  it("needs a message in the same write, and records it as the task's latest", async () => {
    const env = await started();
    await env.execute({ action: "upsert", tasks: [{ key: "host", subject: "Pick a host" }] });
    const before = await env.state();
    await expect(
      env.execute({ action: "upsert", tasks: [{ key: "host", status: "waiting" }] }),
    ).rejects.toThrow("task host: setting waiting needs a message");
    // Refused before anything changed.
    expect((await env.state()).revision).toBe(before.revision);
    // A new task too.
    await expect(
      env.execute({
        action: "upsert",
        tasks: [{ key: "other", subject: "Other", status: "waiting" }],
      }),
    ).rejects.toThrow("task other: setting waiting needs a message");

    await env.execute({
      action: "upsert",
      tasks: [{ key: "host", status: "waiting", message: WAIT }],
    });
    const listed = JSON.parse(await env.text({ action: "list", key: "host" }));
    expect(listed.tasks.find((task: { key: string }) => task.key === "host").status).toBe(
      "waiting",
    );
    expect(await env.text({ action: "list" })).toContain(WAIT);

    // Staying waiting needs no new message; leaving it needs none either.
    await env.execute({ action: "upsert", tasks: [{ key: "host", subject: "Pick the host" }] });
    await env.execute({ action: "upsert", tasks: [{ key: "host", status: "pending" }] });
    expect((await env.state()).tasks[0]!.status).toBe("pending");
  });

  it("takes no in_progress slot, holds back its dependents and counts as unfinished", async () => {
    const env = await started({ config: { singleActive: true } });
    await env.execute({
      action: "upsert",
      tasks: [
        { key: "host", subject: "Pick a host", status: "waiting", message: WAIT },
        { key: "deploy", subject: "Deploy", dependsOn: ["host"] },
        { key: "work", subject: "Work", status: "in_progress" },
      ],
    });
    await expect(
      env.execute({ action: "upsert", tasks: [{ key: "deploy", status: "in_progress" }] }),
    ).rejects.toThrow("dependencies are unresolved: host");
    expect((await env.state()).tasks.map((task) => task.status)).toEqual([
      "waiting",
      "pending",
      "in_progress",
    ]);
  });

  it("is set by the user with /todo:update, which also needs the message", async () => {
    const env = await started();
    await env.execute({ action: "upsert", tasks: [{ key: "host", subject: "Pick a host" }] });
    await env.command("todo:update", "host waiting");
    expect(env.notices).toHaveBeenLastCalledWith(
      expect.stringContaining("setting waiting needs a message"),
      "error",
    );
    expect((await env.state()).tasks[0]!.status).toBe("pending");
    await env.command("todo:update", `host waiting ${WAIT}`);
    expect((await env.state()).tasks[0]!.status).toBe("waiting");
    await env.command("todo:update", "host stalled");
    expect(env.notices).toHaveBeenLastCalledWith(
      "status must be pending, in_progress, waiting, or completed",
      "error",
    );
  });

  it("survives a reload", async () => {
    const env = await started();
    await env.execute({
      action: "upsert",
      tasks: [{ key: "host", subject: "Pick a host", status: "waiting", message: WAIT }],
    });
    await env.emit("session_start");
    expect((await env.state()).tasks[0]!.status).toBe("waiting");
  });
});

describe("showing a waiting task", () => {
  it("sorts it first, with its own glyph and label, and dependents blocked", () => {
    const state = plan();
    expect(orderedTodoTasks(state).map((task) => task.key)).toEqual([
      "host",
      "work",
      "next",
      "deploy",
      "done",
    ]);
    const lines = renderTodoText(state, {
      maxVisible: 10,
      showCompleted: false,
      messages: new Map([["host", WAIT]]),
    });
    expect(lines[1]).toBe(`‖ host: Pick a host [waiting] · last: ${WAIT}`);
    expect(lines).toContain("○ deploy: Deploy ← host [blocked]");
  });

  it("puts a waiting count in the widget's header and the waiting icon on the row", () => {
    const model = todoWidgetModel(plan(), { maxVisible: 10, showCompleted: true });
    expect(model.meta).toEqual([
      [
        { text: "1 waiting on you", tone: "warning" },
        { text: " / ", tone: "muted" },
        { text: "1 active / 2 pending", tone: "muted" },
      ],
      [{ text: "1 waiting on you", tone: "warning" }],
    ]);
    const right = model.rows[0]!.right as unknown[][];
    expect(right.at(-1)).toEqual([{ text: "‖", tone: "warning", icon: "waiting" }]);
  });
});

describe("a waiting task as an attention item you answer", () => {
  const openItems = (env: Awaited<ReturnType<typeof started>>) => {
    const open = new Map<string, unknown>();
    for (const entry of env.session.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "work:item") continue;
      const record = entry.data as { op: string; id: string; data?: unknown; reason?: string };
      if (record.op === "open") open.set(record.id, record.data);
      else open.delete(record.id);
    }
    return [...open.values()];
  };
  const replies = (env: Awaited<ReturnType<typeof started>>) =>
    env.pi.sendMessage.mock.calls.filter(
      ([message]) => (message as { customType?: string }).customType === "todo:reply",
    );
  const waitOn = async (env: Awaited<ReturnType<typeof started>>) => {
    await env.execute({
      action: "upsert",
      tasks: [
        { key: "host", subject: "Pick a host" },
        { key: "deploy", subject: "Deploy", dependsOn: ["host"] },
      ],
    });
    env.clock.now += 60_000;
    await env.execute({
      action: "upsert",
      tasks: [{ key: "host", status: "waiting", message: WAIT }],
    });
    return String((await env.state()).revision);
  };

  it("lists one item per waiting task, with the message that set it and a reply", async () => {
    const env = await started();
    expect(readView(env.pi.events, "todo.attention")).toEqual({ items: [], total: 0 });
    const rev = await waitOn(env);
    const model = readView(env.pi.events, "todo.attention") as AttentionModel;
    expect(isViewModel("attention", model)).toBe(true);
    expect(model).toEqual({
      items: [
        {
          id: "task:host",
          rev,
          category: "task",
          title: "Pick a host",
          reason: WAIT,
          state: "ready",
          since: T0 + 60_000,
          reply: { action: "todo.unblock", args: { key: "host", rev } },
        },
      ],
      total: 1,
    });
    // A note while waiting keeps the revision a reply names, and becomes the reason.
    await env.execute({
      action: "upsert",
      tasks: [{ key: "host", message: "Or tell me in chat" }],
    });
    const again = readView(env.pi.events, "todo.attention") as AttentionModel;
    expect(again.items[0]).toMatchObject({ rev, reason: "Or tell me in chat" });
    expect(openItems(env)).toEqual([{ key: "host", rev }]);
  });

  it("takes the user's reply: recorded as theirs, the task pending, the agent woken once", async () => {
    const env = await started();
    const rev = await waitOn(env);
    await expect(
      dispatchAction(env.pi.events, "todo.unblock", { key: "host", rev: "1", text: "staging" }),
    ).rejects.toThrow("set waiting again since it was shown");
    await expect(
      dispatchAction(env.pi.events, "todo.unblock", { key: "host", rev, text: "   " }),
    ).rejects.toThrow("Type a reply.");
    expect(replies(env)).toEqual([]);

    await dispatchAction(env.pi.events, "todo.unblock", { key: "host", rev, text: " staging " });
    const task = (await env.state()).tasks.find((candidate) => candidate.key === "host")!;
    expect(task.status).toBe("pending");
    const detail = JSON.parse(await env.text({ action: "list", key: "host" }));
    expect(detail.tasks[0].updates.at(-1)).toMatchObject({
      status: "pending",
      from: "waiting",
      message: "staging",
      by: "user",
    });
    expect(replies(env)).toEqual([
      [
        {
          customType: "todo:reply",
          content: `Task host (Pick a host) was waiting on you: ${WAIT}\nThe user replied: staging`,
          details: { key: "host", rev, status: "pending" },
          display: true,
        },
        { triggerTurn: true },
      ],
    ]);
    expect(readView(env.pi.events, "todo.attention")).toEqual({ items: [], total: 0 });
    expect(openItems(env)).toEqual([]);
    // Answered once: the same reply again is refused, and nothing more is sent.
    await expect(
      dispatchAction(env.pi.events, "todo.unblock", { key: "host", rev, text: "staging" }),
    ).rejects.toThrow("no longer waiting");
    expect(replies(env)).toHaveLength(1);
  });

  it("answers from /todo:update too, and closes quietly when the agent moves on itself", async () => {
    const env = await started();
    await waitOn(env);
    await env.command("todo:update", "host in_progress Doing it myself");
    expect(replies(env)).toHaveLength(1);
    expect(String(replies(env)[0]![0]!.content)).toContain(
      "The user set it in_progress: Doing it myself",
    );

    await env.execute({
      action: "upsert",
      tasks: [{ key: "host", status: "waiting", message: WAIT }],
    });
    expect(openItems(env)).toHaveLength(1);
    await env.execute({ action: "upsert", tasks: [{ key: "host", status: "pending" }] });
    expect(openItems(env)).toEqual([]);
    expect(replies(env)).toHaveLength(1);
  });

  it("keeps one item across a reload, and follows the branch on /tree", async () => {
    const env = await started();
    await env.execute({ action: "upsert", tasks: [{ key: "first", subject: "First" }] });
    const before = env.session.getLeafId()!;
    const rev = await waitOn(env);
    // A reload: this instance shuts down, the next starts on the same session.
    await env.emit("session_shutdown");
    await env.emit("session_start");
    await env.emit("resources_discover");
    expect(openItems(env)).toEqual([{ key: "host", rev }]);
    expect(
      env.pi.sendMessage.mock.calls.filter(
        ([message]) => (message as { customType?: string }).customType === "work:lost",
      ),
    ).toEqual([]);
    // The reply still reaches the agent after the reload.
    await dispatchAction(env.pi.events, "todo.unblock", { key: "host", rev, text: "staging" });
    expect(replies(env)).toHaveLength(1);

    // Back to before the wait: nothing waits there.
    env.session.branch(before);
    await env.emit("session_tree");
    expect(readView(env.pi.events, "todo.attention")).toEqual({ items: [], total: 0 });
  });
});
