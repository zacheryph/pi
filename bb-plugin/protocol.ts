// The plugin's side of the wire to pi-bb (extensions/pi-bb/src/protocol.ts).
// Every message from a session is untrusted: parse it here, then pass typed values on.
import type { SessionSnapshot, SurfaceRequest } from "./contract.ts";

export const PROTOCOL_VERSION = 1;
export const ENV_URL = "PI_BB_SURFACE_URL";
export const ENV_TOKEN = "PI_BB_SURFACE_TOKEN";
/** WebSocket route; bb mounts it at `/api/v1/plugins/<id>/http/session`. */
export const SESSION_PATH = "/session";

export const CLOSE_UNSUPPORTED = 4400;
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_REPLACED = 4409;

/** Largest message accepted from a session; pi-presentation bounds every section well below. */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export type SessionMessage =
  | { type: "hello"; version: number; threadId: string; token: string; snapshot: SessionSnapshot }
  | { type: "update"; snapshot: SessionSnapshot }
  | { type: "bye"; reason: "quit" | "replace" }
  | { type: "result"; id: number; ok: boolean; error?: string; data?: unknown };

export type PluginMessage = { type: "request"; id: number; request: SurfaceRequest };

export function encode(message: PluginMessage): string {
  return JSON.stringify(message);
}

/** The fields every renderer relies on; the rest is optional by contract. */
export function isSnapshot(value: unknown): value is SessionSnapshot {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  const status = raw.status as Record<string, unknown> | undefined;
  return (
    typeof raw.id === "string" &&
    raw.id.length > 0 &&
    raw.id.length <= 128 &&
    typeof raw.sessionId === "string" &&
    typeof raw.cwd === "string" &&
    Number.isFinite(raw.startedAt) &&
    !!status &&
    typeof status.kind === "string" &&
    Number.isFinite(status.since)
  );
}

export function parseSessionMessage(data: string | Uint8Array): SessionMessage | undefined {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  if (text.length > MAX_MESSAGE_BYTES) return undefined;
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  switch (raw.type) {
    case "hello":
      return typeof raw.version === "number" &&
        typeof raw.threadId === "string" &&
        typeof raw.token === "string" &&
        isSnapshot(raw.snapshot)
        ? {
            type: "hello",
            version: raw.version,
            threadId: raw.threadId,
            token: raw.token,
            snapshot: raw.snapshot,
          }
        : undefined;
    case "update":
      return isSnapshot(raw.snapshot) ? { type: "update", snapshot: raw.snapshot } : undefined;
    case "bye":
      return { type: "bye", reason: raw.reason === "replace" ? "replace" : "quit" };
    case "result":
      return Number.isSafeInteger(raw.id) && typeof raw.ok === "boolean"
        ? {
            type: "result",
            id: raw.id as number,
            ok: raw.ok,
            ...(typeof raw.error === "string" ? { error: raw.error } : {}),
            ...("data" in raw ? { data: raw.data } : {}),
          }
        : undefined;
    default:
      return undefined;
  }
}
