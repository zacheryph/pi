// Live form views as bb pending interactions: each open questionnaire of a
// live session is one form in place of the thread's composer, answered through
// the questionnaire's own `submit` and `cancel` action references.
import { isFormAnswer } from "pi-surface/form";
import type { ActionRequest, FormAnswer, FormQuestionnaire, JsonObject } from "./contract.ts";
import type { LiveSession, SessionConnection } from "./sessions.ts";
import { openQuestionnaires } from "./views.ts";

/** The pendingInteraction renderer the app registers for form questionnaires. */
export const QUESTIONNAIRE_RENDERER = "questionnaire";

export type FormOutcome =
  | { outcome: "submitted"; value: unknown }
  | { outcome: "cancelled"; reason?: string };

export interface QuestionBridgeOptions {
  /** The thread's live session, or undefined while it has none (never a fixture or saved one). */
  live(threadId: string): LiveSession | undefined;
  /** Shows the questionnaire as one form in the thread's composer (bb.ui.requestInput). */
  ask(
    threadId: string,
    questionnaire: FormQuestionnaire,
    signal: AbortSignal,
  ): Promise<FormOutcome>;
  /** Runs an action on the session, only through the connection that raised the form. */
  run(threadId: string, connection: SessionConnection, request: ActionRequest): Promise<unknown>;
  onError(message: string): void;
}

/** Cancellations that mean the user declined; any other (bb stopping, a restart) answers nothing. */
const DECLINED: ReadonlySet<string | undefined> = new Set(["user", "timeout"]);

interface Raised {
  controller: AbortController;
}

/** One thread's forms, all raised for one connection. */
interface ThreadForms {
  connection: SessionConnection;
  raised: Map<string, Raised>;
  /** Questionnaires answered through this connection; never raised again for it. */
  answered: Set<string>;
}

/** A questionnaire's identity: its form view and its own opaque id. */
const keyOf = (view: string, id: string) => JSON.stringify([view, id]);

/**
 * Mirrors a live session's open questionnaires as bb pending interactions:
 * one form per questionnaire while its form view lists it, withdrawn when the
 * view stops listing it, when another connection takes the thread (a new
 * process, /new, /resume) and when the session has no live connection.
 */
export class QuestionBridge {
  private readonly threads = new Map<string, ThreadForms>();

  constructor(private readonly options: QuestionBridgeOptions) {}

  /** Bring the thread's forms in line with its live session. */
  sync(threadId: string): void {
    const live = this.options.live(threadId);
    let forms = this.threads.get(threadId);
    if (forms && forms.connection !== live?.connection) {
      this.withdraw(forms);
      this.threads.delete(threadId);
      forms = undefined;
    }
    if (!live) return;
    const open = openQuestionnaires(live.snapshot);
    forms ??= { connection: live.connection, raised: new Map(), answered: new Set() };
    const current = new Set(open.map(({ view, questionnaire }) => keyOf(view, questionnaire.id)));
    for (const [key, raised] of forms.raised) {
      if (current.has(key)) continue;
      raised.controller.abort();
      forms.raised.delete(key);
    }
    for (const key of forms.answered) if (!current.has(key)) forms.answered.delete(key);
    for (const { view, questionnaire } of open) {
      const key = keyOf(view, questionnaire.id);
      if (forms.raised.has(key) || forms.answered.has(key)) continue;
      const raised = { controller: new AbortController() };
      forms.raised.set(key, raised);
      void this.raise(threadId, forms, key, questionnaire, raised);
    }
    if (forms.raised.size || forms.answered.size) this.threads.set(threadId, forms);
    else this.threads.delete(threadId);
  }

  dispose(): void {
    for (const forms of this.threads.values()) this.withdraw(forms);
    this.threads.clear();
  }

  private withdraw(forms: ThreadForms): void {
    for (const raised of forms.raised.values()) raised.controller.abort();
    forms.raised.clear();
  }

  private async raise(
    threadId: string,
    forms: ThreadForms,
    key: string,
    questionnaire: FormQuestionnaire,
    raised: Raised,
  ): Promise<void> {
    const { signal } = raised.controller;
    let failed = false;
    try {
      const result = await this.options.ask(threadId, questionnaire, signal);
      // Withdrawn because Pi closed it or the session went: nothing to send.
      if (signal.aborted) return;
      const request = requestFor(questionnaire, result);
      if (!request) return;
      await this.options.run(threadId, forms.connection, request);
      forms.answered.add(key);
    } catch (error) {
      if (signal.aborted) return;
      failed = true;
      this.options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (forms.raised.get(key) === raised) forms.raised.delete(key);
    }
    // Pi refused the answer and the questionnaire is still open: ask again.
    if (failed && this.threads.get(threadId) === forms) this.sync(threadId);
  }
}

/** The action a form's outcome runs: its `submit` with the answer, or its `cancel`. */
function requestFor(
  questionnaire: FormQuestionnaire,
  result: FormOutcome,
): ActionRequest | undefined {
  if (result.outcome === "cancelled") {
    if (!DECLINED.has(result.reason)) return undefined;
    const { action, args } = questionnaire.cancel;
    return args ? { action, args } : { action };
  }
  const answer = readAnswer(result.value);
  if (!isFormAnswer(answer)) throw new Error("The form's answer is not a well-formed answer.");
  const { action, args } = questionnaire.submit;
  return { action, args: { ...args, ...answer } as JsonObject };
}

/** The form's value, narrowed to a `FormAnswer`; the questionnaire's owner checks the rest. */
export function readAnswer(value: unknown): FormAnswer {
  const raw = (value ?? {}) as { answers?: unknown; globalNote?: unknown };
  const answers = Array.isArray(raw.answers)
    ? raw.answers.flatMap((item) => {
        const entry = (item ?? {}) as {
          questionIndex?: unknown;
          optionIndexes?: unknown;
          text?: unknown;
          notes?: unknown;
        };
        if (!Number.isSafeInteger(entry.questionIndex)) return [];
        const optionIndexes = Array.isArray(entry.optionIndexes)
          ? entry.optionIndexes.filter((index): index is number => Number.isSafeInteger(index))
          : [];
        const text = typeof entry.text === "string" ? entry.text.trim() : "";
        const notes = typeof entry.notes === "string" ? entry.notes.trim() : "";
        return [
          {
            questionIndex: entry.questionIndex as number,
            ...(optionIndexes.length ? { optionIndexes } : {}),
            ...(text ? { text } : {}),
            ...(notes ? { notes } : {}),
          },
        ];
      })
    : [];
  const globalNote = typeof raw.globalNote === "string" ? raw.globalNote.trim() : "";
  return { answers, ...(globalNote ? { globalNote } : {}) };
}
