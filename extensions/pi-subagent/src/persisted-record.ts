/**
 * persisted-record.ts — The `subagent:record` session-entry contract.
 *
 * The parent session appends one entry per lifecycle step of every agent it
 * starts — when it is queued or starts running, when a resume starts, and when
 * a run settles — so the
 * session file outlives the in-memory `SubagentManager` (a `/reload` rebuilds
 * the extension; a `/resume` reopens the file). The entries sit on the branch
 * that started the agent, so they follow it through `/tree` and forks.
 *
 * This module owns the entry's shape on both sides: the writer
 * (`SubagentEventsObserver`) builds it here, and readers fold it here.
 *
 * An entry records the three-state `status` (`queued`, `running`, `idle`) and,
 * for an idle agent, how its last run ended in `outcome`. The reader skips any
 * entry that is not `PERSISTED_RECORD_VERSION`.
 */

import { customData } from "../../../packages/pi-session-state/src/index.ts";
import type { RunOutcome, SubagentStatus } from "#src/lifecycle/subagent-state";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import type { SubagentType, ThinkingLevel } from "#src/types";

/** The `customType` every persisted run record is appended under. */
export const SUBAGENT_RECORD_ENTRY = "subagent:record";

/** The shape this module writes and the only one it reads. */
export const PERSISTED_RECORD_VERSION = 2;

/**
 * What is appended at each lifecycle step.
 *
 * The fields after `toolUses` were added later; an entry written before them
 * still validates, and a reader treats a missing one as unknown.
 */
export interface PersistedSubagentRecord {
  readonly version: typeof PERSISTED_RECORD_VERSION;
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  /**
   * How the last run ended; present exactly when the status is `idle`. An agent
   * whose run was cut short by a reload or restart reads back as `interrupted`.
   */
  readonly outcome: RunOutcome | undefined;
  readonly result: string | undefined;
  readonly error: string | undefined;
  readonly turnBudget: TurnBudget | undefined;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  /** The run's session JSONL, which a reader can open after the live session is gone. */
  readonly outputFile: string | undefined;
  readonly toolUses: number;
  /** The model's `provider/id`; absent while an inherited model is still unknown. */
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
  /** The turn ceiling the spawn asked for; absent when it left the agent's own limit. */
  readonly maxTurns?: number;
  /** The directory the agent runs in; absent in entries written before it was recorded. */
  readonly cwd?: string;
  /**
   * The labels of the open work an idle agent was waiting on when the record was written
   * (`CI`, `answer`); absent when it waited on nothing, and in entries written before it was
   * recorded. It is what lets the next start of the parent (a reload or a restart) know which
   * agents to reopen so their work can be taken over (roadmap step 12); the work itself is in the
   * agent's own transcript.
   */
  readonly waitingOn?: readonly string[];
}

/** The fields a reader validates and returns: what labels a past run and opens its transcript. */
export type PersistedRunSummary = Pick<
  PersistedSubagentRecord,
  | "id"
  | "type"
  | "description"
  | "status"
  | "outcome"
  | "startedAt"
  | "completedAt"
  | "toolUses"
  | "outputFile"
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
export interface PersistedRecordSource extends Omit<PersistedSubagentRecord, "model" | "version"> {
  readonly model?: { readonly provider: string; readonly id: string } | undefined;
}

/**
 * Build the entry for one lifecycle step. Copying field by field keeps
 * everything else off the entry, and an unknown optional field is left out
 * rather than written as `undefined`.
 */
export function toPersistedRecord(record: PersistedRecordSource): PersistedSubagentRecord {
  return {
    version: PERSISTED_RECORD_VERSION,
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    // Only an idle agent has an outcome; a run in flight has not ended yet.
    outcome: record.status === "idle" ? record.outcome : undefined,
    result: record.result,
    error: record.error,
    turnBudget: record.turnBudget,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    outputFile: record.outputFile,
    toolUses: record.toolUses,
    ...(record.model ? { model: `${record.model.provider}/${record.model.id}` } : {}),
    ...(record.thinkingLevel !== undefined ? { thinkingLevel: record.thinkingLevel } : {}),
    ...(record.maxTurns !== undefined ? { maxTurns: record.maxTurns } : {}),
    ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
    // Only an idle agent waits.
    ...(record.status === "idle" && record.waitingOn?.length
      ? { waitingOn: [...record.waitingOn] }
      : {}),
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
  for (const data of customData(entries, SUBAGENT_RECORD_ENTRY)) {
    const record = asRecord(data);
    if (record) records.set(record.id, record);
  }
  return [...records.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Read every persisted run's summary out of a session's entries, newest first. */
export function readPersistedRuns(entries: readonly SessionEntryLike[]): PersistedRunSummary[] {
  return readPersistedRecords(entries).map(
    ({ id, type, description, status, outcome, startedAt, completedAt, toolUses, outputFile }) => ({
      id,
      type,
      description,
      status,
      outcome,
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
  "idle",
]);

const RUN_OUTCOMES: ReadonlySet<string> = new Set<RunOutcome>([
  "completed",
  "turn-limit",
  "error",
  "stopped",
  "interrupted",
]);

/** The status and outcome an entry records, or undefined when invalid. */
function readStatus(
  fields: Record<string, unknown>,
): { status: SubagentStatus; outcome: RunOutcome | undefined } | undefined {
  const { version, status, outcome } = fields;
  if (typeof status !== "string") return undefined;
  if (version !== PERSISTED_RECORD_VERSION || !SUBAGENT_STATUSES.has(status)) return undefined;
  if (status !== "idle") return { status: status as SubagentStatus, outcome: undefined };
  if (typeof outcome !== "string" || !RUN_OUTCOMES.has(outcome)) return undefined;
  return { status: "idle", outcome: outcome as RunOutcome };
}

const OPTIONAL_STRINGS = [
  "result",
  "error",
  "outputFile",
  "model",
  "thinkingLevel",
  "cwd",
] as const;
const OPTIONAL_NUMBERS = ["completedAt", "maxTurns"] as const;

const isLabels = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((label) => typeof label === "string");

const isOptional = (value: unknown, type: "string" | "number" | "object"): boolean =>
  value === undefined || value === null || typeof value === type;
const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

function asRecord(data: unknown): PersistedSubagentRecord | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const fields = data as Record<string, unknown>;
  const { id, type, description, startedAt, toolUses } = fields;
  if (typeof id !== "string" || typeof type !== "string" || typeof description !== "string")
    return undefined;
  const state = readStatus(fields);
  if (!state) return undefined;
  if (typeof startedAt !== "number" || typeof toolUses !== "number") return undefined;
  if (!OPTIONAL_STRINGS.every((key) => isOptional(fields[key], "string"))) return undefined;
  if (!OPTIONAL_NUMBERS.every((key) => isOptional(fields[key], "number"))) return undefined;
  if (!isOptional(fields.turnBudget, "object")) return undefined;
  const waitingOn = fields.waitingOn;
  // A malformed list is dropped, not fatal: the record is still a valid account of the run.
  const labels = isLabels(waitingOn) ? waitingOn : undefined;
  const optional = <T>(key: string) => orUndefined(fields[key] as T | null | undefined);
  const model = optional<string>("model");
  return {
    ...toPersistedRecord({
      id,
      type,
      description,
      status: state.status,
      outcome: state.outcome,
      result: optional<string>("result"),
      error: optional<string>("error"),
      turnBudget: optional<TurnBudget>("turnBudget"),
      startedAt,
      completedAt: optional<number>("completedAt"),
      outputFile: optional<string>("outputFile"),
      toolUses,
      thinkingLevel: optional<ThinkingLevel>("thinkingLevel"),
      maxTurns: optional<number>("maxTurns"),
      cwd: optional<string>("cwd"),
      waitingOn: labels,
    }),
    ...(model !== undefined ? { model } : {}),
  };
}
