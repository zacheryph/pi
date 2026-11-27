import { plural } from "#foundations/format";
import type { SummaryCount, SummaryModel } from "#surface";
import type { TodoState } from "#src/state";
import { todoTaskPresentation } from "#src/ui/render";

export interface TodoSummarySource {
  state: TodoState;
  /** Completed tasks archived off the list. */
  archived: number;
}

/**
 * The `todo.summary` view: this branch's task counts and the task in progress,
 * from the same state the widget and `/todo` show, but never filtered or capped
 * by either. Every count is present, zero included, so an empty list reads as
 * zeros where an unloaded pi-todo has no view at all. Task statuses live in
 * the session file, so nothing here is process-bound (`live`).
 * Noun labels agree with their value ("1 task", "2 tasks"); statuses read the
 * same for any value.
 */
export function todoSummaryModel({ state, archived }: TodoSummarySource): SummaryModel {
  const by: Record<string, number> = {
    completed: 0,
    in_progress: 0,
    waiting: 0,
    blocked: 0,
    pending: 0,
  };
  for (const task of state.tasks) {
    const { label } = todoTaskPresentation(task, state);
    by[label] = (by[label] ?? 0) + 1;
  }
  const counts: SummaryCount[] = [
    { key: "total", label: plural(state.tasks.length, "task"), value: state.tasks.length },
    { key: "completed", label: "completed", value: by.completed, tone: "success" },
    { key: "in-progress", label: "in progress", value: by.in_progress, tone: "accent" },
    { key: "waiting", label: "waiting on you", value: by.waiting, tone: "warning" },
    { key: "pending", label: "pending", value: by.pending },
    { key: "blocked", label: "blocked", value: by.blocked, tone: "warning" },
    { key: "archived", label: "archived", value: archived, tone: "muted" },
  ];
  // The first task in progress, in list order, as consumers have always picked it.
  const active = state.tasks.find((task) => task.status === "in_progress");
  return { counts, ...(active ? { active: { id: active.key, label: active.subject } } : {}) };
}
