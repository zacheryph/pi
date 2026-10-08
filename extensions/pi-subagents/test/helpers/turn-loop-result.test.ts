import { describe, expect, it } from "vitest";
import { childCompletedEvent, turnLoopResult } from "./turn-loop-result";

describe("turnLoopResult", () => {
	it("describes a one-turn run with no turn limit by default", () => {
		expect(turnLoopResult()).toEqual({ responseText: "done", turnBudget: { used: 1, phase: "within" } });
	});

	it("applies overrides while keeping other defaults", () => {
		expect(turnLoopResult({ turnBudget: { maxTurns: 3, used: 2, phase: "warned" } })).toEqual({
			responseText: "done",
			turnBudget: { maxTurns: 3, used: 2, phase: "warned" },
		});
	});
});

describe("childCompletedEvent", () => {
	it("describes a run with no turn limit by default", () => {
		expect(childCompletedEvent()).toEqual({ sessionDir: "/sessions/child", agentName: "Explore" });
	});

	it("applies overrides while keeping other defaults", () => {
		expect(childCompletedEvent({ agentName: "Plan" })).toEqual({
			sessionDir: "/sessions/child",
			agentName: "Plan",
		});
	});
});
