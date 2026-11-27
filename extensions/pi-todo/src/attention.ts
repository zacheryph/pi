/**
 * Tasks waiting on the user, as the rest of the bundle sees them: one
 * `todo.attention` item each, answered with `todo.unblock`, and one pi-work item
 * each, so the session is woken once when the user answers.
 *
 * Everything here is derived from the branch's task state and history: nothing
 * is journaled for it, so `/tree`, resume, reload and compaction need nothing
 * of their own.
 */
import {
  isJsonObject,
  MAX_ATTENTION_REASON,
  MAX_ATTENTION_REPLY,
  type ActionDefinition,
  type AttentionItem,
  type AttentionModel,
} from "#surface";
import { sanitizeLine } from "#ui";
import type { WorkHost, WorkItem, WorkMessage } from "#work";
import type { TodoActivity } from "#src/activity";
import { TODO_ATTENTION_VIEW, TODO_UNBLOCK_ACTION } from "#src/events";
import type { TodoState, TodoStatus, TodoTask } from "#src/state";

export { TODO_ATTENTION_VIEW, TODO_UNBLOCK_ACTION };

/** The pi-work owner and kind of a waiting task's item. */
export const TODO_WORK_OWNER = "pi-todo";
export const TODO_WAITING_KIND = "waiting";
/** Custom message type of the answer that wakes the session. */
export const TODO_REPLY_TYPE = "todo:reply";

/** One task waiting on the user, as the view and the work items read it. */
export interface WaitingTask {
  task: TodoTask;
  /** Revision of the update that set it waiting: a reply names the wait it answers. */
  rev: string;
  /** What the user must do: the latest message since it started waiting. */
  message?: string;
  /** When it started waiting, epoch milliseconds, when its history says. */
  since?: number;
}

/** The waiting tasks of a list, in list order. */
export function waitingTasks(state: TodoState, activity: TodoActivity): WaitingTask[] {
  return state.tasks.flatMap((task) => {
    if (task.status !== "waiting") return [];
    const updates = activity.get(task.key)?.updates ?? [];
    // The run of updates at the end that are all `waiting`; its first set the status.
    let start = updates.length;
    while (start > 0 && updates[start - 1]!.status === "waiting") start--;
    const run = updates.slice(start);
    const set = run[0];
    const message = run.findLast((update) => update.message)?.message;
    return [
      {
        task,
        // History keeps the latest updates only; a wait older than all of them is still one wait.
        rev: String(set?.revision ?? 0),
        ...(message ? { message } : {}),
        ...(set ? { since: set.at } : {}),
      },
    ];
  });
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The `todo.attention` view: one item per waiting task, each answered by `todo.unblock`. */
export function todoAttentionModel(waiting: readonly WaitingTask[], now: number): AttentionModel {
  const items = waiting.map(({ task, rev, message, since }): AttentionItem => {
    const reason = message
      ? clip(sanitizeLine(message).replace(/\s+/g, " ").trim(), MAX_ATTENTION_REASON)
      : "";
    return {
      id: `task:${task.key}`,
      rev,
      category: "task",
      title: sanitizeLine(task.subject) || task.key,
      ...(reason ? { reason } : {}),
      state: "ready",
      since: since ?? now,
      reply: { action: TODO_UNBLOCK_ACTION, args: { key: task.key, rev } },
    };
  });
  return { items, total: items.length };
}

/** What `todo.unblock` needs from the session. */
export interface UnblockSource {
  waiting(): readonly WaitingTask[];
  /** Record the user's reply on the task and set it pending, as the user. */
  reply(key: string, text: string): void;
}

/** `todo.unblock { key, rev, text }`: the user's answer to a task waiting on them. */
export function todoUnblockAction(
  source: UnblockSource,
): ActionDefinition<{ key: string; rev: string; text: string }> {
  return {
    id: TODO_UNBLOCK_ACTION,
    title: "Answer a task waiting on you, and wake the agent with the answer",
    parse: (args) => {
      if (
        !isJsonObject(args) ||
        typeof args.key !== "string" ||
        typeof args.rev !== "string" ||
        typeof args.text !== "string"
      )
        throw new Error("expected { key, rev, text }");
      const text = args.text.trim();
      if (!text) throw new Error("Type a reply.");
      if (text.length > MAX_ATTENTION_REPLY)
        throw new Error(`A reply is at most ${MAX_ATTENTION_REPLY} characters.`);
      return { key: args.key, rev: args.rev, text };
    },
    handler: ({ key, rev, text }) => {
      const found = source.waiting().find((waiting) => waiting.task.key === key);
      if (!found) throw new Error(`Task ${key} is no longer waiting on you.`);
      if (found.rev !== rev)
        throw new Error(`Task ${key} was set waiting again since it was shown; look at it again.`);
      source.reply(key, text);
      return { unblocked: key };
    },
  };
}

/** How a waiting task stopped waiting, for the message that wakes the session. */
export interface LeftWaiting {
  /** Its status now; absent when the task is gone. */
  status?: TodoStatus;
  /** The message recorded with the change. */
  message?: string;
}

/** The message that tells the agent the user answered. */
export function replyMessage(waiting: WaitingTask, left: LeftWaiting): WorkMessage {
  const key = waiting.task.key;
  const asked = waiting.message ? `: ${waiting.message}` : "";
  const answer =
    left.status === undefined
      ? "The user removed the task."
      : left.status === "pending" && left.message
        ? `The user replied: ${left.message}`
        : `The user set it ${left.status}${left.message ? `: ${left.message}` : "."}`;
  return {
    customType: TODO_REPLY_TYPE,
    content: `Task ${key} (${waiting.task.subject}) was waiting on you${asked}\n${answer}`,
    details: { key, rev: waiting.rev, ...(left.status ? { status: left.status } : {}) },
  };
}

interface Tracked {
  item: WorkItem;
  waiting: WaitingTask;
}

/**
 * One pi-work item per waiting task, kept in step with the list. A task the
 * user moves on completes its item with their answer, which wakes the session;
 * one the agent moves on itself is cancelled, quietly.
 */
export function createWaitingWork(host: () => WorkHost | undefined) {
  const tracked = new Map<string, Tracked>();
  /** The key and revision an item was opened for. */
  const opened = (item: WorkItem) => {
    const data = isJsonObject(item.data) ? item.data : {};
    return {
      key: typeof data.key === "string" ? data.key : undefined,
      rev: typeof data.rev === "string" ? data.rev : undefined,
    };
  };
  const open = (waiting: WaitingTask): Tracked | undefined => {
    const work = host();
    if (!work) return undefined;
    const item = work.open({
      owner: TODO_WORK_OWNER,
      kind: TODO_WAITING_KIND,
      label: waiting.task.subject,
      data: { key: waiting.task.key, rev: waiting.rev },
    });
    return { item, waiting };
  };
  return {
    /**
     * Take back what an earlier instance left open, during `session_start`:
     * an item whose task still waits at the same revision. Others are cancelled.
     */
    adopt(waiting: readonly WaitingTask[]) {
      tracked.clear();
      const byKey = new Map(waiting.map((entry) => [entry.task.key, entry]));
      const stale: WorkItem[] = [];
      host()?.adopt(TODO_WORK_OWNER, (item) => {
        const { key, rev } = opened(item);
        const entry = key === undefined ? undefined : byKey.get(key);
        if (entry && entry.rev === rev && !tracked.has(entry.task.key))
          tracked.set(entry.task.key, { item, waiting: entry });
        else stale.push(item);
        return true;
      });
      for (const item of stale) item.cancel();
      sync(waiting);
    },
    sync,
    /** Items by task key, for tests. */
    keys: () => [...tracked.keys()],
    /** The session is shutting down: its items stay open on disk for the next start. */
    forget() {
      tracked.clear();
    },
  };

  /**
   * Match the items to the list. `by: "user"` says the user made the change,
   * so a task that left waiting answers its item; `messages` are the change's.
   */
  function sync(
    waiting: readonly WaitingTask[],
    change?: {
      by?: "user";
      state: TodoState;
      messages?: ReadonlyMap<string, string>;
    },
  ) {
    const now = new Map(waiting.map((entry) => [entry.task.key, entry]));
    for (const [key, { item, waiting: was }] of tracked) {
      const still = now.get(key);
      if (still && still.rev === was.rev) {
        // Same wait, maybe a newer message or subject: the answer quotes the latest.
        tracked.set(key, { item, waiting: still });
        continue;
      }
      tracked.delete(key);
      if (change?.by === "user" && !still) {
        const status = change.state.tasks.find((task) => task.key === key)?.status;
        const message = change.messages?.get(key);
        item.complete(
          replyMessage(was, { ...(status ? { status } : {}), ...(message ? { message } : {}) }),
        );
      } else item.cancel();
    }
    for (const entry of waiting) {
      if (tracked.has(entry.task.key)) continue;
      const made = open(entry);
      if (made) tracked.set(entry.task.key, made);
    }
  }
}
