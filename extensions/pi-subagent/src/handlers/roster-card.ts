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

import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
  type AgentMessage,
  contextCard,
  type RestoreEvent,
} from "../../../../packages/pi-session-state/src/index.ts";
import {
  buildRoster,
  formatRosterCard,
  type LiveAgentLike,
  readBranchRecords,
  type RestoreReason,
  type ReachableCheck,
} from "#src/roster";

/** The `customType` the card is appended under. */
export const ROSTER_CARD_TYPE = "subagent:roster";

/** The `details.kind` a `subagent_get` list result carries. */
export const SUBAGENT_LIST_KIND = "list";

const START_REASONS: Record<SessionStartEvent["reason"], RestoreReason> = {
  reload: "reload",
  fork: "fork",
  // A process started on an existing session (`pi -c`) has resumed it too.
  startup: "resume",
  resume: "resume",
  // A new session has no records, so its card is empty anyway.
  new: "resume",
};

function restoreReason(event: RestoreEvent): RestoreReason {
  if (event.type === "session_start") return START_REASONS[event.reason];
  return event.type === "session_tree" ? "/tree" : "compaction";
}

export interface RosterCardOptions {
  getLive: (id: string) => LiveAgentLike | undefined;
  now?: () => number;
  isReachable?: ReachableCheck;
}

/**
 * Register the roster card. A reload, resume, fork, `/tree` or compaction
 * brings it back if the branch already holds agents the model may have lost
 * track of. A branch with none (a fresh session, or `/tree` to before the first
 * spawn) turns it off: an agent spawned after this point has its ID in the
 * conversation already.
 */
export function registerRosterCard(
  pi: Pick<ExtensionAPI, "on">,
  { getLive, now = Date.now, isReachable }: RosterCardOptions,
): void {
  let reason: RestoreReason = "compaction";
  const card = contextCard(pi, {
    type: ROSTER_CARD_TYPE,
    now,
    restore: (ctx, event) => {
      reason = restoreReason(event);
      return (readBranchRecords(ctx)?.length ?? 0) > 0;
    },
    build: (ctx, messages) => {
      const since = card.shownAt();
      if (since !== undefined && listedSince(messages, since)) {
        card.hide();
        return undefined;
      }
      const records = readBranchRecords(ctx);
      return records && formatRosterCard(buildRoster(records, getLive, isReachable), reason);
    },
  });
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
