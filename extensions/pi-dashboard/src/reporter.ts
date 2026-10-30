import { connect as netConnect, type Socket } from "node:net";
import { encode, LineDecoder, PROTOCOL_VERSION, type HubCommand, type ReporterMessage, type SessionSnapshot } from "./protocol.ts";

export interface ReporterOptions {
  socketPath: string;
  /** Starts a hub; called when nothing listens on the socket. */
  spawnHub: () => void;
  /** Runs a command the hub forwarded from the page; resolves with an error message on failure. */
  onCommand?: (command: HubCommand["command"]) => Promise<string | undefined>;
  /** Called once when the hub stays unreachable after `unavailableAfter` attempts. */
  onUnavailable?: () => void;
  unavailableAfter?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Minimum time between spawn attempts, so a hub that cannot start is not respawned in a loop. */
  spawnIntervalMs?: number;
  now?: () => number;
}

const NO_LISTENER = new Set(["ENOENT", "ECONNREFUSED"]);

/**
 * Keeps one Pi session connected to the hub. The connection is the session's
 * liveness signal: the hub drops the card when it closes without a `bye`.
 */
export class Reporter {
  private readonly options: ReporterOptions;
  private socket?: Socket;
  private snapshot?: SessionSnapshot;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private lastSpawn = Number.NEGATIVE_INFINITY;
  private reported = false;
  private closed = false;

  constructor(options: ReporterOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return !!this.socket;
  }

  start(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    this.connect();
  }

  update(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    this.send({ type: "update", snapshot });
  }

  close(reason: "quit" | "replace"): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = undefined;
    if (socket && !socket.destroyed) socket.end(encode({ type: "bye", reason }));
  }

  private send(message: ReporterMessage): void {
    if (this.socket && !this.socket.destroyed) this.socket.write(encode(message));
  }

  private connect(): void {
    if (this.closed) return;
    const socket = netConnect(this.options.socketPath);
    // Never keep Pi alive just for the dashboard.
    socket.unref();
    let failure: string | undefined;
    socket.once("connect", () => {
      if (this.closed) { socket.destroy(); return; }
      this.attempts = 0;
      this.socket = socket;
      if (this.snapshot) this.send({ type: "hello", version: PROTOCOL_VERSION, snapshot: this.snapshot });
    });
    const decoder = new LineDecoder();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const message of decoder.push(chunk)) this.receive(socket, message);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => { failure = error.code; });
    socket.once("close", () => {
      if (this.socket === socket) this.socket = undefined;
      if (!this.closed) this.scheduleRetry(failure);
    });
  }

  private receive(socket: Socket, message: unknown): void {
    const raw = message as Partial<HubCommand> | null;
    if (raw?.type !== "command" || typeof raw.id !== "number" || raw.command !== "focus") return;
    const id = raw.id;
    const reply = (error?: string) => {
      if (socket === this.socket && !socket.destroyed) {
        socket.write(encode({ type: "result", id, ok: !error, ...(error ? { error } : {}) }));
      }
    };
    const handler = this.options.onCommand;
    if (!handler) return reply("This session cannot do that.");
    handler(raw.command).then(reply, (error: unknown) => reply(error instanceof Error ? error.message : String(error)));
  }

  private scheduleRetry(failure: string | undefined): void {
    const now = this.options.now?.() ?? Date.now();
    if (failure && NO_LISTENER.has(failure) && now - this.lastSpawn >= (this.options.spawnIntervalMs ?? 10_000)) {
      this.lastSpawn = now;
      try { this.options.spawnHub(); } catch { /* retried on the next interval */ }
    }
    this.attempts += 1;
    if (!this.reported && this.attempts >= (this.options.unavailableAfter ?? 8)) {
      this.reported = true;
      this.options.onUnavailable?.();
    }
    const min = this.options.minDelayMs ?? 250;
    const delay = Math.min(min * 2 ** Math.min(this.attempts - 1, 10), this.options.maxDelayMs ?? 30_000);
    this.retry = setTimeout(() => this.connect(), delay);
    this.retry.unref?.();
  }
}
