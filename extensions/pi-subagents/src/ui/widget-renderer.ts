/**
 * Pure rendering for the compact subagent widget: a static header rule and one
 * row per agent. Pi owns the Working border, editor, and footer below it.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { isActiveStatus, type SubagentStatus } from "#src/lifecycle/subagent-state";
import { type TurnBudget, wrappedUpAtTurnLimit } from "#src/lifecycle/turn-limits";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import type { SubagentType } from "#src/types";
import {
	describeActivity,
	getDisplayName,
	getPromptModeLabel,
	type ModelIdentity,
	type Theme,
} from "#src/ui/display";
import { GLYPHS, SPINNER } from "#src/ui/glyphs";

/** Minimal agent snapshot for rendering — no class methods or mutation surface. */
export interface WidgetAgent {
	readonly id: string;
	readonly type: SubagentType;
	readonly status: SubagentStatus;
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
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Queued agents have not started; finished durations stay fixed while lingering. */
function elapsedLabel(agent: WidgetAgent, now: number): string {
	if (agent.status === "queued" || !Number.isFinite(agent.startedAt) || agent.startedAt <= 0) return "--:--";
	const seconds = Math.max(0, Math.floor(((agent.completedAt ?? now) - agent.startedAt) / 1000));
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Activity for live agents; explicit outcome for agents still in their linger window. */
function renderStatus(agent: WidgetAgent, spinnerFrame: number, theme: Theme): string {
	if (agent.status === "running") {
		const spinner = SPINNER[spinnerFrame % SPINNER.length];
		const activity = singleLine(describeActivity(agent.activeTools, agent.responseText));
		return `${theme.fg("accent", spinner)} ${theme.fg("muted", activity)}`;
	}
	if (agent.status === "queued") return theme.fg("dim", `${GLYPHS.queued} queued`);
	if (wrappedUpAtTurnLimit(agent)) return theme.fg("warning", `${GLYPHS.success} done (budget warning)`);
	if (agent.status === "completed") return theme.fg("success", `${GLYPHS.success} done`);
	if (agent.status === "stopped") return theme.fg("dim", `${GLYPHS.stopped} stopped`);
	if (agent.status === "error") {
		const error = agent.error ? `: ${singleLine(agent.error)}` : "";
		return theme.fg("error", `${GLYPHS.failure} error${error}`);
	}
	return theme.fg("warning", `${GLYPHS.failure} aborted`);
}

/**
 * Align status to the right, truncating it before it consumes the task column.
 * Width is measured in terminal cells, including ANSI and wide Unicode labels.
 */
function alignColumns(left: string, right: string, width: number): string {
	if (width < 12) return truncateToWidth(left, width, "…");
	const status = truncateToWidth(right, Math.floor(width * 0.4), "…");
	const task = truncateToWidth(left, Math.max(0, width - visibleWidth(status) - 2), "…");
	const gap = Math.max(0, width - visibleWidth(task) - visibleWidth(status));
	return task + " ".repeat(gap) + status;
}

/** One physical row, with optional elapsed time and prompt-mode tag when space permits. */
function renderAgentRow(
	agent: WidgetAgent,
	registry: AgentConfigLookup,
	spinnerFrame: number,
	theme: Theme,
	width: number,
	now: number,
): string {
	const active = isActiveStatus(agent.status);
	const name = singleLine(getDisplayName(agent.type, registry));
	const mode = width >= 60 ? getPromptModeLabel(agent.type, registry) : undefined;
	const tag = mode ? theme.fg("dim", ` (${singleLine(mode)})`) : "";
	const elapsed = width >= 40 ? `${theme.fg("dim", elapsedLabel(agent, now))}  ` : "";
	const identity = active ? theme.bold(name) : theme.fg("dim", name);
	const description = theme.fg(active ? "muted" : "dim", singleLine(agent.description));
	const left = `${elapsed}${identity}${tag}: ${description}`;
	return alignColumns(left, renderStatus(agent, spinnerFrame, theme), width);
}

/** Header icon stays static, even while individual agent status spinners animate. */
function renderHeading(width: number, hasActive: boolean, theme: Theme): string {
	const label = theme.fg(hasActive ? "accent" : "dim", `${GLYPHS.agentsActive} Subagents`);
	const prefix = `${theme.fg("border", "──")} ${label} `;
	const rule = theme.fg("border", "─".repeat(Math.max(0, width - visibleWidth(prefix))));
	return truncateToWidth(prefix + rule, width, "…");
}

// Keep the viewport guard: Pi's regular renderer full-clears scrollback when the
// first changed widget row sits above the viewport. Reserve editor/footer space.
const MAX_WIDGET_LINES = 12;
const MIN_WIDGET_LINES = 3;
const DOCK_LINES_BELOW_WIDGET = 6;

export function widgetLineBudget(terminalRows: number): number {
	return Math.max(MIN_WIDGET_LINES, Math.min(MAX_WIDGET_LINES, terminalRows - DOCK_LINES_BELOW_WIDGET));
}

/** Pure widget rendering. Running > queued > lingering finished, all one row each. */
export function renderWidgetLines(params: {
	agents: readonly WidgetAgent[];
	registry: AgentConfigLookup;
	spinnerFrame: number;
	terminalWidth: number;
	terminalHeight: number;
	theme: Theme;
	shouldShowFinished: (agentId: string, status: string) => boolean;
}): string[] {
	const { agents, registry, spinnerFrame, terminalWidth, terminalHeight, theme, shouldShowFinished } = params;
	const width = Math.max(0, Math.floor(terminalWidth));
	if (width === 0) return [];

	const running = agents.filter(agent => agent.status === "running");
	const queued = agents.filter(agent => agent.status === "queued");
	const finished = agents.filter(agent => !isActiveStatus(agent.status)
		&& agent.completedAt != null && shouldShowFinished(agent.id, agent.status));
	const ordered = [...running, ...queued, ...finished];
	if (ordered.length === 0) return [];

	const lines = [renderHeading(width, running.length + queued.length > 0, theme)];
	const bodyBudget = widgetLineBudget(terminalHeight) - 1;
	const overflow = ordered.length > bodyBudget;
	const shown = ordered.slice(0, overflow ? bodyBudget - 1 : bodyBudget);
	const now = Date.now();
	for (const agent of shown) {
		lines.push(renderAgentRow(agent, registry, spinnerFrame, theme, width, now));
	}

	if (overflow) {
		const hidden = ordered.slice(shown.length);
		const counts = [
			["running", hidden.filter(agent => agent.status === "running").length],
			["queued", hidden.filter(agent => agent.status === "queued").length],
			["finished", hidden.filter(agent => !isActiveStatus(agent.status)).length],
		] as const;
		const summary = counts.filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`).join(", ");
		lines.push(truncateToWidth(theme.fg("dim", `+${hidden.length} more (${summary})`), width, "…"));
	}
	return lines;
}
