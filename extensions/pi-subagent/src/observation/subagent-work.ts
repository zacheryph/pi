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
 *  - the child sends a mid-run update: `notify`, leaving the item open;
 *  - the child asks a question (pi-ask): `notify` with the question, once, leaving the item open.
 *    The child waits on a question item in its own host, so the run ends, the child is idle and
 *    waiting, and this item stays open: the child is not done. The parent's `subagent_send` is
 *    the answer.
 *
 * Nothing here queues. Holding a message while the parent runs and answering it in the same run
 * is the host's job.
 *
 * A session that shuts down leaves its items open on purpose: `dispose` makes this object inert
 * without closing them. The next start of the spawning session (a reload or a restart) finds them
 * open and adopts them (roadmap step 12): `adopt` takes the items of the agents it is about to
 * restore, and once the restore knows which of them are still waiting, `settle` cancels the items
 * of the others (the one report to the parent covers them) and opens an item for a waiting agent
 * that had none. An item of an agent that is not restored (it was done, or its record is gone) is
 * not adopted, and the host closes it as lost with its own message.
 */
import { debugLog } from "#src/debug";
import { completionMessage, questionMessage, updateMessage } from "#src/observation/notification";
import type { Subagent } from "#src/types";
import type { Json, WorkHost, WorkItem } from "#work";

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

/** What a restore found out about one agent, as far as its spawner's item is concerned. */
export interface RestoredWork {
  id: string;
  type: string;
  description: string;
  /** The agent holds open work, or owes the answer to a message: its run is still to be reported. */
  continuing: boolean;
}

/** What the lifecycle observer tells the work producer. */
export interface AgentWork {
  /** A run was asked for. Opens the agent's item unless an earlier request already holds one. */
  runRequested(record: Subagent): void;
  /** The run ended, with whatever outcome the record now holds. */
  runEnded(record: Subagent): void;
  /** A running child sent its parent a message. */
  update(record: Subagent, message: string): void;
  /** A child asked its parent a question. */
  question(record: Subagent, question: string): void;
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

  question(record: Subagent, question: string): void {
    if (this.disposed) return;
    // The child waits on its question item, so the parent must hear it: with no item for the run
    // (the host was unreachable when it was requested, or was replaced since), open one now, as
    // `runEnded` does. It then carries the completion when the agent is done.
    const item = this.items.get(record.id) ?? this.open(record);
    if (!item) return; // no host at all: `open` has logged it
    item.notify(questionMessage(record, question));
  }

  dispose(): void {
    this.disposed = true;
    this.items.clear();
    this.requested.clear();
  }

  /**
   * The start of the spawning session: take over the open items that the agents in `agentIds`
   * left in its host. Called before the agents are restored, so a run the restore asks for finds
   * its item instead of opening a second one. Every item of those agents is taken: the restore
   * then keeps the ones of agents that go on (`settle`) and cancels the rest.
   */
  adopt(agentIds: ReadonlySet<string>): void {
    const host = this.host();
    if (!host || this.disposed) return;
    host.adopt(WORK_OWNER, (item) => {
      const agentId = (item.data as Partial<SubagentItemData> | undefined)?.agentId;
      if (typeof agentId !== "string" || !agentIds.has(agentId)) return false;
      if (this.items.has(agentId)) {
        // One item per agent at a time: an extra one is the leftover of an earlier instance.
        item.cancel();
        return true;
      }
      this.items.set(agentId, item);
      this.requested.add(agentId);
      return true;
    });
  }

  /**
   * The restore of this agent is over. An agent that goes on keeps its adopted item, which its
   * completion will close, or gets one if the host held none (its earlier one was lost). One
   * that does not (done, interrupted, lost everything) has its item cancelled without a message:
   * the single report to the parent tells it what happened, and a completion message for a run
   * that was cut short would be a second one.
   */
  settle(agent: RestoredWork): void {
    if (this.disposed) return;
    if (agent.continuing) {
      if (!this.items.has(agent.id)) {
        this.requested.add(agent.id);
        this.open(agent);
      }
      return;
    }
    const item = this.items.get(agent.id);
    this.items.delete(agent.id);
    this.requested.delete(agent.id);
    item?.cancel();
  }

  private open(
    record: Pick<Subagent, "id" | "type" | "description"> & { toolCallId?: string },
  ): WorkItem | undefined {
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
