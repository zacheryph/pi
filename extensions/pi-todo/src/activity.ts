import { type TodoDetails, type TodoState, type TodoStatus, TodoValidationError } from "./state.ts";

/**
 * Local sidecar beside upstream's pure snapshot engine: per-task status/message
 * history and user review watermarks. Upstream state.ts stays byte-for-byte.
 */
export const MAX_TASK_UPDATES = 10;
export const MAX_TASK_MESSAGE_LENGTH = 2_000;

export interface TodoUpdate {
  /** Plan revision that recorded this update; doubles as the review watermark. */
  revision: number;
  /** Epoch milliseconds; display only. */
  at: number;
  /** Status after this update. */
  status: TodoStatus;
  /** Previous status, only when this update changed it. */
  from?: TodoStatus;
  message?: string;
  /** User command; absent for model tool calls. */
  by?: "user";
  /** pi-subagents agent id, when a subagent made the update through a delegated claim. */
  agent?: string;
}

export interface TodoTaskActivity {
  /** Absent for tasks restored from journals written before history existed. */
  createdAt?: number;
  updates: TodoUpdate[];
}

/** Keyed by task key. Maps avoid inherited keys such as "constructor". */
export type TodoActivity = ReadonlyMap<string, TodoTaskActivity>;

export interface TodoReview {
  revision: number;
  at: number;
}

export interface TodoReviewState {
  /** Latest review action on this branch. */
  at?: number;
  tasks: ReadonlyMap<string, TodoReview>;
}

/** Review journal payload: highest reviewed update revision per key. */
export interface TodoReviewEntry {
  at: number;
  tasks: Record<string, number>;
}

const STATUSES: ReadonlySet<unknown> = new Set(["pending", "in_progress", "completed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Bounded to the valid Date range so formatting never throws. */
function readTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : undefined;
}

/**
 * Records status transitions and messages for a mutation upstream already
 * validated. Message-only patches leave upstream's snapshot unchanged, so bump
 * the revision here: journaling and optimistic revision checks depend on it.
 * Pure; throws before anything is journaled.
 */
export function recordTodoActivity(
  previous: TodoState,
  next: TodoDetails,
  patches: readonly { key: string; message?: string }[] | undefined,
  activity: TodoActivity,
  meta: { at: number; by?: "user"; agent?: string },
): { details: TodoDetails; activity: Map<string, TodoTaskActivity> } {
  const messages = new Map<string, string>();
  for (const [index, patch] of (patches ?? []).entries()) {
    if (patch.message === undefined) continue;
    if (typeof patch.message !== "string") throw new TodoValidationError(`tasks[${index}].message must be a string`);
    const message = patch.message.trim();
    if (message.length > MAX_TASK_MESSAGE_LENGTH) {
      throw new TodoValidationError(`tasks[${index}].message must be at most ${MAX_TASK_MESSAGE_LENGTH} characters`);
    }
    if (message) messages.set(patch.key.trim(), message);
  }

  let details = next;
  if (messages.size && next.revision === previous.revision) {
    const listed = new Set([...next.change.added, ...next.change.updated]);
    details = {
      ...next,
      revision: previous.revision + 1,
      change: { ...next.change, updated: [...next.change.updated, ...[...messages.keys()].filter((key) => !listed.has(key))] },
    };
  }

  const before = new Map(previous.tasks.map((task) => [task.key, task]));
  const recorded = new Map<string, TodoTaskActivity>();
  for (const task of details.tasks) {
    const prior = before.get(task.key);
    // A reused key after removal starts a fresh history.
    const history = prior ? activity.get(task.key) : undefined;
    const message = messages.get(task.key);
    const changed = prior ? prior.status !== task.status : task.status !== "pending";
    const updates = history?.updates.map((update) => ({ ...update })) ?? [];
    if (changed || message) {
      updates.push({
        revision: details.revision, at: meta.at, status: task.status,
        ...(prior && changed ? { from: prior.status } : {}),
        ...(message ? { message } : {}),
        ...(meta.by ? { by: meta.by } : {}),
        ...(meta.agent ? { agent: meta.agent } : {}),
      });
    }
    const createdAt = prior ? history?.createdAt : meta.at;
    if (createdAt === undefined && !updates.length) continue;
    recorded.set(task.key, {
      ...(createdAt !== undefined ? { createdAt } : {}),
      updates: updates.slice(-MAX_TASK_UPDATES),
    });
  }
  return { details, activity: recorded };
}

export function cloneTodoActivity(activity: TodoActivity): Map<string, TodoTaskActivity> {
  return new Map([...activity].map(([key, entry]) => [key, {
    ...entry, updates: entry.updates.map((update) => ({ ...update })),
  }]));
}

/** Journal form. Task keys cannot spell "__proto__", so a plain object is safe. */
export function serializeTodoActivity(activity: TodoActivity): Record<string, TodoTaskActivity> {
  return Object.fromEntries(cloneTodoActivity(activity));
}

function readUpdate(value: unknown, maxRevision: number): TodoUpdate | undefined {
  if (!isRecord(value)) return undefined;
  const revision = readCount(value.revision);
  const at = readTime(value.at);
  if (revision === undefined || revision < 1 || revision > maxRevision || at === undefined) return undefined;
  if (!STATUSES.has(value.status) || (value.from !== undefined && !STATUSES.has(value.from))) return undefined;
  if (value.by !== undefined && value.by !== "user") return undefined;
  if (value.agent !== undefined && (typeof value.agent !== "string" || !value.agent || value.agent.length > 128)) return undefined;
  let message: string | undefined;
  if (value.message !== undefined) {
    if (typeof value.message !== "string") return undefined;
    message = value.message.trim();
    if (!message || message.length > MAX_TASK_MESSAGE_LENGTH) return undefined;
  }
  return {
    revision, at, status: value.status as TodoStatus,
    ...(value.from !== undefined ? { from: value.from as TodoStatus } : {}),
    ...(message ? { message } : {}),
    ...(value.by === "user" ? { by: "user" as const } : {}),
    ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
  };
}

/**
 * Lenient: history is display metadata, not plan state. Drop invalid parts
 * instead of rejecting an otherwise valid journal snapshot.
 */
export function readTodoActivity(raw: unknown, state: TodoState): Map<string, TodoTaskActivity> {
  const activity = new Map<string, TodoTaskActivity>();
  if (!isRecord(raw)) return activity;
  const keys = new Set(state.tasks.map((task) => task.key));
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.has(key) || !isRecord(value)) continue;
    const createdAt = readTime(value.createdAt);
    const updates = (Array.isArray(value.updates) ? value.updates : [])
      .map((update) => readUpdate(update, state.revision))
      .filter((update): update is TodoUpdate => !!update)
      .slice(-MAX_TASK_UPDATES);
    if (createdAt === undefined && !updates.length) continue;
    activity.set(key, { ...(createdAt !== undefined ? { createdAt } : {}), updates });
  }
  return activity;
}

export function createTodoReviewState(): TodoReviewState {
  return { tasks: new Map() };
}

/** Watermarks only move forward; malformed entries are ignored. */
export function applyTodoReview(review: TodoReviewState, raw: unknown): TodoReviewState {
  if (!isRecord(raw) || !isRecord(raw.tasks)) return review;
  const at = readTime(raw.at);
  if (at === undefined) return review;
  const tasks = new Map(review.tasks);
  for (const [key, value] of Object.entries(raw.tasks)) {
    const revision = readCount(value);
    if (revision === undefined) continue;
    const current = tasks.get(key);
    if (!current || revision > current.revision) tasks.set(key, { revision, at });
  }
  return { at: Math.max(review.at ?? 0, at), tasks };
}

/** Model messages are flagged until reviewed; status-only and user updates never are. */
export function isReviewable(update: TodoUpdate): boolean {
  return !!update.message && update.by !== "user";
}

export function unreviewedTodoUpdates(key: string, activity: TodoActivity, review: TodoReviewState): TodoUpdate[] {
  const seen = review.tasks.get(key)?.revision ?? 0;
  return (activity.get(key)?.updates ?? []).filter((update) => isReviewable(update) && update.revision > seen);
}

/** Latest unreviewed update per task, newest first; ties keep plan order. */
export function unreviewedTodoTasks(state: TodoState, activity: TodoActivity, review: TodoReviewState): Map<string, TodoUpdate> {
  const entries: [string, TodoUpdate][] = [];
  for (const task of state.tasks) {
    const latest = unreviewedTodoUpdates(task.key, activity, review).at(-1);
    if (latest) entries.push([task.key, latest]);
  }
  return new Map(entries.sort((a, b) => b[1].revision - a[1].revision));
}

/** Review marks for unreviewed tasks in this snapshot, optionally limited to keys. */
export function todoReviewMarks(
  state: TodoState, activity: TodoActivity, review: TodoReviewState, keys?: Iterable<string>,
): Map<string, number> {
  const allowed = keys ? new Set(keys) : undefined;
  const marks = new Map<string, number>();
  for (const [key, update] of unreviewedTodoTasks(state, activity, review)) {
    if (!allowed || allowed.has(key)) marks.set(key, update.revision);
  }
  return marks;
}

export function latestTodoMessage(key: string, activity: TodoActivity): TodoUpdate | undefined {
  return activity.get(key)?.updates.findLast((update) => update.message);
}

export function lastTodoActivityAt(key: string, activity: TodoActivity): number | undefined {
  const entry = activity.get(key);
  return entry?.updates.at(-1)?.at ?? entry?.createdAt;
}
