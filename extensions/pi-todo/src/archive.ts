/**
 * archive.ts — completed tasks that left the list.
 *
 * The list keeps every unfinished task and the most recently completed ones.
 * Older completed tasks move to the archive: a short record of each (key,
 * subject, when it completed, its last message) that `todo_list` with the key
 * still returns, so a long-running session can check what was done without
 * carrying every finished task in the model's context.
 *
 * The archive is journaled apart from the list: each change appends only the
 * records it archived, so a long archive is not written again with every edit.
 */

import { isRecord } from "#foundations/guards";
import { latestTodoMessage, type TodoActivity, type TodoTaskActivity } from "#src/activity";
import type { TodoDetails, TodoState, TodoTask } from "#src/state";

/** Journal of archived records; replayed in order on the branch. */
export const TODO_ARCHIVE_TYPE = "todo:archive";
/** Completed tasks the list keeps; older ones are archived. */
export const MAX_RECENT_COMPLETED = 10;
/** Archived records kept; the oldest are dropped beyond this. */
export const MAX_ARCHIVED_TASKS = 200;
/** An archived record keeps this much of the task's last message. */
export const MAX_ARCHIVED_MESSAGE_LENGTH = 240;

/** A completed task that left the list. */
export interface ArchivedTask {
  key: string;
  subject: string;
  /** List revision of the change that archived it. */
  revision: number;
  /** Epoch milliseconds; absent when the completion was not recorded. */
  completedAt?: number;
  /** The task's last message, shortened. */
  message?: string;
}

/** Archived records by key, oldest first. */
export type TodoArchive = ReadonlyMap<string, ArchivedTask>;

/** Journal payload: the records one change archived, or a clear of the whole archive. */
export interface TodoArchiveEntry {
  tasks?: ArchivedTask[];
  clear?: true;
}

const KEY = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function readArchivedTask(value: unknown): ArchivedTask | undefined {
  if (!isRecord(value)) return undefined;
  const { key, subject, revision, completedAt, message } = value;
  if (typeof key !== "string" || !KEY.test(key)) return undefined;
  if (typeof subject !== "string" || !subject || subject.length > 160) return undefined;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
    return undefined;
  const time =
    typeof completedAt === "number" &&
    Number.isFinite(completedAt) &&
    completedAt >= 0 &&
    completedAt <= 8.64e15
      ? completedAt
      : undefined;
  const text =
    typeof message === "string" && message
      ? message.slice(0, MAX_ARCHIVED_MESSAGE_LENGTH)
      : undefined;
  return {
    key,
    subject,
    revision,
    ...(time !== undefined ? { completedAt: time } : {}),
    ...(text ? { message: text } : {}),
  };
}

/**
 * The archive after a journal entry. A record for a key already archived
 * replaces it (a reused key completed again); the oldest records beyond the cap
 * are dropped. Lenient: malformed records are skipped.
 */
export function applyTodoArchive(archive: TodoArchive, raw: unknown): Map<string, ArchivedTask> {
  if (!isRecord(raw)) return new Map(archive);
  if (raw.clear === true) return new Map();
  const next = new Map(archive);
  for (const value of Array.isArray(raw.tasks) ? raw.tasks : []) {
    const task = readArchivedTask(value);
    if (!task) continue;
    next.delete(task.key);
    next.set(task.key, task);
  }
  for (const key of next.keys()) {
    if (next.size <= MAX_ARCHIVED_TASKS) break;
    next.delete(key);
  }
  return next;
}

/** Archived records whose key is not back on the list. */
export function archivedOnly(archive: TodoArchive, state: TodoState): ArchivedTask[] {
  const live = new Set(state.tasks.map((task) => task.key));
  return [...archive.values()].filter((task) => !live.has(task.key));
}

/** When a completed task last became completed: its revision and time, from its history. */
function completion(key: string, activity: TodoActivity): { revision: number; at?: number } {
  const updates = activity.get(key)?.updates ?? [];
  // A status change to completed carries `from`; a task created completed has it as its first update.
  const update =
    updates.findLast((candidate) => candidate.status === "completed" && candidate.from) ??
    (updates[0]?.status === "completed" ? updates[0] : undefined);
  return update ? { revision: update.revision, at: update.at } : { revision: 0 };
}

function record(task: TodoTask, revision: number, activity: TodoActivity): ArchivedTask {
  const message = latestTodoMessage(task.key, activity)?.message;
  const { at } = completion(task.key, activity);
  return {
    key: task.key,
    subject: task.subject,
    revision,
    ...(at !== undefined ? { completedAt: at } : {}),
    ...(message ? { message: message.slice(0, MAX_ARCHIVED_MESSAGE_LENGTH) } : {}),
  };
}

export interface ArchiveOptions {
  /** The list before the change, and its history. */
  previous: TodoState;
  previousActivity: TodoActivity;
  /** The change, with history recorded for it. */
  next: TodoDetails;
  activity: ReadonlyMap<string, TodoTaskActivity>;
  /** Completed tasks the change removed that go to the archive (`clear` of completed tasks). */
  removed?: readonly string[];
}

/**
 * Archive the completed tasks beyond the most recent `MAX_RECENT_COMPLETED`,
 * and the completed tasks `removed` names. Prerequisite links to archived tasks
 * are dropped: a completed prerequisite is already satisfied. The revision moves
 * on when archiving changes a list the change itself left alone.
 */
export function archiveCompleted({
  previous,
  previousActivity,
  next,
  activity,
  removed = [],
}: ArchiveOptions): {
  details: TodoDetails;
  activity: Map<string, TodoTaskActivity>;
  archived: ArchivedTask[];
} {
  const completed = next.tasks
    .map((task, index) => ({ task, index, revision: completion(task.key, activity).revision }))
    .filter(({ task }) => task.status === "completed")
    // Most recent first; between equals, the later task in the list.
    .sort((a, b) => b.revision - a.revision || b.index - a.index);
  // Oldest first, the order the archive keeps.
  const overflow = completed
    .slice(MAX_RECENT_COMPLETED)
    .reverse()
    .map(({ task }) => task);
  const before = new Map(previous.tasks.map((task) => [task.key, task]));
  const cleared = removed.flatMap((key) => {
    const task = before.get(key);
    return task?.status === "completed" && !next.tasks.some((live) => live.key === key)
      ? [task]
      : [];
  });
  if (!overflow.length && !cleared.length)
    return { details: next, activity: new Map(activity), archived: [] };

  const gone = new Set(overflow.map((task) => task.key));
  const revision =
    gone.size && next.revision === previous.revision ? next.revision + 1 : next.revision;
  const archived = [
    ...cleared.map((task) => record(task, revision, previousActivity)),
    ...overflow.map((task) => record(task, revision, activity)),
  ];
  const archivedKeys = new Set(archived.map((task) => task.key));
  const tasks = next.tasks
    .filter((task) => !gone.has(task.key))
    .map((task) => {
      const dependsOn = task.dependsOn?.filter((key) => !gone.has(key));
      const { dependsOn: _old, ...rest } = task;
      return dependsOn?.length ? { ...rest, dependsOn } : rest;
    });
  const history = new Map([...activity].filter(([key]) => !gone.has(key)));
  const keep = (keys: readonly string[]) => keys.filter((key) => !archivedKeys.has(key));
  return {
    details: {
      ...next,
      revision,
      tasks,
      change: {
        added: keep(next.change.added),
        updated: keep(next.change.updated),
        removed: keep(next.change.removed),
        archived: [...archivedKeys],
      },
    },
    activity: history,
    archived,
  };
}

/** `todo_list` with an archived task's key. */
export function formatArchivedTask(revision: number, task: ArchivedTask): string {
  return JSON.stringify({
    revision,
    archived: {
      key: task.key,
      subject: task.subject,
      status: "completed",
      ...(task.completedAt !== undefined
        ? { completedAt: new Date(task.completedAt).toISOString() }
        : {}),
      ...(task.message ? { lastMessage: task.message } : {}),
    },
  });
}
