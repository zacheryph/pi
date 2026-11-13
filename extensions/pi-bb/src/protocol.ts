// The wire between pi-bb (inside Pi) and the pi-surface bb plugin's server.
// The plugin keeps its own copy of these shapes and validates every message;
// change both sides together and bump PROTOCOL_VERSION.

import type { QuestionnaireAnswer, SessionSnapshot } from "#presentation/contract";

export const PROTOCOL_VERSION = 1;

/** Environment the plugin contributes to every Pi thread through `experimental_contributeEnv`. */
export const ENV_URL = "PI_BB_SURFACE_URL";
export const ENV_TOKEN = "PI_BB_SURFACE_TOKEN";
/** Set by bb's Pi provider for every thread. */
export const ENV_THREAD = "BB_THREAD_ID";

/** Close codes the plugin uses when it refuses a session; the client stops retrying on these. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_UNSUPPORTED = 4400;
/** A newer connection for the same thread took over. */
export const CLOSE_REPLACED = 4409;
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED,
  CLOSE_REPLACED,
]);

/** Requests the plugin forwards from bb's UI; answered only to the socket that asked. */
export type SurfaceRequest =
  | { command: "stash-preview"; name: string }
  | { command: "todo-history"; key: string }
  /** `question` is the questionnaire's id (its tool call id). */
  | { command: "answer"; question: string; answer: QuestionnaireAnswer };

/** Pi to plugin. `hello` is the first message and authenticates the socket. */
export type SessionMessage =
  | {
      type: "hello";
      version: number;
      threadId: string;
      token: string;
      snapshot: SessionSnapshot;
    }
  | { type: "update"; snapshot: SessionSnapshot }
  /** `replace`: /new, /resume, /fork or /reload; the same process reconnects shortly. */
  | { type: "bye"; reason: "quit" | "replace" }
  | { type: "result"; id: number; ok: boolean; error?: string; data?: unknown };

/** Plugin to Pi. */
export type PluginMessage = { type: "request"; id: number; request: SurfaceRequest };

export function encode(message: SessionMessage): string {
  return JSON.stringify(message);
}

/** Reads a plugin message; anything malformed is dropped. */
export function parsePluginMessage(data: unknown): PluginMessage | undefined {
  if (typeof data !== "string") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  const message = raw as { type?: unknown; id?: unknown; request?: unknown } | null;
  if (message?.type !== "request" || !Number.isSafeInteger(message.id)) return undefined;
  const request = parseRequest(message.request);
  return request ? { type: "request", id: message.id as number, request } : undefined;
}

function parseRequest(value: unknown): SurfaceRequest | undefined {
  const raw = value as {
    command?: unknown;
    name?: unknown;
    key?: unknown;
    question?: unknown;
    answer?: unknown;
  } | null;
  if (raw?.command === "stash-preview" && typeof raw.name === "string")
    return { command: "stash-preview", name: raw.name };
  if (raw?.command === "todo-history" && typeof raw.key === "string")
    return { command: "todo-history", key: raw.key };
  // pi-ask checks the answer against its questionnaire.
  if (raw?.command === "answer" && typeof raw.question === "string")
    return { command: "answer", question: raw.question, answer: raw.answer as QuestionnaireAnswer };
  return undefined;
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
