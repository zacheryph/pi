import { settleSnapshot } from "pi-surface/settle";
import { allAttention, threadAttention, type AttentionSource } from "./attention.ts";
import type {
  ActionRequest,
  ActionResult,
  AttentionResult,
  AttentionRow,
  DeliverySnapshot,
  SessionSummary,
  SnapshotResult,
} from "./contract.ts";
import {
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED,
  encode,
  parseSessionMessage,
  PROTOCOL_VERSION,
} from "./protocol.ts";
import {
  openQuestionnaires,
  profileName,
  runningAgents,
  sessionModel,
  todoProgress,
} from "./views.ts";

/** What the store needs of a WebSocket; bb's `ExperimentalPluginWebSocket` satisfies it. */
export interface SessionSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Answers requests for a fixture session, which has no Pi process behind it. */
export type FixtureResponder = (request: ActionRequest) => unknown;

/** A live session's last snapshot, kept so a thread shows its state while no Pi runs for it. */
export interface SavedSnapshot {
  threadId: string;
  snapshot: DeliverySnapshot;
  savedAt: number;
}

/** What an archive load found: the records it can read, and how many it could not. */
export interface ArchiveLoad {
  saved: SavedSnapshot[];
  /** Records of another version or malformed; treated as if they did not exist. */
  ignored: number;
}

/**
 * Where live snapshots outlast the plugin: bb restarts, plugin reloads and Pi
 * processes bb stopped. Synchronous, like the plugin's SQLite database.
 */
export interface SnapshotArchive {
  load(): ArchiveLoad;
  save(saved: SavedSnapshot): void;
  delete(threadId: string): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Entry {
  threadId: string;
  /** Saved: a live session's last snapshot, settled, with no Pi process behind it. */
  source: "live" | "fixture" | "saved";
  snapshot: DeliverySnapshot;
  updatedAt: number;
  connection?: SessionConnection;
  fixture?: FixtureResponder;
  drop?: ReturnType<typeof setTimeout>;
}

/** A thread's live session: its latest snapshot and the connection that sent it. */
export interface LiveSession {
  snapshot: DeliverySnapshot;
  connection: SessionConnection;
}

export interface SessionStoreOptions {
  /** Checks a session's credential for its thread. */
  verify(threadId: string, token: string): boolean | Promise<boolean>;
  /** A thread's session appeared, changed or went away. */
  onChange(threadId: string): void;
  /**
   * Pi named a session that had a different name, or none, in the store's last
   * snapshot for the thread. Never called for a thread the store has not seen,
   * so a Pi that merely reconnects with its saved name does not undo a rename
   * made in bb.
   */
  onRename?(threadId: string, name: string): void;
  /** Keeps live snapshots across plugin loads. */
  archive?: SnapshotArchive;
  /** Reports archive failures and unreadable messages; the store keeps working. */
  onError?(message: string): void;
  /** How long a disconnected session stays live before it is shown as saved; covers /reload and process restarts. */
  graceMs?: number;
  /** How long a session gets to say hello after connecting. */
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  /** Whether a row is hidden from the attention list, such as one queued for dismissal. */
  hides?(threadId: string, row: AttentionRow): boolean;
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

  get open(): boolean {
    return !this.closed;
  }

  async message(data: string | Uint8Array): Promise<void> {
    if (this.closed) return;
    const parsed = parseSessionMessage(data);
    if (!parsed.ok) {
      this.store.warn(`session message dropped: ${parsed.error}`);
      return;
    }
    if (!("message" in parsed)) {
      // An older or newer pi-bb: both sides must be updated together.
      if (!this.threadId)
        this.refuse(
          CLOSE_UNSUPPORTED,
          `protocol ${PROTOCOL_VERSION} expected, got ${parsed.unsupported}`,
        );
      return;
    }
    const { message } = parsed;
    if (!this.threadId) {
      if (message.type !== "hello") return;
      clearTimeout(this.helloTimer);
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
      case "result": {
        const { type: _type, id, ...result } = message;
        this.store.settle(this, id, result);
        return;
      }
      case "bye":
        // The close that follows detaches; a `replace` reconnects within the grace period.
        return;
      case "hello":
        return;
    }
  }

  /** Tells the session the plugin accepted it: it may now advertise that bb answers its forms. */
  welcome(): void {
    this.send(encode({ type: "welcome", version: PROTOCOL_VERSION }));
  }

  send(data: string): void {
    this.socket.send(data);
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

/** The latest snapshot per bb thread, live, saved or fixture, and the sockets behind live ones. */
export class SessionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<SessionConnection, Map<number, Pending>>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: SessionStoreOptions) {
    const loaded = this.archived(() => options.archive?.load());
    for (const saved of loaded?.saved ?? []) {
      this.entries.set(saved.threadId, {
        threadId: saved.threadId,
        source: "saved",
        snapshot: settleSnapshot(saved.snapshot, saved.savedAt),
        updatedAt: saved.savedAt,
      });
    }
    if (loaded?.ignored)
      this.warn(
        `snapshot archive: ignored ${loaded.ignored} saved snapshot${loaded.ignored === 1 ? "" : "s"} of an older version or unreadable; ${loaded.ignored === 1 ? "its thread shows" : "their threads show"} Pi again after the next turn.`,
      );
  }

  private readonly hides = (threadId: string, row: AttentionRow): boolean =>
    this.options.hides?.(threadId, row) ?? false;

  verify(threadId: string, token: string): boolean | Promise<boolean> {
    return this.options.verify(threadId, token);
  }

  warn(message: string): void {
    this.options.onError?.(message);
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
      connected: isConnected(entry),
    };
  }

  /** The thread's live session with an open socket, for raising interactions; never a fixture. */
  live(threadId: string): LiveSession | undefined {
    const entry = this.entries.get(threadId);
    return entry?.source === "live" && entry.connection
      ? { snapshot: entry.snapshot, connection: entry.connection }
      : undefined;
  }

  summaries(): SessionSummary[] {
    return [...this.entries.values()]
      .map((entry) => summarize(entry, this.hides))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** What needs the user in every session: live, saved and fixture. */
  attention(): AttentionResult {
    return allAttention([...this.entries.values()].map(attentionSource), this.hides);
  }

  setFixture(threadId: string, snapshot: DeliverySnapshot, responder: FixtureResponder): void {
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

  /** The thread is gone: drop whatever the store holds for it, saved copy included. */
  forget(threadId: string): void {
    this.archived(() => this.options.archive?.delete(threadId));
    const entry = this.entries.get(threadId);
    if (!entry) return;
    clearTimeout(entry.drop);
    this.entries.delete(threadId);
    // A Pi still reporting for a deleted thread is told not to come back.
    entry.connection?.refuse(CLOSE_REPLACED, "thread deleted");
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

  /**
   * Runs an action on the thread's session and waits for its result. With
   * `connection`, only that connection may run it: a request made for one
   * process (a form it raised) never reaches the process that replaced it.
   */
  async request(
    threadId: string,
    request: ActionRequest,
    options: { connection?: SessionConnection } = {},
  ): Promise<unknown> {
    const entry = this.entries.get(threadId);
    if (!entry) throw new SessionError("not_found", "No Pi session for this thread.");
    if (entry.source === "fixture") return entry.fixture?.(request);
    if (entry.source === "saved")
      throw new SessionError(
        "conflict",
        "Pi is not running for this thread. It starts again with the thread's next turn.",
      );
    const connection = entry.connection;
    if (!connection) throw new SessionError("conflict", "The Pi session is reconnecting.");
    if (options.connection && options.connection !== connection)
      throw new SessionError("conflict", "The Pi session that asked has been replaced.");
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
        connection.send(encode({ type: "request", id, request }));
      } catch {
        clearTimeout(timer);
        waiting.delete(id);
        reject(new Error("The Pi session is not reachable."));
      }
    });
  }

  attach(connection: SessionConnection, snapshot: DeliverySnapshot): void {
    const threadId = connection.threadId!;
    const existing = this.entries.get(threadId);
    if (existing) clearTimeout(existing.drop);
    const previous = existing?.connection;
    // A live snapshot replaces whatever was shown, a saved one included; nothing is merged.
    this.entries.set(threadId, {
      threadId,
      source: "live",
      snapshot,
      updatedAt: this.now(),
      connection,
    });
    // The newest process for a thread wins (bb restarts Pi on resume).
    if (previous && previous !== connection) previous.refuse(CLOSE_REPLACED, "replaced");
    try {
      connection.welcome();
    } catch {
      /* its close detaches it */
    }
    this.save(threadId, snapshot);
    this.options.onChange(threadId);
    if (existing && existing.source !== "fixture")
      this.renamed(threadId, existing.snapshot, snapshot);
  }

  update(connection: SessionConnection, snapshot: DeliverySnapshot): void {
    const entry = this.entries.get(connection.threadId!);
    // A replaced connection's late update never touches its replacement.
    if (!entry || entry.connection !== connection) return;
    const before = entry.snapshot;
    entry.snapshot = snapshot;
    entry.updatedAt = this.now();
    this.save(entry.threadId, snapshot);
    this.options.onChange(entry.threadId);
    this.renamed(entry.threadId, before, snapshot);
  }

  private renamed(threadId: string, before: DeliverySnapshot, after: DeliverySnapshot): void {
    const name = sessionModel(after)?.name;
    if (!name || name === sessionModel(before)?.name) return;
    try {
      this.options.onRename?.(threadId, name);
    } catch {
      /* a failing rename never costs the live view */
    }
  }

  settle(connection: SessionConnection, id: number, result: ActionResult): void {
    const waiting = this.pending.get(connection)?.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.get(connection)?.delete(id);
    if (result.ok) waiting.resolve(result.value);
    else waiting.reject(new Error(result.error));
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
    // No process came back: keep showing what it last reported, as saved.
    entry.drop = setTimeout(() => {
      if (this.entries.get(threadId) !== entry || entry.connection) return;
      this.entries.set(threadId, {
        threadId,
        source: "saved",
        snapshot: settleSnapshot(entry.snapshot, this.now()),
        updatedAt: entry.updatedAt,
      });
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

  private save(threadId: string, snapshot: DeliverySnapshot): void {
    this.archived(() => this.options.archive?.save({ threadId, snapshot, savedAt: this.now() }));
  }

  /** Runs an archive call; a failing archive costs persistence, never the live view. */
  private archived<T>(run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      this.warn(`snapshot archive: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}

function isConnected(entry: Entry): boolean {
  return entry.source === "fixture" || !!entry.connection;
}

function attentionSource(entry: Entry): AttentionSource {
  return {
    threadId: entry.threadId,
    snapshot: entry.snapshot,
    source: entry.source,
    connected: isConnected(entry),
  };
}

/** The sessions list's row for a thread, read from its views; a missing view leaves its fields out. */
function summarize(entry: Entry, hides?: SessionStoreOptions["hides"]): SessionSummary {
  const { snapshot } = entry;
  const attention = threadAttention(attentionSource(entry), hides);
  const session = sessionModel(snapshot);
  const model = session?.model;
  const profile = profileName(snapshot);
  const todos = todoProgress(snapshot);
  return {
    threadId: entry.threadId,
    source: entry.source,
    connected: isConnected(entry),
    updatedAt: entry.updatedAt,
    ...(session
      ? {
          cwd: session.cwd,
          status: session.status.kind,
          ...(session.name ? { name: session.name } : {}),
          ...(model ? { model: model.name ?? model.id } : {}),
        }
      : {}),
    ...(profile ? { profile } : {}),
    ...(todos ? { todos } : {}),
    runningAgents: runningAgents(snapshot),
    questions: openQuestionnaires(snapshot).length,
    attention: { blocking: attention.blocking, owed: attention.owed },
  };
}
