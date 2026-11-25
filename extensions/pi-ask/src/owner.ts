import { isRecord } from "#foundations/guards";
import {
  isFormQuestionnaire,
  MAX_FORM_QUESTIONNAIRES,
  MAX_VIEW_BYTES,
  utf8Bytes,
  type FormModel,
  type FormQuestionnaire,
} from "#surface";
import { ASK_CANCEL_ACTION, ASK_SUBMIT_ACTION, type AskAnswerResult } from "#src/events";
import {
  readExternalAnswer,
  type AskOutcome,
  type AskQuestion,
  type CancelReason,
} from "#src/questions";

/** How many settled ids are remembered, so a late answer is told it is stale rather than unknown. */
const REMEMBERED_IDS = 64;

/**
 * One questionnaire waiting for the user. Every display of it (the terminal window, a form
 * consumer, Pi's own dialogs) settles it through `settle`, and only the first outcome counts.
 */
export interface PendingQuestionnaire {
  /** The asking tool call's id; the form's opaque questionnaire id. */
  readonly id: string;
  readonly questions: readonly AskQuestion[];
  /** When it opened, epoch milliseconds. */
  readonly openedAt: number;
  /** Listed in the form view, where consumers outside the terminal can answer it. */
  readonly published: boolean;
  /** The winning outcome, once there is one. */
  readonly outcome: AskOutcome | undefined;
  /** Resolves with the winning outcome. */
  readonly done: Promise<AskOutcome>;
  /** Aborted when it settles: whatever still shows it closes. */
  readonly signal: AbortSignal;
  /** The one completion path. Returns whether this outcome won; a later one changes nothing. */
  settle(outcome: AskOutcome): boolean;
  /** Takes it out of the form, for good: only the display that still shows it can answer now. */
  withdraw(): void;
}

/** A request `ask` refuses before showing anything, with what the model is told. */
export class QuestionnaireRefused extends Error {}

/** The form entry consumers outside the terminal draw and answer. */
export function formQuestionnaire(
  id: string,
  questions: readonly AskQuestion[],
  openedAt: number,
): FormQuestionnaire {
  return {
    id,
    openedAt,
    questions: questions.map((question) => ({
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    })),
    submit: { action: ASK_SUBMIT_ACTION, args: { id } },
    cancel: { action: ASK_CANCEL_ACTION, args: { id } },
  };
}

interface Entry extends PendingQuestionnaire {
  form: FormQuestionnaire;
}

/**
 * The session's open questionnaires: the single owner of their pending state. It builds the
 * `ask.questions` form from the published ones and checks every outside answer against the
 * questionnaire it names. One per session, in the extension's closure.
 */
export class OpenQuestionnaires {
  private readonly entries = new Map<string, Entry>();
  private readonly settled: string[] = [];
  private readonly changed: () => void;
  private readonly now: () => number;

  constructor(options: { changed: () => void; now?: () => number }) {
    this.changed = options.changed;
    this.now = options.now ?? Date.now;
  }

  /**
   * Opens a questionnaire and lists it in the form at once. Throws `QuestionnaireRefused` for
   * one the form cannot carry: one too many open at once, or text beyond the form's bounds.
   * Nothing is pending after a refusal.
   */
  open(id: string, questions: readonly AskQuestion[]): PendingQuestionnaire {
    if (this.entries.has(id))
      throw new QuestionnaireRefused(`A questionnaire "${id}" is already open.`);
    const openedAt = this.now();
    const form = formQuestionnaire(id, questions, openedAt);
    this.check(form);
    const at = this.settled.indexOf(id);
    if (at >= 0) this.settled.splice(at, 1);
    const controller = new AbortController();
    let resolve!: (outcome: AskOutcome) => void;
    const done = new Promise<AskOutcome>((settle) => (resolve = settle));
    let outcome: AskOutcome | undefined;
    let published = true;
    const entry: Entry = {
      id,
      questions,
      openedAt,
      form,
      done,
      signal: controller.signal,
      get published() {
        return published;
      },
      get outcome() {
        return outcome;
      },
      settle: (next) => {
        if (outcome) return false;
        outcome = next;
        this.entries.delete(id);
        this.remember(id);
        if (published) {
          published = false;
          this.changed();
        }
        resolve(next);
        controller.abort();
        return true;
      },
      withdraw: () => {
        if (!published) return;
        published = false;
        this.changed();
      },
    };
    this.entries.set(id, entry);
    this.changed();
    return entry;
  }

  /** The form of every published questionnaire, oldest first; undefined while none is. */
  form(): FormModel | undefined {
    const questionnaires = this.published().map((entry) => entry.form);
    return questionnaires.length ? { questionnaires } : undefined;
  }

  /**
   * Answers or cancels a published questionnaire from outside the terminal, all or nothing:
   * `{ toolCallId, answers?, globalNote?, cancel? }`. Returns the verdict, refusals included.
   */
  answer(data: unknown): AskAnswerResult {
    if (!isRecord(data) || typeof data.toolCallId !== "string")
      return { ok: false, code: "invalid_payload", reason: "toolCallId is required." };
    const echo = { toolCallId: data.toolCallId };
    const entry = this.entries.get(data.toolCallId);
    if (!entry)
      return this.settled.includes(data.toolCallId)
        ? {
            ok: false,
            code: "closed",
            reason: "That questionnaire was already answered or cancelled.",
            ...echo,
          }
        : { ok: false, code: "not_found", reason: "No open questionnaire has that id.", ...echo };
    if (!entry.published)
      return {
        ok: false,
        code: "not_found",
        reason: "That questionnaire is not open for answers here; Pi's own dialog is asking it.",
        ...echo,
      };
    const outcome = readExternalAnswer(entry.questions, data);
    if ("code" in outcome)
      return { ok: false, code: outcome.code, reason: outcome.reason, ...echo };
    entry.settle(outcome);
    return { ok: true, ...echo };
  }

  /** Settles every open questionnaire, published or not, as cancelled for `reason`. */
  cancelAll(reason: CancelReason): void {
    // Each settle deletes its own entry; deleting the current entry is safe while iterating a Map.
    for (const entry of this.entries.values()) entry.settle({ status: "cancelled", reason });
  }

  get size(): number {
    return this.entries.size;
  }

  private published(): Entry[] {
    return [...this.entries.values()].filter((entry) => entry.published);
  }

  /** Refuses a questionnaire the form could not carry whole beside the ones already in it. */
  private check(form: FormQuestionnaire): void {
    const listed = this.published().map((entry) => entry.form);
    if (listed.length >= MAX_FORM_QUESTIONNAIRES)
      throw new QuestionnaireRefused(
        `${MAX_FORM_QUESTIONNAIRES} questionnaires are already waiting for the user, the most that can be open at once. Wait for those answers, or continue with your best judgment and say what you assumed.`,
      );
    if (!isFormQuestionnaire(form))
      throw new QuestionnaireRefused(
        "These questions are too long to show. Ask shorter questions with fewer, shorter options.",
      );
    if (utf8Bytes(JSON.stringify({ questionnaires: [...listed, form] })) > MAX_VIEW_BYTES)
      throw new QuestionnaireRefused(
        "The open questionnaires would be too large to show together. Ask shorter questions, or wait for the open ones to be answered.",
      );
  }

  private remember(id: string): void {
    this.settled.push(id);
    if (this.settled.length > REMEMBERED_IDS) this.settled.shift();
  }
}
