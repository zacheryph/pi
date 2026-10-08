import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { Theme } from "#src/ui/display";
import { renderWidgetLines, type WidgetAgent, widgetLineBudget } from "#src/ui/widget-renderer";

const registry = new AgentTypeRegistry(() => new Map());
const theme: Theme = { fg: (_color, text) => text, bold: text => text };
const NOW = 100_000;

function makeAgent(overrides: Partial<WidgetAgent> = {}): WidgetAgent {
	return {
		id: "agent-1",
		type: "general-purpose",
		status: "running",
		description: "test task",
		toolUses: 5,
		startedAt: NOW - 83_000,
		compactionCount: 0,
		turnBudget: { maxTurns: 10, used: 3, phase: "within" },
		activeTools: new Map(),
		responseText: "",
		contextPercent: null,
		...overrides,
	};
}

type RenderParams = Parameters<typeof renderWidgetLines>[0];
function render(overrides: Partial<RenderParams> = {}): string[] {
	return renderWidgetLines({
		agents: [makeAgent()],
		registry,
		spinnerFrame: 0,
		terminalWidth: 80,
		terminalHeight: 40,
		theme,
		shouldShowFinished: () => true,
		...overrides,
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("compact widget heading and rows", () => {
	it("renders a top rule and exactly one row per agent, without a box or bottom rule", () => {
		const lines = render({ agents: [makeAgent(), makeAgent({ id: "second", type: "Explore" })] });
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe(`── ● Subagents ${"─".repeat(65)}`);
		expect(lines[1]).toContain("01:23  Agent (twin): test task");
		expect(lines[2]).toContain("Explore: test task");
		expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│├└⎿]/);
	});

	it("keeps the header icon static while agent status spinners advance", () => {
		const first = render({ spinnerFrame: 0 });
		const next = render({ spinnerFrame: 1 });
		expect(first[0]).toBe(next[0]);
		expect(first[1]).toContain("⠋ thinking…");
		expect(next[1]).toContain("⠙ thinking…");
	});

	it("right-aligns status without wrapping", () => {
		const row = render()[1];
		expect(row).toHaveLength(80);
		expect(row).toMatch(/test task\s{2,}⠋ thinking…$/);
	});

	it("shows active tools, or streamed response text when no tools run", () => {
		expect(render({ agents: [makeAgent({ activeTools: new Map([["r", "read"]]) })] })[1]).toContain("reading…");
		expect(render({ agents: [makeAgent({ responseText: "Found auth middleware" })] })[1]).toContain("Found auth middleware");
	});

	it("omits model, turns, tool counts, tokens and context stats", () => {
		const text = render({ agents: [makeAgent({
			model: { provider: "anthropic", id: "claude-sonnet-5" },
			lifetimeUsage: { input: 5000, output: 2000, cacheWrite: 1000 },
			contextPercent: 45,
			compactionCount: 2,
		})] }).join("\n");
		for (const value of ["anthropic", "sonnet", "↻", "tool uses", "token", "45%", "⇊"]) {
			expect(text).not.toContain(value);
		}
	});

	it("renders queued agents individually with static labels and no running clock", () => {
		const agents = [
			makeAgent({ id: "q1", status: "queued", description: "first queued task" }),
			makeAgent({ id: "q2", status: "queued", description: "second queued task" }),
		];
		const first = render({ agents });
		expect(first).toHaveLength(3);
		expect(first[1]).toContain("--:--  Agent (twin): first queued task");
		expect(first[2]).toContain("second queued task");
		expect(first.slice(1).every(line => line.endsWith("◦ queued"))).toBe(true);
		vi.advanceTimersByTime(60_000);
		expect(render({ agents })).toEqual(first);
	});

	it("orders running, queued, and then lingering finished agents", () => {
		const lines = render({ agents: [
			makeAgent({ id: "f", status: "completed", completedAt: NOW, description: "finished task" }),
			makeAgent({ id: "q", status: "queued", description: "queued task" }),
			makeAgent({ id: "r", description: "running task" }),
		] });
		expect(lines[1]).toContain("running task");
		expect(lines[2]).toContain("queued task");
		expect(lines[3]).toContain("finished task");
	});

	it("advances elapsed time for running agents, clamping future start times", () => {
		vi.advanceTimersByTime(1000);
		expect(render()[1]).toContain("01:24");
		expect(render({ agents: [makeAgent({ startedAt: NOW + 10_000 })] })[1]).toContain("00:00");
	});

	it("handles elapsed times beyond an hour", () => {
		vi.setSystemTime(4_000_000);
		expect(render({ agents: [makeAgent({ startedAt: 1000 })] })[1]).toContain("66:39");
	});
});

describe("finished outcomes and linger filtering", () => {
	it.each([
		["completed", "✓ done"],
		["stopped", "■ stopped"],
		["aborted", "✗ aborted"],
		["error", "✗ error"],
	] as const)("shows %s outcome", (status, label) => {
		const row = render({ agents: [makeAgent({ status, completedAt: NOW })] })[1];
		expect(row.endsWith(label)).toBe(true);
	});

	it("preserves budget-warning outcome", () => {
		const row = render({ agents: [makeAgent({
			status: "completed", completedAt: NOW,
			turnBudget: { maxTurns: 10, used: 9, phase: "warned" },
		})] })[1];
		expect(row).toContain("✓ done (budget warning)");
	});

	it("shows error details when space allows", () => {
		expect(render({ agents: [makeAgent({ status: "error", completedAt: NOW, error: "request failed" })] })[1])
			.toContain("✗ error: request failed");
	});

	it("freezes elapsed duration for lingering finished agents", () => {
		const agents = [makeAgent({ status: "completed", completedAt: NOW - 30_000 })];
		const first = render({ agents });
		expect(first[1]).toContain("00:53");
		vi.advanceTimersByTime(60_000);
		expect(render({ agents })).toEqual(first);
	});

	it("keeps static icon and dims the heading when only finished agents remain", () => {
		const colors: string[] = [];
		const recordingTheme = { ...theme, fg: (color: string, text: string) => { colors.push(`${color}:${text}`); return text; } };
		render({ agents: [makeAgent({ status: "completed", completedAt: NOW })], theme: recordingTheme });
		expect(colors).toContain("dim:● Subagents");
	});

	it("filters expired finished agents and agents without a completion timestamp", () => {
		const agents = [
			makeAgent({ id: "keep", status: "completed", completedAt: NOW, description: "keep this" }),
			makeAgent({ id: "hide", status: "error", completedAt: NOW, description: "hide this" }),
			makeAgent({ id: "unfinished", status: "error", description: "no timestamp" }),
		];
		const lines = render({ agents, shouldShowFinished: id => id === "keep" });
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("keep this");
		expect(lines.join("\n")).not.toContain("hide this");
		expect(render({ agents, shouldShowFinished: () => false })).toEqual([]);
	});

	it("returns no heading for an empty agent list", () => {
		expect(render({ agents: [] })).toEqual([]);
	});
});

describe("terminal layout safety", () => {
	it.each([0, 1, 2, 8, 12, 20, 39, 40, 60, 80, 200])("fits every row in %i terminal cells", terminalWidth => {
		const ansiTheme: Theme = { fg: (_color, text) => `\x1b[36m${text}\x1b[39m`, bold: text => `\x1b[1m${text}\x1b[22m` };
		const lines = render({ terminalWidth, theme: ansiTheme, agents: [makeAgent({
			description: "界面 🧪 café ".repeat(30),
			activeTools: new Map([["tool", "界面工具".repeat(20)]]),
		})] });
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(terminalWidth);
			expect(line).not.toMatch(/[\r\n]/);
		}
		if (terminalWidth === 0) expect(lines).toEqual([]);
	});

	it("keeps agent identity and status visible when task/activity text is long", () => {
		const row = render({ agents: [makeAgent({ description: "Long task ".repeat(100), responseText: "Streaming ".repeat(100) })] })[1];
		expect(row).toContain("Agent");
		expect(row).toContain("Streaming");
		expect(row).toContain("…");
		expect(visibleWidth(row)).toBe(80);
	});

	it("drops elapsed time and prompt mode on narrow screens, keeping task and status", () => {
		const row = render({ terminalWidth: 30 })[1];
		expect(row).toContain("Agent: test task");
		expect(row).toContain("thinking…");
		expect(row).not.toContain("01:23");
		expect(row).not.toContain("twin");
	});

	it("does not let multiline task, tool, or error labels introduce extra rows", () => {
		const lines = render({ agents: [
			makeAgent({ description: "task\nsecond\tline", activeTools: new Map([["t", "custom\ncommand"]]) }),
			makeAgent({ id: "error", status: "error", completedAt: NOW, error: "failed\r\nretry\x1b[31m" }),
		] });
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
	});

	it.each([
		[6, 3], [7, 3], [9, 3], [10, 4], [12, 6], [14, 8], [16, 10], [18, 12], [24, 12], [60, 12],
	])("preserves viewport budget at %i rows", (rows, budget) => {
		expect(widgetLineBudget(rows)).toBe(budget);
	});

	it("fits six running agents in seven lines", () => {
		const agents = Array.from({ length: 6 }, (_, index) => makeAgent({ id: `r${index}` }));
		expect(render({ agents })).toHaveLength(7);
	});

	it("caps height and counts hidden running/queued/finished agents exactly", () => {
		const agents = [
			...Array.from({ length: 12 }, (_, index) => makeAgent({ id: `r${index}` })),
			makeAgent({ id: "q", status: "queued" }),
			makeAgent({ id: "f", status: "completed", completedAt: NOW }),
		];
		const lines = render({ agents });
		expect(lines).toHaveLength(12);
		expect(lines.at(-1)).toBe("+4 more (2 running, 1 queued, 1 finished)");
	});

	it("prioritizes running over queued over finished on short terminals", () => {
		const lines = render({ terminalHeight: 9, agents: [
			makeAgent({ id: "f", status: "completed", completedAt: NOW }),
			...Array.from({ length: 3 }, (_, index) => makeAgent({ id: `q${index}`, status: "queued" })),
			makeAgent({ id: "r", description: "live task" }),
		] });
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("live task");
		expect(lines[2]).toBe("+4 more (3 queued, 1 finished)");
	});
});
