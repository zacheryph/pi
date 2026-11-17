import { describe, expect, it } from "vitest";
import {
  isViewModel,
  onViewChanged,
  readView,
  settleViews,
  type SummaryModel,
  type ViewEntry,
} from "#surface";
import { createTodoReviewState } from "#src/activity";
import { MAX_RECENT_COMPLETED } from "#src/archive";
import { todoSettings } from "#src/config";
import { TODO_SUMMARY_VIEW } from "#src/events";
import { createEmptyTodoState } from "#src/state";
import { todoSummaryModel } from "#src/summary";
import { renderTodoText } from "#src/ui/render";
import { started, type Harness } from "#test/harness";

const summary = (env: Harness) => {
  const model = readView(env.pi.events, TODO_SUMMARY_VIEW);
  expect(isViewModel("summary", model)).toBe(true);
  return model as SummaryModel;
};
const counts = (env: Harness) =>
  Object.fromEntries(summary(env).counts.map((count) => [count.key, count.value]));
const zeros = {
  total: 0,
  completed: 0,
  "in-progress": 0,
  pending: 0,
  blocked: 0,
  unreviewed: 0,
  "unreviewed-messages": 0,
  archived: 0,
};

describe("todo.summary", () => {
  it("reads zeros for an empty list, where an unloaded pi-todo has no view", async () => {
    const env = await started();
    expect(summary(env)).toEqual({
      counts: [
        { key: "total", label: "tasks", value: 0 },
        { key: "completed", label: "completed", value: 0, tone: "success" },
        { key: "in-progress", label: "in progress", value: 0, tone: "accent" },
        { key: "pending", label: "pending", value: 0 },
        { key: "blocked", label: "blocked", value: 0, tone: "warning" },
        { key: "unreviewed", label: "unreviewed", value: 0, tone: "accent" },
        { key: "unreviewed-messages", label: "new messages", value: 0 },
        { key: "archived", label: "archived", value: 0, tone: "muted" },
      ],
    });
    // The widget has nothing to show; the summary still answers.
    expect(readView(env.pi.events, "todo.widget")).toBeUndefined();
    await env.emit("session_shutdown");
    expect(() => readView(env.pi.events, TODO_SUMMARY_VIEW)).toThrow("Unknown view");
  });

  it("counts every task by status and names the first task in progress", async () => {
    const env = await started();
    await env.execute({
      action: "upsert",
      tasks: [
        { key: "a", subject: "Read the plan", status: "completed", message: "Read it" },
        { key: "b", subject: "Write the collector", status: "in_progress", message: "Started" },
        { key: "c", subject: "Review it", dependsOn: ["b"] },
        { key: "d", subject: "Ship it" },
        { key: "e", subject: "Second in progress", status: "in_progress" },
      ],
    });
    expect(counts(env)).toEqual({
      ...zeros,
      total: 5,
      completed: 1,
      "in-progress": 2,
      pending: 1,
      blocked: 1,
      unreviewed: 2,
      "unreviewed-messages": 2,
    });
    expect(summary(env).active).toEqual({ id: "b", label: "Write the collector" });
  });

  it("stays available while the widget is disabled", async () => {
    const env = await started({ config: { widget: false } });
    await env.execute({ action: "upsert", tasks: [{ key: "a", subject: "A" }] });
    expect(readView(env.pi.events, "todo.widget")).toBeUndefined();
    expect(counts(env)).toMatchObject({ total: 1, pending: 1 });
  });

  it("counts tasks the widget filters out", async () => {
    const env = await started({ config: { showCompleted: false } });
    await env.execute({
      action: "upsert",
      tasks: [
        { key: "a", subject: "A", status: "completed" },
        { key: "b", subject: "B", status: "completed" },
      ],
    });
    // Every task is completed and nothing is unreviewed: the widget hides.
    expect(readView(env.pi.events, "todo.widget")).toBeUndefined();
    expect(counts(env)).toMatchObject({ total: 2, completed: 2, unreviewed: 0 });
  });

  it("counts the whole list where the widget caps its rows, and archived tasks", async () => {
    const env = await started({ config: { maxVisible: 2 } });
    const many = MAX_RECENT_COMPLETED + 3;
    await env.execute({
      action: "upsert",
      tasks: Array.from({ length: many }, (_, i) => ({ key: `t${i}`, subject: `Step ${i}` })),
    });
    const lines = renderTodoText(await env.state(), { ...todoSettings.defaults(), maxVisible: 2 });
    expect(lines.at(-1)).toBe(`+${many - 2} more`);
    expect(counts(env)).toMatchObject({ total: many, pending: many });

    await env.execute({
      action: "upsert",
      tasks: Array.from({ length: many }, (_, i) => ({
        key: `t${i}`,
        status: "completed" as const,
      })),
    });
    // Completed tasks beyond the recent ones leave the list for the archive.
    expect(counts(env)).toMatchObject({
      total: MAX_RECENT_COMPLETED,
      completed: MAX_RECENT_COMPLETED,
      archived: 3,
    });
  });

  it("announces review changes with the unreviewed counts they change", async () => {
    const env = await started();
    const announced: string[] = [];
    onViewChanged(env.pi.events, (id) => announced.push(id));
    await env.execute({
      action: "upsert",
      tasks: [
        { key: "a", subject: "A", message: "One" },
        { key: "b", subject: "B", message: "Two" },
      ],
    });
    await env.execute({ action: "upsert", tasks: [{ key: "a", message: "Three" }] });
    expect(announced).toContain(TODO_SUMMARY_VIEW);
    expect(counts(env)).toMatchObject({ unreviewed: 2, "unreviewed-messages": 3 });

    announced.length = 0;
    await env.command("todo:review", "all");
    expect(announced).toContain(TODO_SUMMARY_VIEW);
    expect(counts(env)).toMatchObject({ unreviewed: 0, "unreviewed-messages": 0 });
  });

  it("follows the branch on tree navigation and a restart", async () => {
    const env = await started();
    await env.execute({ action: "upsert", tasks: [{ key: "root", subject: "Root" }] });
    const root = env.session.getLeafId()!;
    await env.execute({
      action: "upsert",
      tasks: [{ key: "left", subject: "Left", status: "in_progress" }],
    });
    const left = env.session.getLeafId()!;
    env.session.branch(root);
    const announced: string[] = [];
    onViewChanged(env.pi.events, (id) => announced.push(id));
    await env.emit("session_tree");
    expect(announced).toContain(TODO_SUMMARY_VIEW);
    expect(counts(env)).toMatchObject({ total: 1, "in-progress": 0 });
    expect(summary(env).active).toBeUndefined();

    env.session.branch(left);
    const restored = await started({ session: env.session });
    expect(counts(restored)).toMatchObject({ total: 2, "in-progress": 1 });
    expect(summary(restored).active).toEqual({ id: "left", label: "Left" });
  });

  it("is persisted state: a saved summary settles unchanged, task in progress included", async () => {
    const env = await started();
    await env.execute({
      action: "upsert",
      tasks: [
        { key: "a", subject: "A", status: "completed", message: "Done" },
        { key: "b", subject: "B", status: "in_progress" },
      ],
    });
    const model = summary(env);
    expect(JSON.stringify(model)).not.toContain('"live"');
    const saved: ViewEntry[] = [{ id: TODO_SUMMARY_VIEW, kind: "summary", title: "Tasks", model }];
    expect(settleViews(saved, Date.now())).toEqual(saved);
  });

  it("builds from the given state alone", () => {
    const model = todoSummaryModel({
      state: createEmptyTodoState(),
      activity: new Map(),
      review: createTodoReviewState(),
      archived: 4,
    });
    expect(model.counts.find((count) => count.key === "archived")?.value).toBe(4);
    expect(model.active).toBeUndefined();
  });
});
