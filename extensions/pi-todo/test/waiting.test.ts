// The `waiting` status: a task only the user can move on.
import { describe, expect, it } from "vitest";
import { createEmptyTodoState, writeTodoSnapshot, type TodoState } from "#src/state";
import { orderedTodoTasks, renderTodoText, todoWidgetModel } from "#src/ui/render";
import { started } from "#test/harness";

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
