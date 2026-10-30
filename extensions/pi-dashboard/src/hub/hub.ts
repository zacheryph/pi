import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { hubPaths, IDLE_GRACE_MS, isSnapshot, LineDecoder, PROTOCOL_VERSION, type HubPaths, type SessionSnapshot } from "../protocol.ts";
import { renderPage } from "./page.ts";

export interface HubOptions {
  dir: string;
  /** 0 picks a free port. */
  port: number;
  idleGraceMs?: number;
  httpRetryMs?: number;
  log?: (line: string) => void;
}

export interface SessionView extends SessionSnapshot {
  /** The session is restarting its runtime (/new, /resume, /fork, /reload). */
  restarting?: boolean;
}

export interface SessionsPayload {
  home: string;
  sessions: SessionView[];
}

interface Entry {
  snapshot: SessionSnapshot;
  socket?: Socket;
  expiry?: ReturnType<typeof setTimeout>;
}

const HEARTBEAT_MS = 25_000;
const BROADCAST_DELAY_MS = 50;

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'",
};

/**
 * One hub per machine. Pi sessions connect over a unix socket and stream
 * snapshots; browsers read them over loopback HTTP and server-sent events.
 * Binding the socket is the startup lock, and the hub stops itself once no
 * session has been connected for the grace period.
 */
export class Hub {
  readonly paths: HubPaths;
  httpPort?: number;
  httpError?: string;
  /** Resolves once the hub has stopped, by idle shutdown or stop(). */
  readonly closed: Promise<void>;

  private readonly port: number;
  private readonly idleGraceMs: number;
  private readonly httpRetryMs: number;
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
    this.log = options.log ?? (() => {});
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  async start(): Promise<"started" | "already-running"> {
    mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 });
    const server = createNetServer((socket) => this.accept(socket));
    if (!await listenExclusive(server, this.paths.socket)) return "already-running";
    try { chmodSync(this.paths.socket, 0o600); } catch { /* best effort; the directory is 0700 */ }
    this.socketServer = server;
    this.armIdle();
    this.heartbeat = setInterval(() => { for (const stream of this.streams) stream.write(": ping\n\n"); }, HEARTBEAT_MS);
    await this.listenHttp();
    return "started";
  }

  stop(reason = "stopped"): Promise<void> {
    return this.stopping ??= (async () => {
      this.log(`stopping: ${reason}`);
      for (const timer of [this.idleTimer, this.httpRetry, this.broadcastTimer]) clearTimeout(timer);
      clearInterval(this.heartbeat);
      for (const entry of this.sessions.values()) clearTimeout(entry.expiry);
      for (const stream of this.streams) stream.end();
      this.streams.clear();
      for (const socket of this.connections) socket.destroy();
      // Node removes the socket file when the server closes.
      await Promise.all([closeServer(this.socketServer), closeServer(this.httpServer)]);
      this.resolveClosed();
    })();
  }

  list(): SessionsPayload {
    const sessions = [...this.sessions.values()]
      .map((entry): SessionView => entry.socket ? { ...entry.snapshot } : { ...entry.snapshot, restarting: true })
      .sort((a, b) => a.cwd.localeCompare(b.cwd) || a.startedAt - b.startedAt);
    return { home: homedir(), sessions };
  }

  private async listenHttp(): Promise<void> {
    const server = createHttpServer((request, response) => this.handle(request, response));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
    } catch (error) {
      this.httpError = error instanceof Error ? error.message : String(error);
      this.log(`http unavailable (${this.httpError}); retrying in ${this.httpRetryMs}ms`);
      if (!this.stopping) this.httpRetry = setTimeout(() => { this.httpRetry = undefined; void this.listenHttp(); }, this.httpRetryMs);
      return;
    }
    if (this.stopping) { await closeServer(server); return; }
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
    socket.setEncoding("utf8");
    socket.on("error", () => { /* the close handler cleans up */ });
    socket.on("data", (chunk: string) => {
      for (const message of decoder.push(chunk)) {
        if (!message || typeof message !== "object") continue;
        const raw = message as { type?: unknown; version?: unknown; snapshot?: unknown; reason?: unknown };
        if (raw.type === "hello") {
          if (typeof raw.version === "number" && raw.version > PROTOCOL_VERSION) {
            // A newer reporter brings a newer hub: step aside so it can start one.
            void this.stop(`reporter speaks protocol ${raw.version}`);
            return;
          }
          if (id || !isSnapshot(raw.snapshot)) { socket.destroy(); return; }
          id = raw.snapshot.id;
          this.register(id, raw.snapshot, socket);
        } else if (raw.type === "update" && id && isSnapshot(raw.snapshot) && raw.snapshot.id === id) {
          const entry = this.sessions.get(id);
          if (entry?.socket === socket) { entry.snapshot = raw.snapshot; this.scheduleBroadcast(); }
        } else if (raw.type === "bye" && (raw.reason === "quit" || raw.reason === "replace")) {
          farewell = raw.reason;
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
          entry.expiry = setTimeout(() => { this.sessions.delete(key); this.scheduleBroadcast(); }, this.idleGraceMs);
        } else {
          this.sessions.delete(id);
        }
        this.scheduleBroadcast();
      }
      if (!this.reporters.size) this.armIdle();
    });
  }

  private register(id: string, snapshot: SessionSnapshot, socket: Socket): void {
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

  private handle(request: IncomingMessage, response: ServerResponse): void {
    // Rejecting foreign Host headers blocks DNS-rebinding pages from reading the API.
    if (!this.allowedHost(request.headers.host)) return text(response, 403, "Forbidden host\n");
    if (request.method !== "GET") return text(response, 405, "Method not allowed\n");
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
    if (pathname === "/") {
      response.writeHead(200, PAGE_HEADERS).end(renderPage());
    } else if (pathname === "/api/sessions") {
      json(response, this.list());
    } else if (pathname === "/api/health") {
      json(response, { ok: true, protocol: PROTOCOL_VERSION, pid: process.pid, sessions: this.sessions.size });
    } else if (pathname === "/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      response.write(`retry: 2000\n\n${sseFrame(this.list())}`);
      this.streams.add(response);
      request.on("close", () => this.streams.delete(response));
    } else {
      text(response, 404, "Not found\n");
    }
  }
}

function sseFrame(payload: SessionsPayload): string {
  return `event: sessions\ndata: ${JSON.stringify(payload)}\n\n`;
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(body);
}

function listen(server: NetServer, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
}

function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
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
  try { unlinkSync(path); } catch { /* another hub may have replaced it already */ }
  await listen(server, path);
  return true;
}

function closeServer(server: NetServer | HttpServer | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  if ("closeAllConnections" in server) server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
