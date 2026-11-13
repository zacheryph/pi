import {
  unreviewedTodoUpdates,
  type TodoActivity,
  type TodoReviewState,
  type TodoUpdate,
} from "#src/activity";
import { isTaskBlocked, type TodoState, type TodoStatus } from "#src/state";

/**
 * `pi.events` channel carrying the complete task list for other extensions in
 * the same session (each subagent has its own bus). Emitted on session start,
 * branch changes, every plan change and every review. Read-only data: each
 * emission is a fresh copy, and listeners cannot change tasks through it.
 */
export const TODO_SNAPSHOT_EVENT = "todo:snapshot";
export const TODO_SNAPSHOT_VERSION = 1;

export interface TodoSnapshotTask {
  key: string;
  subject: string;
  description?: string;
  status: TodoStatus;
  dependsOn?: string[];
  /** Not completed and waiting on an unfinished prerequisite. */
  blocked: boolean;
  createdAt?: number;
  /** Status and message history, oldest first (bounded by pi-todo). */
  updates: TodoUpdate[];
  /** Messages the user has not reviewed yet. */
  unreviewed: number;
  /** pi-subagent agent id of the subagent this task is handed to, if any. */
  claimedBy?: string;
}

export interface TodoSnapshotEvent {
  version: typeof TODO_SNAPSHOT_VERSION;
  revision: number;
  tasks: TodoSnapshotTask[];
}

/*
 * Actions and views on this session's bus (see pi-surface), defined from
 * session start to shutdown.
 */

/**
 * Action: `{ id: <key>, reviewed? }` resolves to the task's detail blocks, as
 * `/todo` shows them. `reviewed` (key → `{ revision, at }`) is the review state
 * a list showed; without it the current review state is used.
 */
export const TODO_INSPECT_ACTION = "todo.inspect";
/**
 * Action: mark task messages reviewed; resolves to `{ reviewed: <tasks advanced> }`.
 * `{ ids?, revisions?, branch? }`: with `revisions` (key → revision a list
 * showed), marks those of `ids` (default: all of them) up to that revision;
 * without, marks the latest message of `ids` (default: every task). A `branch`
 * other than the current one is refused, so a stale list cannot mark a
 * different branch.
 */
export const TODO_REVIEW_ACTION = "todo.review";
/** Action: `{ key }` resolves to that task's `TodoHistoryResult` on this branch. */
export const TODO_HISTORY_ACTION = "todo.history";
/** Widget view: the task widget above the editor, absent when the terminal hides it. */
export const TODO_WIDGET_VIEW = "todo.widget";
/** Explorer view: the `/todo` browser on its All tab. */
export const TODO_EXPLORER_VIEW = "todo.explorer";

/** A task's creation time and its status and message history, oldest first. */
export interface TodoHistoryResult {
  key: string;
  createdAt?: number;
  updates: TodoUpdate[];
}

export function todoSnapshotEvent(
  state: TodoState,
  activity: TodoActivity,
  review: TodoReviewState,
  holders: ReadonlyMap<string, string> = new Map(),
): TodoSnapshotEvent {
  return structuredClone({
    version: TODO_SNAPSHOT_VERSION,
    revision: state.revision,
    tasks: state.tasks.map((task): TodoSnapshotTask => {
      const history = activity.get(task.key);
      return {
        ...task,
        blocked: task.status !== "completed" && isTaskBlocked(task, state.tasks),
        ...(history?.createdAt !== undefined ? { createdAt: history.createdAt } : {}),
        updates: history?.updates ?? [],
        unreviewed: unreviewedTodoUpdates(task.key, activity, review).length,
        ...(holders.has(task.key) ? { claimedBy: holders.get(task.key) } : {}),
      };
    }),
  });
}
