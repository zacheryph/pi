import { errorText } from "#foundations/errors";
import type { SessionSnapshot } from "#presentation/contract";
import {
  encode,
  parsePluginMessage,
  PROTOCOL_VERSION,
  TERMINAL_CLOSE_CODES,
  type SessionMessage,
  type SurfaceEnv,
  type SurfaceRequest,
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
  | { kind: "connecting"; attempts: number }
  | { kind: "connected"; since: number }
  /** The plugin refused this session; retrying cannot help until Pi restarts with new settings. */
  | { kind: "refused"; code: number; reason: string }
  | { kind: "closed" };

export interface SurfaceClientOptions {
  endpoint: SurfaceEnv;
  /** Answers a request the plugin forwarded from bb's UI; rejects with a message the UI shows. */
  onRequest: (request: SurfaceRequest) => Promise<unknown>;
  socket?: SocketFactory;
  minDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
}

const OPEN = 1;

/**
 * Keeps one Pi session connected to the plugin. The socket is the session's
 * liveness signal: the plugin drops the session a short grace after it closes.
 * Nothing here throws into Pi; failures turn into reconnects.
 */
export class SurfaceClient {
  private readonly options: SurfaceClientOptions;
  private socket?: SocketLike;
  private snapshot?: SessionSnapshot;
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

  start(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    this.connect();
  }

  update(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    this.send({ type: "update", snapshot });
  }

  /** Idempotent; `replace` tells the plugin the same process reconnects shortly. */
  close(reason: "quit" | "replace"): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retry);
    this.status = { kind: "closed" };
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    try {
      if (socket.readyState === OPEN) socket.send(encode({ type: "bye", reason }));
      socket.close(1000, reason);
    } catch {
      /* already closing */
    }
  }

  private send(message: SessionMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    try {
      socket.send(encode(message));
    } catch {
      /* the close handler reconnects */
    }
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
    socket.addEventListener("open", () => {
      if (this.stopped) {
        socket.close(1000, "quit");
        return;
      }
      this.attempts = 0;
      this.socket = socket;
      this.status = { kind: "connected", since: this.options.now?.() ?? Date.now() };
      if (!this.snapshot) return;
      const { threadId, token } = this.options.endpoint;
      this.send({
        type: "hello",
        version: PROTOCOL_VERSION,
        threadId,
        token,
        snapshot: this.snapshot,
      });
    });
    socket.addEventListener("message", (event) => this.receive(socket, event.data));
    // Errors are followed by close, which decides what happens next.
    socket.addEventListener("error", () => {});
    socket.addEventListener("close", (event) => {
      if (this.socket === socket) this.socket = undefined;
      if (this.stopped) return;
      if (TERMINAL_CLOSE_CODES.has(event.code)) {
        this.status = { kind: "refused", code: event.code, reason: event.reason };
        return;
      }
      this.scheduleRetry();
    });
  }

  private receive(socket: SocketLike, data: unknown): void {
    const message = parsePluginMessage(data);
    if (!message) return;
    const { id } = message;
    const reply = (result: { error: string } | { data: unknown }) => {
      if (socket !== this.socket) return;
      this.send(
        "error" in result
          ? { type: "result", id, ok: false, error: result.error }
          : {
              type: "result",
              id,
              ok: true,
              ...(result.data === undefined ? {} : { data: result.data }),
            },
      );
    };
    let pending: Promise<unknown>;
    try {
      pending = this.options.onRequest(message.request);
    } catch (error) {
      reply({ error: errorText(error) });
      return;
    }
    pending.then(
      (result) => reply({ data: result }),
      (error: unknown) => reply({ error: errorText(error) }),
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
