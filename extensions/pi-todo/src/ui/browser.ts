import {
  showExplorer,
  type ActionBus,
  type ExplorerItem,
  type ExplorerModel,
  type ModalContext,
} from "#ui";
import {
  createTodoReviewState,
  lastTodoActivityAt,
  type TodoActivity,
  type TodoReviewState,
  unreviewedTodoTasks,
} from "#src/activity";
import { TODO_INSPECT_ACTION, TODO_REVIEW_ACTION } from "#src/events";
import type { TodoState } from "#src/state";
import { formatTodoAge, orderedTodoTasks, todoTaskPresentation } from "#src/ui/render";

export type TodoBrowserView = "all" | "unreviewed" | "recent";
const TODO_VIEWS: readonly TodoBrowserView[] = ["all", "unreviewed", "recent"];

export interface TodoBrowserOptions {
  /** Enables unreviewed markers, view tabs and the review state details are shown against. */
  activity?: TodoActivity;
  review?: TodoReviewState;
  now?: number;
  view?: TodoBrowserView;
  /** Subagent holding each delegated task, as a display label. */
  assignees?: ReadonlyMap<string, string>;
  /** The branch this snapshot was taken on; `todo.review` refuses marks for another. */
  branch?: number;
  /** The session's bus, where `todo.inspect` and `todo.review` are defined. */
  actions?: ActionBus;
}

/**
 * Task snapshot for the shared explorer, as plain JSON. Details load through
 * `todo.inspect`; task mutations belong exclusively to explicit commands and
 * tools, and the only write is review state, through `todo.review`.
 */
export function todoExplorerModel(
  state: TodoState,
  options: TodoBrowserOptions = {},
): ExplorerModel {
  const now = options.now ?? Date.now();
  const history = options.activity && {
    activity: options.activity,
    review: options.review ?? createTodoReviewState(),
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
    };
  });
  const base = {
    title: "Todos",
    noun: ["task", "tasks"] as const,
    items,
    hints: [{ keys: "/todo:add" }, { keys: "/todo:clear" }],
  };
  if (!history)
    return {
      ...base,
      notices: [{ text: "Read-only task snapshot", tone: "muted" }],
      loadDetail: { action: TODO_INSPECT_ACTION },
    };
  const order = new Map(state.tasks.map((task, index) => [task.key, index]));
  const recent = state.tasks
    .map((task) => task.key)
    .sort(
      (a, b) =>
        (lastTodoActivityAt(b, history.activity) ?? -1) -
          (lastTodoActivityAt(a, history.activity) ?? -1) || order.get(a)! - order.get(b)!,
    );
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
    // Opening a marked task, or Ctrl+R on the filtered list, reviews it, each at
    // the revision this snapshot displayed.
    ...(unreviewed.size
      ? {
          marker: {
            label: "unreviewed",
            clearAction: "mark reviewed",
            onClear: {
              action: TODO_REVIEW_ACTION,
              args: {
                revisions: Object.fromEntries(
                  [...unreviewed].map(([key, update]) => [key, update.revision]),
                ),
                ...(options.branch === undefined ? {} : { branch: options.branch }),
              },
            },
          },
        }
      : {}),
    // Details show the review state this list showed, so messages it marked as
    // new stay marked in the detail that opening the task just reviewed.
    loadDetail: {
      action: TODO_INSPECT_ACTION,
      args: {
        reviewed: Object.fromEntries(
          [...history.review.tasks].map(([key, { revision, at }]) => [key, { revision, at }]),
        ),
      },
    },
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
