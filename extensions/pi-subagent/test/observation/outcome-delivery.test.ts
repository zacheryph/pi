import { describe, expect, it } from "vitest";
import type { DisplayStatus } from "#src/lifecycle/subagent-state";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import {
  type OutcomeAddenda,
  type OutcomeBody,
  renderOutcomeAddenda,
  renderOutcomeBody,
  renderQuestionAffordance,
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

describe("renderQuestionAffordance", () => {
  describe("when a message would be accepted", () => {
    it("names the exact send call that answers the question", () => {
      expect(renderQuestionAffordance("b15f500f-314b-49b", "Which config?", undefined)).toBe(
        "\n\nThis agent is waiting on an answer:\n\n  Which config?\n\n" +
          'Answer by calling subagent_send with agent_id: "b15f500f-314b-49b" and your answer as the message.',
      );
    });

    it("indents every line of a multi-line question", () => {
      expect(renderQuestionAffordance("agent-1", "A or B?\nOr C?", undefined)).toContain(
        "  A or B?\n  Or C?",
      );
    });
  });

  describe("when a message would be refused", () => {
    it("reports a released session without naming a send", () => {
      expect(renderQuestionAffordance("agent-7", "Which config?", "session-released")).toBe(
        "\n\nThis agent ended its run with a question that can no longer be answered \u2014 " +
          "its session was released and its saved transcript is gone:\n\n  Which config?\n\n" +
          "Spawn a new agent with the context it needs; this one cannot take a message.",
      );
    });

    it("names a missing session as the reason", () => {
      expect(renderQuestionAffordance("agent-7", "Which config?", "no-session")).toContain(
        "it never started a session and its original task was not saved",
      );
    });

    it("still reports the question itself", () => {
      expect(renderQuestionAffordance("agent-7", "Which config?", "session-released")).toContain(
        "  Which config?",
      );
    });

    it("indents every line of a multi-line question", () => {
      expect(renderQuestionAffordance("agent-1", "A or B?\nOr C?", "no-session")).toContain(
        "  A or B?\n  Or C?",
      );
    });

    it("names no send call for any reason", () => {
      for (const refusal of ["rebuilding", "no-session", "session-released"] as const) {
        expect(renderQuestionAffordance("agent-7", "Which config?", refusal)).not.toContain(
          "subagent_send",
        );
      }
    });
  });

  // Changed by roadmap step 7b (was: a question on a child that had not finished running said
  // to end the turn and wait). A running child takes a message, so the only transient
  // refusal left is a stopped rebuild that still owns the transcript.
  describe("when a stopped rebuild still owns the transcript", () => {
    it("says the question cannot be answered yet, and to try again", () => {
      expect(renderQuestionAffordance("agent-7", "Which config?", "rebuilding")).toBe(
        "\n\nThis agent asked a question, but it was stopped while its session was being created or rebuilt " +
          "and cannot take your answer yet:\n\n  Which config?\n\n" +
          "Try again in a moment.",
      );
    });

    it("does not tell the parent to spawn a new agent, which a permanent refusal does", () => {
      expect(renderQuestionAffordance("agent-7", "Which config?", "rebuilding")).not.toContain(
        "Spawn a new agent",
      );
    });

    it("indents every line of a multi-line question", () => {
      expect(renderQuestionAffordance("agent-1", "A or B?\nOr C?", "rebuilding")).toContain(
        "  A or B?\n  Or C?",
      );
    });
  });

  it("renders nothing when the child asked nothing", () => {
    expect(renderQuestionAffordance("agent-1", undefined, undefined)).toBe("");
  });

  it("renders nothing for an empty question", () => {
    expect(renderQuestionAffordance("agent-1", "", undefined)).toBe("");
  });

  it("renders nothing for an unanswerable agent that asked nothing", () => {
    expect(renderQuestionAffordance("agent-1", undefined, "session-released")).toBe("");
  });
});

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
  function makeAddenda(overrides: Partial<OutcomeAddenda> = {}): OutcomeAddenda {
    return { id: "agent-1", sendRefusal: undefined, ...overrides };
  }

  it("renders nothing when the run produced no addenda", () => {
    expect(renderOutcomeAddenda(makeAddenda())).toBe("");
  });

  it("composes the same text the carriers built by hand", () => {
    const addenda = makeAddenda({
      runUpdates: ["The bug is in the retry wrapper."],
      pendingQuestion: "Which config?",
    });

    expect(renderOutcomeAddenda(addenda)).toBe(
      renderRunUpdates(addenda.runUpdates) +
        renderQuestionAffordance(addenda.id, addenda.pendingQuestion, addenda.sendRefusal),
    );
  });

  it("passes the refusal through, so the tail does not name a refused send", () => {
    const rendered = renderOutcomeAddenda(
      makeAddenda({ pendingQuestion: "Which config?", sendRefusal: "session-released" }),
    );

    expect(rendered).toContain("Which config?");
    expect(rendered).not.toContain("subagent_send");
  });

  it("leads with what the agent flagged along the way", () => {
    const rendered = renderOutcomeAddenda(
      makeAddenda({
        runUpdates: ["The bug is in the retry wrapper."],
        pendingQuestion: "Which config?",
      }),
    );

    // Both must be present, or the index comparison passes on a -1 that means
    // "absent" rather than "earlier".
    expect(rendered).toContain("retry wrapper");
    expect(rendered).toContain("waiting on an answer");
    expect(rendered.indexOf("retry wrapper")).toBeLessThan(
      rendered.indexOf("waiting on an answer"),
    );
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
