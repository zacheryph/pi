import { join } from "node:path";
import {
  ACTION_ID,
  DASHBOARD_LINE_BYTES,
  decodeJson,
  isJsonValue,
  MAX_VIEW_ERROR,
  readDeliverySnapshot,
  utf8Bytes,
  type Decoded,
  type DeliverySnapshot,
  type JsonValue,
  type ViewEntry,
} from "#surface";

// Shared by the reporter (inside Pi) and the hub (plain Node, outside Pi).
// Keep this file free of Pi imports and of TypeScript syntax Node cannot strip.

/**
 * Bump when reporter and hub must be upgraded together. A hub steps aside for
 * a reporter that speaks a newer version and refuses one that speaks an older.
 */
export const PROTOCOL_VERSION = 7;
export const DEFAULT_PORT = 7317;
/** How long the hub waits with no sessions, or keeps a restarting session's card. */
export const IDLE_GRACE_MS = 15_000;
/** Longest line either side reads, in UTF-8 bytes, terminator excluded. */
export const MAX_LINE_BYTES = DASHBOARD_LINE_BYTES;

export type { DeliverySnapshot, HostTerminal as TerminalInfo, JsonValue } from "#surface";

export type ReporterMessage =
  /** The first message on a connection; the hub answers `welcome` or `refused`. */
  | { type: "hello"; version: number; snapshot: DeliverySnapshot }
  /** A complete snapshot that replaces the previous one; nothing is merged. */
  | { type: "update"; snapshot: DeliverySnapshot }
  /** `replace`: /new, /resume, /fork or /reload; the same process reconnects shortly. */
  | { type: "bye"; reason: "quit" | "replace" }
  | { type: "result"; id: number; ok: boolean; error?: string; data?: JsonValue };

/**
 * Requests the page makes of one session, answered to the page that asked and
 * never broadcast. Focus is the dashboard's own host request; everything else
 * runs an action a view of the session references, through pi-surface.
 */
export type CommandRequest =
  | { command: "focus" }
  | { command: "action"; action: string; args?: JsonValue };

/** Hub to reporter. */
export type HubMessage =
  /** The hub accepted the hello and speaks this protocol. */
  | { type: "welcome"; version: number }
  /** The hub will not take this connection, and closes it. */
  | { type: "refused"; version: number; error: string }
  | ({ type: "command"; id: number } & CommandRequest);

export interface HubPaths {
  dir: string;
  socket: string;
  log: string;
}

export function hubPaths(dir: string): HubPaths {
  return { dir, socket: join(dir, "hub.sock"), log: join(dir, "hub.log") };
}

export function encode(message: ReporterMessage | HubMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * A hello or update line around a snapshot's JSON, exactly as measured by
 * pi-surface's `collectDelivery`, so it is not serialized twice.
 */
export function snapshotLine(type: "hello" | "update", snapshotJson: string): string {
  const head =
    type === "hello" ? `{"type":"hello","version":${PROTOCOL_VERSION},` : `{"type":"update",`;
  return `${head}"snapshot":${snapshotJson}}\n`;
}

/** What a snapshot line adds around the snapshot, in UTF-8 bytes; the larger (hello) of the two. */
export const SNAPSHOT_FRAMING_BYTES = utf8Bytes(snapshotLine("hello", ""));

/**
 * Splits a byte stream into JSON lines, measuring each in UTF-8 bytes as it
 * travels. A line over `maxBytes` is skipped, however it arrives, and so is a
 * line that is not UTF-8 JSON; each becomes a failed entry saying why, for the
 * reader to log. Blank lines are ignored.
 */
export class LineDecoder {
  private readonly maxBytes: number;
  private pending: Buffer[] = [];
  private size = 0;
  /** The current line went over the limit: its remaining bytes are dropped. */
  private overflow = 0;

  constructor(maxBytes = MAX_LINE_BYTES) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer | string): Decoded<unknown>[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const out: Decoded<unknown>[] = [];
    let start = 0;
    while (start <= data.length) {
      const end = data.indexOf(0x0a, start);
      const piece = data.subarray(start, end < 0 ? data.length : end);
      this.append(piece);
      if (end < 0) break;
      this.finish(out);
      start = end + 1;
    }
    return out;
  }

  private append(piece: Buffer): void {
    if (!piece.length) return;
    if (this.overflow || this.size + piece.length > this.maxBytes) {
      this.overflow = (this.overflow || this.size) + piece.length;
      this.pending = [];
      this.size = 0;
      return;
    }
    this.pending.push(piece);
    this.size += piece.length;
  }

  private finish(out: Decoded<unknown>[]): void {
    const overflow = this.overflow;
    const line = Buffer.concat(this.pending, this.size);
    this.pending = [];
    this.size = 0;
    this.overflow = 0;
    if (overflow) {
      out.push({
        ok: false,
        error: `Message too large: ${overflow} bytes, over ${this.maxBytes}.`,
      });
      return;
    }
    if (!line.toString("utf8").trim()) return;
    out.push(decodeJson(line, this.maxBytes));
  }
}

/** The snapshot a hello or update carries, read as pi-surface reads deliveries, or undefined. */
export function readSnapshot(value: unknown): DeliverySnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  return readDeliverySnapshot((value as { snapshot?: unknown }).snapshot);
}

/** A page or hub request as the reporter accepts it, or undefined. */
export function readCommand(value: unknown): CommandRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { command?: unknown; action?: unknown; args?: unknown };
  if (raw.command === "focus") return { command: "focus" };
  if (raw.command !== "action" || typeof raw.action !== "string" || !ACTION_ID.test(raw.action))
    return undefined;
  if (raw.args !== undefined && !isJsonValue(raw.args)) return undefined;
  return {
    command: "action",
    action: raw.action,
    ...(raw.args === undefined ? {} : { args: raw.args }),
  };
}

/** At most `MAX_VIEW_ERROR` characters of an error message. */
export function boundError(text: string): string {
  if (text.length <= MAX_VIEW_ERROR) return text;
  let head = text.slice(0, MAX_VIEW_ERROR - 1);
  // Never end in half a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…`;
}

/**
 * Every action a set of views offers a consumer: an explorer's `onOpen`,
 * `loadDetail` and marker `onClear`, and each form questionnaire's `submit`
 * and `cancel`. The hub runs only these for the page, so a page can do what
 * the session's views offer and nothing else.
 */
export function offeredActions(views: readonly ViewEntry[]): Set<string> {
  const offered = new Set<string>();
  for (const entry of views) {
    if (entry.model === undefined) continue;
    if (entry.kind === "explorer") {
      const { onOpen, loadDetail, marker } = entry.model;
      for (const ref of [onOpen, loadDetail, marker?.onClear]) if (ref) offered.add(ref.action);
    } else if (entry.kind === "form") {
      for (const questionnaire of entry.model.questionnaires) {
        offered.add(questionnaire.submit.action);
        offered.add(questionnaire.cancel.action);
      }
    }
  }
  return offered;
}
