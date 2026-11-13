import type { Questionnaire, QuestionnaireAnswer, SessionSnapshot } from "./contract.ts";

/** The pendingInteraction renderer the app registers for pi-ask questionnaires. */
export const QUESTIONNAIRE_RENDERER = "questionnaire";

export type FormOutcome =
  | { outcome: "submitted"; value: unknown }
  | { outcome: "cancelled"; reason?: string };

export interface QuestionBridgeOptions {
  /** Shows the questionnaire as one form in the thread's composer (bb.ui.requestInput). */
  ask(threadId: string, questionnaire: Questionnaire, signal: AbortSignal): Promise<FormOutcome>;
  /** Sends the answer to the session's pi-ask. */
  answer(threadId: string, question: string, answer: QuestionnaireAnswer): Promise<unknown>;
  onError(message: string): void;
}

/**
 * Mirrors a live session's open questionnaires as bb pending interactions:
 * one form per questionnaire while it is open in Pi, withdrawn when Pi closes it.
 */
export class QuestionBridge {
  private readonly open = new Map<string, Map<string, AbortController>>();

  constructor(private readonly options: QuestionBridgeOptions) {}

  /** Call with the thread's live snapshot, or undefined when it has none. */
  sync(threadId: string, snapshot: SessionSnapshot | undefined): void {
    const questions = snapshot?.questions ?? [];
    const raised = this.open.get(threadId) ?? new Map<string, AbortController>();
    const current = new Set(questions.map((questionnaire) => questionnaire.id));
    for (const [id, controller] of raised) {
      if (current.has(id)) continue;
      controller.abort();
      raised.delete(id);
    }
    for (const questionnaire of questions) {
      if (raised.has(questionnaire.id)) continue;
      const controller = new AbortController();
      raised.set(questionnaire.id, controller);
      void this.raise(threadId, questionnaire, controller, raised);
    }
    if (raised.size) this.open.set(threadId, raised);
    else this.open.delete(threadId);
  }

  dispose(): void {
    for (const raised of this.open.values())
      for (const controller of raised.values()) controller.abort();
    this.open.clear();
  }

  private async raise(
    threadId: string,
    questionnaire: Questionnaire,
    controller: AbortController,
    raised: Map<string, AbortController>,
  ): Promise<void> {
    try {
      const result = await this.options.ask(threadId, questionnaire, controller.signal);
      // Withdrawn because Pi closed it: nothing to send.
      if (controller.signal.aborted) return;
      const answer: QuestionnaireAnswer =
        result.outcome === "submitted" ? readAnswer(result.value) : { cancel: true };
      await this.options.answer(threadId, questionnaire.id, answer);
    } catch (error) {
      if (!controller.signal.aborted)
        this.options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (raised.get(questionnaire.id) === controller) raised.delete(questionnaire.id);
    }
  }
}

/** The form's value, narrowed to what pi-ask's `ask:answer` takes; pi-ask checks the rest. */
export function readAnswer(value: unknown): QuestionnaireAnswer {
  const raw = (value ?? {}) as { answers?: unknown; globalNote?: unknown; cancel?: unknown };
  if (raw.cancel === true) return { cancel: true };
  const answers = Array.isArray(raw.answers)
    ? raw.answers.flatMap((item) => {
        const entry = item as {
          questionIndex?: unknown;
          optionIndexes?: unknown;
          text?: unknown;
        };
        if (!Number.isSafeInteger(entry.questionIndex)) return [];
        const optionIndexes = Array.isArray(entry.optionIndexes)
          ? entry.optionIndexes.filter((index): index is number => Number.isSafeInteger(index))
          : [];
        const text = typeof entry.text === "string" ? entry.text.trim() : "";
        return [
          {
            questionIndex: entry.questionIndex as number,
            ...(optionIndexes.length ? { optionIndexes } : {}),
            ...(text ? { text } : {}),
          },
        ];
      })
    : [];
  const globalNote = typeof raw.globalNote === "string" ? raw.globalNote.trim() : "";
  return { answers, ...(globalNote ? { globalNote } : {}) };
}
