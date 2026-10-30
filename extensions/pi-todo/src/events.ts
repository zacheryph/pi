import { unreviewedTodoUpdates, type TodoActivity, type TodoReviewState, type TodoUpdate } from "./activity.ts";
import { isTaskBlocked, type TodoState, type TodoStatus } from "./state.ts";

/**
 * `pi.events` channel carrying the complete task list for other extensions in
 * the same session (each subagent has its own bus). Emitted on session start,
 * branch changes, every plan change and every review. Read-only data: each
 * emission is a fresh copy, and listeners cannot change tasks through it.
 */
export const TODO_SNAPSHOT_EVENT = "pi-todo:snapshot";
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
}

export interface TodoSnapshotEvent {
  version: typeof TODO_SNAPSHOT_VERSION;
  revision: number;
  tasks: TodoSnapshotTask[];
}

export function todoSnapshotEvent(state: TodoState, activity: TodoActivity, review: TodoReviewState): TodoSnapshotEvent {
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
      };
    }),
  });
}
