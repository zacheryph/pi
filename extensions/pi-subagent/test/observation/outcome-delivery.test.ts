import { describe, expect, it } from "vitest";
import type { DisplayStatus } from "#src/lifecycle/subagent-state";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import {
  type OutcomeAddenda,
  type OutcomeBody,
  renderOutcomeAddenda,
  renderOutcomeBody,
  renderRunUpdates,
  renderSendUnavailable,
  renderStatusLabel,
  renderStatusNote,
} from "#src/observation/outcome-delivery";

function makeOutcome(overrides: Partial<OutcomeBody> = {}): OutcomeBody {
  return {
    status: "completed",
    result: "All done.",
    error: undefined,
    stoppedWhileQueued: false,
    ...overrides,
  };
}

describe("status vocabulary", () => {
  const warned: TurnBudget = { maxTurns: 2, used: 3, phase: "warned" };
  const exhausted: TurnBudget = { maxTurns: 2, used: 7, phase: "exhausted" };

  // One case, spelled out, before the status table below generalizes the rest.
  it("renders a completed run the harness warned as wrapped up, in both presentations", () => {
    expect(renderStatusLabel({ status: "completed", turnBudget: warned })).toBe(
      "Wrapped up (after turn-budget warning)",
    );
    expect(renderStatusNote({ status: "completed", turnBudget: warned })).toBe(
      " (wrapped up \u2014 after turn-budget warning)",
    );
  });

  it("renders an aborted run by its status, not its budget", () => {
    expect(renderStatusLabel({ status: "aborted", turnBudget: exhausted })).toBe(
      "Aborted (turn limit reached, output may be incomplete)",
    );
  });

  it("renders a completed run within its budget as done", () => {
    const within: TurnBudget = { maxTurns: 5, used: 2, phase: "within" };
    expect(renderStatusLabel({ status: "completed", turnBudget: within })).toBe("Done");
    expect(renderStatusNote({ status: "completed", turnBudget: within })).toBe("");
  });

  const rows: { status: DisplayStatus; label: string; note: string }[] = [
    {
      status: "aborted",
      label: "Aborted (turn limit reached, output may be incomplete)",
      note: " (aborted \u2014 turn limit reached, output may be incomplete)",
    },
    { status: "stopped", label: "Stopped (user request)", note: " (stopped \u2014 user request)" },
    { status: "completed", label: "Done", note: "" },
    { status: "running", label: "Done", note: "" },
    { status: "queued", label: "Done", note: "" },
  ];

  for (const row of rows) {
    it(`renders "${row.status}" as label ${JSON.stringify(row.label)}`, () => {
      expect(renderStatusLabel({ status: row.status })).toBe(row.label);
    });

    it(`renders "${row.status}" as note ${JSON.stringify(row.note)}`, () => {
      expect(renderStatusNote({ status: row.status })).toBe(row.note);
    });
  }

  it("names the error in the label form", () => {
    expect(renderStatusLabel({ status: "error", error: "timeout" })).toBe("Error: timeout");
  });

  it("reports an unknown error when none was captured", () => {
    expect(renderStatusLabel({ status: "error" })).toBe("Error: unknown");
  });

  it("adds no note for an error, whose body already carries the message", () => {
    expect(renderStatusNote({ status: "error" })).toBe("");
  });
});

describe("renderSendUnavailable", () => {
  it("says nothing when a message would be accepted", () => {
    expect(renderSendUnavailable(undefined)).toBe("");
  });

  it("says nothing for a refusal that lifts in a moment", () => {
    expect(renderSendUnavailable("rebuilding")).toBe("");
  });

  it.each([
    ["no-session", "it never started a session and its original task was not saved"],
    ["session-released", "its session was released and its saved transcript is gone"],
    ["directory-unavailable", "the directory it ran in no longer exists"],
    ["agent-type-unavailable", "its agent type is no longer available"],
  ] as const)(
    "gives the reason a %s agent cannot take a message, and what to do instead",
    (refusal, clause) => {
      expect(renderSendUnavailable(refusal)).toBe(
        `Send: not available, because ${clause}. Spawn a new agent with the context it needs.`,
      );
    },
  );
});

// Removed by roadmap step 10: `renderQuestionAffordance` (a question the child "ended its turn with",
// quoted after its outcome, with a send call that depended on whether the agent could be reached).
// A question is now its own message to the parent when it is asked (`questionMessage`, tested in
// notification.test.ts), and an agent that waits on one is an ordinary waiting agent.

describe("renderOutcomeBody", () => {
  it("points a running agent at its completion message instead of reporting an outcome", () => {
    expect(renderOutcomeBody(makeOutcome({ status: "running" }))).toBe(
      "Agent is still running. Its completion message arrives when it finishes.",
    );
  });

  it("reports the error for a failed agent", () => {
    expect(renderOutcomeBody(makeOutcome({ status: "error", error: "boom" }))).toBe("Error: boom");
  });

  it("says no work was performed for an agent stopped while queued", () => {
    expect(
      renderOutcomeBody(
        makeOutcome({ status: "stopped", stoppedWhileQueued: true, result: undefined }),
      ),
    ).toBe("Agent was stopped while queued and never started. No work was performed.");
  });

  it("returns the trimmed result for a completed agent", () => {
    expect(renderOutcomeBody(makeOutcome({ result: "  spaced  " }))).toBe("spaced");
  });

  it("falls back to No output when a completed agent produced none", () => {
    expect(renderOutcomeBody(makeOutcome({ result: undefined }))).toBe("No output.");
  });

  // The empty string is what a child whose provider errored actually carries:
  // the streamed-text collector holds "" and no earlier assistant message has
  // text to fall back to. `??` passes it through, rendering the parent a
  // completion header followed by nothing (#889).
  it("falls back to No output when the result is an empty string", () => {
    expect(renderOutcomeBody(makeOutcome({ result: "" }))).toBe("No output.");
  });

  it("prefers the running note over a result a running agent has already accumulated", () => {
    expect(renderOutcomeBody(makeOutcome({ status: "running", result: "partial" }))).toBe(
      "Agent is still running. Its completion message arrives when it finishes.",
    );
  });

  it("prefers the error line over the never-started note when both could apply", () => {
    expect(
      renderOutcomeBody(makeOutcome({ status: "error", error: "boom", stoppedWhileQueued: true })),
    ).toBe("Error: boom");
  });
});

describe("renderOutcomeAddenda", () => {
  it("renders nothing when the run produced no addenda", () => {
    expect(renderOutcomeAddenda({})).toBe("");
  });

  it("renders what the agent flagged along the way", () => {
    const addenda: OutcomeAddenda = { runUpdates: ["The bug is in the retry wrapper."] };

    expect(renderOutcomeAddenda(addenda)).toBe(renderRunUpdates(addenda.runUpdates));
    expect(renderOutcomeAddenda(addenda)).toContain("retry wrapper");
  });
});

describe("renderRunUpdates", () => {
  it("renders nothing when the agent sent none", () => {
    expect(renderRunUpdates([])).toBe("");
  });

  it("renders nothing when the carrier has no updates field", () => {
    expect(renderRunUpdates(undefined)).toBe("");
  });

  it("introduces a single update and quotes it", () => {
    expect(renderRunUpdates(["The bug is in the retry wrapper."])).toBe(
      "\n\nUpdates this agent sent while it worked:\n\n  The bug is in the retry wrapper.",
    );
  });

  it("separates several updates with a blank line, in order", () => {
    expect(renderRunUpdates(["First.", "Second."])).toBe(
      "\n\nUpdates this agent sent while it worked:\n\n  First.\n\n  Second.",
    );
  });

  it("quotes every line of a multi-line update", () => {
    expect(renderRunUpdates(["A or B?\nOr C?"])).toContain("  A or B?\n  Or C?");
  });
});
