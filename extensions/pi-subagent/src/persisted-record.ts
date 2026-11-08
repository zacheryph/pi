/**
 * persisted-record.ts — The `subagent:record` session-entry contract.
 *
 * The parent session appends one entry per lifecycle step of every agent it
 * starts — when it is queued or starts running, when a resume starts, and when
 * a run settles (including a run that ended its turn with a question) — so the
 * session file outlives the in-memory `SubagentManager` (a `/reload` rebuilds
 * the extension; a `/resume` reopens the file). The entries sit on the branch
 * that started the agent, so they follow it through `/tree` and forks.
 *
 * This module owns the entry's shape on both sides: the writer
 * (`SubagentEventsObserver`) builds it here, and readers fold it here.
 */

import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import type { SubagentType, ThinkingLevel } from "#src/types";

/** The `customType` every persisted run record is appended under. */
export const SUBAGENT_RECORD_ENTRY = "subagent:record";

/**
 * What is appended at each lifecycle step.
 *
 * The fields after `toolUses` were added later; an entry written before them
 * still validates, and a reader treats a missing one as unknown.
 */
export interface PersistedSubagentRecord {
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly result: string | undefined;
  readonly error: string | undefined;
  readonly turnBudget: TurnBudget | undefined;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  /** The run's session JSONL, which a reader can open after the live session is gone. */
  readonly outputFile: string | undefined;
  readonly toolUses: number;
  /** The question the agent ended its turn with, when it declared one. */
  readonly pendingQuestion?: string;
  readonly waitingReason?: string;
  /** The model's `provider/id`; absent while an inherited model is still unknown. */
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
  /** The turn ceiling the spawn asked for; absent when it left the agent's own limit. */
  readonly maxTurns?: number;
  /** The directory the agent runs in; absent in entries written before it was recorded. */
  readonly cwd?: string;
}

/** The fields a reader validates and returns: what labels a past run and opens its transcript. */
export type PersistedRunSummary = Pick<
  PersistedSubagentRecord,
  "id" | "type" | "description" | "status" | "startedAt" | "completedAt" | "toolUses" | "outputFile"
>;

/** The session-entry fields the reader inspects; Pi's `SessionEntry` satisfies it. */
export interface SessionEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/**
 * What the writer copies from. A `Subagent` satisfies it structurally; the
 * model arrives as an object and is stored as its `provider/id` label.
 */
export interface PersistedRecordSource extends Omit<PersistedSubagentRecord, "model"> {
  readonly model?: { readonly provider: string; readonly id: string } | undefined;
}

/**
 * Build the entry for one lifecycle step. Copying field by field keeps
 * everything else off the entry, and an unknown optional field is left out
 * rather than written as `undefined`.
 */
export function toPersistedRecord(record: PersistedRecordSource): PersistedSubagentRecord {
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    result: record.result,
    error: record.error,
    turnBudget: record.turnBudget,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    outputFile: record.outputFile,
    toolUses: record.toolUses,
    ...(record.waitingReason !== undefined ? { waitingReason: record.waitingReason } : {}),
    ...(record.pendingQuestion !== undefined ? { pendingQuestion: record.pendingQuestion } : {}),
    ...(record.model ? { model: `${record.model.provider}/${record.model.id}` } : {}),
    ...(record.thinkingLevel !== undefined ? { thinkingLevel: record.thinkingLevel } : {}),
    ...(record.maxTurns !== undefined ? { maxTurns: record.maxTurns } : {}),
    ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
  };
}

/**
 * Fold a branch's entries into the latest record per agent, newest first.
 *
 * Every lifecycle step appends a new entry under the same id, so the last one
 * wins. Entries that do not validate are skipped, including those written
 * before the entry recorded `toolUses`.
 */
export function readPersistedRecords(
  entries: readonly SessionEntryLike[],
): PersistedSubagentRecord[] {
  const records = new Map<string, PersistedSubagentRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_RECORD_ENTRY) continue;
    const record = asRecord(entry.data);
    if (record) records.set(record.id, record);
  }
  return [...records.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Read every persisted run's summary out of a session's entries, newest first. */
export function readPersistedRuns(entries: readonly SessionEntryLike[]): PersistedRunSummary[] {
  return readPersistedRecords(entries).map(
    ({ id, type, description, status, startedAt, completedAt, toolUses, outputFile }) => ({
      id,
      type,
      description,
      status,
      startedAt,
      completedAt,
      toolUses,
      outputFile,
    }),
  );
}

const SUBAGENT_STATUSES: ReadonlySet<string> = new Set<SubagentStatus>([
  "queued",
  "running",
  "waiting",
  "completed",
  "aborted",
  "stopped",
  "error",
]);

const OPTIONAL_STRINGS = [
  "result",
  "error",
  "outputFile",
  "pendingQuestion",
  "waitingReason",
  "model",
  "thinkingLevel",
  "cwd",
] as const;
const OPTIONAL_NUMBERS = ["completedAt", "maxTurns"] as const;

const isOptional = (value: unknown, type: "string" | "number" | "object"): boolean =>
  value === undefined || value === null || typeof value === type;
const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

function asRecord(data: unknown): PersistedSubagentRecord | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const fields = data as Record<string, unknown>;
  const { id, type, description, status, startedAt, toolUses } = fields;
  if (typeof id !== "string" || typeof type !== "string" || typeof description !== "string")
    return undefined;
  if (typeof status !== "string" || !SUBAGENT_STATUSES.has(status)) return undefined;
  if (typeof startedAt !== "number" || typeof toolUses !== "number") return undefined;
  if (!OPTIONAL_STRINGS.every((key) => isOptional(fields[key], "string"))) return undefined;
  if (!OPTIONAL_NUMBERS.every((key) => isOptional(fields[key], "number"))) return undefined;
  if (!isOptional(fields.turnBudget, "object")) return undefined;
  const optional = <T>(key: string) => orUndefined(fields[key] as T | null | undefined);
  const model = optional<string>("model");
  return {
    ...toPersistedRecord({
      id,
      type,
      description,
      status: status as SubagentStatus,
      result: optional<string>("result"),
      error: optional<string>("error"),
      turnBudget: optional<TurnBudget>("turnBudget"),
      startedAt,
      completedAt: optional<number>("completedAt"),
      outputFile: optional<string>("outputFile"),
      toolUses,
      pendingQuestion: optional<string>("pendingQuestion"),
      waitingReason: optional<string>("waitingReason"),
      thinkingLevel: optional<ThinkingLevel>("thinkingLevel"),
      maxTurns: optional<number>("maxTurns"),
      cwd: optional<string>("cwd"),
    }),
    ...(model !== undefined ? { model } : {}),
  };
}
