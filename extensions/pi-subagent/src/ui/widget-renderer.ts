/**
 * Pure rendering for the compact subagent widget: a static header rule and one
 * row per agent. Pi owns the Working border, editor, and footer below it.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { type DisplayStatus, isActiveStatus } from "#src/lifecycle/subagent-state";
import { type TurnBudget, wrappedUpAtTurnLimit } from "#src/lifecycle/turn-limits";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import type { SubagentType } from "#src/types";
import { describeActivity, getDisplayName, type ModelIdentity, type Theme } from "#src/ui/display";
import {
  ICONS,
  renderWidget,
  sanitizeLine,
  SPINNER,
  type Line,
  type Span,
  type WidgetRow,
} from "../../../../packages/pi-ui/src/index.ts";

/** Minimal agent snapshot for rendering — no class methods or mutation surface. */
export interface WidgetAgent {
  readonly id: string;
  readonly type: SubagentType;
  readonly status: DisplayStatus;
  /**
   * What an idle agent waits on (the labels of its open work). A non-empty list makes the agent
   * waiting rather than done, whatever `status` says about its last run.
   */
  readonly waitingOn?: readonly string[];
  readonly description: string;
  readonly toolUses: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly lifetimeUsage?: Readonly<LifetimeUsage>;
  readonly compactionCount: number;
  readonly turnBudget?: TurnBudget;
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
  readonly contextPercent: number | null;
  readonly model?: ModelIdentity;
}

/** User/model-provided labels must never add rows or terminal control codes. */
function singleLine(text: string): string {
  return sanitizeLine(text).replace(/\s+/g, " ").trim();
}

/**
 * Whether the agent is waiting: idle (no run queued or running) on open work. Derived, never
 * stored: the same agent is done once its work is.
 */
export function isWaiting(agent: Pick<WidgetAgent, "status" | "waitingOn">): boolean {
  return agent.status !== "running" && agent.status !== "queued" && !!agent.waitingOn?.length;
}

/**
 * Queued and waiting agents are not running, and no timer advances them, so they show no clock;
 * finished durations stay fixed while lingering.
 */
function elapsedLabel(agent: WidgetAgent, now: number): string {
  if (
    agent.status === "queued" ||
    isWaiting(agent) ||
    !Number.isFinite(agent.startedAt) ||
    agent.startedAt <= 0
  )
    return "--:--";
  const seconds = Math.max(0, Math.floor(((agent.completedAt ?? now) - agent.startedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Activity for live agents; explicit outcome for agents still in their linger
 * window. Plain text is pre-clipped to `max` cells so the status never takes
 * more than its share of the row; the library styles and aligns it.
 */
function statusLine(agent: WidgetAgent, spinnerFrame: number, max: number): Line {
  const fit = (text: string) => truncateToWidth(text, Math.max(1, max), "…");
  if (agent.status === "running") {
    const spinner = SPINNER[spinnerFrame % SPINNER.length];
    const activity = singleLine(describeActivity(agent.activeTools, agent.responseText));
    const clipped = fit(`${spinner} ${activity}`);
    return [
      { text: spinner, tone: "accent" },
      { text: clipped.slice(spinner.length), tone: "muted" },
    ];
  }
  if (isWaiting(agent)) {
    const labels = (agent.waitingOn ?? []).map(singleLine).filter(Boolean).join(", ");
    return { text: fit(`waiting: ${labels || "work"}`), tone: "muted" };
  }
  if (agent.status === "queued") return { text: fit(`${ICONS.queued} queued`), tone: "dim" };
  if (wrappedUpAtTurnLimit(agent))
    return { text: fit(`${ICONS.success} done (budget warning)`), tone: "warning" };
  if (agent.status === "completed") return { text: fit(`${ICONS.success} done`), tone: "success" };
  if (agent.status === "stopped") return { text: fit(`${ICONS.stopped} stopped`), tone: "dim" };
  if (agent.status === "error") {
    const error = agent.error ? `: ${singleLine(agent.error)}` : "";
    return { text: fit(`${ICONS.failure} error${error}`), tone: "error" };
  }
  return { text: fit(`${ICONS.failure} aborted`), tone: "warning" };
}

/** One physical row, with optional elapsed time when space permits. */
function agentRow(
  agent: WidgetAgent,
  registry: AgentConfigLookup,
  spinnerFrame: number,
  width: number,
  now: number,
): WidgetRow {
  // Decisions use the inset content width, as before the shared renderer.
  const content = Math.max(0, width - 2);
  const active = isActiveStatus(agent.status) || isWaiting(agent);
  const name = singleLine(getDisplayName(agent.type, registry));
  const left: Span[] = [];
  if (content >= 40) left.push({ text: elapsedLabel(agent, now), tone: "dim" }, "  ");
  left.push(active ? { text: name, bold: true } : { text: name, tone: "dim" });
  left.push(": ", { text: singleLine(agent.description), tone: active ? "muted" : "dim" });
  return {
    left,
    // Below 12 columns the task keeps the row; the status is dropped.
    right: content < 12 ? [] : [statusLine(agent, spinnerFrame, Math.floor(content * 0.4))],
    group: agent.status === "running" ? "running" : isWaiting(agent) ? "waiting" : "finished",
  };
}

// Keep the viewport guard: Pi's regular renderer full-clears scrollback when the
// first changed widget row sits above the viewport. Reserve editor/footer space.
const MAX_WIDGET_LINES = 12;
const MIN_WIDGET_LINES = 3;
const DOCK_LINES_BELOW_WIDGET = 6;

export function widgetLineBudget(terminalRows: number): number {
  return Math.max(
    MIN_WIDGET_LINES,
    Math.min(MAX_WIDGET_LINES, terminalRows - DOCK_LINES_BELOW_WIDGET),
  );
}

/**
 * Pure widget rendering. Running > waiting > lingering finished, one row each. A waiting agent
 * stays until its work is done. Queued agents get no rows; they are counted on the title bar.
 */
export function renderWidgetLines(params: {
  agents: readonly WidgetAgent[];
  registry: AgentConfigLookup;
  spinnerFrame: number;
  terminalWidth: number;
  terminalHeight: number;
  theme: Theme;
  shouldShowFinished: (agentId: string, status: string) => boolean;
}): string[] {
  const {
    agents,
    registry,
    spinnerFrame,
    terminalWidth,
    terminalHeight,
    theme,
    shouldShowFinished,
  } = params;
  const width = Math.max(0, Math.floor(terminalWidth));
  if (width === 0) return [];

  const running = agents.filter((agent) => agent.status === "running");
  const waiting = agents.filter(isWaiting);
  const queuedCount = agents.filter((agent) => agent.status === "queued").length;
  const finished = agents.filter(
    (agent) =>
      !isActiveStatus(agent.status) &&
      !isWaiting(agent) &&
      agent.completedAt != null &&
      shouldShowFinished(agent.id, agent.status),
  );
  const ordered = [...running, ...waiting, ...finished];
  if (ordered.length === 0 && queuedCount === 0) return [];

  const now = Date.now();
  return renderWidget(
    {
      title: { label: "Subagents", icon: ICONS.agents },
      active: running.length + queuedCount + waiting.length > 0,
      // Queued agents take no rows; their count rides the title bar.
      meta: queuedCount > 0 ? [{ text: `${queuedCount} queued`, tone: "dim" }] : [],
      rows: ordered.map((agent) => agentRow(agent, registry, spinnerFrame, width, now)),
      maxRows: widgetLineBudget(terminalHeight),
      // Collapse to the heading while an inline window (an ask) is open.
      docked: true,
    },
    width,
    theme,
  );
}
