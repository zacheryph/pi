import { connect as netConnect, type Socket } from "node:net";
import {
  encode, LineDecoder, PROTOCOL_VERSION, type CommandRequest, type QuestionnaireAnswer, type ReporterMessage, type SessionSnapshot,
} from "./protocol.ts";

export interface ReporterOptions {
  socketPath: string;
  /** Starts a hub; called when nothing listens on the socket. */
  spawnHub: () => void;
  /** Runs a request the hub forwarded from the page; rejects with a message the page shows. */
  onCommand?: (request: CommandRequest) => Promise<unknown>;
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

function parseRequest(message: unknown): CommandRequest | undefined {
  const raw = message as { command?: unknown; name?: unknown; key?: unknown; question?: unknown; answer?: unknown };
  if (raw.command === "focus") return { command: "focus" };
  if (raw.command === "stash-preview" && typeof raw.name === "string") return { command: "stash-preview", name: raw.name };
  if (raw.command === "todo-history" && typeof raw.key === "string") return { command: "todo-history", key: raw.key };
  // The answer's shape is checked against its questionnaire by the extension.
  if (raw.command === "answer" && typeof raw.question === "string") return { command: "answer", question: raw.question, answer: raw.answer as QuestionnaireAnswer };
  return undefined;
}

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
    const raw = message as { type?: unknown; id?: unknown } | null;
    if (raw?.type !== "command" || typeof raw.id !== "number") return;
    const id = raw.id;
    const reply = (result: { error: string } | { data: unknown }) => {
      if (socket !== this.socket || socket.destroyed) return;
      socket.write(encode("error" in result
        ? { type: "result", id, ok: false, error: result.error }
        : { type: "result", id, ok: true, ...(result.data === undefined ? {} : { data: result.data }) }));
    };
    const request = parseRequest(message);
    const handler = this.options.onCommand;
    if (!request || !handler) return reply({ error: "This session cannot do that." });
    handler(request).then(
      (data) => reply({ data }),
      (error: unknown) => reply({ error: error instanceof Error ? error.message : String(error) }),
    );
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
