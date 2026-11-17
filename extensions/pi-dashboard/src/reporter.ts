import { errorText } from "#foundations/errors";
import { connect as netConnect, type Socket } from "node:net";
import { utf8Bytes } from "#surface";
import {
  boundError,
  encode,
  LineDecoder,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  readCommand,
  snapshotLine,
  type CommandRequest,
  type JsonValue,
  type ReporterMessage,
} from "#src/protocol";

export interface ReporterOptions {
  socketPath: string;
  /** Starts a hub; called when nothing listens on the socket. */
  spawnHub: () => void;
  /** Runs a request the hub forwarded from the page; rejects with a message the page shows. */
  onCommand?: (request: CommandRequest) => Promise<JsonValue | undefined>;
  /** The hub accepted this session and speaks this reporter's protocol. */
  onConnected?: () => void;
  /** The connection the hub accepted has closed; called once per `onConnected`. */
  onDisconnected?: () => void;
  /** The hub refused this session, with its reason; it is retried like an unreachable hub. */
  onRefused?: (reason: string) => void;
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
 * Snapshots arrive as JSON text already measured against the hub's line limit.
 */
export class Reporter {
  private readonly options: ReporterOptions;
  private socket?: Socket;
  private snapshot?: string;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private lastSpawn = Number.NEGATIVE_INFINITY;
  private reported = false;
  private closed = false;
  private welcomed = false;

  constructor(options: ReporterOptions) {
    this.options = options;
  }

  /** Whether a hub has accepted this session on the current connection. */
  get connected(): boolean {
    return this.welcomed;
  }

  /** Connects, saying hello with the latest snapshot given to `update`. */
  start(): void {
    this.connect();
  }

  /** Replaces the session's snapshot: its JSON, from `collectDelivery`. */
  update(snapshotJson: string): void {
    this.snapshot = snapshotJson;
    this.write(snapshotLine("update", snapshotJson));
  }

  close(reason: "quit" | "replace"): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = undefined;
    this.disconnected();
    if (socket && !socket.destroyed) socket.end(encode({ type: "bye", reason }));
  }

  private write(line: string): void {
    if (this.socket && !this.socket.destroyed) this.socket.write(line);
  }

  private disconnected(): void {
    if (!this.welcomed) return;
    this.welcomed = false;
    this.options.onDisconnected?.();
  }

  private connect(): void {
    if (this.closed) return;
    const socket = netConnect(this.options.socketPath);
    // Never keep Pi alive just for the dashboard.
    socket.unref();
    let failure: string | undefined;
    socket.once("connect", () => {
      if (this.closed) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      if (this.snapshot !== undefined) this.write(snapshotLine("hello", this.snapshot));
    });
    const decoder = new LineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const decoded of decoder.push(chunk))
        if (decoded.ok) this.receive(socket, decoded.value);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      failure = error.code;
    });
    socket.once("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.disconnected();
      }
      if (!this.closed) this.scheduleRetry(failure);
    });
  }

  private receive(socket: Socket, message: unknown): void {
    if (socket !== this.socket) return;
    const raw = message as { type?: unknown; id?: unknown; version?: unknown; error?: unknown };
    if (raw?.type === "welcome") {
      if (raw.version !== PROTOCOL_VERSION || this.welcomed) return;
      // Only an accepted connection resets the backoff: a hub that refuses is retried slowly.
      this.attempts = 0;
      this.welcomed = true;
      this.options.onConnected?.();
      return;
    }
    if (raw?.type === "refused") {
      // The refusal says more than "did not start" would.
      this.reported = true;
      this.options.onRefused?.(
        typeof raw.error === "string"
          ? boundError(raw.error)
          : "The dashboard refused this session.",
      );
      return;
    }
    if (raw?.type !== "command" || typeof raw.id !== "number") return;
    const id = raw.id;
    const reply = (result: { error: string } | { data: JsonValue | undefined }) => {
      if (socket !== this.socket || socket.destroyed) return;
      let message: ReporterMessage =
        "error" in result
          ? { type: "result", id, ok: false, error: boundError(result.error) }
          : {
              type: "result",
              id,
              ok: true,
              ...(result.data === undefined ? {} : { data: result.data }),
            };
      let line = encode(message);
      const bytes = utf8Bytes(line) - 1;
      if (bytes > MAX_LINE_BYTES) {
        message = {
          type: "result",
          id,
          ok: false,
          error: `The answer is too large to send to the dashboard: ${Math.ceil(bytes / 1024)} KB.`,
        };
        line = encode(message);
      }
      socket.write(line);
    };
    const request = readCommand(message);
    const handler = this.options.onCommand;
    if (!request || !handler) return reply({ error: "This session cannot do that." });
    handler(request).then(
      (data) => reply({ data }),
      (error: unknown) => reply({ error: errorText(error) }),
    );
  }

  private scheduleRetry(failure: string | undefined): void {
    const now = this.options.now?.() ?? Date.now();
    if (
      failure &&
      NO_LISTENER.has(failure) &&
      now - this.lastSpawn >= (this.options.spawnIntervalMs ?? 10_000)
    ) {
      this.lastSpawn = now;
      try {
        this.options.spawnHub();
      } catch {
        /* retried on the next interval */
      }
    }
    this.attempts += 1;
    if (!this.reported && this.attempts >= (this.options.unavailableAfter ?? 8)) {
      this.reported = true;
      this.options.onUnavailable?.();
    }
    const min = this.options.minDelayMs ?? 250;
    const delay = Math.min(
      min * 2 ** Math.min(this.attempts - 1, 10),
      this.options.maxDelayMs ?? 30_000,
    );
    this.retry = setTimeout(() => this.connect(), delay);
    this.retry.unref?.();
  }
}
