import { Type, type Static } from "typebox";

export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 4;
export const MAX_HEADER = 16;
export const MAX_LABEL = 60;
export const MAX_TEXT = 4_000;

export const AskParameters = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          question: Type.String({
            minLength: 1,
            maxLength: MAX_TEXT,
            description: "The full question, ending with a question mark",
          }),
          header: Type.Optional(
            Type.String({
              maxLength: MAX_HEADER,
              description: "Short tag shown beside the question, e.g. Auth method",
            }),
          ),
          options: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  label: Type.String({
                    minLength: 1,
                    maxLength: MAX_LABEL,
                    description: "1-5 words naming the choice",
                  }),
                  description: Type.Optional(
                    Type.String({
                      maxLength: 1_000,
                      description: "What the choice means or costs",
                    }),
                  ),
                },
                { additionalProperties: false },
              ),
              {
                maxItems: MAX_OPTIONS,
                description:
                  "Up to 4 distinct choices. A free-text answer is always offered too; omit options for a question that only takes text",
              },
            ),
          ),
          multiSelect: Type.Optional(
            Type.Boolean({ description: "Allow choosing several options; default false" }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_QUESTIONS, description: "1-4 independent questions" },
    ),
  },
  { additionalProperties: false },
);
export type AskParams = Static<typeof AskParameters>;

export interface AskOption {
  label: string;
  description: string;
}
export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect: boolean;
}

/** One question's answer: chosen labels, typed text, or both for a multi-select. */
export interface AskAnswer {
  question: string;
  selected: string[];
  text?: string;
  notes?: string;
}

export type AskOutcome =
  | { status: "answered"; answers: AskAnswer[]; note?: string }
  | { status: "cancelled" };

/** Collapses line terminators so a question renders and serializes predictably. */
const tidy = (text: string | undefined): string =>
  (text ?? "")
    .replace(/\r\n?/g, "\n")
    // oxlint-disable-next-line no-control-regex -- Strips control characters, keeping newlines.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .trim();

/** Normalizes model input; throws a message written for the model on anything ambiguous. */
export function readQuestions(params: AskParams): AskQuestion[] {
  const questions = params.questions.map((raw) => ({
    question: tidy(raw.question),
    header: tidy(raw.header).replace(/\n/g, " "),
    options: (raw.options ?? []).map((option) => ({
      label: tidy(option.label).replace(/\n/g, " "),
      description: tidy(option.description),
    })),
    multiSelect: raw.multiSelect === true,
  }));
  if (!questions.length) throw new Error("ask needs at least one question.");
  const seen = new Set<string>();
  for (const question of questions) {
    if (!question.question) throw new Error("Every question needs text.");
    if (seen.has(question.question)) throw new Error(`Duplicate question: ${question.question}`);
    seen.add(question.question);
    const labels = new Set<string>();
    for (const option of question.options) {
      if (!option.label) throw new Error(`An option of "${question.question}" has no label.`);
      const key = option.label.toLowerCase();
      if (labels.has(key))
        throw new Error(`Duplicate option "${option.label}" in "${question.question}".`);
      labels.add(key);
    }
  }
  return questions;
}

/** The question text a parent agent reads in the child's result. */
export function formatForParent(questions: readonly AskQuestion[]): string {
  return questions
    .map((question, index) => {
      const lead = questions.length > 1 ? `${index + 1}. ` : "";
      const head = question.header ? `[${question.header}] ` : "";
      const choices = question.options.map(
        (option, choice) =>
          `   ${String.fromCharCode(97 + choice)}) ${option.label}${option.description ? ` — ${option.description}` : ""}`,
      );
      const mode = question.options.length
        ? question.multiSelect
          ? "   (choose any, or answer in your own words)"
          : "   (choose one, or answer in your own words)"
        : "";
      return [`${lead}${head}${question.question}`, ...choices, ...(mode ? [mode] : [])].join("\n");
    })
    .join("\n\n");
}

/** The tool result text the model reads once the user has answered. */
export function formatOutcome(outcome: AskOutcome): string {
  if (outcome.status === "cancelled")
    return "The user dismissed the questions without answering. Do not ask the same thing again; continue with your best judgment or explain what you need.";
  const lines = outcome.answers.map((answer) => {
    const parts = [
      ...answer.selected.map((label) => `"${label}"`),
      ...(answer.text ? [`"${answer.text}" (own words)`] : []),
    ];
    const value = parts.length ? parts.join(", ") : "(no answer)";
    return `- ${answer.question} → ${value}${answer.notes ? ` (note: ${answer.notes})` : ""}`;
  });
  return ["The user answered:", ...lines, ...(outcome.note ? [`Note: ${outcome.note}`] : [])].join(
    "\n",
  );
}

export type AnswerRejectCode = "invalid_payload" | "invalid_answer";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const index = (value: unknown, below: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < below
    ? value
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && tidy(value) ? tidy(value).slice(0, MAX_TEXT) : undefined;

/**
 * Checks an answer sent from outside the terminal. All or nothing: every question
 * answered once, every index in range, a single-select with exactly one option or
 * text. A partial answer would reach the model looking like the user's own.
 */
export function readExternalAnswer(
  questions: readonly AskQuestion[],
  data: Record<string, unknown>,
): AskOutcome | { code: AnswerRejectCode; reason: string } {
  const note = text(data.globalNote);
  if (data.cancel === true) return { status: "cancelled" };
  if (!Array.isArray(data.answers))
    return { code: "invalid_payload", reason: "answers must be an array." };
  const answers: (AskAnswer | undefined)[] = questions.map(() => undefined);
  for (const raw of data.answers) {
    if (!isRecord(raw))
      return { code: "invalid_payload", reason: "Each answer must be an object." };
    const at = index(raw.questionIndex, questions.length);
    if (at === undefined)
      return { code: "invalid_answer", reason: "An answer names a question that does not exist." };
    if (answers[at]) return { code: "invalid_answer", reason: `Question ${at} is answered twice.` };
    const question = questions[at]!;
    const picked = raw.optionIndexes === undefined ? [] : raw.optionIndexes;
    if (!Array.isArray(picked))
      return { code: "invalid_payload", reason: "optionIndexes must be an array." };
    const choices = picked.map((value) => index(value, question.options.length));
    if (choices.some((choice) => choice === undefined))
      return { code: "invalid_answer", reason: "An answer picks an option that does not exist." };
    if (new Set(choices).size !== choices.length)
      return { code: "invalid_answer", reason: "An answer picks the same option twice." };
    const typed = text(raw.text);
    const count = choices.length + (typed ? 1 : 0);
    if (!count) return { code: "invalid_answer", reason: `Question ${at} has no answer.` };
    if (!question.multiSelect && count !== 1)
      return { code: "invalid_answer", reason: `Question ${at} takes exactly one answer.` };
    const notes = text(raw.notes);
    answers[at] = {
      question: question.question,
      selected: (choices as number[]).map((choice) => question.options[choice]!.label),
      ...(typed ? { text: typed } : {}),
      ...(notes ? { notes } : {}),
    };
  }
  if (answers.some((answer) => !answer))
    return { code: "invalid_answer", reason: "Answer every question." };
  return { status: "answered", answers: answers as AskAnswer[], ...(note ? { note } : {}) };
}
