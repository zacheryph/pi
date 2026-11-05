/**
 * display.ts — Pure formatting helpers and display utilities for agent UI.
 *
 * All functions are stateless and dependency-free (no SDK runtime imports, no widget lifecycle).
 * Consumed by the widget, the menu, tool modules, and the notification renderer.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import type { AgentInvocation, SubagentType } from "#src/types";
import { ICONS } from "../../../../packages/pi-ui/src/index.ts";

// ---- Types ----

/** A model as the UI names it. The SDK's `Model` satisfies it structurally. */
export interface ModelIdentity {
  readonly provider: string;
  readonly id: string;
}

export type Theme = {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
};

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** The `provider/id` of the model the agent runs (e.g. "anthropic/claude-haiku-4-5"). */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "inherit context"]). */
  tags?: string[];
  agentId?: string;
  error?: string;
  /** The run's turn budget; absent until its turn loop starts. */
  turnBudget?: TurnBudget;
}

// ---- Constants ----

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Pure formatters ----

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/** Format a turn budget as turns used against the ceiling: "↻5≤30", or "↻5" when unlimited. */
export function formatTurnBudget(budget: TurnBudget): string {
  return budget.maxTurns != null
    ? `${ICONS.turns}${budget.used}≤${budget.maxTurns}`
    : `${ICONS.turns}${budget.used}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** A model as `provider/id`, the syntax the Agent tool's `model` argument accepts. */
export function formatModel(model: ModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

/** A model's `provider/id` label, or undefined while the model is unknown. */
export function modelLabel(model: ModelIdentity | undefined): string | undefined {
  return model ? formatModel(model) : undefined;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

// ---- Display helpers ----

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType, registry: AgentConfigLookup): string {
  const config = registry.resolveAgentConfig(type);
  return config.displayName ?? config.name;
}

/** Tags describing invocation overrides. */
export function buildInvocationTags(invocation: AgentInvocation | undefined): { tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  if (invocation.thinking) tags.push(`thinking: ${invocation.thinking}`);
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground === false) tags.push("foreground");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return { tags };
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(
  activeTools: ReadonlyMap<string, string>,
  responseText?: string,
): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}
