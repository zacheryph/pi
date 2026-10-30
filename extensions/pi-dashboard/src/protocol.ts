import { join } from "node:path";

// Shared by the reporter (inside Pi) and the hub (plain Node, outside Pi).
// Keep this file free of Pi imports and of TypeScript syntax Node cannot strip.

/** Bump when the hub must be replaced to understand newer reporters. */
export const PROTOCOL_VERSION = 1;
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
}

export type ReporterMessage =
  | { type: "hello"; version: number; snapshot: SessionSnapshot }
  | { type: "update"; snapshot: SessionSnapshot }
  /** `replace`: /new, /resume, /fork or /reload; the same process reconnects shortly. */
  | { type: "bye"; reason: "quit" | "replace" };

export interface HubPaths {
  dir: string;
  socket: string;
  log: string;
}

export function hubPaths(dir: string): HubPaths {
  return { dir, socket: join(dir, "hub.sock"), log: join(dir, "hub.log") };
}

export function encode(message: ReporterMessage): string {
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
