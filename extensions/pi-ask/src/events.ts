import type { AskQuestion } from "./questions.ts";

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
  /** Set when ok is false; branch on this, not on reason. */
  code?: "not_found" | "invalid_payload" | "invalid_answer";
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
