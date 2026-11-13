import type {
  SessionSnapshot,
  SessionSummary,
  SnapshotResult,
  SurfaceRequest,
} from "./contract.ts";
import {
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED,
  encode,
  parseSessionMessage,
  PROTOCOL_VERSION,
} from "./protocol.ts";

/** What the store needs of a WebSocket; bb's `ExperimentalPluginWebSocket` satisfies it. */
export interface SessionSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Answers requests for a fixture session, which has no Pi process behind it. */
export type FixtureResponder = (request: SurfaceRequest) => unknown;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Entry {
  threadId: string;
  source: "live" | "fixture";
  snapshot: SessionSnapshot;
  updatedAt: number;
  connection?: SessionConnection;
  fixture?: FixtureResponder;
  drop?: ReturnType<typeof setTimeout>;
}

export interface SessionStoreOptions {
  /** Checks a session's credential for its thread. */
  verify(threadId: string, token: string): boolean | Promise<boolean>;
  /** A thread's session appeared, changed or went away. */
  onChange(threadId: string): void;
  /** How long a disconnected session's last snapshot stays; covers /reload and process restarts. */
  graceMs?: number;
  /** How long a session gets to say hello after connecting. */
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

export class SessionError extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

/** One accepted socket; it speaks for a thread once its hello checks out. */
export class SessionConnection {
  threadId?: string;
  private helloTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly store: SessionStore,
    readonly socket: SessionSocket,
    helloTimeoutMs: number,
  ) {
    this.helloTimer = setTimeout(
      () => this.refuse(CLOSE_UNAUTHORIZED, "hello expected"),
      helloTimeoutMs,
    );
    this.helloTimer.unref?.();
  }

  async message(data: string | Uint8Array): Promise<void> {
    if (this.closed) return;
    const message = parseSessionMessage(data);
    if (!message) return;
    if (!this.threadId) {
      if (message.type !== "hello") return;
      clearTimeout(this.helloTimer);
      if (message.version !== PROTOCOL_VERSION) {
        this.refuse(CLOSE_UNSUPPORTED, `protocol ${PROTOCOL_VERSION} expected`);
        return;
      }
      if (!(await this.store.verify(message.threadId, message.token))) {
        this.refuse(CLOSE_UNAUTHORIZED, "bad token");
        return;
      }
      if (this.closed) return;
      this.threadId = message.threadId;
      this.store.attach(this, message.snapshot);
      return;
    }
    switch (message.type) {
      case "update":
        this.store.update(this, message.snapshot);
        return;
      case "result":
        this.store.settle(this, message.id, message.ok, message.data, message.error);
        return;
      case "bye":
        // The close that follows detaches; a `replace` reconnects within the grace period.
        return;
      case "hello":
        return;
    }
  }

  closedBySession(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    this.store.detach(this);
  }

  /** Closes from the plugin's side. */
  refuse(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    this.store.detach(this);
    try {
      this.socket.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}

/** The latest snapshot per bb thread, live or fixture, and the sockets behind live ones. */
export class SessionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<SessionConnection, Map<number, Pending>>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: SessionStoreOptions) {}

  verify(threadId: string, token: string): boolean | Promise<boolean> {
    return this.options.verify(threadId, token);
  }

  /** A new socket on the session route. */
  open(socket: SessionSocket): SessionConnection {
    const connection = new SessionConnection(this, socket, this.options.helloTimeoutMs ?? 10_000);
    if (this.disposed) connection.refuse(1001, "plugin stopping");
    return connection;
  }

  get(threadId: string): SnapshotResult {
    const entry = this.entries.get(threadId);
    if (!entry) return { snapshot: null, source: null, connected: false };
    return {
      snapshot: entry.snapshot,
      source: entry.source,
      connected: entry.source === "fixture" || !!entry.connection,
    };
  }

  /** Live snapshot with an open socket, for raising interactions. */
  live(threadId: string): SessionSnapshot | undefined {
    const entry = this.entries.get(threadId);
    return entry?.source === "live" && entry.connection ? entry.snapshot : undefined;
  }

  summaries(): SessionSummary[] {
    return [...this.entries.values()]
      .map((entry) => summarize(entry))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  setFixture(threadId: string, snapshot: SessionSnapshot, responder: FixtureResponder): void {
    const existing = this.entries.get(threadId);
    if (existing?.source === "live" && existing.connection)
      throw new SessionError("conflict", `Thread ${threadId} has a connected Pi session.`);
    if (existing) clearTimeout(existing.drop);
    this.entries.set(threadId, {
      threadId,
      source: "fixture",
      snapshot,
      updatedAt: this.now(),
      fixture: responder,
    });
    this.options.onChange(threadId);
  }

  /** Removes a fixture; live sessions are left alone. */
  clearFixture(threadId: string): boolean {
    const entry = this.entries.get(threadId);
    if (entry?.source !== "fixture") return false;
    this.entries.delete(threadId);
    this.options.onChange(threadId);
    return true;
  }

  /** Forwards a request to the thread's session and waits for its answer. */
  async request(threadId: string, request: SurfaceRequest): Promise<unknown> {
    const entry = this.entries.get(threadId);
    if (!entry) throw new SessionError("not_found", "No Pi session for this thread.");
    if (entry.source === "fixture") return entry.fixture?.(request);
    const connection = entry.connection;
    if (!connection) throw new SessionError("conflict", "The Pi session is reconnecting.");
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.get(connection)?.delete(id);
        reject(new Error("The Pi session did not answer in time."));
      }, this.options.requestTimeoutMs ?? 10_000);
      timer.unref?.();
      const waiting = this.pending.get(connection) ?? new Map<number, Pending>();
      waiting.set(id, { resolve, reject, timer });
      this.pending.set(connection, waiting);
      try {
        connection.socket.send(encode({ type: "request", id, request }));
      } catch {
        clearTimeout(timer);
        waiting.delete(id);
        reject(new Error("The Pi session is not reachable."));
      }
    });
  }

  attach(connection: SessionConnection, snapshot: SessionSnapshot): void {
    const threadId = connection.threadId!;
    const existing = this.entries.get(threadId);
    if (existing) clearTimeout(existing.drop);
    const previous = existing?.connection;
    this.entries.set(threadId, {
      threadId,
      source: "live",
      snapshot,
      updatedAt: this.now(),
      connection,
    });
    // The newest process for a thread wins (bb restarts Pi on resume).
    if (previous && previous !== connection) previous.refuse(CLOSE_REPLACED, "replaced");
    this.options.onChange(threadId);
  }

  update(connection: SessionConnection, snapshot: SessionSnapshot): void {
    const entry = this.entries.get(connection.threadId!);
    if (!entry || entry.connection !== connection) return;
    entry.snapshot = snapshot;
    entry.updatedAt = this.now();
    this.options.onChange(entry.threadId);
  }

  settle(
    connection: SessionConnection,
    id: number,
    ok: boolean,
    data: unknown,
    error: string | undefined,
  ): void {
    const waiting = this.pending.get(connection)?.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.get(connection)?.delete(id);
    if (ok) waiting.resolve(data);
    else waiting.reject(new Error(error ?? "The Pi session could not do that."));
  }

  detach(connection: SessionConnection): void {
    for (const waiting of this.pending.get(connection)?.values() ?? []) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("The Pi session disconnected."));
    }
    this.pending.delete(connection);
    const threadId = connection.threadId;
    if (!threadId) return;
    const entry = this.entries.get(threadId);
    if (!entry || entry.connection !== connection) return;
    entry.connection = undefined;
    if (this.disposed) return;
    entry.drop = setTimeout(() => {
      if (this.entries.get(threadId) !== entry || entry.connection) return;
      this.entries.delete(threadId);
      this.options.onChange(threadId);
    }, this.options.graceMs ?? 15_000);
    entry.drop.unref?.();
    this.options.onChange(threadId);
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.drop);
      entry.connection?.refuse(1001, "plugin stopping");
    }
    this.entries.clear();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function summarize(entry: Entry): SessionSummary {
  const { snapshot } = entry;
  const tasks = snapshot.todos?.tasks ?? [];
  const active = tasks.find((task) => task.status === "in_progress");
  return {
    threadId: entry.threadId,
    source: entry.source,
    connected: entry.source === "fixture" || !!entry.connection,
    updatedAt: entry.updatedAt,
    cwd: snapshot.cwd,
    ...(snapshot.name ? { name: snapshot.name } : {}),
    ...(snapshot.agent ? { agent: snapshot.agent } : {}),
    ...(snapshot.model ? { model: snapshot.model.name ?? snapshot.model.id } : {}),
    status: snapshot.status.kind,
    ...(snapshot.todos
      ? {
          todos: {
            done: tasks.filter((task) => task.status === "completed").length,
            total: snapshot.todos.total,
            ...(active ? { active: active.subject } : {}),
          },
        }
      : {}),
    runningAgents:
      snapshot.subagents?.agents.filter(
        (agent) => agent.state === "running" || agent.state === "queued",
      ).length ?? 0,
    questions: snapshot.questions?.length ?? 0,
  };
}
