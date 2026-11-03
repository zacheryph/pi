/**
 * prs.ts — pull request records in the `git:ledger`.
 *
 * A PR is recorded the first time any tool in the session touches it: opened
 * here (`created`) or only looked at (`referenced`). Each record keeps the last
 * status a tool's output showed, merged field by field, and the tool calls
 * that touched it. pi-git never calls GitHub itself for this; it records what
 * the session's own tools already said.
 */

import { LEDGER_VERSION } from "./ledger.ts";

export type PrOrigin = "created" | "referenced";
export type PrState = "open" | "closed" | "merged";
export type PrReview = "approved" | "changes_requested" | "review_required";

export interface PrRef {
  /** `github.com`, or a GitHub Enterprise host. */
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export interface PrChecks {
  passed: number;
  failed: number;
  pending: number;
}

/** What one or more tool outputs showed about a PR. Every field is optional but the stamp. */
export interface PrStatus {
  state?: PrState;
  draft?: boolean;
  review?: PrReview;
  checks?: PrChecks;
  mergeable?: boolean;
  headSha?: string;
  headRef?: string;
  /** When the newest of these fields was observed. */
  observedAt: number;
  /** The tool whose output last changed them. */
  source: string;
  /**
   * When each field was observed. A field without a time here counts as seen
   * at `observedAt`.
   */
  fieldAt?: Partial<Record<PrField, number>>;
}

/** The part of a status a single observation carries. */
export type PrFacts = Omit<PrStatus, "observedAt" | "source" | "fieldAt">;
export type PrField = keyof PrFacts;

const FIELDS: readonly PrField[] = [
  "state",
  "draft",
  "review",
  "checks",
  "mergeable",
  "headSha",
  "headRef",
];

export interface PrCall {
  tool: string;
  toolCallId: string;
  at: number;
  /** Subagent id of the session that made the call, when that was a subagent. */
  agentId?: string;
}

export interface PrRecord extends PrRef {
  v: typeof LEDGER_VERSION;
  kind: "pr";
  /** `host/owner/repo#number`, lower-cased; the record's identity. */
  key: string;
  url: string;
  origin: PrOrigin;
  title?: string;
  status?: PrStatus;
  /** Tool calls that touched it, oldest first, at most {@link MAX_CALLS}. */
  calls: PrCall[];
  createdAt: number;
  updatedAt: number;
  /** Subagent id of the session that first recorded it, when that was a subagent. */
  createdBy?: string;
  /** `adopt` when a descendant session recorded or changed it and handed it up. */
  via?: "adopt";
}

export const MAX_CALLS = 20;

export function prKey(ref: PrRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
}

export function prUrl(ref: PrRef): string {
  return `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

/** `owner/repo#12`. */
export function prLabel(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

const STATES: ReadonlySet<unknown> = new Set(["open", "closed", "merged"]);
const REVIEWS: ReadonlySet<unknown> = new Set(["approved", "changes_requested", "review_required"]);

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStatus(value: unknown): value is PrStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  const checks = status.checks as Record<string, unknown> | undefined;
  return (
    typeof status.observedAt === "number" &&
    isString(status.source) &&
    (status.state === undefined || STATES.has(status.state)) &&
    (status.draft === undefined || typeof status.draft === "boolean") &&
    (status.review === undefined || REVIEWS.has(status.review)) &&
    (status.mergeable === undefined || typeof status.mergeable === "boolean") &&
    (status.headSha === undefined || isString(status.headSha)) &&
    (status.headRef === undefined || isString(status.headRef)) &&
    (checks === undefined ||
      (isCount(checks.passed) && isCount(checks.failed) && isCount(checks.pending))) &&
    (status.fieldAt === undefined || isFieldTimes(status.fieldAt))
  );
}

function isFieldTimes(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, at]) => (FIELDS as readonly string[]).includes(key) && typeof at === "number",
  );
}

function isCall(value: unknown): value is PrCall {
  if (!value || typeof value !== "object") return false;
  const call = value as Record<string, unknown>;
  return (
    isString(call.tool) &&
    isString(call.toolCallId) &&
    typeof call.at === "number" &&
    (call.agentId === undefined || isString(call.agentId))
  );
}

/** Shape check for data read back from a session file or handed over by another session. */
export function isPrRecord(value: unknown): value is PrRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === LEDGER_VERSION &&
    record.kind === "pr" &&
    isString(record.key) &&
    isString(record.host) &&
    isString(record.owner) &&
    isString(record.repo) &&
    typeof record.number === "number" &&
    Number.isSafeInteger(record.number) &&
    record.number > 0 &&
    record.key === prKey(record as unknown as PrRef) &&
    isString(record.url) &&
    (record.origin === "created" || record.origin === "referenced") &&
    (record.title === undefined || typeof record.title === "string") &&
    (record.status === undefined || isStatus(record.status)) &&
    Array.isArray(record.calls) &&
    record.calls.every(isCall) &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    (record.createdBy === undefined || isString(record.createdBy))
  );
}

/** A status recording `facts` as seen at `at`, each field stamped with that time. */
export function observedStatus(facts: PrFacts, at: number, source: string): PrStatus {
  const fieldAt: Partial<Record<PrField, number>> = {};
  for (const field of FIELDS) if (facts[field] !== undefined) fieldAt[field] = at;
  return { ...facts, observedAt: at, source, fieldAt };
}

/**
 * Combine two statuses field by field, each from whichever side saw that field
 * last (a tie goes to `b`). Reading the checks neither forgets the review nor
 * refreshes an older state: a status's `observedAt` moves with its newest
 * field, but each field keeps its own time.
 */
export function mergeStatus(a: PrStatus | undefined, b: PrStatus | undefined) {
  if (!a) return b;
  if (!b) return a;
  const timeOf = (status: PrStatus, field: PrField) => status.fieldAt?.[field] ?? status.observedAt;
  const merged: Record<string, unknown> = {};
  const fieldAt: Partial<Record<PrField, number>> = {};
  for (const field of FIELDS) {
    const fromA = a[field] !== undefined;
    const fromB = b[field] !== undefined;
    if (!fromA && !fromB) continue;
    const side = fromB && (!fromA || timeOf(b, field) >= timeOf(a, field)) ? b : a;
    merged[field] = side[field];
    fieldAt[field] = timeOf(side, field);
  }
  const newer = b.observedAt >= a.observedAt ? b : a;
  return {
    ...(merged as PrFacts),
    observedAt: Math.max(a.observedAt, b.observedAt),
    source: newer.source,
    fieldAt,
  } satisfies PrStatus;
}

/** Both call lists, once each, oldest first, keeping the newest {@link MAX_CALLS}. */
export function mergeCalls(a: readonly PrCall[], b: readonly PrCall[]): PrCall[] {
  const byId = new Map<string, PrCall>();
  for (const call of [...a, ...b]) if (!byId.has(call.toolCallId)) byId.set(call.toolCallId, call);
  return [...byId.values()].sort((x, y) => x.at - y.at).slice(-MAX_CALLS);
}

/**
 * Combine this session's record with a descendant's version of it. A PR
 * opened by either stays opened; statuses and calls accumulate from both;
 * the title and URL come from the newer version.
 */
export function mergePr(existing: PrRecord, candidate: PrRecord): PrRecord {
  const candidateNewer = candidate.updatedAt >= existing.updatedAt;
  const newer = candidateNewer ? candidate : existing;
  const status = mergeStatus(existing.status, candidate.status);
  const createdBy = existing.createdBy ?? candidate.createdBy;
  return {
    ...newer,
    origin:
      existing.origin === "created" || candidate.origin === "created" ? "created" : "referenced",
    ...(newer.title === undefined && (existing.title ?? candidate.title) !== undefined
      ? { title: existing.title ?? candidate.title }
      : {}),
    ...(status ? { status } : {}),
    calls: mergeCalls(existing.calls, candidate.calls),
    createdAt: Math.min(existing.createdAt, candidate.createdAt),
    updatedAt: Math.max(existing.updatedAt, candidate.updatedAt),
    ...(createdBy ? { createdBy } : {}),
    ...(candidateNewer ? { via: "adopt" as const } : {}),
  };
}

/** "open · approved · checks 3 passed, 1 failed", or "no status seen yet". */
export function describePr(status: PrStatus | undefined): string {
  if (!status) return "no status seen yet";
  const parts: string[] = [];
  if (status.state) parts.push(status.draft && status.state === "open" ? "draft" : status.state);
  else if (status.draft) parts.push("draft");
  if (status.review) parts.push(status.review.replace("_", " "));
  if (status.checks) {
    const { passed, failed, pending } = status.checks;
    const counts = [
      failed ? `${failed} failed` : "",
      pending ? `${pending} pending` : "",
      passed ? `${passed} passed` : "",
    ].filter(Boolean);
    parts.push(`checks ${counts.length ? counts.join(", ") : "none"}`);
  }
  if (status.mergeable === false && status.state !== "merged") parts.push("conflicts");
  return parts.length ? parts.join(" · ") : "no status seen yet";
}
