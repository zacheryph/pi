import { join } from "node:path";

// Shared by the reporter (inside Pi) and the hub (plain Node, outside Pi).
// Keep this file free of Pi imports and of TypeScript syntax Node cannot strip.

/** Bump when the hub must be replaced to understand newer reporters. */
export const PROTOCOL_VERSION = 6;
export const DEFAULT_PORT = 7317;
/** How long the hub waits with no sessions, or keeps a restarting session's card. */
export const IDLE_GRACE_MS = 15_000;
const MAX_LINE_BYTES = 1024 * 1024;

export type {
  SessionStatus,
  TodoStatus,
  TodoSection,
  StashSection,
  GitWorktreeState,
  GitPrState,
  GitSection,
  UsageSection,
  SubagentState,
  SubagentsSection,
  ActivitySection,
  Questionnaire,
  QuestionnaireAnswer,
  TerminalInfo,
  SessionSnapshot,
  TodoHistory,
  StashPreview,
} from "#presentation/contract";
import type { SessionSnapshot, QuestionnaireAnswer } from "#presentation/contract";

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
  | { command: "todo-history"; key: string }
  /** `question` is the questionnaire's id (its tool call id). */
  | { command: "answer"; question: string; answer: QuestionnaireAnswer };

/** Hub to reporter. */
export type HubCommand = { type: "command"; id: number } & CommandRequest;

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
      try {
        messages.push(JSON.parse(line));
      } catch {
        /* drop malformed line */
      }
    }
    return messages;
  }
}

export function isSnapshot(value: unknown): value is SessionSnapshot {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  const status = raw.status as Record<string, unknown> | undefined;
  return (
    typeof raw.id === "string" &&
    raw.id.length > 0 &&
    raw.id.length <= 128 &&
    Number.isSafeInteger(raw.pid) &&
    typeof raw.sessionId === "string" &&
    typeof raw.cwd === "string" &&
    Number.isFinite(raw.startedAt) &&
    !!status &&
    typeof status.kind === "string" &&
    Number.isFinite(status.since)
  );
}
