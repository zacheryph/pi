/**
 * record-observer.ts — Subscribes to session events and accumulates SubagentState stats.
 *
 * Replaces the scattered callback-wrapping logic in SubagentManager's startAgent()
 * and resume() with a single direct subscription. The observer targets the
 * SubagentState value object directly, so it carries no dependency on Subagent;
 * the caller forwards itself to its own lifecycle observer via onCompact.
 */

import type { SubagentState } from "#src/lifecycle/subagent-state";
import type { CompactionInfo, SubscribableSession } from "#src/types";

export interface SubagentObserverOptions {
  onCompact?: (info: CompactionInfo) => void;
  /**
   * Called when visible activity changes: tool start/end, first assistant text in a message,
   * or usage update at message end. Not called on spurious state resets with no visible change.
   */
  onActivityChange?: () => void;
}

/**
 * Subscribe to session events and accumulate stats on the subagent state.
 *
 * Handles:
 * - `tool_execution_start` → `state.addActiveTool(name)`, call `onActivityChange`
 * - `tool_execution_end` → `state.removeActiveTool(name)`, `state.incrementToolUses()`, call `onActivityChange`
 * - `message_start` → `state.resetResponseText()`, call `onActivityChange` only if visible text was nonempty (avoids spurious announcements on user/toolResult)
 * - `message_update` (text_delta) → `state.appendResponseText(delta)`, call `onActivityChange` only on first nonempty text
 * - `message_end` (assistant, with usage) → `state.addUsage(…)`, call `onActivityChange`
 * - `compaction_end` (not aborted) → `state.incrementCompactions()`, call `onCompact`
 *
 * @returns An unsubscribe function.
 */
export function subscribeSubagentObserver(
  session: SubscribableSession,
  state: SubagentState,
  options?: SubagentObserverOptions,
): () => void {
  let hasAnnouncedFirstTextDelta = false;

  return session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      state.addActiveTool(event.toolName);
      options?.onActivityChange?.();
    }

    if (event.type === "tool_execution_end") {
      state.removeActiveTool(event.toolName);
      state.incrementToolUses();
      options?.onActivityChange?.();
    }

    if (event.type === "message_start") {
      const wasEmpty = state.responseText.length === 0;
      state.resetResponseText();
      hasAnnouncedFirstTextDelta = false;
      // Only announce if visible text state actually changes (empty → empty is not a change).
      // This avoids spurious notifications on user/toolResult messages.
      if (!wasEmpty) {
        options?.onActivityChange?.();
      }
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      state.appendResponseText(event.assistantMessageEvent.delta);
      // Announce only on first nonempty text to avoid per-token spam
      if (!hasAnnouncedFirstTextDelta && state.responseText.length > 0) {
        hasAnnouncedFirstTextDelta = true;
        options?.onActivityChange?.();
      }
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = event.message.usage;
      state.addUsage({
        input: u.input,
        output: u.output,
        cacheWrite: u.cacheWrite,
      });
      options?.onActivityChange?.();
    }

    if (event.type === "compaction_end" && !event.aborted && event.result) {
      state.incrementCompactions();
      options?.onCompact?.({
        reason: event.reason,
        tokensBefore: event.result.tokensBefore,
      });
    }
  });
}
