import {
  isAmount,
  isArrayOf,
  isBoolean,
  isFiniteNumber,
  isRecord,
  isString,
  isText,
  isTrue,
  optional,
} from "#src/guards";

/**
 * The view id of the core session view, by convention. pi-system-insights
 * provides it; consumers find it by kind (`session`) and tolerate its absence.
 */
export const SESSION_VIEW_ID = "system.session";

/**
 * What the session's Pi process is doing, and since when (epoch milliseconds).
 * Precedence, highest first: waiting for the user, compacting, running a tool,
 * working, idle.
 *
 * The whole status is process-bound (see `#src/model`): it describes a running
 * process, so a settled session reads `{ kind: "idle" }` from the time it settled.
 */
export type SessionStatus = { since: number } & (
  | { kind: "idle" }
  | { kind: "working" }
  /** The most recent top-level tool still running. */
  | { kind: "tool"; tool: string }
  | { kind: "compacting" }
  /** Waiting for the user; `title` names what asks, such as a dialog's title. */
  | { kind: "waiting"; title?: string }
);
export type SessionStatusKind = SessionStatus["kind"];
export const SESSION_STATUS_KINDS: readonly SessionStatusKind[] = [
  "idle",
  "working",
  "tool",
  "compacting",
  "waiting",
];

/** One recent top-level tool call. */
export type SessionActivity = {
  tool: string;
  /** What the call is about, without its content: a path, or a command's first line. */
  summary?: string;
  /** When the call started, epoch milliseconds. */
  at: number;
  /** How long a finished call took. */
  durationMs?: number;
  error?: boolean;
  /**
   * Still running. Process-bound (see `#src/model`): settled, the flag is
   * dropped, and the call keeps no duration because it never finished.
   */
  live?: true;
};

/** The selected model, as Pi names it. */
export type SessionModelRef = { provider: string; id: string; name?: string };

/** Current context usage. `null` where Pi does not know yet, e.g. right after compaction. */
export type SessionContext = { tokens: number | null; window: number; percent: number | null };

/**
 * Billed token and cost totals for the whole session file: abandoned branches
 * and compacted history included, as Pi's `/session` reports them. Not
 * process-bound: they are rebuilt from the session's history.
 */
export type SessionUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD. */
  cost: number;
};

/**
 * Core information about one Pi session, observed by pi-system-insights.
 *
 * It holds only what Pi itself knows. A main-agent profile belongs to
 * pi-subagent's summary view; connection identity (a dashboard id, a bb thread)
 * belongs to the delivery snapshot that carries this view.
 */
export type SessionModel = {
  /** Pi's id for the session file; changes on /new, /resume and /fork. */
  sessionId: string;
  cwd: string;
  /** The session's name, set with /name. */
  name?: string;
  model?: SessionModelRef;
  /** Thinking level, e.g. `medium`. */
  thinking?: string;
  context?: SessionContext;
  status: SessionStatus;
  /** Recent top-level tool calls, newest first. */
  activity?: readonly SessionActivity[];
  usage?: SessionUsage;
  /** When the Pi process started, epoch milliseconds. */
  startedAt: number;
  piVersion?: string;
};

const isNullableAmount = (value: unknown) => value === null || isAmount(value);

function isSessionStatus(value: unknown): value is SessionStatus {
  if (!isRecord(value) || !isFiniteNumber(value.since)) return false;
  switch (value.kind) {
    case "idle":
    case "working":
    case "compacting":
      return true;
    case "tool":
      return isText()(value.tool);
    case "waiting":
      return optional(value.title, isString);
    default:
      return false;
  }
}

const isActivity = (value: unknown) =>
  isRecord(value) &&
  isText()(value.tool) &&
  optional(value.summary, isString) &&
  isFiniteNumber(value.at) &&
  optional(value.durationMs, isAmount) &&
  optional(value.error, isBoolean) &&
  optional(value.live, isTrue);

const isModelRef = (value: unknown) =>
  isRecord(value) &&
  isText()(value.provider) &&
  isText()(value.id) &&
  optional(value.name, isString);

const isContext = (value: unknown) =>
  isRecord(value) &&
  isNullableAmount(value.tokens) &&
  isAmount(value.window) &&
  isNullableAmount(value.percent);

const isUsage = (value: unknown) =>
  isRecord(value) &&
  isAmount(value.input) &&
  isAmount(value.output) &&
  isAmount(value.cacheRead) &&
  isAmount(value.cacheWrite) &&
  isAmount(value.cost);

export function isSessionModel(value: unknown): value is SessionModel {
  return (
    isRecord(value) &&
    isText()(value.sessionId) &&
    isString(value.cwd) &&
    optional(value.name, isString) &&
    optional(value.model, isModelRef) &&
    optional(value.thinking, isString) &&
    optional(value.context, isContext) &&
    isSessionStatus(value.status) &&
    optional(value.activity, isArrayOf(isActivity)) &&
    optional(value.usage, isUsage) &&
    isFiniteNumber(value.startedAt) &&
    optional(value.piVersion, isString)
  );
}
