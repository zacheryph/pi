import {
  showExplorer,
  type ActionBus,
  type ExplorerItem,
  type ExplorerModel,
  type ModalContext,
} from "#ui";
import { lastTodoActivityAt, type TodoActivity } from "#src/activity";
import { TODO_INSPECT_ACTION } from "#src/events";
import type { TodoState } from "#src/state";
import { orderedTodoTasks, todoTaskPresentation } from "#src/ui/render";

export type TodoBrowserView = "all" | "recent";
const TODO_VIEWS: readonly TodoBrowserView[] = ["all", "recent"];

export interface TodoBrowserOptions {
  /** Enables view tabs and message search. */
  activity?: TodoActivity;
  view?: TodoBrowserView;
  /** Subagent holding each delegated task, as a display label. */
  assignees?: ReadonlyMap<string, string>;
  /** The session's bus, where `todo.inspect` is defined. */
  actions?: ActionBus;
  /** Completed tasks archived off the list. */
  archived?: number;
}

const archivedNotice = (count = 0) =>
  count > 0 ? ` · ${count} earlier completed task${count === 1 ? "" : "s"} archived` : "";

/**
 * Task snapshot for the shared explorer, as plain JSON. Details load through
 * `todo.inspect`; task mutations belong exclusively to explicit commands and
 * tools, so the browser never writes.
 */
export function todoExplorerModel(
  state: TodoState,
  options: TodoBrowserOptions = {},
): ExplorerModel {
  const activity = options.activity;
  const items = orderedTodoTasks(state).map((task): ExplorerItem => {
    const presentation = todoTaskPresentation(task, state);
    const messages =
      activity?.get(task.key)?.updates.flatMap((update) => update.message ?? []) ?? [];
    const assignee = options.assignees?.get(task.key);
    return {
      id: task.key,
      label: `${task.key}: ${task.subject}${task.dependsOn?.length ? ` ← ${task.dependsOn.join(", ")}` : ""}${assignee ? ` → ${assignee}` : ""}`,
      badge: { text: `${presentation.glyph} ${presentation.label}`, tone: presentation.color },
      search: `${task.description ?? ""} ${task.status} ${(task.dependsOn ?? []).join(" ")} ${messages.join(" ")}${assignee ? ` ${assignee}` : ""}`,
    };
  });
  const base = {
    title: "Todos",
    noun: ["task", "tasks"] as const,
    items,
    hints: [{ keys: "/todo:add" }, { keys: "/todo:clear" }],
    loadDetail: { action: TODO_INSPECT_ACTION },
  };
  if (!activity) return { ...base, notices: [{ text: "Read-only task snapshot", tone: "muted" }] };
  const order = new Map(state.tasks.map((task, index) => [task.key, index]));
  const recent = state.tasks
    .map((task) => task.key)
    .sort(
      (a, b) =>
        (lastTodoActivityAt(b, activity) ?? -1) - (lastTodoActivityAt(a, activity) ?? -1) ||
        order.get(a)! - order.get(b)!,
    );
  return {
    ...base,
    notices: [
      { text: `Read-only task snapshot${archivedNotice(options.archived)}`, tone: "muted" },
    ],
    tabs: [
      { label: "All", ids: items.map((item) => item.id) },
      { label: "Recent", ids: recent },
    ],
    initialTab: Math.max(0, TODO_VIEWS.indexOf(options.view ?? "all")),
  };
}

export async function showTodoBrowser(
  ctx: ModalContext,
  state: TodoState,
  options: TodoBrowserOptions = {},
): Promise<void> {
  await showExplorer(ctx, todoExplorerModel(state, options), {
    command: "/todo",
    actions: options.actions,
  });
}
