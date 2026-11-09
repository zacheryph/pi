/**
 * subagent-work.ts - pi-subagent as a work producer for the session that spawned an agent.
 *
 * A run is something the spawner waits on, so it is an item in the spawner's work host
 * (packages/pi-work, `work:v1`). The host writes the messages into the transcript and wakes the
 * session; this file never sends one:
 *
 *  - a run is asked for (spawn, or new input to an idle agent): open an item;
 *  - the run ends with an outcome: complete the item with the completion message, which carries
 *    the same text and details the completion nudge always did;
 *  - the run ends because it was stopped: deliver the same message, then cancel the item (a
 *    stopped run is cancelled work, not finished work);
 *  - the child sends a mid-run update: `notify`, leaving the item open.
 *
 * Nothing here queues. Holding a message while the parent runs and answering it in the same run
 * is the host's job.
 *
 * A session that shuts down leaves its items open on purpose: `dispose` makes this object inert
 * without closing them, so the next start of the spawning session finds them open and reports
 * them lost (roadmap step 12 will adopt them instead).
 */
import { debugLog } from "#src/debug";
import { completionMessage, updateMessage } from "#src/observation/notification";
import type { Subagent } from "#src/types";
import type { Json, WorkHost, WorkItem } from "../../../../packages/pi-work/src/index.ts";

/** The `owner` of every item this extension opens. */
export const WORK_OWNER = "pi-subagent";

/** The `kind` of those items. */
export const WORK_KIND = "subagent";

/** What an item records about the agent, persisted with it. */
export interface SubagentItemData {
  agentId: string;
  type: string;
  description: string;
  toolCallId?: string;
}

/** Longest description spelled in an item's label, so the agent id and type after it survive. */
const LABEL_DESCRIPTION = 80;

/**
 * The label names the agent the way a person would find it again: the generic `work:lost` message
 * prints only `kind "label" (owner, item id)`.
 */
export function itemLabel(record: Pick<Subagent, "id" | "type" | "description">): string {
  const flat = record.description.replace(/\s+/g, " ").trim();
  const description =
    flat.length > LABEL_DESCRIPTION ? `${flat.slice(0, LABEL_DESCRIPTION - 1)}…` : flat;
  return `${description} (${record.type} agent ${record.id})`;
}

/** What the lifecycle observer tells the work producer. */
export interface AgentWork {
  /** A run was asked for. Opens the agent's item unless an earlier request already holds one. */
  runRequested(record: Subagent): void;
  /** The run ended, with whatever outcome the record now holds. */
  runEnded(record: Subagent): void;
  /** A running child sent its parent a message. */
  update(record: Subagent, message: string): void;
  /** The session is going away: forget the items without closing them. */
  dispose(): void;
}

export class SubagentWork implements AgentWork {
  /** The open item of each agent that has a run requested or running. */
  private readonly items = new Map<string, WorkItem>();
  /** Agents with a run requested and not yet ended, whether or not an item could be opened. */
  private readonly requested = new Set<string>();
  private disposed = false;

  /** `host` is read per call: it is the live host of the session that spawned, and changes on reload. */
  constructor(private readonly host: () => WorkHost | undefined) {}

  runRequested(record: Subagent): void {
    if (this.disposed || this.items.has(record.id)) return;
    this.requested.add(record.id);
    this.open(record);
  }

  runEnded(record: Subagent): void {
    if (this.disposed) return;
    // No item for a requested run only when the host was unreachable at the request: open one
    // now so the outcome still arrives, as a completion message always has. A run that was
    // never requested, or already ended, delivers nothing.
    if (!this.items.has(record.id) && !this.requested.has(record.id)) return;
    const item = this.items.get(record.id) ?? this.open(record);
    this.requested.delete(record.id);
    this.items.delete(record.id);
    if (!item) return;
    const message = completionMessage(record);
    if (record.displayStatus === "stopped") {
      item.notify(message);
      item.cancel();
    } else {
      item.complete(message);
    }
  }

  update(record: Subagent, message: string): void {
    // A run that ended has an outcome, and its completion message renders what the run still
    // owes, so an update is announced only while the child can still act on the reply.
    if (this.disposed || !record.isActive()) return;
    const item = this.items.get(record.id);
    if (!item) return;
    // This channel is delivering the message, so the completion message does not repeat it.
    record.markUpdateAnnounced(message);
    item.notify(updateMessage(record, message));
  }

  dispose(): void {
    this.disposed = true;
    this.items.clear();
    this.requested.clear();
  }

  private open(record: Subagent): WorkItem | undefined {
    const host = this.host();
    if (!host) {
      debugLog("subagent work item", new Error("the session has no work host"));
      return undefined;
    }
    const data: SubagentItemData = {
      agentId: record.id,
      type: record.type,
      description: record.description,
      ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
    };
    try {
      const item = host.open({
        owner: WORK_OWNER,
        kind: WORK_KIND,
        label: itemLabel(record),
        data: data as unknown as Json,
      });
      this.items.set(record.id, item);
      return item;
    } catch (err) {
      debugLog("subagent work item", err);
      return undefined;
    }
  }
}
