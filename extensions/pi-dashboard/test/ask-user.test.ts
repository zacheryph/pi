import { describe, expect, it, vi } from "vitest";
import {
  ASK_USER_ANSWER_EVENT,
  ASK_USER_ANSWER_RESULT_EVENT,
  ASK_USER_BLOCKED_EVENT,
  ASK_USER_PROMPT_EVENT,
  AskUserTracker,
  readAnswer,
  readPrompt,
  type Bus,
} from "#src/ask-user";

/** A synchronous bus like Pi's, for one session. */
function bus(): Bus & { sent: Array<[string, unknown]> } {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    on: (channel, handler) => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      return () => {};
    },
    emit: (channel, data) => {
      sent.push([channel, data]);
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
}

const prompt = (toolCallId = "call-1") => ({
  toolCallId,
  questions: [
    {
      question: "Which strategy?",
      header: "Strategy",
      multiSelect: false,
      options: [
        { label: "Retry", description: "Back off and retry", hasPreview: false },
        { label: "Fail fast", description: "", hasPreview: false },
      ],
    },
    {
      question: "Which tests?",
      header: "Tests",
      multiSelect: true,
      options: [
        { label: "Unit", description: "" },
        { label: "E2E", description: "" },
      ],
    },
  ],
});

/** Stands in for rpiv ask-user's answer channel: answers verdicts the way it does. */
function rpiv(target: Bus, verdict: (payload: Record<string, unknown>) => Record<string, unknown>) {
  target.on(ASK_USER_ANSWER_EVENT, (data) => {
    const payload = data as Record<string, unknown>;
    target.emit(ASK_USER_ANSWER_RESULT_EVENT, {
      requestId: payload.requestId,
      toolCallId: payload.toolCallId,
      ...verdict(payload),
    });
  });
}

describe("readPrompt", () => {
  it("keeps the questions, options and descriptions the page shows", () => {
    expect(readPrompt(prompt(), 5)).toEqual({
      id: "call-1",
      since: 5,
      questions: [
        {
          question: "Which strategy?",
          header: "Strategy",
          multiSelect: false,
          options: [
            { label: "Retry", description: "Back off and retry" },
            { label: "Fail fast", description: "" },
          ],
        },
        {
          question: "Which tests?",
          header: "Tests",
          multiSelect: true,
          options: [
            { label: "Unit", description: "" },
            { label: "E2E", description: "" },
          ],
        },
      ],
    });
  });

  it("refuses payloads it could not show whole", () => {
    expect(readPrompt({ questions: [] }, 1)).toBeUndefined();
    expect(readPrompt({ toolCallId: "x", questions: [] }, 1)).toBeUndefined();
    expect(
      readPrompt({ toolCallId: "x", questions: [{ header: "no question" }] }, 1),
    ).toBeUndefined();
    expect(
      readPrompt(
        { toolCallId: "x", questions: Array.from({ length: 9 }, () => ({ question: "q" })) },
        1,
      ),
    ).toBeUndefined();
  });
});

describe("readAnswer", () => {
  const questionnaire = readPrompt(prompt(), 1)!;

  it("keeps the documented fields and drops the rest", () => {
    expect(
      readAnswer(
        {
          answers: [
            { questionIndex: 0, optionIndexes: [1], extra: true },
            { questionIndex: 1, optionIndexes: [0, 1], text: "  and perf  ", notes: "" },
          ],
          globalNote: "ship it",
          requestId: "spoof",
        },
        questionnaire,
      ),
    ).toEqual({
      answers: [
        { questionIndex: 0, optionIndexes: [1] },
        { questionIndex: 1, optionIndexes: [0, 1], text: "and perf" },
      ],
      globalNote: "ship it",
    });
    expect(readAnswer({ cancel: true, answers: [{ questionIndex: 0 }] }, questionnaire)).toEqual({
      cancel: true,
    });
  });

  it("refuses answers that name questions or options that do not exist", () => {
    expect(readAnswer({ answers: [{ questionIndex: 2, text: "x" }] }, questionnaire)).toBe(
      "An answer names a question that does not exist.",
    );
    expect(readAnswer({ answers: [{ questionIndex: 0, optionIndexes: [5] }] }, questionnaire)).toBe(
      "An answer picks an option that does not exist.",
    );
    expect(readAnswer({ answers: "x" }, questionnaire)).toBe("Answer every question.");
    expect(readAnswer(null, questionnaire)).toBe("The answer must be an object.");
  });
});

describe("AskUserTracker", () => {
  it("lists open questionnaires until rpiv reports the wait is over", () => {
    const events = bus();
    const changed = vi.fn();
    const tracker = new AskUserTracker(events, changed, () => 7);
    expect(tracker.list()).toBeUndefined();
    events.emit(ASK_USER_PROMPT_EVENT, prompt("a"));
    events.emit(ASK_USER_PROMPT_EVENT, prompt("b"));
    expect(tracker.list()?.map((questionnaire) => questionnaire.id)).toEqual(["a", "b"]);
    events.emit(ASK_USER_BLOCKED_EVENT, { active: true, toolCallId: "a" });
    expect(tracker.list()).toHaveLength(2);
    events.emit(ASK_USER_BLOCKED_EVENT, { active: false, toolCallId: "a" });
    expect(tracker.list()?.map((questionnaire) => questionnaire.id)).toEqual(["b"]);
    tracker.close("b");
    expect(tracker.list()).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("answers through rpiv's channel and closes the questionnaire once accepted", async () => {
    const events = bus();
    rpiv(events, () => ({ ok: true }));
    const tracker = new AskUserTracker(events, () => {});
    events.emit(ASK_USER_PROMPT_EVENT, prompt());
    await tracker.answer("call-1", {
      answers: [
        { questionIndex: 0, optionIndexes: [0] },
        { questionIndex: 1, text: "smoke" },
      ],
    });
    expect(events.sent.find(([channel]) => channel === ASK_USER_ANSWER_EVENT)?.[1]).toEqual({
      toolCallId: "call-1",
      requestId: "pi-dashboard-1",
      answers: [
        { questionIndex: 0, optionIndexes: [0] },
        { questionIndex: 1, text: "smoke" },
      ],
    });
    expect(tracker.list()).toBeUndefined();
  });

  it("passes a decline through as cancel", async () => {
    const events = bus();
    rpiv(events, () => ({ ok: true }));
    const tracker = new AskUserTracker(events, () => {});
    events.emit(ASK_USER_PROMPT_EVENT, prompt());
    await tracker.answer("call-1", { cancel: true });
    expect(events.sent.find(([channel]) => channel === ASK_USER_ANSWER_EVENT)?.[1]).toEqual({
      toolCallId: "call-1",
      requestId: "pi-dashboard-1",
      cancel: true,
    });
  });

  it("reports rpiv's refusal and keeps the questionnaire open unless it is gone", async () => {
    const events = bus();
    let code = "invalid_answer";
    rpiv(events, () => ({ ok: false, code, reason: "question 2 is unanswered" }));
    const tracker = new AskUserTracker(events, () => {});
    events.emit(ASK_USER_PROMPT_EVENT, prompt());
    await expect(
      tracker.answer("call-1", { answers: [{ questionIndex: 0, optionIndexes: [0] }] }),
    ).rejects.toThrow("Not accepted: question 2 is unanswered");
    expect(tracker.list()).toHaveLength(1);
    code = "not_found";
    await expect(tracker.answer("call-1", { answers: [] })).rejects.toThrow();
    expect(tracker.list()).toBeUndefined();
  });

  it("refuses unknown questionnaires and malformed answers before emitting", async () => {
    const events = bus();
    const tracker = new AskUserTracker(events, () => {});
    await expect(tracker.answer("missing", { cancel: true })).rejects.toThrow("no longer open");
    events.emit(ASK_USER_PROMPT_EVENT, prompt());
    await expect(tracker.answer("call-1", { answers: [{ questionIndex: 9 }] })).rejects.toThrow(
      "does not exist",
    );
    expect(events.sent.some(([channel]) => channel === ASK_USER_ANSWER_EVENT)).toBe(false);
  });

  it("says when no rpiv answer channel replies", async () => {
    vi.useFakeTimers();
    try {
      const events = bus();
      const tracker = new AskUserTracker(events, () => {});
      events.emit(ASK_USER_PROMPT_EVENT, prompt());
      const pending = expect(tracker.answer("call-1", { cancel: true })).rejects.toThrow(
        "did not answer",
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps at most 8 open questionnaires, dropping the oldest", () => {
    const events = bus();
    const tracker = new AskUserTracker(events, () => {});
    for (let index = 0; index < 10; index += 1)
      events.emit(ASK_USER_PROMPT_EVENT, prompt(`c${index}`));
    expect(tracker.list()?.map((questionnaire) => questionnaire.id)).toEqual([
      "c2",
      "c3",
      "c4",
      "c5",
      "c6",
      "c7",
      "c8",
      "c9",
    ]);
  });
});
