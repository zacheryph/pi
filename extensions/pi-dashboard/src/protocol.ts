import { join } from "node:path";

// Shared by the reporter (inside Pi) and the hub (plain Node, outside Pi).
// Keep this file free of Pi imports and of TypeScript syntax Node cannot strip.

/** Bump when the hub must be replaced to understand newer reporters. */
export const PROTOCOL_VERSION = 4;
export const DEFAULT_PORT = 7317;
/** How long the hub waits with no sessions, or keeps a restarting session's card. */
export const IDLE_GRACE_MS = 15_000;
const MAX_LINE_BYTES = 1024 * 1024;

export type SessionStatus =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "tool"; tool: string }
  | { kind: "compacting" }
  | { kind: "waiting"; title?: string };

export type TodoStatus = "pending" | "in_progress" | "completed";

/** From pi-todo's snapshot event, bounded for the wire. */
export interface TodoSection {
  revision: number;
  /** Tasks in the plan; `tasks` may hold fewer when capped. */
  total: number;
  tasks: Array<{
    key: string;
    subject: string;
    status: TodoStatus;
    /** Waiting on an unfinished prerequisite. */
    blocked: boolean;
    /** Messages the user has not reviewed. */
    unreviewed: number;
    description?: string;
    dependsOn?: string[];
    /** Latest outcome message. */
    message?: { text: string; at?: number };
    updatedAt?: number;
  }>;
}

/** From pi-stash's snapshot event: this branch's entries, newest first, metadata only. */
export interface StashSection {
  /** Entries on the branch; `entries` may hold fewer when capped. */
  total: number;
  entries: Array<{
    name: string;
    handle: string;
    bytes: number;
    lines: number;
    mime: string;
    description?: string;
    /** `content`, `path:<relative>`, or `tool:<name>`. */
    source: string;
    createdAt: number;
    /** Session id that stored it; differs from the card's for subagent results. */
    createdBy: string;
    versions: number;
  }>;
  /** Size of pi-stash's shared content store and its configured cap. */
  store?: { bytes: number; maxBytes: number };
}

/** Token and cost totals for the whole session, as Pi's /session reports them. */
export interface UsageSection {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD. */
  cost: number;
}

/** Compaction history on the branch, plus pi-blackhole's memory ledger when present. */
export interface MemorySection {
  compactions: number;
  lastCompactionAt?: number;
  blackhole?: {
    /** Observations recorded on the branch. */
    observations: number;
    /** Recorded observations not dropped since. */
    kept: number;
    dropped: number;
    reflections: number;
    /** Tokens held by the kept observations. */
    keptTokens: number;
  };
}

export type SubagentState = "queued" | "running" | "completed" | "failed" | "stopped";

/** Subagents seen on this session's bus while the dashboard was loaded, newest first. */
export interface SubagentsSection {
  agents: Array<{
    id: string;
    type: string;
    description: string;
    state: SubagentState;
    /** When the dashboard first saw it. */
    since: number;
    durationMs?: number;
    toolUses?: number;
    tokens?: number;
    /** Latest progress message, or the error for a failed run. */
    note?: string;
  }>;
}

/** Recent top-level tool calls, newest first. */
export type ActivitySection = Array<{
  tool: string;
  /** Path for file tools, or the first line of a bash command; clipped. */
  summary?: string;
  at: number;
  durationMs?: number;
  /** Still running. */
  running?: boolean;
  error?: boolean;
}>;

/** Where Focus goes; present only when a terminal adapter recognized the session. */
export interface TerminalInfo {
  kind: string;
  label: string;
}

export interface SessionSnapshot {
  /** Stable for the Pi process, across /new, /resume and /reload. */
  id: string;
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  agent?: string;
  model?: { provider: string; id: string; name?: string };
  thinking?: string;
  status: SessionStatus & { since: number };
  context?: { tokens: number | null; window: number; percent: number | null };
  startedAt: number;
  piVersion?: string;
  /** Absent when pi-todo is not loaded. */
  todos?: TodoSection;
  /** Absent when pi-stash is not loaded. */
  stash?: StashSection;
  usage?: UsageSection;
  memory?: MemorySection;
  /** Absent when pi-subagents is not loaded or nothing has run yet. */
  subagents?: SubagentsSection;
  terminal?: TerminalInfo;
  activity?: ActivitySection;
}

export type ReporterMessage =
  | { type: "hello"; version: number; snapshot: SessionSnapshot }
  | { type: "update"; snapshot: SessionSnapshot }
  /** `replace`: /new, /resume, /fork or /reload; the same process reconnects shortly. */
  | { type: "bye"; reason: "quit" | "replace" }
  | { type: "result"; id: number; ok: boolean; error?: string; data?: unknown };

/**
 * Requests the page makes of one session. Content requests (stash previews,
 * task history) are answered only to the page that asked, never broadcast.
 */
export type CommandRequest =
  | { command: "focus" }
  | { command: "stash-preview"; name: string }
  | { command: "todo-history"; key: string };

/** Hub to reporter. */
export type HubCommand = { type: "command"; id: number } & CommandRequest;

/** A task's status and message history, as `todo-history` returns it. */
export interface TodoHistory {
  key: string;
  createdAt?: number;
  updates: Array<{ revision: number; at: number; status: TodoStatus; from?: TodoStatus; message?: string; byUser?: boolean }>;
}

/** The head of a stash entry, as `stash-preview` returns it. */
export interface StashPreview {
  handle: string;
  lines: string[];
  total: number;
  complete: boolean;
}

export interface HubPaths {
  dir: string;
  socket: string;
  log: string;
}

export function hubPaths(dir: string): HubPaths {
  return { dir, socket: join(dir, "hub.sock"), log: join(dir, "hub.log") };
}

export function encode(message: ReporterMessage | HubCommand): string {
  return `${JSON.stringify(message)}\n`;
}

/** Splits a byte stream into JSON lines. Malformed lines are dropped; an oversized line resets the buffer. */
export class LineDecoder {
  private buffer = "";

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > MAX_LINE_BYTES) this.buffer = "";
    const messages: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); } catch { /* drop malformed line */ }
    }
    return messages;
  }
}

export function isSnapshot(value: unknown): value is SessionSnapshot {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  const status = raw.status as Record<string, unknown> | undefined;
  return typeof raw.id === "string" && raw.id.length > 0 && raw.id.length <= 128
    && Number.isSafeInteger(raw.pid) && typeof raw.sessionId === "string" && typeof raw.cwd === "string"
    && Number.isFinite(raw.startedAt) && !!status && typeof status.kind === "string" && Number.isFinite(status.since);
}
