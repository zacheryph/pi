import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import {
  connect,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { homedir } from "node:os";
import { isActionRequest, settleSnapshot, type DeliverySnapshot } from "#surface";
import {
  encode,
  hubPaths,
  IDLE_GRACE_MS,
  LineDecoder,
  offeredActions,
  PROTOCOL_VERSION,
  readSnapshot,
  type CommandRequest,
  type HubMessage,
  type HubPaths,
  type JsonValue,
} from "#src/protocol";
import { renderPage } from "#src/hub/page";

export interface HubOptions {
  dir: string;
  /** 0 picks a free port. */
  port: number;
  idleGraceMs?: number;
  httpRetryMs?: number;
  /** How long a Focus request waits for the session to answer. */
  commandTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface CommandOutcome {
  status: number;
  ok: boolean;
  error?: string;
  data?: unknown;
}

type Answer = { ok: boolean; error?: string; data?: unknown; timedOut?: boolean };

/**
 * One session as the page sees it: the latest complete snapshot its reporter
 * sent. While the session restarts its runtime (/new, /resume, /fork, /reload)
 * the record is `disconnected` and settled: process-bound state is shown as
 * stopped, forms are gone and no action runs until the live session returns.
 */
export interface SessionRecord extends DeliverySnapshot {
  disconnected?: true;
}

export interface SessionsPayload {
  home: string;
  sessions: SessionRecord[];
}

interface Entry {
  snapshot: DeliverySnapshot;
  /** The live connection; absent while the session restarts. */
  socket?: Socket;
  expiry?: ReturnType<typeof setTimeout>;
}

const HEARTBEAT_MS = 25_000;
/** Action requests are the only bodies; a form answer with every note filled stays well under this. */
const MAX_BODY_BYTES = 64 * 1024;
const BROADCAST_DELAY_MS = 50;

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'",
};

/**
 * One hub per machine. Pi sessions connect over a unix socket and stream
 * snapshots; browsers read them over loopback HTTP and server-sent events.
 * Binding the socket is the startup lock, and the hub stops itself once no
 * session has been connected for the grace period.
 */
export class Hub {
  readonly paths: HubPaths;
  /** Required on state-changing requests; only the page served by this hub knows it. */
  readonly token = randomBytes(24).toString("base64url");
  httpPort?: number;
  httpError?: string;
  /** Resolves once the hub has stopped, by idle shutdown or stop(). */
  readonly closed: Promise<void>;

  private readonly port: number;
  private readonly idleGraceMs: number;
  private readonly httpRetryMs: number;
  private readonly commandTimeoutMs: number;
  /** Focus requests awaiting an answer, with the connection that must give it. */
  private readonly pending = new Map<
    number,
    { socket: Socket; finish: (result: Answer) => void }
  >();
  private nextCommand = 1;
  private readonly log: (line: string) => void;
  private readonly sessions = new Map<string, Entry>();
  private readonly connections = new Set<Socket>();
  private readonly reporters = new Set<Socket>();
  private readonly streams = new Set<ServerResponse>();
  private socketServer?: NetServer;
  private httpServer?: HttpServer;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private httpRetry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private broadcastTimer?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<void>;
  private resolveClosed: () => void = () => {};

  constructor(options: HubOptions) {
    this.paths = hubPaths(options.dir);
    this.port = options.port;
    this.idleGraceMs = options.idleGraceMs ?? IDLE_GRACE_MS;
    this.httpRetryMs = options.httpRetryMs ?? 5_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 12_000;
    this.log = options.log ?? (() => {});
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async start(): Promise<"started" | "already-running"> {
    mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 });
    const server = createNetServer((socket) => this.accept(socket));
    if (!(await listenExclusive(server, this.paths.socket))) return "already-running";
    try {
      chmodSync(this.paths.socket, 0o600);
    } catch {
      /* best effort; the directory is 0700 */
    }
    this.socketServer = server;
    this.armIdle();
    this.heartbeat = setInterval(() => {
      for (const stream of this.streams) stream.write(": ping\n\n");
    }, HEARTBEAT_MS);
    await this.listenHttp();
    return "started";
  }

  stop(reason = "stopped"): Promise<void> {
    return (this.stopping ??= (async () => {
      this.log(`stopping: ${reason}`);
      for (const timer of [this.idleTimer, this.httpRetry, this.broadcastTimer])
        clearTimeout(timer);
      clearInterval(this.heartbeat);
      for (const entry of this.sessions.values()) clearTimeout(entry.expiry);
      for (const { finish } of this.pending.values())
        finish({ ok: false, error: "The dashboard is shutting down." });
      this.pending.clear();
      for (const stream of this.streams) stream.end();
      this.streams.clear();
      for (const socket of this.connections) socket.destroy();
      // Node removes the socket file when the server closes.
      await Promise.all([closeServer(this.socketServer), closeServer(this.httpServer)]);
      this.resolveClosed();
    })());
  }

  list(): SessionsPayload {
    const sessions = [...this.sessions.values()]
      .map((entry): SessionRecord =>
        entry.socket ? { ...entry.snapshot } : { ...entry.snapshot, disconnected: true },
      )
      .sort(
        (a, b) =>
          sortKey(a).cwd.localeCompare(sortKey(b).cwd) ||
          sortKey(a).startedAt - sortKey(b).startedAt ||
          a.id.localeCompare(b.id),
      );
    return { home: homedir(), sessions };
  }

  private async listenHttp(): Promise<void> {
    const server = createHttpServer((request, response) => this.handle(request, response));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.httpError = error instanceof Error ? error.message : String(error);
      this.log(`http unavailable (${this.httpError}); retrying in ${this.httpRetryMs}ms`);
      if (!this.stopping)
        this.httpRetry = setTimeout(() => {
          this.httpRetry = undefined;
          void this.listenHttp();
        }, this.httpRetryMs);
      return;
    }
    if (this.stopping) {
      await closeServer(server);
      return;
    }
    this.httpServer = server;
    this.httpPort = (server.address() as AddressInfo).port;
    this.httpError = undefined;
    this.log(`listening on http://127.0.0.1:${this.httpPort}/`);
  }

  private accept(socket: Socket): void {
    const decoder = new LineDecoder();
    let id: string | undefined;
    let farewell: "quit" | "replace" | undefined;
    this.connections.add(socket);
    socket.on("error", () => {
      /* the close handler cleans up */
    });
    const send = (message: HubMessage) => {
      if (!socket.destroyed && !socket.writableEnded) socket.write(encode(message));
    };
    /** Says why, then closes: an older or broken reporter is never read as this protocol. */
    const refuse = (error: string) => {
      this.log(`refused a reporter: ${error}`);
      send({ type: "refused", version: PROTOCOL_VERSION, error });
      socket.end();
    };
    socket.on("data", (chunk: Buffer) => {
      for (const decoded of decoder.push(chunk)) {
        if (socket.destroyed || socket.writableEnded) return;
        if (!decoded.ok) {
          this.log(`dropped a line from ${id ?? "a reporter"}: ${decoded.error}`);
          continue;
        }
        const message = decoded.value;
        if (!message || typeof message !== "object") continue;
        const raw = message as { type?: unknown; version?: unknown; reason?: unknown };
        if (raw.type === "hello") {
          if (id) return refuse("A connection says hello once.");
          if (typeof raw.version !== "number")
            return refuse("Malformed hello: it names no protocol version.");
          if (raw.version > PROTOCOL_VERSION) {
            // A newer reporter brings a newer hub: step aside so it can start one.
            void this.stop(`reporter speaks protocol ${raw.version}`);
            return;
          }
          if (raw.version < PROTOCOL_VERSION)
            return refuse(
              `This dashboard speaks protocol ${PROTOCOL_VERSION}; the session speaks ${raw.version}. Restart that Pi session to update it.`,
            );
          const snapshot = readSnapshot(message);
          if (!snapshot) return refuse("Malformed hello: its snapshot is not a delivery snapshot.");
          id = snapshot.id;
          this.register(id, snapshot, socket);
          send({ type: "welcome", version: PROTOCOL_VERSION });
        } else if (!id) {
          return refuse("The first message must be a hello.");
        } else if (raw.type === "update") {
          const snapshot = readSnapshot(message);
          const entry = this.sessions.get(id);
          // Only the session's own live connection replaces its snapshot, and only as itself.
          if (snapshot?.id === id && entry?.socket === socket) {
            entry.snapshot = snapshot;
            this.scheduleBroadcast();
          }
        } else if (raw.type === "bye" && (raw.reason === "quit" || raw.reason === "replace")) {
          farewell = raw.reason;
        } else if (raw.type === "result") {
          const result = message as { id?: unknown; ok?: unknown; error?: unknown };
          const waiting = typeof result.id === "number" ? this.pending.get(result.id) : undefined;
          if (waiting?.socket === socket) {
            waiting.finish({
              ok: result.ok === true,
              ...(typeof result.error === "string" ? { error: result.error.slice(0, 500) } : {}),
              ...("data" in result ? { data: (result as { data?: unknown }).data } : {}),
            });
          }
        }
      }
    });
    socket.on("close", () => {
      this.connections.delete(socket);
      this.reporters.delete(socket);
      const entry = id ? this.sessions.get(id) : undefined;
      if (id && entry?.socket === socket) {
        entry.socket = undefined;
        if (farewell === "replace") {
          const key = id;
          // Shown as the session last was, settled: nothing in it runs or answers until it returns.
          entry.snapshot = settleSnapshot(entry.snapshot, Date.now());
          entry.expiry = setTimeout(() => {
            this.sessions.delete(key);
            this.scheduleBroadcast();
          }, this.idleGraceMs);
        } else {
          this.sessions.delete(id);
        }
        this.scheduleBroadcast();
      }
      if (!this.reporters.size) this.armIdle();
    });
  }

  /** Asks a session to bring its terminal to the front. */
  focus(sessionId: string): Promise<CommandOutcome> {
    return this.command(sessionId, { command: "focus" });
  }

  /** Runs an action one of the session's current views offers, such as a form's submit. */
  action(sessionId: string, action: string, args?: JsonValue): Promise<CommandOutcome> {
    return this.command(sessionId, {
      command: "action",
      action,
      ...(args === undefined ? {} : { args }),
    });
  }

  /** Relays one request to a session and returns its answer to the caller only. */
  async command(sessionId: string, request: CommandRequest): Promise<CommandOutcome> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { status: 404, ok: false, error: "That session is no longer running." };
    if (!entry.socket)
      return {
        status: 409,
        ok: false,
        error: "That session is restarting; try again in a moment.",
      };
    if (request.command === "focus" && !entry.snapshot.host?.terminal)
      return { status: 409, ok: false, error: "This session's terminal does not support Focus." };
    if (request.command === "action" && !offeredActions(entry.snapshot.views).has(request.action))
      return {
        status: 409,
        ok: false,
        error: "This session no longer offers that; the page may be out of date.",
      };
    const id = this.nextCommand++;
    const socket = entry.socket;
    const result = await new Promise<Answer>((resolve) => {
      const timer = setTimeout(
        () => finish({ ok: false, error: "The session did not answer.", timedOut: true }),
        this.commandTimeoutMs,
      );
      const onClose = () => finish({ ok: false, error: "The session closed before answering." });
      const finish = (value: Answer) => {
        clearTimeout(timer);
        socket.off("close", onClose);
        this.pending.delete(id);
        resolve(value);
      };
      this.pending.set(id, { socket, finish });
      socket.once("close", onClose);
      socket.write(encode({ type: "command", id, ...request }));
    });
    if (result.ok)
      return { status: 200, ok: true, ...(result.data === undefined ? {} : { data: result.data }) };
    return {
      status: result.timedOut ? 504 : 502,
      ok: false,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  private register(id: string, snapshot: DeliverySnapshot, socket: Socket): void {
    const entry = this.sessions.get(id);
    if (entry) {
      clearTimeout(entry.expiry);
      entry.expiry = undefined;
      // A fresh runtime of the same process supersedes a connection that has not closed yet.
      if (entry.socket && entry.socket !== socket) entry.socket.destroy();
      entry.socket = socket;
      entry.snapshot = snapshot;
    } else {
      this.sessions.set(id, { snapshot, socket });
    }
    this.reporters.add(socket);
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.scheduleBroadcast();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.reporters.size) void this.stop("no sessions");
    }, this.idleGraceMs);
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer || this.stopping) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      const frame = sseFrame(this.list());
      for (const stream of this.streams) stream.write(frame);
    }, BROADCAST_DELAY_MS);
  }

  private allowedHost(host: string | undefined): boolean {
    if (!host || this.httpPort === undefined) return false;
    const value = host.toLowerCase();
    return [`127.0.0.1:${this.httpPort}`, `localhost:${this.httpPort}`].includes(value);
  }

  /** Same-origin requests carrying this hub's token; other sites cannot read the page to learn it. */
  private authorized(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (
      origin !== undefined &&
      origin !== `http://127.0.0.1:${this.httpPort}` &&
      origin !== `http://localhost:${this.httpPort}`
    )
      return false;
    const given = Buffer.from(String(request.headers["x-dashboard-token"] ?? ""));
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    // Rejecting foreign Host headers blocks DNS-rebinding pages from reading the API.
    if (!this.allowedHost(request.headers.host)) return text(response, 403, "Forbidden host\n");
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
    const session = /^\/api\/sessions\/([^/]+)\/(.+)$/.exec(pathname);
    if (request.method === "POST" && session) {
      if (!this.authorized(request)) return text(response, 403, "Forbidden\n");
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) tooLarge = true;
        else chunks.push(chunk);
      });
      request.on("end", () => {
        if (tooLarge) return text(response, 413, "Request body too large\n");
        let body: unknown;
        if (size) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return text(response, 400, "Request body is not JSON\n");
          }
        }
        let id: string;
        try {
          id = decodeURIComponent(session[1]!);
        } catch {
          return text(response, 400, "Bad request path\n");
        }
        let command: CommandRequest;
        if (session[2] === "focus") command = { command: "focus" };
        else if (session[2] === "actions") {
          if (!isActionRequest(body))
            return text(response, 400, "Expected an action request: { action, args? }\n");
          command = {
            command: "action",
            action: body.action,
            ...(body.args === undefined ? {} : { args: body.args }),
          };
        } else return text(response, 404, "Not found\n");
        void this.command(id, command).then(({ status, ...body }) => json(response, body, status));
      });
      return;
    }
    if (request.method !== "GET") return text(response, 405, "Method not allowed\n");
    if (pathname === "/") {
      response.writeHead(200, PAGE_HEADERS).end(renderPage(this.token));
    } else if (pathname === "/api/sessions") {
      json(response, this.list());
    } else if (pathname === "/api/health") {
      json(response, {
        ok: true,
        protocol: PROTOCOL_VERSION,
        pid: process.pid,
        sessions: this.sessions.size,
      });
    } else if (pathname === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      response.write(`retry: 2000\n\n${sseFrame(this.list())}`);
      this.streams.add(response);
      request.on("close", () => this.streams.delete(response));
    } else {
      text(response, 404, "Not found\n");
    }
  }
}

/** Where a record sorts: by directory, then start, from its session view when it has one. */
function sortKey(record: SessionRecord): { cwd: string; startedAt: number } {
  const entry = record.views.find((view) => view.kind === "session" && view.model);
  const model = entry?.kind === "session" ? entry.model : undefined;
  return { cwd: model?.cwd ?? "", startedAt: model?.startedAt ?? 0 };
}

function sseFrame(payload: SessionsPayload): string {
  return `event: sessions\ndata: ${JSON.stringify(payload)}\n\n`;
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response
    .writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    })
    .end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(body);
}

function listen(server: NetServer, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/** Binds the socket unless a live hub already owns it; a stale socket file is replaced. */
async function listenExclusive(server: NetServer, path: string): Promise<boolean> {
  try {
    await listen(server, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  }
  if (await isLive(path)) return false;
  try {
    unlinkSync(path);
  } catch {
    /* another hub may have replaced it already */
  }
  await listen(server, path);
  return true;
}

function closeServer(server: NetServer | HttpServer | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  if ("closeAllConnections" in server) server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
