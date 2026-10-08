import type { ChildCompletedEvent } from "#src/lifecycle/child-lifecycle";
import type { TurnLoopResult } from "#src/lifecycle/subagent-session";

/** A turn loop that ran to completion, one turn, with no turn limit. */
export function turnLoopResult(overrides: Partial<TurnLoopResult> = {}): TurnLoopResult {
	return {
		responseText: "done",
		turnBudget: { used: 1, phase: "within" },
		...overrides,
	};
}

/** A `subagents:child:completed` payload for a run with no turn limit. */
export function childCompletedEvent(overrides: Partial<ChildCompletedEvent> = {}): ChildCompletedEvent {
	return {
		sessionDir: "/sessions/child",
		agentName: "Explore",
		...overrides,
	};
}
