// The wire between pi-bb (inside Pi) and the pi-surface bb plugin's server.
// The plugin keeps its own copy of these shapes (bb-plugin/protocol.ts) and
// checks every message; change both sides together and bump PROTOCOL_VERSION.

import {
  isActionRequest,
  utf8Bytes,
  type ActionRequest,
  type ActionResult,
  type DeliverySnapshot,
} from "#surface";

/**
 * 3: a snapshot is pi-surface's `DeliverySnapshot` (every collected view, the
 * session's core state included as the `system.session` view); requests are
 * action requests; the plugin welcomes an accepted session.
 */
export const PROTOCOL_VERSION = 3;

/** Environment the plugin contributes to every Pi thread through `experimental_contributeEnv`. */
export const ENV_URL = "PI_BB_SURFACE_URL";
export const ENV_TOKEN = "PI_BB_SURFACE_TOKEN";
/** Set by bb's Pi provider for every thread. */
export const ENV_THREAD = "BB_THREAD_ID";

/** Close codes the plugin uses when it refuses a session; the client stops retrying on these. */
export const CLOSE_UNAUTHORIZED = 4401;
/** The plugin speaks another protocol version: one side needs updating. */
export const CLOSE_UNSUPPORTED = 4400;
/** A newer connection for the same thread took over. */
export const CLOSE_REPLACED = 4409;
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED,
  CLOSE_REPLACED,
]);

/** Pi to plugin. `hello` is the first message and authenticates the socket. */
export type SessionMessage =
  | {
      type: "hello";
      version: number;
      threadId: string;
      token: string;
      snapshot: DeliverySnapshot;
    }
  | { type: "update"; snapshot: DeliverySnapshot }
  /** `replace`: /new, /resume, /fork or /reload; the same process reconnects shortly. */
  | { type: "bye"; reason: "quit" | "replace" }
  /** The answer to one `request`, sent only on the socket that asked. */
  | ({ type: "result"; id: number } & ActionResult);

/** Plugin to Pi. */
export type PluginMessage =
  /** The plugin accepted the hello: from now on it shows this session and may ask it to act. */
  { type: "welcome"; version: number } | { type: "request"; id: number; request: ActionRequest };

/**
 * A hello or an update, around a snapshot's JSON as `collectDelivery` measured
 * it: the snapshot is embedded as is, never encoded a second time.
 */
export function encodeSnapshotMessage(
  message:
    | { type: "hello"; threadId: string; token: string; snapshot: string }
    | { type: "update"; snapshot: string },
): string {
  const { snapshot, ...head } = message;
  const fields = head.type === "hello" ? { ...head, version: PROTOCOL_VERSION } : head;
  return `${JSON.stringify(fields).slice(0, -1)},"snapshot":${snapshot}}`;
}

/**
 * The bytes a hello adds around its snapshot, the largest framing a snapshot
 * travels in: what a collection reserves of the plugin's message limit.
 */
export function helloFramingBytes(threadId: string, token: string): number {
  return utf8Bytes(encodeSnapshotMessage({ type: "hello", threadId, token, snapshot: "" }));
}

export function encode(
  message: Extract<SessionMessage, { type: "bye" }> | Extract<SessionMessage, { type: "result" }>,
): string {
  return JSON.stringify(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly these keys, so a message of another shape is never half-read. */
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Reads a plugin message strictly; anything malformed is dropped. */
export function parsePluginMessage(data: unknown): PluginMessage | undefined {
  if (typeof data !== "string") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  if (raw.type === "welcome")
    return hasKeys(raw, ["type", "version"]) && Number.isSafeInteger(raw.version)
      ? { type: "welcome", version: raw.version as number }
      : undefined;
  if (raw.type !== "request" || !hasKeys(raw, ["type", "id", "request"])) return undefined;
  if (!Number.isSafeInteger(raw.id)) return undefined;
  const request = raw.request;
  // The arguments are JSON; the action checks them.
  if (!isActionRequest(request) || !hasKeys(request, ["action", "args"])) return undefined;
  return {
    type: "request",
    id: raw.id as number,
    request: request.args === undefined ? { action: request.action } : request,
  };
}

/** The plugin's session endpoint as a WebSocket URL; bb hands the extension an http(s) URL. */
export function socketUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export interface SurfaceEnv {
  url: string;
  token: string;
  threadId: string;
}

/** The plugin endpoint, when bb runs this Pi for a thread and the plugin is installed. */
export function readSurfaceEnv(env: NodeJS.ProcessEnv): SurfaceEnv | undefined {
  const threadId = env[ENV_THREAD]?.trim();
  const token = env[ENV_TOKEN]?.trim();
  const url = env[ENV_URL] ? socketUrl(env[ENV_URL].trim()) : undefined;
  if (!threadId || !token || !url) return undefined;
  return { url, token, threadId };
}
