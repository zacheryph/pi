import {
  isArrayOf,
  isBoolean,
  isBoundedString,
  isCount,
  isFiniteNumber,
  isRecord,
  isText,
  optional,
  uniqueBy,
} from "#src/guards";
import type { JsonObject } from "#src/json";
import { isActionReference, type ActionRef } from "#src/model";

/**
 * The view id of the session's open questionnaires, by convention. pi-ask
 * provides it while at least one questionnaire waits for the user.
 */
export const FORM_VIEW_ID = "ask.questions";

/** Most questionnaires one form holds at once. */
export const MAX_FORM_QUESTIONNAIRES = 8;
/** Longest questionnaire id, in UTF-16 units. */
export const MAX_QUESTIONNAIRE_ID = 200;
/** Longest questionnaire title. */
export const MAX_FORM_TITLE = 200;
/** Most questions in one questionnaire. */
export const MAX_FORM_QUESTIONS = 8;
/** Most options one question offers. */
export const MAX_FORM_OPTIONS = 20;
/** Longest question text, typed answer, note or option description. */
export const MAX_FORM_TEXT = 4_000;
/** Longest question header. */
export const MAX_FORM_HEADER = 60;
/** Longest option label. */
export const MAX_FORM_LABEL = 200;

export type FormOption = { label: string; description?: string };

/**
 * One question. Every question also takes an answer typed in the user's own
 * words and a note; a question without options takes only typed text.
 */
export type FormQuestion = {
  question: string;
  /** A short tag shown beside the question, e.g. "Auth method". */
  header?: string;
  options: readonly FormOption[];
  /** Several options may be chosen. Default false: exactly one option or typed text. */
  multiSelect?: boolean;
};

/**
 * One open questionnaire. Several may be open at once, each answered on its
 * own; `id` tells them apart and is opaque: a consumer never parses it, and it
 * need not have a view id's shape (pi-ask uses the asking tool call's id).
 */
export type FormQuestionnaire = {
  id: string;
  title?: string;
  /** When it opened, epoch milliseconds. */
  openedAt?: number;
  questions: readonly FormQuestion[];
  /** Dispatched with the reference's arguments plus a `FormAnswer`'s fields. */
  submit: ActionRef<JsonObject>;
  /** Dispatched with the reference's arguments, to decline the whole questionnaire. */
  cancel: ActionRef<JsonObject>;
};

/**
 * The session's open questionnaires, oldest first. A form is process-bound
 * as a whole (see `#src/model`): nobody can answer it once its process has
 * gone, so a settled snapshot holds no form.
 */
export type FormModel = { questionnaires: readonly FormQuestionnaire[] };

/** One question's answer: chosen options by index, typed text, or both for a multi-select. */
export type FormQuestionAnswer = {
  questionIndex: number;
  optionIndexes?: readonly number[];
  text?: string;
  notes?: string;
};

/**
 * What a consumer adds to `submit`'s arguments. The owner validates it against
 * the questionnaire again, strictly and all or nothing.
 */
export type FormAnswer = {
  answers: readonly FormQuestionAnswer[];
  /** A note on the questionnaire as a whole. */
  globalNote?: string;
};

const isObjectAction = (value: unknown) => isActionReference(value, true);

const isOption = (value: unknown) =>
  isRecord(value) &&
  isText(MAX_FORM_LABEL)(value.label) &&
  optional(value.description, isBoundedString(MAX_FORM_TEXT));

const isQuestion = (value: unknown) =>
  isRecord(value) &&
  isText(MAX_FORM_TEXT)(value.question) &&
  optional(value.header, isBoundedString(MAX_FORM_HEADER)) &&
  isArrayOf(isOption, MAX_FORM_OPTIONS)(value.options) &&
  optional(value.multiSelect, isBoolean);

export function isFormQuestionnaire(value: unknown): value is FormQuestionnaire {
  return (
    isRecord(value) &&
    isText(MAX_QUESTIONNAIRE_ID)(value.id) &&
    optional(value.title, isBoundedString(MAX_FORM_TITLE)) &&
    optional(value.openedAt, isFiniteNumber) &&
    isArrayOf(isQuestion, MAX_FORM_QUESTIONS)(value.questions) &&
    value.questions.length > 0 &&
    isObjectAction(value.submit) &&
    isObjectAction(value.cancel)
  );
}

/** A form within the bounds above, with no two questionnaires sharing an id. */
export function isFormModel(value: unknown): value is FormModel {
  return (
    isRecord(value) &&
    isArrayOf(isFormQuestionnaire, MAX_FORM_QUESTIONNAIRES)(value.questionnaires) &&
    uniqueBy(value.questionnaires as FormQuestionnaire[], (questionnaire) => questionnaire.id)
  );
}

const isQuestionAnswer = (value: unknown) =>
  isRecord(value) &&
  isCount(value.questionIndex) &&
  (value.questionIndex as number) < MAX_FORM_QUESTIONS &&
  optional(value.optionIndexes, isArrayOf(isCount, MAX_FORM_OPTIONS)) &&
  optional(value.text, isBoundedString(MAX_FORM_TEXT)) &&
  optional(value.notes, isBoundedString(MAX_FORM_TEXT));

/** The shape and bounds of an answer; whether it fits its questionnaire is the owner's check. */
export function isFormAnswer(value: unknown): value is FormAnswer {
  return (
    isRecord(value) &&
    isArrayOf(isQuestionAnswer, MAX_FORM_QUESTIONS)(value.answers) &&
    optional(value.globalNote, isBoundedString(MAX_FORM_TEXT))
  );
}
