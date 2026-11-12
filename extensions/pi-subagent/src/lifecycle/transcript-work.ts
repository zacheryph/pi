/**
 * transcript-work.ts - the work an agent's transcript holds open, read and settled with no live
 * session (roadmap step 12).
 *
 * An agent's open items are custom entries in its own transcript (`work:item`, written by its work
 * host). Normally its host reads them when the session is reopened (`SubagentManager.restore`
 * reopens every agent that may hold some). When the transcript cannot be reopened in a session
 * (its directory or agent type is gone, or the session could not be built), nothing can adopt the
 * items, so they are lost, and the agent must still be told: this closes them and writes the same
 * `work:lost` message the host would have, straight into the file with `SessionManager.open`
 * and `appendCustomMessageEntry`. Only for a transcript no live session holds, since two writers
 * would interleave.
 */
import { customData } from "#session-state";
import { debugLog } from "#src/debug";
import { lostMessage, openRecords, WORK_ENTRY, type WorkItemView, type WorkRecord } from "#work";

/** The slice of `SessionManager` this reads and writes through. */
export interface TranscriptStore {
  getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
  appendCustomEntry(customType: string, data?: unknown): string;
  appendCustomMessageEntry(
    customType: string,
    content: string | { type: "text"; text: string }[],
    display: boolean,
    details?: unknown,
  ): string;
}

export interface TranscriptWork {
  /** The items the transcript holds open, oldest first; none when it cannot be read. */
  openItems(path: string): WorkItemView[];
  /**
   * Close the items as lost and write the lost message into the transcript. Returns whether it
   * was written.
   */
  closeLost(path: string, items: readonly WorkItemView[]): boolean;
}

/** Transcript access over `open`, which is `SessionManager.open` in production. */
export function transcriptWork(
  open: (path: string) => TranscriptStore,
  now: () => number = Date.now,
): TranscriptWork {
  const safely = <T>(path: string, action: string, run: (store: TranscriptStore) => T) => {
    try {
      return run(open(path));
    } catch (error) {
      debugLog(`transcript work ${action} ${path}`, error);
      return undefined;
    }
  };
  return {
    openItems: (path) =>
      safely(path, "read", (store) =>
        openRecords(customData(store.getBranch(), WORK_ENTRY)).map((record): WorkItemView => ({
          id: record.id,
          owner: record.owner,
          kind: record.kind,
          label: record.label,
          ...(record.data !== undefined ? { data: record.data } : {}),
          openedAt: record.at,
        })),
      ) ?? [],
    closeLost: (path, items) =>
      safely(path, "close", (store) => {
        if (items.length === 0) return false;
        for (const item of items) {
          const close: WorkRecord = {
            v: 1,
            op: "close",
            id: item.id,
            reason: "lost",
            at: now(),
          };
          store.appendCustomEntry(WORK_ENTRY, close);
        }
        const message = lostMessage(items);
        store.appendCustomMessageEntry(message.customType, message.content, true, message.details);
        return true;
      }) ?? false,
  };
}
