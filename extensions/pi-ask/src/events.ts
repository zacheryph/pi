/**
 * pi-ask's contract on the session's `pi.events` bus: the `ask.questions` form view (see
 * pi-surface) and the two actions its entries carry. Every questionnaire is named by the asking
 * tool call's id.
 */

/**
 * Action: answer one questionnaire of the `ask.questions` form. Takes `{ id }` (the form's
 * questionnaire id, the asking tool call's) plus a pi-surface `FormAnswer`'s fields; resolves to
 * `{ id, status: "answered" }` and rejects with the reason when the answer is refused.
 */
export const ASK_SUBMIT_ACTION = "ask.submit";
/** Action: decline one questionnaire of the form. Takes `{ id }`; rejects when it is not open. */
export const ASK_CANCEL_ACTION = "ask.cancel";

/** The verdict on an answer or cancellation from outside the terminal. */
export interface AskAnswerResult {
  ok: boolean;
  /**
   * Set when ok is false; branch on this, not on reason. `closed`: the questionnaire was already
   * answered or cancelled, a stale or duplicate answer. `not_found`: no questionnaire with that id
   * is open for answers from outside the terminal.
   */
  code?: "not_found" | "closed" | "invalid_payload" | "invalid_answer";
  reason?: string;
  toolCallId?: string;
}
