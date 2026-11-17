import { errorText } from "#foundations/errors";
import { MAX_VIEW_ERROR, type ActionRequest, type JsonValue } from "#surface";
import {
  CLOSE_UNSUPPORTED,
  encode,
  encodeSnapshotMessage,
  parsePluginMessage,
  PROTOCOL_VERSION,
  TERMINAL_CLOSE_CODES,
  type SessionMessage,
  type SurfaceEnv,
} from "#src/protocol";

/** The part of the WHATWG WebSocket the client uses; Node's global `WebSocket` satisfies it. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export type ConnectionState =
  /** No socket, or one that has not been welcomed yet. */
  | { kind: "connecting"; attempts: number }
  /** The plugin accepted the hello. */
  | { kind: "connected"; since: number }
  /** The plugin refused this session; retrying cannot help until Pi restarts with new settings. */
  | { kind: "refused"; code: number; reason: string }
  | { kind: "closed" };

export interface SurfaceClientOptions {
  endpoint: SurfaceEnv;
  /** Runs an action the plugin forwarded from bb's UI; rejects with a message the UI shows. */
  onRequest: (request: ActionRequest) => Promise<JsonValue | undefined>;
  /** The plugin accepted this session: bb shows it and can answer its forms. */
  onAccepted?: () => void;
  /** The accepted connection is gone: closed, refused, replaced or stopped. */
  onLost?: () => void;
  socket?: SocketFactory;
  minDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
}

const OPEN = 1;

/** At most `MAX_VIEW_ERROR` units, never ending in half a surrogate pair, never blank. */
function boundedError(error: unknown): string {
  const text = errorText(error).trim() || "The action failed.";
  if (text.length <= MAX_VIEW_ERROR) return text;
  const cut = text.slice(0, MAX_VIEW_ERROR);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Keeps one Pi session connected to the plugin. The socket is the session's
 * liveness signal: the plugin drops the session a short grace after it closes.
 * Snapshots arrive as JSON (see `collectDelivery`); the client keeps only the
 * latest, says hello with it on every connect and sends later ones once the
 * plugin has welcomed the session. Nothing here throws into Pi; failures turn
 * into reconnects.
 */
export class SurfaceClient {
  private readonly options: SurfaceClientOptions;
  /** The newest socket, from its creation until it closes. */
  private socket?: SocketLike;
  /** The latest snapshot's JSON, and the one the plugin last received. */
  private latest?: string;
  private delivered?: string;
  private helloSent = false;
  private accepted = false;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private stopped = false;
  private status: ConnectionState = { kind: "connecting", attempts: 0 };

  constructor(options: SurfaceClientOptions) {
    this.options = options;
  }

  get state(): ConnectionState {
    return this.status;
  }

  start(): void {
    this.connect();
  }

  /** The session's current snapshot, as JSON; replaces any earlier one. */
  update(snapshot: string): void {
    this.latest = snapshot;
    if (this.accepted) this.deliver();
    else if (this.socket && !this.helloSent) this.hello(this.socket);
  }

  /** Idempotent; `replace` tells the plugin the same process reconnects shortly. */
  close(reason: "quit" | "replace"): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retry);
    this.status = { kind: "closed" };
    const socket = this.socket;
    this.socket = undefined;
    this.lose();
    if (!socket) return;
    try {
      if (socket.readyState === OPEN) socket.send(encode({ type: "bye", reason }));
      socket.close(1000, reason);
    } catch {
      /* already closing */
    }
  }

  private lose(): void {
    if (!this.accepted) return;
    this.accepted = false;
    this.options.onLost?.();
  }

  private send(socket: SocketLike, data: string): boolean {
    if (socket !== this.socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(data);
      return true;
    } catch {
      /* the close handler reconnects */
      return false;
    }
  }

  private hello(socket: SocketLike): void {
    const snapshot = this.latest;
    if (snapshot === undefined) return;
    const { threadId, token } = this.options.endpoint;
    if (this.send(socket, encodeSnapshotMessage({ type: "hello", threadId, token, snapshot }))) {
      this.helloSent = true;
      this.delivered = snapshot;
    }
  }

  private deliver(): void {
    const snapshot = this.latest;
    const socket = this.socket;
    if (!socket || snapshot === undefined || snapshot === this.delivered) return;
    if (this.send(socket, encodeSnapshotMessage({ type: "update", snapshot })))
      this.delivered = snapshot;
  }

  private connect(): void {
    if (this.stopped) return;
    this.status = { kind: "connecting", attempts: this.attempts };
    let socket: SocketLike;
    try {
      socket = (this.options.socket ?? ((url) => new WebSocket(url)))(this.options.endpoint.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    this.helloSent = false;
    this.delivered = undefined;
    socket.addEventListener("open", () => {
      if (this.stopped) {
        socket.close(1000, "quit");
        return;
      }
      this.hello(socket);
    });
    socket.addEventListener("message", (event) => this.receive(socket, event.data));
    // Errors are followed by close, which decides what happens next.
    socket.addEventListener("error", () => {});
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.lose();
      if (this.stopped) return;
      if (TERMINAL_CLOSE_CODES.has(event.code)) {
        this.status = { kind: "refused", code: event.code, reason: event.reason };
        return;
      }
      this.scheduleRetry();
    });
  }

  private receive(socket: SocketLike, data: unknown): void {
    if (socket !== this.socket) return;
    const message = parsePluginMessage(data);
    if (!message) return;
    if (message.type === "welcome") {
      if (this.accepted) return;
      if (message.version !== PROTOCOL_VERSION) {
        // A plugin that welcomes another version cannot read this session's snapshots.
        const reason = `protocol ${PROTOCOL_VERSION} expected, the plugin speaks ${message.version}`;
        this.status = { kind: "refused", code: CLOSE_UNSUPPORTED, reason };
        this.socket = undefined;
        this.stopped = true;
        socket.close(1000, "unsupported");
        return;
      }
      this.attempts = 0;
      this.accepted = true;
      this.status = { kind: "connected", since: this.options.now?.() ?? Date.now() };
      // Anything collected after the hello went out.
      this.deliver();
      this.options.onAccepted?.();
      return;
    }
    // The plugin asks only once it has accepted the session.
    if (!this.accepted) return;
    const { id } = message;
    const reply = (result: Extract<SessionMessage, { type: "result" }>) => {
      // Only the socket that asked hears the answer; a replacement never does.
      if (socket === this.socket && this.accepted) this.send(socket, encode(result));
    };
    let pending: Promise<JsonValue | undefined>;
    try {
      pending = this.options.onRequest(message.request);
    } catch (error) {
      reply({ type: "result", id, ok: false, error: boundedError(error) });
      return;
    }
    pending.then(
      (value) => reply({ type: "result", id, ok: true, ...(value === undefined ? {} : { value }) }),
      (error: unknown) => reply({ type: "result", id, ok: false, error: boundedError(error) }),
    );
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.attempts += 1;
    this.status = { kind: "connecting", attempts: this.attempts };
    const min = this.options.minDelayMs ?? 500;
    const delay = Math.min(
      min * 2 ** Math.min(this.attempts - 1, 10),
      this.options.maxDelayMs ?? 30_000,
    );
    this.retry = setTimeout(() => this.connect(), delay);
    // Never keep Pi alive just for bb.
    this.retry.unref?.();
  }
}
