import { describe, expect, it, vi } from "vitest";
import { isFormModel, MAX_FORM_QUESTIONNAIRES } from "#surface";
import { OpenQuestionnaires, QuestionnaireRefused } from "#src/owner";
import type { AskQuestion } from "#src/questions";

const questions: AskQuestion[] = [
  {
    question: "Which database?",
    header: "",
    options: [
      { label: "Postgres", description: "" },
      { label: "SQLite", description: "No server" },
    ],
    multiSelect: false,
  },
];

function owner() {
  const changed = vi.fn();
  return { changed, open: new OpenQuestionnaires({ changed, now: () => 42 }) };
}

describe("OpenQuestionnaires", () => {
  it("lists published questionnaires oldest first, as a valid form", () => {
    const { open, changed } = owner();
    open.open("b", questions);
    open.open("a", questions);
    open.open("hidden", questions).withdraw();
    const form = open.form();
    expect(isFormModel(form)).toBe(true);
    expect(form!.questionnaires.map((questionnaire) => questionnaire.id)).toEqual(["b", "a"]);
    expect(form!.questionnaires[0]!.questions[0]).toEqual({
      question: "Which database?",
      options: [{ label: "Postgres" }, { label: "SQLite", description: "No server" }],
    });
    // Each opening, and the withdrawal, announced the form.
    expect(changed).toHaveBeenCalledTimes(4);
    expect(open.size).toBe(3);
  });

  it("settles once: the first outcome wins, resolves done and aborts the signal", async () => {
    const { open, changed } = owner();
    const record = open.open("a", questions);
    expect(record.settle({ status: "cancelled" })).toBe(true);
    expect(record.settle({ status: "answered", answers: [] })).toBe(false);
    await expect(record.done).resolves.toEqual({ status: "cancelled" });
    expect(record.signal.aborted).toBe(true);
    expect(record.published).toBe(false);
    expect(open.form()).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("withdraws from the form for good, refusing outside answers from then on", () => {
    const { open, changed } = owner();
    const record = open.open("a", questions);
    record.withdraw();
    record.withdraw();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(open.form()).toBeUndefined();
    expect(open.answer({ toolCallId: "a", cancel: true })).toMatchObject({ code: "not_found" });
    expect(record.outcome).toBeUndefined();
    // Settling it later announces nothing more: it is no longer in the form.
    record.settle({ status: "cancelled" });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("tells a stale id from an unknown one, for a bounded number of ids", () => {
    const { open } = owner();
    for (let at = 0; at < 70; at++)
      open.open(`id-${at}`, questions).settle({ status: "cancelled" });
    expect(open.answer({ toolCallId: "id-69", cancel: true })).toMatchObject({ code: "closed" });
    expect(open.answer({ toolCallId: "id-0", cancel: true })).toMatchObject({ code: "not_found" });
  });

  it("refuses an id already open, and one questionnaire more than a form holds", () => {
    const { open } = owner();
    const first = open.open("a", questions);
    expect(() => open.open("a", questions)).toThrow(QuestionnaireRefused);
    for (let at = 1; at < MAX_FORM_QUESTIONNAIRES; at++) open.open(`q${at}`, questions);
    expect(() => open.open("over", questions)).toThrow("already waiting");
    expect(open.size).toBe(MAX_FORM_QUESTIONNAIRES);
    // One handed over to Pi's own dialog has left the form, and no longer counts against it.
    first.withdraw();
    expect(() => open.open("over", questions)).not.toThrow();
  });

  it("cancels everything open for a reason", async () => {
    const { open } = owner();
    const a = open.open("a", questions);
    const b = open.open("b", questions);
    b.withdraw();
    open.cancelAll("ended");
    await expect(a.done).resolves.toEqual({ status: "cancelled", reason: "ended" });
    await expect(b.done).resolves.toEqual({ status: "cancelled", reason: "ended" });
    expect(open.size).toBe(0);
  });

  it("checks an outside answer all or nothing and echoes the request id", () => {
    const { open } = owner();
    const record = open.open("a", questions);
    expect(open.answer(null)).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(
      open.answer({ toolCallId: "a", requestId: "r", answers: [{ questionIndex: 0 }] }),
    ).toEqual({
      ok: false,
      code: "invalid_answer",
      reason: "Question 0 has no answer.",
      toolCallId: "a",
      requestId: "r",
    });
    expect(record.outcome).toBeUndefined();
    expect(
      open.answer({ toolCallId: "a", answers: [{ questionIndex: 0, optionIndexes: [1] }] }),
    ).toEqual({ ok: true, toolCallId: "a" });
    expect(record.outcome).toEqual({
      status: "answered",
      answers: [{ question: "Which database?", selected: ["SQLite"] }],
    });
  });
});
