/**
 * roster-card.ts — Restores the branch's agents to the model's context after a
 * compaction.
 *
 * The model saw every agent's ID in the `subagent_start` result and completion
 * message that named it. A compaction summarizes those away, keeping only the
 * IDs its summary happens to mention, so a card naming every agent this session
 * started on the branch is written into the transcript once after it: a
 * `custom` message with `display: false`, hidden in the TUI but sent to the
 * model like any other message. A resume, reload, fork or `/tree` keeps the
 * results in context and writes nothing (see `restoreCard`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { restoreCard } from "#session-state";
import {
  buildRoster,
  formatRosterCard,
  type LiveAgentLike,
  readBranchRecords,
  type ReachableCheck,
} from "#src/roster";

/** The `customType` the card is written under. */
export const ROSTER_CARD_TYPE = "subagent:roster";

export interface RosterCardOptions {
  getLive: (id: string) => LiveAgentLike | undefined;
  isReachable?: ReachableCheck;
}

/**
 * Register the roster card: after a compaction on a branch that started agents,
 * one card built from the branch's records and live state.
 */
export function registerRosterCard(
  pi: Pick<ExtensionAPI, "on" | "sendMessage">,
  { getLive, isReachable }: RosterCardOptions,
): void {
  restoreCard(pi, {
    type: ROSTER_CARD_TYPE,
    build: (ctx) => {
      const records = readBranchRecords(ctx);
      return records && formatRosterCard(buildRoster(records, getLive, isReachable));
    },
  });
}
