/**
 * roster-card.ts — Restores the branch's agents to the model's context.
 *
 * After a compaction, reload, resume or `/tree`, the model keeps only the agent
 * IDs its summary or branch happens to mention. Until it lists them itself, each
 * request ends with a card naming every agent this session started on the
 * branch: built from the branch's records plus live state, appended as a
 * `custom` message with `display: false`, and never written to the transcript
 * or shown in the TUI.
 *
 * The card stops once a successful `subagent_get` list result arrives after the
 * event that brought it back, the same idea as pi-todo's checkpoint rule: the
 * model has then seen the roster in its own context.
 */

import type { ContextEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
  buildRoster,
  formatRosterCard,
  type LiveAgentLike,
  readBranchRecords,
  type RestoreReason,
  type ReachableCheck,
} from "#src/roster";

type AgentMessage = ContextEvent["messages"][number];

/** The `customType` the card is appended under. */
export const ROSTER_CARD_TYPE = "subagent:roster";

/** The `details.kind` a `subagent_get` list result carries. */
export const SUBAGENT_LIST_KIND = "list";

/** Why Pi started or replaced the session. */
type SessionStartReason = SessionStartEvent["reason"];

const START_REASONS: Record<SessionStartReason, RestoreReason> = {
  reload: "reload",
  fork: "fork",
  // A process started on an existing session (`pi -c`) has resumed it too.
  startup: "resume",
  resume: "resume",
  // A new session has no records, so its card is empty anyway.
  new: "resume",
};

/** The message slice the card reads and writes. */
interface ContextMessages {
  readonly messages: readonly AgentMessage[];
}

export class RosterCard {
  /** When the card was last brought back; undefined while it is off. */
  private since: number | undefined;
  private reason: RestoreReason = "compaction";

  constructor(
    private readonly getLive: (id: string) => LiveAgentLike | undefined,
    private readonly now: () => number = Date.now,
    private readonly isReachable?: ReachableCheck,
  ) {}

  /** The session started: a reload, resume or fork may have lost the roster. */
  handleSessionStart(event: { reason: SessionStartReason }, ctx: unknown): void {
    this.restore(START_REASONS[event.reason], ctx);
  }

  /** `/tree` moved to another branch, with its own agents. */
  handleSessionTree(ctx: unknown): void {
    this.restore("/tree", ctx);
  }

  /** The conversation was summarized; the summary may drop agent IDs. */
  handleSessionCompact(ctx: unknown): void {
    this.restore("compaction", ctx);
  }

  handleSessionShutdown(): void {
    this.since = undefined;
  }

  /**
   * Bring the card back if the branch already holds agents the model may have
   * lost track of. A branch with none (a fresh session, or `/tree` to before
   * the first spawn) turns it off: an agent spawned after this point has its
   * ID in the conversation already.
   */
  private restore(reason: RestoreReason, ctx: unknown): void {
    const hasAgents = (readBranchRecords(ctx)?.length ?? 0) > 0;
    this.since = hasAgents ? this.now() : undefined;
    this.reason = reason;
  }

  /**
   * Strip any earlier card, then append the current one while it is due.
   * Returns undefined when the messages need no change.
   */
  handleContext(event: ContextMessages, ctx: unknown): { messages: AgentMessage[] } | undefined {
    const messages = event.messages.filter(
      (message) => !(message.role === "custom" && message.customType === ROSTER_CARD_TYPE),
    );
    const unchanged = () => (messages.length === event.messages.length ? undefined : { messages });
    if (this.since === undefined) return unchanged();
    if (listedSince(messages, this.since)) {
      this.since = undefined;
      return unchanged();
    }
    const records = readBranchRecords(ctx);
    const card =
      records &&
      formatRosterCard(buildRoster(records, this.getLive, this.isReachable), this.reason);
    if (!card) return unchanged();
    return {
      messages: [
        ...messages,
        {
          role: "custom",
          customType: ROSTER_CARD_TYPE,
          content: card,
          display: false,
          timestamp: this.now(),
        },
      ],
    };
  }
}

/** Whether a successful `subagent_get` list result arrived at or after `since`. */
function listedSince(messages: readonly AgentMessage[], since: number): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === "subagent_get" &&
      !message.isError &&
      message.timestamp >= since &&
      (message.details as { kind?: unknown } | undefined)?.kind === SUBAGENT_LIST_KIND,
  );
}
