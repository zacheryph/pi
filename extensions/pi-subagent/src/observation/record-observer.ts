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
   * Called when visible activity changes: tool start/end, assistant text,
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
 * - `message_update` (nonempty text_delta) → `state.appendResponseText(delta)`, call `onActivityChange`
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
      // Only announce if visible text state actually changes (empty → empty is not a change).
      // This avoids spurious notifications on user/toolResult messages.
      if (!wasEmpty) {
        options?.onActivityChange?.();
      }
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      state.appendResponseText(event.assistantMessageEvent.delta);
      // The widget shows response text, not just a writing flag. Announce each change;
      // bb and the dashboard already coalesce these into bounded 250 ms deliveries.
      if (event.assistantMessageEvent.delta.length > 0) options?.onActivityChange?.();
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
