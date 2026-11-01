import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AskParameters,
  formatForParent,
  formatOutcome,
  readExternalAnswer,
  readQuestions,
} from "../src/questions.ts";

const choice = {
  question: "Which database?",
  header: "Storage",
  options: [
    { label: "Postgres (Recommended)", description: "Already in production" },
    { label: "SQLite", description: "No server" },
  ],
};

describe("ask parameters", () => {
  it("accept 1-4 questions with up to 4 options, and text-only questions", () => {
    expect(Check(AskParameters, { questions: [choice] })).toBe(true);
    expect(Check(AskParameters, { questions: [{ question: "Which port?" }] })).toBe(true);
    expect(Check(AskParameters, { questions: [] })).toBe(false);
    expect(Check(AskParameters, { questions: Array(5).fill(choice) })).toBe(false);
    expect(
      Check(AskParameters, {
        questions: [{ ...choice, options: Array(5).fill({ label: "x" }) }],
      }),
    ).toBe(false);
    expect(Check(AskParameters, { questions: [{ ...choice, header: "x".repeat(17) }] })).toBe(
      false,
    );
    expect(Check(AskParameters, { questions: [{ ...choice, extra: true }] })).toBe(false);
  });
});

describe("readQuestions", () => {
  it("normalizes text and defaults", () => {
    expect(readQuestions({ questions: [{ question: " Why?\r\n\u0007Really? " }] })).toEqual([
      { question: "Why?\nReally?", header: "", options: [], multiSelect: false },
    ]);
  });

  it("rejects duplicate questions and option labels with a message for the model", () => {
    expect(() => readQuestions({ questions: [choice, choice] })).toThrow("Duplicate question");
    expect(() =>
      readQuestions({
        questions: [{ question: "Pick", options: [{ label: "A" }, { label: "a" }] }],
      }),
    ).toThrow('Duplicate option "a"');
  });
});

describe("formatting", () => {
  it("writes the parent's question with lettered choices", () => {
    const text = formatForParent(
      readQuestions({ questions: [choice, { question: "Anything else?", multiSelect: true }] }),
    );
    expect(text).toBe(
      [
        "1. [Storage] Which database?",
        "   a) Postgres (Recommended) — Already in production",
        "   b) SQLite — No server",
        "   (choose one, or answer in your own words)",
        "",
        "2. Anything else?",
      ].join("\n"),
    );
  });

  it("writes answers and dismissals for the model", () => {
    expect(
      formatOutcome({
        status: "answered",
        answers: [
          { question: "Which database?", selected: ["SQLite"] },
          { question: "Why?", selected: [], text: "Tests", notes: "for now" },
        ],
        note: "thanks",
      }),
    ).toBe(
      [
        "The user answered:",
        '- Which database? → "SQLite"',
        '- Why? → "Tests" (own words) (note: for now)',
        "Note: thanks",
      ].join("\n"),
    );
    expect(formatOutcome({ status: "cancelled" })).toContain("dismissed");
  });
});

describe("readExternalAnswer", () => {
  const questions = readQuestions({
    questions: [choice, { question: "Extras?", multiSelect: true, options: choice.options }],
  });

  it("accepts a whole answer and a cancel", () => {
    expect(
      readExternalAnswer(questions, {
        answers: [
          { questionIndex: 0, optionIndexes: [1] },
          { questionIndex: 1, optionIndexes: [1, 0], text: "Redis", notes: "cache" },
        ],
        globalNote: "ok",
      }),
    ).toEqual({
      status: "answered",
      answers: [
        { question: "Which database?", selected: ["SQLite"] },
        {
          question: "Extras?",
          selected: ["SQLite", "Postgres (Recommended)"],
          text: "Redis",
          notes: "cache",
        },
      ],
      note: "ok",
    });
    expect(readExternalAnswer(questions, { cancel: true })).toEqual({ status: "cancelled" });
  });

  it.each([
    [{}, "invalid_payload"],
    [{ answers: [null] }, "invalid_payload"],
    [{ answers: [{ questionIndex: 0, optionIndexes: [0] }] }, "invalid_answer"],
    [{ answers: [{ questionIndex: 2, optionIndexes: [0] }] }, "invalid_answer"],
    [
      {
        answers: [
          { questionIndex: 0, optionIndexes: [0, 1] },
          { questionIndex: 1, text: "x" },
        ],
      },
      "invalid_answer",
    ],
    [
      {
        answers: [
          { questionIndex: 0, optionIndexes: [0], text: "also" },
          { questionIndex: 1, text: "x" },
        ],
      },
      "invalid_answer",
    ],
    [
      {
        answers: [
          { questionIndex: 0, optionIndexes: [5] },
          { questionIndex: 1, text: "x" },
        ],
      },
      "invalid_answer",
    ],
    [
      {
        answers: [
          { questionIndex: 0, optionIndexes: [0] },
          { questionIndex: 0, optionIndexes: [1] },
        ],
      },
      "invalid_answer",
    ],
    [
      {
        answers: [
          { questionIndex: 0, optionIndexes: [0] },
          { questionIndex: 1, text: "   " },
        ],
      },
      "invalid_answer",
    ],
  ])("rejects %j as %s, all or nothing", (data, code) => {
    expect(readExternalAnswer(questions, data)).toMatchObject({ code });
  });
});
