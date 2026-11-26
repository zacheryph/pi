/**
 * attention.ts — pull requests handed to the user for review, and what has
 * become of them since.
 *
 * Intent is recorded as `git:attention` entries: a request (this PR, at this
 * head, needs your review) and a dismissal (the user has dealt with it). What
 * happened to the PR comes from the `git:ledger` PR records the session
 * already writes. `reduceReviews` folds both, in session order, into at most
 * one row per PR; the session replays it on start and `/tree` and feeds it
 * each entry as it is written, so both paths reach the same rows.
 *
 * A fact counts only when it was observed after the request: each status
 * field carries its own time, so a subagent's older report adopted later
 * cannot change a row early.
 */

import {
  ATTENTION_VIEW_SUFFIX,
  isAttentionUrl,
  MAX_ATTENTION_ID,
  MAX_ATTENTION_ITEMS,
  MAX_ATTENTION_REASON,
  type AttentionItem,
  type AttentionModel,
} from "#surface";
import { customEntries, type EntriesSource } from "#session-state";
import { LEDGER_TYPE } from "#src/ledger";
import {
  isPrRecord,
  prKey,
  prLabel,
  prUrl,
  type PrField,
  type PrRecord,
  type PrRef,
} from "#src/prs";

export const ATTENTION_TYPE = "git:attention";
export const ATTENTION_VERSION = 1;
/** The pi-surface view of the PRs handed to the user: one review item per PR. */
export const GIT_ATTENTION_VIEW = `git${ATTENTION_VIEW_SUFFIX}`;
/** Dismisses one item at the revision the user saw: `{ id, rev }` from the item. */
export const GIT_ATTENTION_DISMISS = "git.attention.dismiss";

/** This PR, at this head, was handed to the user for review. Written by the main session only. */
export interface ReviewRequest extends PrRef {
  v: typeof ATTENTION_VERSION;
  kind: "request";
  /** `prKey` of the PR. */
  key: string;
  /** The full head SHA the request was checked against. */
  head: string;
  /** The PR was a draft when it was requested: marking it ready for review resolves it. */
  draft?: boolean;
  /** Why it needs the user, in a few words. */
  reason?: string;
  at: number;
}

/** The user dealt with the request for this head. */
export interface ReviewDismissal {
  v: typeof ATTENTION_VERSION;
  kind: "dismissal";
  key: string;
  head: string;
  at: number;
}

export type AttentionEntry = ReviewRequest | ReviewDismissal;

export interface ReviewRow {
  request: ReviewRequest;
  /** `stale`: a different head was observed after the request; it stays so until requested again. */
  state: "ready" | "stale";
}

/** Open requests by PR key, in the order they were (last) requested. */
export type ReviewRows = ReadonlyMap<string, ReviewRow>;

/** What the reducer is fed: an attention entry, or a PR record the ledger holds. */
export type ReviewEvent = AttentionEntry | PrRecord;

/** A head SHA is evidence of a new head only in full: an abbreviated one could match either. */
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** Longest reason a request keeps. */
export const MAX_REQUEST_REASON = 200;

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** A PR identity whose URL is `https://host/owner/repo/pull/number` and nothing else. */
export function isPrIdentity(ref: Partial<PrRef>): ref is PrRef {
  return (
    typeof ref.host === "string" &&
    ref.host.length <= 253 &&
    HOST.test(ref.host) &&
    typeof ref.owner === "string" &&
    NAME.test(ref.owner) &&
    typeof ref.repo === "string" &&
    NAME.test(ref.repo) &&
    ref.repo !== "." &&
    ref.repo !== ".." &&
    typeof ref.number === "number" &&
    Number.isSafeInteger(ref.number) &&
    ref.number > 0
  );
}

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const itemId = (key: string) => `pr:${key}`;

/** Shape check for an entry read back from the session file. */
export function isAttentionEntry(value: unknown): value is AttentionEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry.v !== ATTENTION_VERSION || !isTime(entry.at)) return false;
  if (typeof entry.head !== "string" || !FULL_SHA.test(entry.head)) return false;
  if (typeof entry.key !== "string" || itemId(entry.key).length > MAX_ATTENTION_ID) return false;
  if (entry.kind === "dismissal") return true;
  if (entry.kind !== "request") return false;
  const ref = entry as Partial<PrRef>;
  return (
    isPrIdentity(ref) &&
    entry.key === prKey(ref) &&
    (entry.draft === undefined || typeof entry.draft === "boolean") &&
    (entry.reason === undefined ||
      (typeof entry.reason === "string" && entry.reason.length <= MAX_REQUEST_REASON))
  );
}

/** When a status field was seen, if the record holds it. */
function seenAt(record: PrRecord, field: PrField): number | undefined {
  const status = record.status;
  if (status?.[field] === undefined) return undefined;
  return status.fieldAt?.[field] ?? status.observedAt;
}

/** The record's value for `field`, only when it was observed after `since`. */
function after<F extends PrField>(record: PrRecord, field: F, since: number) {
  const at = seenAt(record, field);
  return at !== undefined && at > since ? record.status?.[field] : undefined;
}

/** What one PR record does to its open request, if any. */
function applyFacts(row: ReviewRow, record: PrRecord): ReviewRow | undefined {
  const since = row.request.at;
  const state = after(record, "state", since);
  if (state === "merged" || state === "closed") return undefined;
  let next = row;
  const head = after(record, "headSha", since);
  if (next.state === "ready" && head && FULL_SHA.test(head) && !sameSha(head, row.request.head))
    next = { ...row, state: "stale" };
  if (next.state === "ready") {
    if (row.request.draft && after(record, "draft", since) === false) return undefined;
    if (after(record, "review", since) === "approved") return undefined;
  }
  return next;
}

const sameSha = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * One step: the rows after `event`. Returns `rows` itself when nothing
 * changed, so a caller can skip announcing.
 *
 * - A request opens a row, or replaces a stale or older one. Repeating a ready
 *   request for the same head changes nothing.
 * - A dismissal closes the row it names, at the head it names.
 * - A PR record closes the row on a merge or close, marks it stale on a new
 *   full head SHA, and closes a ready row when the PR is approved or (if it
 *   was requested as a draft) marked ready for review. Each only when observed
 *   after the request.
 */
export function reduceReviews(rows: ReviewRows, event: ReviewEvent): ReviewRows {
  if (event.kind === "pr") {
    const row = rows.get(event.key);
    if (!row) return rows;
    const next = applyFacts(row, event);
    if (next === row) return rows;
    const copy = new Map(rows);
    if (next) copy.set(event.key, next);
    else copy.delete(event.key);
    return copy;
  }
  const row = rows.get(event.key);
  if (event.kind === "dismissal") {
    if (!row || !sameSha(row.request.head, event.head)) return rows;
    const copy = new Map(rows);
    copy.delete(event.key);
    return copy;
  }
  if (row?.state === "ready" && sameSha(row.request.head, event.head)) return rows;
  const copy = new Map(rows);
  copy.delete(event.key);
  copy.set(event.key, { request: event, state: "ready" });
  return copy;
}

/** Fold a session's entries, `git:ledger` and `git:attention` interleaved in session order. */
export function foldReviews(entries: Iterable<unknown>): ReviewRows {
  let rows: ReviewRows = new Map();
  for (const { customType, data } of customEntries(entries, [LEDGER_TYPE, ATTENTION_TYPE])) {
    if (customType === ATTENTION_TYPE) {
      if (isAttentionEntry(data)) rows = reduceReviews(rows, data);
    } else if (isPrRecord(data)) rows = reduceReviews(rows, data);
  }
  return rows;
}

/** Fold `ctx`'s whole session, every branch: a handoff made to a person is not undone by `/tree`. */
export function readReviews(ctx: EntriesSource): ReviewRows {
  return foldReviews(ctx.sessionManager.getEntries());
}

const short = (sha: string) => sha.slice(0, 7);

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** When the PR's head or state was last seen, the facts a review row rests on. */
function lastObserved(record: PrRecord | undefined): number | undefined {
  if (!record) return undefined;
  const times = [seenAt(record, "headSha"), seenAt(record, "state")].filter(isTime);
  return times.length ? Math.max(...times) : undefined;
}

/** One review row as an attention item: linked to the PR, dismissed at the head it was handed off at. */
export function reviewItem(row: ReviewRow, record: PrRecord | undefined): AttentionItem {
  const { request, state } = row;
  const id = itemId(request.key);
  const label = prLabel(request);
  const what = request.reason || record?.title;
  const where =
    state === "stale"
      ? `new commits since ${short(request.head)}`
      : `${request.draft ? "draft" : "head"} at ${short(request.head)}`;
  const reason = clip(what ? `${what} · ${where}` : where, MAX_ATTENTION_REASON);
  const url = prUrl(request);
  const observedAt = lastObserved(record);
  return {
    id,
    rev: request.head,
    category: "review",
    title: clip(`Review ${label}`, 200),
    reason,
    state,
    since: request.at,
    ...(observedAt !== undefined ? { observedAt } : {}),
    ...(isAttentionUrl(url) ? { link: { url, label: clip(label, 100) } } : {}),
    dismiss: { action: GIT_ATTENTION_DISMISS, args: { id, rev: request.head } },
  };
}

/** The `git.attention` view: oldest request first, at most `MAX_ATTENTION_ITEMS`. */
export function attentionModel(
  rows: ReviewRows,
  prs: ReadonlyMap<string, PrRecord>,
): AttentionModel {
  const all = [...rows.values()].sort((a, b) => a.request.at - b.request.at);
  return {
    items: all
      .slice(0, MAX_ATTENTION_ITEMS)
      .map((row) => reviewItem(row, prs.get(row.request.key))),
    total: all.length,
  };
}

/** The row an item id names, as `git.attention.dismiss` is given it. */
export function rowForItem(rows: ReviewRows, id: string): ReviewRow | undefined {
  return id.startsWith("pr:") ? rows.get(id.slice(3)) : undefined;
}
