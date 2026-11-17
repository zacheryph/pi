// The plugin's side of the wire to pi-bb (extensions/pi-bb/src/protocol.ts).
// Every message from a session is untrusted: parse it here, then pass typed values on.
import { BB_MESSAGE_BYTES, decodeJson } from "pi-surface/bytes";
import {
  isActionResult,
  readDeliverySnapshot,
  type ActionRequest,
  type ActionResult,
  type DeliverySnapshot,
} from "pi-surface/delivery";

/**
 * 3: a snapshot is pi-surface's `DeliverySnapshot`, requests are action
 * requests, and the plugin welcomes an accepted session.
 */
export const PROTOCOL_VERSION = 3;
export const ENV_URL = "PI_BB_SURFACE_URL";
export const ENV_TOKEN = "PI_BB_SURFACE_TOKEN";
/** WebSocket route; bb mounts it at `/api/v1/plugins/<id>/http/session`. */
export const SESSION_PATH = "/session";

export const CLOSE_UNSUPPORTED = 4400;
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_REPLACED = 4409;

/** Largest message accepted from a session, in UTF-8 bytes; pi-bb fits every snapshot to it. */
export const MAX_MESSAGE_BYTES = BB_MESSAGE_BYTES;
const MAX_TOKEN = 512;

export type SessionMessage =
  | {
      type: "hello";
      version: number;
      threadId: string;
      token: string;
      snapshot: DeliverySnapshot;
    }
  | { type: "update"; snapshot: DeliverySnapshot }
  | { type: "bye"; reason: "quit" | "replace" }
  | ({ type: "result"; id: number } & ActionResult);

export type PluginMessage =
  | { type: "welcome"; version: number }
  | { type: "request"; id: number; request: ActionRequest };

/**
 * What reading a session's message gave: the message; a hello of another
 * protocol version, whose snapshot is not read (the session is refused with
 * 4400); or why it could not be read.
 */
export type ParsedMessage =
  | { ok: true; message: SessionMessage }
  | { ok: true; unsupported: number }
  | { ok: false; error: string };

export function encode(message: PluginMessage): string {
  return JSON.stringify(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly the message's own keys, so another shape is never half-read. */
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const isThreadId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

const malformed = (what: string): ParsedMessage => ({ ok: false, error: `Malformed ${what}.` });

function snapshotOf(value: unknown): DeliverySnapshot | undefined {
  // Tolerant of a kind this copy does not draw: it is left out, never the whole snapshot.
  return readDeliverySnapshot(value);
}

/**
 * One message from a session, checked before parsing against
 * `MAX_MESSAGE_BYTES` of UTF-8 (never `String.length`), then strictly by type.
 */
export function parseSessionMessage(data: string | Uint8Array): ParsedMessage {
  const decoded = decodeJson(data, MAX_MESSAGE_BYTES);
  if (!decoded.ok) return decoded;
  const raw = decoded.value;
  if (!isRecord(raw)) return malformed("message");
  switch (raw.type) {
    case "hello": {
      if (!Number.isSafeInteger(raw.version)) return malformed("hello");
      // Another version's snapshot has another shape: say so instead of reading it.
      if (raw.version !== PROTOCOL_VERSION) return { ok: true, unsupported: raw.version as number };
      if (!hasKeys(raw, ["type", "version", "threadId", "token", "snapshot"]))
        return malformed("hello");
      const snapshot = snapshotOf(raw.snapshot);
      if (
        !isThreadId(raw.threadId) ||
        typeof raw.token !== "string" ||
        raw.token.length > MAX_TOKEN ||
        !snapshot
      )
        return malformed("hello");
      return {
        ok: true,
        message: {
          type: "hello",
          version: raw.version,
          threadId: raw.threadId,
          token: raw.token,
          snapshot,
        },
      };
    }
    case "update": {
      const snapshot = hasKeys(raw, ["type", "snapshot"]) ? snapshotOf(raw.snapshot) : undefined;
      return snapshot ? { ok: true, message: { type: "update", snapshot } } : malformed("update");
    }
    case "bye":
      return hasKeys(raw, ["type", "reason"]) && (raw.reason === "quit" || raw.reason === "replace")
        ? { ok: true, message: { type: "bye", reason: raw.reason } }
        : malformed("bye");
    case "result": {
      const { type: _type, id, ...result } = raw;
      return Number.isSafeInteger(id) &&
        isActionResult(result) &&
        hasKeys(result, ["ok", "value", "error"])
        ? { ok: true, message: { type: "result", id: id as number, ...result } }
        : malformed("result");
    }
    default:
      return malformed("message");
  }
}
