import {
  isArrayOf,
  isBoundedString,
  isCount,
  isFiniteNumber,
  isRecord,
  isString,
  isText,
  isTrue,
  optional,
  uniqueBy,
} from "#src/guards";
import { isActionReference, isLine, type ActionRef, type Line, type Span } from "#src/model";

/**
 * The suffix of an attention view's id, by convention: each producer defines
 * one view, `<extension>.attention`, such as `git.attention`.
 */
export const ATTENTION_VIEW_SUFFIX = ".attention";

/** Most items one attention view holds; `total` counts the rest. */
export const MAX_ATTENTION_ITEMS = 50;
/** Longest item id or revision, in UTF-16 units. */
export const MAX_ATTENTION_ID = 200;
/** Longest category. */
export const MAX_ATTENTION_CATEGORY = 40;
/** Most text in an item's title, all spans together. */
export const MAX_ATTENTION_TITLE = 200;
/** Longest reason. */
export const MAX_ATTENTION_REASON = 500;
/** Longest link URL. */
export const MAX_ATTENTION_URL = 2_000;
/** Longest link label. */
export const MAX_ATTENTION_LABEL = 100;

/** A category: lowercase words joined by hyphens, e.g. `review`, `findings`. */
export const ATTENTION_CATEGORY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A web page about the item. `https:` only, and every consumer checks it again before drawing it. */
export type AttentionLink = { url: string; label: string };

/**
 * One thing a session owes the user: work handed off for review, findings to
 * read. It lives in the session file, so it outlasts the process: only an item
 * marked `live` is removed when the process has gone.
 */
export type AttentionItem = {
  /** Stable within its view and opaque, e.g. `pr:github.com/acme/web#42`. */
  id: string;
  /** What was handed off, such as a head commit; a dismissal names the revision it saw. */
  rev?: string;
  /** What kind of thing it is; a renderer maps it to an icon, and an unknown one to a generic icon. */
  category: string;
  /** e.g. "Review acme/web#42". */
  title: Line;
  /** Why it needs the user, e.g. "Checkout cleanup · draft at a13c90e". */
  reason?: string;
  /** `stale`: still owed, but what was handed off has since changed, such as new commits. */
  state: "ready" | "stale";
  /** When it was raised, epoch milliseconds. */
  since: number;
  /** When the producer last confirmed it, epoch milliseconds. */
  observedAt?: number;
  link?: AttentionLink;
  /** Opens the item in the session. Dispatched with the reference's arguments as given. */
  open?: ActionRef;
  /** Tells the producer the user has dealt with the item. Dispatched with its arguments as given. */
  dismiss?: ActionRef;
  /** Process-bound (see `#src/model`): settled, the item is removed. */
  live?: true;
};

/**
 * What one producer is owed by the user, in the producer's order. A session
 * may have several attention views; `attentionRows` merges them with the
 * session's open questions.
 */
export type AttentionModel = {
  items: readonly AttentionItem[];
  /** The producer's true count, at least `items.length`, so a capped list can say "and 12 more". */
  total: number;
};

/** The characters a line shows, all spans together. */
function lineLength(line: Line): number {
  const spans: readonly Span[] = Array.isArray(line) ? line : [line as Span];
  return spans.reduce((sum, span) => sum + (typeof span === "string" ? span : span.text).length, 0);
}

/** A URL a consumer may open: `https:` and parseable, within the bound. */
export function isAttentionUrl(value: unknown): value is string {
  if (!isString(value) || value.length > MAX_ATTENTION_URL) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const isLink = (value: unknown) =>
  isRecord(value) && isAttentionUrl(value.url) && isText(MAX_ATTENTION_LABEL)(value.label);

const isTitle = (value: unknown) =>
  isLine(value) && lineLength(value) > 0 && lineLength(value) <= MAX_ATTENTION_TITLE;

export function isAttentionItem(value: unknown): value is AttentionItem {
  return (
    isRecord(value) &&
    isText(MAX_ATTENTION_ID)(value.id) &&
    optional(value.rev, isText(MAX_ATTENTION_ID)) &&
    isString(value.category) &&
    value.category.length <= MAX_ATTENTION_CATEGORY &&
    ATTENTION_CATEGORY.test(value.category) &&
    isTitle(value.title) &&
    optional(value.reason, isBoundedString(MAX_ATTENTION_REASON)) &&
    (value.state === "ready" || value.state === "stale") &&
    isFiniteNumber(value.since) &&
    optional(value.observedAt, isFiniteNumber) &&
    optional(value.link, isLink) &&
    optional(value.open, (ref) => isActionReference(ref)) &&
    optional(value.dismiss, (ref) => isActionReference(ref)) &&
    optional(value.live, isTrue)
  );
}

/** An attention model within the bounds above, with no two items sharing an id. */
export function isAttentionModel(value: unknown): value is AttentionModel {
  return (
    isRecord(value) &&
    isArrayOf(isAttentionItem, MAX_ATTENTION_ITEMS)(value.items) &&
    uniqueBy(value.items as AttentionItem[], (item) => item.id) &&
    isCount(value.total) &&
    value.total >= value.items.length
  );
}
