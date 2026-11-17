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
import type { StateIcon, Tone, WidgetModel } from "#surface";
import {
  ICONS,
  renderWidget,
  sanitizeLine,
  SPINNER,
  stateCounts,
  type Line,
  type Span,
  type WidgetRow,
} from "#ui";

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
  if (!hasClock(agent)) return "--:--";
  const seconds = Math.max(0, Math.floor(((agent.completedAt ?? now) - agent.startedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Whether the agent shows a time at all: not queued, not waiting, and with a start. */
function hasClock(agent: WidgetAgent): boolean {
  return (
    agent.status !== "queued" &&
    !isWaiting(agent) &&
    Number.isFinite(agent.startedAt) &&
    agent.startedAt > 0
  );
}

/** Whether the clock counts up from `startedAt` now, rather than showing a fixed duration. */
function clockRuns(agent: WidgetAgent): boolean {
  return hasClock(agent) && agent.completedAt == null;
}

/**
 * The elapsed clock; while it runs it carries its start, so a surface can keep it running. A
 * running clock is process-bound: once Pi has gone it stops at its text.
 */
function clockSpan(agent: WidgetAgent, now: number): Span {
  return {
    text: elapsedLabel(agent, now),
    tone: "dim",
    ...(clockRuns(agent) ? { since: agent.startedAt, live: true as const } : {}),
  };
}

/** What a running or waiting agent's row reads once its Pi process has gone. */
const STOPPED: Line = [
  { text: ICONS.stopped, tone: "dim", icon: "stopped" },
  { text: " stopped", tone: "dim" },
];

/**
 * Activity for live agents; explicit outcome for agents still in their linger
 * window. Plain text is pre-clipped to `max` cells so the status never takes
 * more than its share of the row; the library styles and aligns it.
 */
function statusLine(agent: WidgetAgent, spinner: string, max: number): Line {
  const fit = (text: string) =>
    Number.isFinite(max) ? truncateToWidth(text, Math.max(1, max), "…") : text;
  // `glyph rest`, clipped as one; the glyph says which state it stands for, so a surface with
  // icons can draw its own. A live glyph shows the running process's state (see pi-surface).
  const status = (
    glyph: string,
    icon: StateIcon,
    rest: string,
    tone: Tone,
    restTone = tone,
    live = false,
  ): Line => {
    const mark = live ? { live: true as const } : {};
    const clipped = fit(`${glyph}${rest}`);
    if (!clipped.startsWith(glyph)) return { text: clipped, tone, icon, ...mark };
    return [
      { text: glyph, tone, icon, ...mark },
      { text: clipped.slice(glyph.length), tone: restTone },
    ];
  };
  if (agent.status === "running") {
    const activity = singleLine(describeActivity(agent.activeTools, agent.responseText));
    return status(spinner, "active", ` ${activity}`, "accent", "muted", true);
  }
  if (isWaiting(agent)) {
    const labels = (agent.waitingOn ?? []).map(singleLine).filter(Boolean).join(", ");
    // No glyph in the terminal; an icon where icons are drawn.
    return [
      { text: "", tone: "muted", icon: "waiting", live: true },
      { text: fit(`waiting: ${labels || "work"}`), tone: "muted" },
    ];
  }
  if (agent.status === "queued") return status(ICONS.queued, "queued", " queued", "dim");
  if (wrappedUpAtTurnLimit(agent))
    return status(ICONS.success, "done", " done (budget warning)", "warning");
  if (agent.status === "completed") return status(ICONS.success, "done", " done", "success");
  if (agent.status === "stopped") return status(ICONS.stopped, "stopped", " stopped", "dim");
  if (agent.status === "error") {
    const error = agent.error ? `: ${singleLine(agent.error)}` : "";
    return status(ICONS.failure, "failed", ` error${error}`, "error");
  }
  return status(ICONS.failure, "stopped", " aborted", "warning");
}

/** One physical row, with optional elapsed time when space permits. `width` may be `Infinity`. */
function agentRow(
  agent: WidgetAgent,
  registry: AgentConfigLookup,
  spinner: string,
  width: number,
  now: number,
): WidgetRow {
  // Decisions use the inset content width, as before the shared renderer.
  const content = Math.max(0, width - 2);
  const active = isActiveStatus(agent.status) || isWaiting(agent);
  const name = singleLine(getDisplayName(agent.type, registry));
  // A running or waiting agent lives in this process: a saved row reads "stopped" (see pi-surface).
  const live = agent.status === "running" || isWaiting(agent);
  const right = content < 12 ? [] : [STOPPED];
  return {
    // The clock leads the row when there is room; the terminal draws it two spaces before the name.
    ...(content >= 40 ? { lead: clockSpan(agent, now) } : {}),
    left: [
      // The name is always bold, as a task's key is; a finished agent's is dim.
      active ? { text: name, bold: true } : { text: name, tone: "dim", bold: true },
      ": ",
      { text: singleLine(agent.description), tone: active ? "muted" : "dim" },
    ],
    // Below 12 columns the task keeps the row; the status is dropped.
    right: content < 12 ? [] : [statusLine(agent, spinner, Math.floor(content * 0.4))],
    group: agent.status === "running" ? "running" : isWaiting(agent) ? "waiting" : "finished",
    ...(live ? { live: { right, group: "stopped" } } : {}),
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

export interface WidgetModelParams {
  agents: readonly WidgetAgent[];
  registry: AgentConfigLookup;
  shouldShowFinished: (agentId: string, status: string) => boolean;
  /** The glyph before a running agent's activity: the terminal's spinner frame. */
  spinner?: string;
  /**
   * The terminal's width. Without it every row keeps its clock and its whole status.
   */
  width?: number;
  now?: number;
}

/**
 * The widget as a JSON model: running > waiting > lingering finished, one row each. A waiting
 * agent stays until its work is done. Queued agents get no rows; they are counted on the title
 * bar. `undefined` while there is nothing to show.
 */
export function subagentWidgetModel(params: WidgetModelParams): WidgetModel | undefined {
  const { agents, registry, shouldShowFinished } = params;
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
  // Waiting agents still hold open work, so they count as active; queued ones have not started.
  const counts = stateCounts({ active: running.length + waiting.length, pending: queuedCount });
  if (ordered.length === 0 && queuedCount === 0) return undefined;

  const now = params.now ?? Date.now();
  const width = params.width ?? Infinity;
  const spinner = params.spinner ?? ICONS.active;
  const active = running.length + queuedCount + waiting.length > 0;
  return {
    title: { label: "Subagents", icon: ICONS.agents },
    active,
    // Queued agents take no rows; they are the pending count on the title bar.
    meta: counts ? [counts] : [],
    rows: ordered.map((agent) => agentRow(agent, registry, spinner, width, now)),
    // The heading's activity and counts are all running, waiting and queued agents: process-bound.
    ...(active ? { live: { active: false, meta: [] } } : {}),
  };
}

/** Pure widget rendering: the model with the terminal's row budget and spinner frame. */
export function renderWidgetLines(params: {
  agents: readonly WidgetAgent[];
  registry: AgentConfigLookup;
  spinnerFrame: number;
  terminalWidth: number;
  terminalHeight: number;
  theme: Theme;
  shouldShowFinished: (agentId: string, status: string) => boolean;
}): string[] {
  const width = Math.max(0, Math.floor(params.terminalWidth));
  if (width === 0) return [];
  const model = subagentWidgetModel({
    agents: params.agents,
    registry: params.registry,
    shouldShowFinished: params.shouldShowFinished,
    spinner: SPINNER[params.spinnerFrame % SPINNER.length],
    width,
  });
  if (!model) return [];
  return renderWidget(
    {
      ...model,
      maxRows: widgetLineBudget(params.terminalHeight),
      // Collapse to the heading while an inline window (an ask) is open.
      docked: true,
    },
    width,
    params.theme,
  );
}
