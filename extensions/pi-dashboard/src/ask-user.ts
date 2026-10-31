import type { Questionnaire, QuestionnaireAnswer } from "./protocol.ts";
import { clip } from "./sections.ts";

// @juicesharp/rpiv-ask-user-question's public event contract (events.ts):
// channel names are immutable and payloads append-only.
export const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";
export const ASK_USER_ANSWER_EVENT = "rpiv:ask-user:answer";
export const ASK_USER_ANSWER_RESULT_EVENT = "rpiv:ask-user:answer-result";

const MAX_QUESTIONNAIRES = 8;
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 20;
const MAX_TEXT = 4_000;
const VERDICT_TIMEOUT_MS = 2_000;

export interface Bus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const index = (value: unknown, below: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < below
    ? value
    : undefined;

/** Parses a prompt payload; undefined when it is not one. */
export function readPrompt(data: unknown, now: number): Questionnaire | undefined {
  if (
    !isRecord(data) ||
    typeof data.toolCallId !== "string" ||
    !data.toolCallId ||
    !Array.isArray(data.questions)
  )
    return undefined;
  const questions: Questionnaire["questions"] = [];
  for (const raw of data.questions.slice(0, MAX_QUESTIONS)) {
    if (!isRecord(raw)) return undefined;
    const question = clip(raw.question, MAX_TEXT);
    if (!question) return undefined;
    const options = (Array.isArray(raw.options) ? raw.options : [])
      .slice(0, MAX_OPTIONS)
      .flatMap((option) =>
        isRecord(option) && clip(option.label, 200)
          ? [
              {
                label: clip(option.label, 200)!,
                description: clip(option.description, 1_000) ?? "",
              },
            ]
          : [],
      );
    questions.push({
      question,
      header: clip(raw.header, 60) ?? "",
      multiSelect: raw.multiSelect === true,
      options,
    });
  }
  // A questionnaire the page cannot show whole cannot be answered whole.
  if (!questions.length || questions.length !== data.questions.length) return undefined;
  return { id: data.toolCallId.slice(0, 200), since: now, questions };
}

/**
 * Normalizes an answer from the page against the questionnaire it names.
 * rpiv validates again, strictly and all-or-nothing; this only keeps the
 * payload to the documented fields and catches mistakes before they leave.
 */
export function readAnswer(
  data: unknown,
  questionnaire: Questionnaire,
): QuestionnaireAnswer | string {
  if (!isRecord(data)) return "The answer must be an object.";
  const globalNote = clip(data.globalNote, MAX_TEXT);
  if (data.cancel === true) return { cancel: true, ...(globalNote ? { globalNote } : {}) };
  if (!Array.isArray(data.answers)) return "Answer every question.";
  const answers: NonNullable<QuestionnaireAnswer["answers"]> = [];
  for (const raw of data.answers) {
    if (!isRecord(raw)) return "Each answer must be an object.";
    const questionIndex = index(raw.questionIndex, questionnaire.questions.length);
    if (questionIndex === undefined) return "An answer names a question that does not exist.";
    const options = questionnaire.questions[questionIndex]!.options.length;
    const picked = Array.isArray(raw.optionIndexes)
      ? raw.optionIndexes.map((value) => index(value, options))
      : [];
    if (picked.some((value) => value === undefined))
      return "An answer picks an option that does not exist.";
    const text = clip(raw.text, MAX_TEXT);
    const notes = clip(raw.notes, MAX_TEXT);
    answers.push({
      questionIndex,
      ...(picked.length ? { optionIndexes: picked as number[] } : {}),
      ...(text ? { text } : {}),
      ...(notes ? { notes } : {}),
    });
  }
  return { answers, ...(globalNote ? { globalNote } : {}) };
}

/**
 * Follows rpiv ask-user questionnaires on the session's bus and answers them
 * through the package's own inbound channel. The first answer wins, whether
 * typed in the terminal or sent from the dashboard.
 */
export class AskUserTracker {
  private readonly open = new Map<string, Questionnaire>();
  private readonly verdicts = new Map<string, (verdict: Record<string, unknown>) => void>();
  private readonly bus: Bus;
  private readonly onChange: () => void;
  private readonly now: () => number;
  private requests = 0;

  constructor(bus: Bus, onChange: () => void, now: () => number = Date.now) {
    this.bus = bus;
    this.onChange = onChange;
    this.now = now;
    bus.on(ASK_USER_PROMPT_EVENT, (data) => {
      const questionnaire = readPrompt(data, this.now());
      if (!questionnaire) return;
      this.open.delete(questionnaire.id);
      this.open.set(questionnaire.id, questionnaire);
      // A runaway caller cannot grow this without bound; the oldest goes first.
      while (this.open.size > MAX_QUESTIONNAIRES) this.open.delete(this.open.keys().next().value!);
      this.onChange();
    });
    bus.on(ASK_USER_BLOCKED_EVENT, (data) => {
      if (isRecord(data) && data.active === false && typeof data.toolCallId === "string")
        this.close(data.toolCallId);
    });
    bus.on(ASK_USER_ANSWER_RESULT_EVENT, (data) => {
      if (isRecord(data) && typeof data.requestId === "string")
        this.verdicts.get(data.requestId)?.(data);
    });
  }

  list(): Questionnaire[] | undefined {
    return this.open.size
      ? [...this.open.values()].map((questionnaire) => structuredClone(questionnaire))
      : undefined;
  }

  /** The asking tool call finished; its questionnaire is over however it ended. */
  close(id: string): void {
    if (this.open.delete(id)) this.onChange();
  }

  clear(): void {
    this.open.clear();
  }

  /** Sends an answer and resolves once rpiv accepts it; rejects with its reason otherwise. */
  async answer(id: string, data: unknown): Promise<void> {
    const questionnaire = this.open.get(id);
    if (!questionnaire)
      throw new Error(
        "That question is no longer open; it may have been answered in the terminal.",
      );
    const answer = readAnswer(data, questionnaire);
    if (typeof answer === "string") throw new Error(answer);
    const requestId = `pi-dashboard-${++this.requests}`;
    const verdict = new Promise<Record<string, unknown> | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), VERDICT_TIMEOUT_MS);
      this.verdicts.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    try {
      this.bus.emit(ASK_USER_ANSWER_EVENT, { toolCallId: id, requestId, ...answer });
      const result = await verdict;
      if (!result)
        throw new Error(
          "rpiv ask-user did not answer; is @juicesharp/rpiv-ask-user-question 2.15 or newer loaded?",
        );
      if (result.ok !== true) {
        if (result.code === "not_found") this.close(id);
        throw new Error(
          typeof result.reason === "string" && result.reason
            ? `Not accepted: ${result.reason.slice(0, 300)}`
            : "rpiv ask-user refused the answer.",
        );
      }
      this.close(id);
    } finally {
      this.verdicts.delete(requestId);
    }
  }
}
