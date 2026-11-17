import type { AskQuestion } from "#src/questions";

/**
 * pi-ask's contract on the session's `pi.events` bus. Payloads are JSON-safe and
 * listeners must tolerate fields they do not know. Every payload names its
 * questionnaire by the asking tool call's id.
 */

/** A questionnaire is waiting for the user. Emitted before it is shown. */
export const ASK_OPENED = "ask:opened";
/** A questionnaire stopped waiting: answered, cancelled, or failed. */
export const ASK_CLOSED = "ask:closed";
/** Request: answer or cancel an open questionnaire from outside the terminal. */
export const ASK_ANSWER = "ask:answer";
/** The one reply to each `ask:answer` request. */
export const ASK_ANSWER_RESULT = "ask:answer-result";
/**
 * Action on the session's bus (see pi-surface): `ask:answer` as an action. It
 * takes the same payload and resolves to the `AskAnswerResult` that request
 * would reply with, refusals included.
 */
export const ASK_ANSWER_ACTION = "ask.answer";
/**
 * Action: answer one questionnaire of the `ask.questions` form. Takes `{ id }` (the form's
 * questionnaire id, the asking tool call's) plus a pi-surface `FormAnswer`'s fields; resolves to
 * `{ id, status: "answered" }` and rejects with the reason when the answer is refused.
 */
export const ASK_SUBMIT_ACTION = "ask.submit";
/** Action: decline one questionnaire of the form. Takes `{ id }`; rejects when it is not open. */
export const ASK_CANCEL_ACTION = "ask.cancel";

export interface AskOpenedEvent {
  toolCallId: string;
  questions: {
    question: string;
    header: string;
    multiSelect: boolean;
    options: { label: string; description: string }[];
  }[];
}

export interface AskClosedEvent {
  toolCallId: string;
  outcome: "answered" | "cancelled" | "error";
}

/**
 * Inbound answer. `answers` has one entry per question: `optionIndexes` into the
 * question's options and/or `text`. Single-select questions take exactly one.
 */
export interface AskAnswerRequest {
  toolCallId: string;
  /** Echoed on the reply so a sender can pair them. */
  requestId?: string;
  answers?: { questionIndex: number; optionIndexes?: number[]; text?: string; notes?: string }[];
  globalNote?: string;
  cancel?: boolean;
}

export interface AskAnswerResult {
  ok: boolean;
  /**
   * Set when ok is false; branch on this, not on reason. `closed`: the questionnaire was already
   * answered or cancelled, a stale or duplicate answer. `not_found`: no questionnaire with that id
   * is open for answers from outside the terminal.
   */
  code?: "not_found" | "closed" | "invalid_payload" | "invalid_answer";
  reason?: string;
  requestId?: string;
  toolCallId?: string;
}

export function openedEvent(toolCallId: string, questions: readonly AskQuestion[]): AskOpenedEvent {
  return {
    toolCallId,
    questions: questions.map((question) => ({
      question: question.question,
      header: question.header,
      multiSelect: question.multiSelect,
      options: question.options.map((option) => ({ ...option })),
    })),
  };
}
