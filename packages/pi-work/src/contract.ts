/**
 * The `work:v1` contract: what a session waits on.
 *
 * A **work host** exists for every session and is found by session id through pi-session-tree
 * (`service(sessionId, WORK_SERVICE)`). Producers (jobs, delegated subagents, questions) open
 * items in it and never deliver messages themselves. The host persists open items as data,
 * writes each message into the session's transcript as it arrives, and decides when a message
 * wakes an idle session (its wake policy).
 */

/** The service name a host is offered under, per session id. */
export const WORK_SERVICE = "work:v1";

/** Custom entry type of the records that persist open items (see `WorkRecord`). */
export const WORK_ENTRY = "work:item";

/** Custom message type the host writes for items nobody took over after a restart. */
export const WORK_LOST = "work:lost";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface TextPart {
  type: "text";
  text: string;
}

/** Plain data, written into the session's transcript as a custom message. */
export type WorkMessage = {
  customType: string;
  content: string | TextPart[];
  details?: Json;
};

/** What a producer says when it opens an item. */
export interface WorkItemSpec {
  /** The producer that can adopt this item after a reload (for example `pi-job`). */
  owner: string;
  /** What kind of thing is awaited (`job`, `watch`, `subagent`, `question`). */
  kind: string;
  /** Short text for the widget and dashboard (`CI`, `answer`). */
  label: string;
  /** Whatever the owner needs to adopt the item again. Persisted as is. */
  data?: Json;
}

/** An open item as the widget and dashboard see it. */
export interface WorkItemView extends WorkItemSpec {
  readonly id: string;
  /** Epoch milliseconds. */
  readonly openedAt: number;
}

/**
 * A handle on one open item. After the item is closed (or its host is gone) every method does
 * nothing, so a producer cannot deliver a second result by mistake.
 */
export interface WorkItem extends WorkItemView {
  /** Deliver a message without closing the item (progress, a question). Wakes the session. */
  notify(message: WorkMessage): void;
  /** Close the item and deliver its result. Wakes the session. */
  complete(message: WorkMessage): void;
  /** Close the item without a message. */
  cancel(): void;
}

export interface WorkHost {
  /** Something this session now waits on. Open work keeps an agent from finishing. */
  open(spec: WorkItemSpec): WorkItem;
  /**
   * Items left open by an earlier process or session instance, for their owner to adopt. Call
   * `adopt` for each persisted item of `owner` that is still open; return `true` to take it
   * over (the handle then works like one from `open`). Call it from `session_start`: items no
   * owner has adopted by the end of startup are closed as lost.
   */
  adopt(owner: string, adopt: (item: WorkItem) => boolean): void;
  /** The session's open items, oldest first. */
  list(): readonly WorkItemView[];
}

/**
 * How a host persists items: append-only records in the session's transcript, as custom entries
 * of type `WORK_ENTRY`. The open items are those opened and not yet closed. One record per
 * state change, so a closed item costs two small entries and nothing is rewritten.
 */
export type WorkRecord =
  | {
      v: 1;
      op: "open";
      id: string;
      owner: string;
      kind: string;
      label: string;
      data?: Json;
      /** Epoch milliseconds. */
      at: number;
    }
  | {
      v: 1;
      op: "close";
      id: string;
      /** `lost`: nobody adopted the item at startup. */
      reason: "completed" | "cancelled" | "lost";
      at: number;
    };
