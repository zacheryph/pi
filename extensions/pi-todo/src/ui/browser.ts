import { showExplorer, type ExplorerItem, type ExplorerView, type ModalContext } from "#ui";
import {
  createTodoReviewState,
  lastTodoActivityAt,
  type TodoActivity,
  type TodoReviewState,
  unreviewedTodoTasks,
} from "#src/activity";
import type { TodoState } from "#src/state";
import {
  formatTodoAge,
  orderedTodoTasks,
  todoTaskDetail,
  todoTaskPresentation,
} from "#src/ui/render";

export type TodoBrowserView = "all" | "unreviewed" | "recent";
const TODO_VIEWS: readonly TodoBrowserView[] = ["all", "unreviewed", "recent"];

export interface TodoBrowserOptions {
  /** Enables history details, unreviewed markers and view tabs. */
  activity?: TodoActivity;
  review?: TodoReviewState;
  now?: number;
  view?: TodoBrowserView;
  /** Review watermarks (key → revision) for messages this snapshot showed. */
  onReview?: (marks: ReadonlyMap<string, number>) => void;
  /** Subagent holding each delegated task, as a display label. */
  assignees?: ReadonlyMap<string, string>;
}

/**
 * Task snapshot for the shared explorer. Task mutations belong exclusively to
 * explicit commands/tools; the only write is review state, through onReview.
 */
export function todoExplorerView(state: TodoState, options: TodoBrowserOptions = {}): ExplorerView {
  const now = options.now ?? Date.now();
  const history = options.activity && {
    activity: options.activity,
    review: options.review ?? createTodoReviewState(),
    now,
  };
  const unreviewed = history
    ? unreviewedTodoTasks(state, history.activity, history.review)
    : new Map();
  const items = orderedTodoTasks(state).map((task): ExplorerItem => {
    const presentation = todoTaskPresentation(task, state);
    const messages =
      history?.activity.get(task.key)?.updates.flatMap((update) => update.message ?? []) ?? [];
    const assignee = options.assignees?.get(task.key);
    return {
      id: task.key,
      label: `${task.key}: ${task.subject}${task.dependsOn?.length ? ` ← ${task.dependsOn.join(", ")}` : ""}${assignee ? ` → ${assignee}` : ""}`,
      badge: { text: `${presentation.glyph} ${presentation.label}`, tone: presentation.color },
      marked: unreviewed.has(task.key),
      search: `${task.description ?? ""} ${task.status} ${(task.dependsOn ?? []).join(" ")} ${messages.join(" ")}${assignee ? ` ${assignee}` : ""}`,
      detail: todoTaskDetail(task, state, history, assignee),
    };
  });
  const base = {
    title: "Todos",
    noun: ["task", "tasks"] as const,
    items,
    hints: [{ keys: "/todo:add" }, { keys: "/todo:clear" }],
  };
  if (!history) return { ...base, notices: [{ text: "Read-only task snapshot", tone: "muted" }] };
  const order = new Map(state.tasks.map((task, index) => [task.key, index]));
  const recent = state.tasks
    .map((task) => task.key)
    .sort(
      (a, b) =>
        (lastTodoActivityAt(b, history.activity) ?? -1) -
          (lastTodoActivityAt(a, history.activity) ?? -1) || order.get(a)! - order.get(b)!,
    );
  // Each shown message is reviewed once, at the revision this snapshot displayed.
  const pending = new Map(unreviewed);
  const review = (keys: string[]) => {
    const marks = new Map<string, number>();
    for (const key of keys) {
      const update = pending.get(key);
      if (update) marks.set(key, update.revision);
      pending.delete(key);
    }
    if (marks.size) options.onReview?.(marks);
  };
  const reviewed = history.review.at;
  return {
    ...base,
    notices: [
      {
        text: `Read-only task snapshot · last reviewed ${reviewed === undefined ? "never" : formatTodoAge(reviewed, now)}`,
        tone: "muted",
      },
    ],
    tabs: [
      { label: "All", ids: items.map((item) => item.id) },
      {
        label: "Unreviewed",
        ids: [...unreviewed.keys()],
        emptyText: "No unreviewed messages. Tab for other views.",
      },
      { label: "Recent", ids: recent },
    ],
    initialTab: Math.max(0, TODO_VIEWS.indexOf(options.view ?? "all")),
    // Opening a marked task, or Ctrl+R on the filtered list, reviews it.
    ...(unreviewed.size
      ? { marker: { label: "unreviewed", clearAction: "mark reviewed", onClear: review } }
      : {}),
  };
}

export async function showTodoBrowser(
  ctx: ModalContext,
  state: TodoState,
  options: TodoBrowserOptions = {},
): Promise<void> {
  await showExplorer(ctx, todoExplorerView(state, options), {
    command: "/todo",
  });
}
