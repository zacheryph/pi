/**
 * roster.ts — The agents this session's branch started, folded from its
 * `subagent:record` entries and overlaid with whichever of them are still live.
 *
 * One view feeds both readers that need it: `subagent_get` with no ID lists it,
 * and the context card restores it after compaction, reload, resume or `/tree`.
 * An agent belongs to the roster only if the branch holds a record for it, so a
 * live agent started on a branch `/tree` has since left drops out with it.
 *
 * Pure functions only, apart from reading the branch off a context.
 */

import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import {
  type PersistedSubagentRecord,
  readPersistedRecords,
  type SessionEntryLike,
} from "#src/persisted-record";
import { sanitizeLine } from "../../../packages/pi-ui/src/index.ts";

/**
 * Where an agent stands, for ordering and labelling.
 *
 * `waiting` is a completed run that ended its turn with a question.
 * `interrupted` is a record still reading queued or running with no live agent
 * behind it: the runtime that ran it was reloaded or replaced first.
 */
export type RosterState =
  | "waiting"
  | "queued"
  | "running"
  | "interrupted"
  | "error"
  | "aborted"
  | "stopped"
  | "completed";

/** The live fields the roster reads; a `Subagent` satisfies it. */
export interface LiveAgentLike {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly pendingQuestion?: string | undefined;
  readonly error?: string | undefined;
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
}

export interface RosterEntry {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly state: RosterState;
  readonly pendingQuestion: string | undefined;
  readonly error: string | undefined;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  /** Whether a live agent in this runtime backs the entry. */
  readonly live: boolean;
}

/** Card limits from the issue that introduced it: whole lines, cut at grapheme boundaries. */
export const CARD_MAX_LINES = 20;
export const DESCRIPTION_MAX_CHARS = 80;
export const QUESTION_MAX_CHARS = 160;
/** How many agents a `subagent_get` list shows before it counts the rest. */
export const LIST_MAX_LINES = 50;

/** The state an agent's status, question and liveness put it in. */
export function rosterState(
  status: SubagentStatus,
  pendingQuestion: string | undefined,
  live: boolean,
): RosterState {
  if (status === "queued" || status === "running") return live ? status : "interrupted";
  if (status === "completed" && pendingQuestion !== undefined) return "waiting";
  return status;
}

/** 0 waiting, 1 queued or running, 2 failed or stopped, 3 completed. */
function rosterGroup(state: RosterState): number {
  switch (state) {
    case "waiting":
      return 0;
    case "queued":
    case "running":
      return 1;
    case "completed":
      return 3;
    default:
      return 2;
  }
}

/** Whether the card must keep this entry however long it gets. */
function isPinned(entry: RosterEntry): boolean {
  return rosterGroup(entry.state) < 2;
}

/**
 * The branch's agents, overlaid with live state, in roster order: waiting on a
 * question, running, failed, then completed — each newest first.
 */
export function buildRoster(
  records: readonly LiveAgentLike[],
  getLive: (id: string) => LiveAgentLike | undefined,
): RosterEntry[] {
  const entries = records.map((record): RosterEntry => {
    const live = getLive(record.id);
    const source: LiveAgentLike = live ?? record;
    return {
      id: record.id,
      type: source.type,
      description: source.description,
      state: rosterState(source.status, source.pendingQuestion, live !== undefined),
      pendingQuestion: source.pendingQuestion,
      error: source.error,
      startedAt: source.startedAt,
      completedAt: source.completedAt,
      live: live !== undefined,
    };
  });
  return entries.sort((a, b) => {
    const group = rosterGroup(a.state) - rosterGroup(b.state);
    if (group !== 0) return group;
    return sortTime(b) - sortTime(a);
  });
}

function sortTime(entry: RosterEntry): number {
  return entry.state === "completed" ? (entry.completedAt ?? entry.startedAt) : entry.startedAt;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Sanitize text to one line and cut it to `max` user-perceived characters,
 * ending with an ellipsis when cut. Cuts fall between grapheme clusters, so a
 * wide CJK character, an emoji or a flag is kept whole or dropped whole.
 */
export function clipText(text: string, max: number): string {
  const line = sanitizeLine(text).replace(/\s+/g, " ").trim();
  const graphemes = Array.from(segmenter.segment(line), (part) => part.segment);
  if (graphemes.length <= max) return line;
  return graphemes.slice(0, Math.max(max - 1, 0)).join("") + "…";
}

/** A local `HH:MM` clock time. */
export function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What follows the label on a roster line. */
function stateText(entry: RosterEntry): string {
  switch (entry.state) {
    case "waiting":
      return `waiting for your answer: "${clipText(entry.pendingQuestion ?? "", QUESTION_MAX_CHARS)}"`;
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "interrupted":
      return "interrupted: the session was reloaded or replaced before it finished";
    case "error":
      return `failed: ${clipText(entry.error ?? "unknown error", QUESTION_MAX_CHARS)}`;
    case "aborted":
      return "failed: turn budget exhausted";
    case "stopped":
      return "stopped before it finished";
    case "completed":
      return entry.completedAt === undefined
        ? "completed"
        : `completed ${formatClock(entry.completedAt)}`;
  }
}

/** One roster line: ID, type, description, state, and the question or error. */
export function formatRosterLine(entry: RosterEntry): string {
  const type = clipText(entry.type, DESCRIPTION_MAX_CHARS);
  const description = clipText(entry.description, DESCRIPTION_MAX_CHARS);
  return `- ${entry.id} ${type} "${description}": ${stateText(entry)}`;
}

/** The line that counts what a capped roster left out. */
function overflowLine(dropped: readonly RosterEntry[]): string {
  // Only failed and completed agents are ever dropped.
  const completed = dropped.filter((entry) => entry.state === "completed").length;
  const failed = dropped.length - completed;
  const parts = [
    ...(failed ? [`${failed} failed`] : []),
    ...(completed ? [`${completed} older completed`] : []),
  ];
  return `- ${parts.join(" and ")} ${dropped.length === 1 ? "agent" : "agents"} not shown`;
}

/**
 * Cap a roster at `maxLines` whole lines, the last of which counts what was
 * left out. Waiting and running agents are never dropped, even past the cap.
 */
function capRoster(entries: readonly RosterEntry[], maxLines: number): string[] {
  if (entries.length <= maxLines) return entries.map(formatRosterLine);
  const pinned = entries.filter(isPinned);
  const rest = entries.filter((entry) => !isPinned(entry));
  const room = Math.max(maxLines - 1 - pinned.length, 0);
  const dropped = rest.slice(room);
  return [
    ...[...pinned, ...rest.slice(0, room)].map(formatRosterLine),
    ...(dropped.length ? [overflowLine(dropped)] : []),
  ];
}

/** Why the card is back, worded for its header. */
export type RestoreReason = "compaction" | "reload" | "resume" | "fork" | "/tree";

/**
 * The context card: the branch's agents after the model lost track of them.
 * Undefined when the branch started none.
 */
export function formatRosterCard(
  entries: readonly RosterEntry[],
  reason: RestoreReason,
): string | undefined {
  if (!entries.length) return undefined;
  return [
    `Subagents started by this session (restored after ${reason}; subagent_get <id> for details):`,
    ...capRoster(entries, CARD_MAX_LINES),
  ].join("\n");
}

/** The `subagent_get` list: every agent on the branch, in roster order. */
export function formatRosterList(entries: readonly RosterEntry[]): string {
  if (!entries.length) return "No agents were started on this branch of the session.";
  return [
    `Agents started on this branch (${entries.length}; subagent_get <id> for details):`,
    ...capRoster(entries, LIST_MAX_LINES),
  ].join("\n");
}

/** The branch-reading slice of a Pi context; `ExtensionContext` satisfies it. */
interface BranchContext {
  readonly sessionManager?: { getBranch(): readonly SessionEntryLike[] };
}

/**
 * Fold the records on the context's current branch, or undefined when the
 * context carries no session (a bare tool call outside Pi).
 */
export function readBranchRecords(ctx: unknown): PersistedSubagentRecord[] | undefined {
  const sessionManager = (ctx as BranchContext | undefined)?.sessionManager;
  if (typeof sessionManager?.getBranch !== "function") return undefined;
  return readPersistedRecords(sessionManager.getBranch());
}
