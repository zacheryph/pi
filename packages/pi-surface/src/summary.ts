import {
  isAmount,
  isArrayOf,
  isRecord,
  isString,
  isText,
  isTrue,
  optional,
  uniqueBy,
} from "#src/guards";
import { isTone, type Tone } from "#src/model";

/** A count's key: lowercase words joined by hyphens, e.g. `running`, `in-progress`. */
export const SUMMARY_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * One number a producer reports about its own state, such as the tasks in a
 * plan or the subagents running now. It is the producer's total, never a count
 * of the rows some display happens to show, so it stays right when a widget is
 * hidden or a list is capped.
 */
export type SummaryCount = {
  /** Stable, machine-readable name; consumers select counts by it. Unique in its summary. */
  key: string;
  /** Display text for the count, e.g. "running". Never parsed. */
  label: string;
  /** A finite number of zero or more. */
  value: number;
  tone?: Tone;
  /**
   * Process-bound (see `#src/model`): the count measures something that exists
   * only while the process runs, such as running agents. Settled, it reads 0.
   */
  live?: true;
};

/** An item the producer is working on now, by its own identity. */
export type SummaryItem = {
  /** The producer's id for the item, e.g. a task key. Opaque. */
  id: string;
  /** Display text, e.g. the task's subject. */
  label: string;
  /**
   * Process-bound (see `#src/model`): settled, the summary has no active item.
   * A task that is `in_progress` in the session file is not process-bound.
   */
  live?: true;
};

/**
 * Identity a producer owns and other consumers show, such as the main agent's
 * profile from pi-subagent. Present whenever it applies, even with no counts.
 */
export type SummaryProfile = {
  /** Machine-readable name, e.g. the profile's name. */
  name: string;
  /** Display text when it differs from `name`. */
  label?: string;
  description?: string;
};

/**
 * Structured facts about an extension's state for badges, headers and session
 * lists. Always available while the extension is loaded: an empty summary (no
 * counts) says the extension has nothing yet, where an absent view says it is
 * not loaded.
 */
export type SummaryModel = {
  /** In the producer's order. */
  counts: readonly SummaryCount[];
  active?: SummaryItem;
  profile?: SummaryProfile;
};

const isCount = (value: unknown) =>
  isRecord(value) &&
  isString(value.key) &&
  SUMMARY_KEY.test(value.key) &&
  isString(value.label) &&
  isAmount(value.value) &&
  optional(value.tone, isTone) &&
  optional(value.live, isTrue);

const isItem = (value: unknown) =>
  isRecord(value) && isText()(value.id) && isString(value.label) && optional(value.live, isTrue);

const isProfile = (value: unknown) =>
  isRecord(value) &&
  isText()(value.name) &&
  optional(value.label, isString) &&
  optional(value.description, isString);

export function isSummaryModel(value: unknown): value is SummaryModel {
  return (
    isRecord(value) &&
    isArrayOf(isCount)(value.counts) &&
    uniqueBy(value.counts as SummaryCount[], (count) => count.key) &&
    optional(value.active, isItem) &&
    optional(value.profile, isProfile)
  );
}

/** The value of the count with `key`, or `undefined` when the summary has none. */
export function summaryCount(model: SummaryModel, key: string): number | undefined {
  return model.counts.find((count) => count.key === key)?.value;
}
