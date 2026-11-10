/**
 * The work host: open items, their persistence and their messages, independent of who provides
 * it. `createWorkHost` takes the two things that differ between hosts:
 *
 *  - a `WorkStore`, where open items are persisted (the root session appends custom entries; a
 *    managed child can write its session file directly), and
 *  - a `DeliveryHost`, the wake policy: whether the session is idle and how a message reaches
 *    its transcript. The root session sends with `sendMessage`, starting a turn when idle. A
 *    child's manager asks for a run through the concurrency limiter instead.
 *
 * Messages are never stored by the host. Each one goes straight into the transcript through the
 * delivery, so the transcript is the inbox and an undelivered message survives a released
 * session, a reload and a restart with nothing extra to store.
 *
 * Startup: `start()` loads the items an earlier instance left open, owners call
 * `adopt(owner, fn)` during their own `session_start`, then `settleStartup()` closes whatever
 * nobody adopted as lost. A lost item never wakes the session by itself: a single `work:lost`
 * message is appended with `record`, which starts no turn.
 */
import {
  Delivery,
  continuesRun,
  type BeforeSettleEvent,
  type ContextMessage,
  type DeliveryHost,
} from "./delivery.ts";
import {
  WORK_LOST,
  type Json,
  type WorkHost,
  type WorkItem,
  type WorkItemSpec,
  type WorkItemView,
  type WorkMessage,
  type WorkRecord,
} from "./contract.ts";

export interface WorkStore {
  /** Everything persisted under `WORK_ENTRY` so far, oldest first. Malformed data is skipped. */
  read(): readonly unknown[];
  append(record: WorkRecord): void;
}

export interface WorkHostOptions {
  store: WorkStore;
  /** The wake policy and transcript writer. */
  delivery: DeliveryHost<WorkMessage>;
  /**
   * Whether the transport holds messages after `send` returns (Pi appends a message sent mid-run
   * at the end of the turn). With it, `complete` closes the item only once the transport calls
   * `messageLanded` for its message, so a crash in between leaves the item open and the next
   * start reports it lost. Without it, a message is in the transcript when `send` returns and
   * the item closes at once (a transport that writes the session file directly).
   */
  confirmLanding?: boolean;
  /**
   * With `confirmLanding`: an opaque mark taken just before a completion's message is sent, for
   * the transport to tell that message from an identical one that landed earlier (the root host
   * records the transcript position). Passed back to `messageLanded`'s `accepts`, and revisable
   * with `reviseLanding`.
   */
  landingMark?(): unknown;
  /** Called once per startup with the items closed as lost, after their message was written. */
  onLost?(items: readonly WorkItemView[]): void;
  /**
   * Called after the set of open items changed: an item was opened, completed, cancelled or
   * closed as lost. Not called for `notify`, and not for the second half of a close (the
   * landing confirmation of a completed item): `list()` already reads as it will afterwards.
   * For whoever shows the open items or acts on there being none (a managed child that went
   * idle on an item and now has none). Called after the change is fully applied, including any
   * wake the completion's message caused, so a reader sees the state the session is in. A throw
   * is swallowed.
   */
  onChange?(): void;
  now?(): number;
  newId?(): string;
}

/** The longest label or item list the lost message spells out. */
const LOST_LABEL = 160;
const LOST_ITEMS = 20;

interface Entry {
  view: WorkItemView;
  /** Opened in this instance, or adopted by its owner. Unadopted entries are lost at startup. */
  adopted: boolean;
  closed: boolean;
  handle: WorkItem;
}

/** A completed item whose result message is not in the transcript yet. */
interface Awaiting {
  key: string;
  entry: Entry;
  /** `WorkHostOptions.landingMark` at the time of the send; the transport may revise it. */
  mark: unknown;
}

/** What identifies a message at the transcript: Pi keeps the type, the content and the details as sent. */
const messageKey = (m: { customType?: string; content?: unknown; details?: unknown }): string =>
  JSON.stringify([m.customType ?? "", m.content ?? [], m.details ?? null]);

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A record read back from the transcript, or undefined for anything that is not one. */
export function parseRecord(raw: unknown): WorkRecord | undefined {
  const r = raw as Partial<Record<string, unknown>> | null;
  if (!r || typeof r !== "object" || r.v !== 1 || !isText(r.id)) return undefined;
  const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0;
  if (r.op === "open") {
    if (!isText(r.owner) || !isText(r.kind) || typeof r.label !== "string") return undefined;
    return {
      v: 1,
      op: "open",
      id: r.id,
      owner: r.owner,
      kind: r.kind,
      label: r.label,
      ...(r.data !== undefined ? { data: r.data as Json } : {}),
      at,
    };
  }
  if (
    r.op === "close" &&
    (r.reason === "completed" || r.reason === "cancelled" || r.reason === "lost")
  )
    return { v: 1, op: "close", id: r.id, reason: r.reason, at };
  return undefined;
}

/** The records that are still open: opened, never closed, oldest first. */
export function openRecords(raw: readonly unknown[]): Extract<WorkRecord, { op: "open" }>[] {
  const open = new Map<string, Extract<WorkRecord, { op: "open" }>>();
  for (const item of raw) {
    const record = parseRecord(item);
    if (record?.op === "open") open.set(record.id, record);
    else if (record?.op === "close") open.delete(record.id);
  }
  return [...open.values()];
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The single message that reports items nobody took over. Data only, so it can be written to a transcript file. */
export function lostMessage(items: readonly WorkItemView[]): WorkMessage {
  const lines = items
    .slice(0, LOST_ITEMS)
    .map(
      (item) =>
        `- ${item.kind}${item.label ? ` "${oneLine(item.label, LOST_LABEL)}"` : ""} (${item.owner}, ${item.id})`,
    );
  if (items.length > LOST_ITEMS) lines.push(`- and ${items.length - LOST_ITEMS} more`);
  const noun = items.length === 1 ? "item" : "items";
  return {
    customType: WORK_LOST,
    content:
      `Work lost: ${items.length} ${noun} still open when this session started, and nothing took ${items.length === 1 ? "it" : "them"} over. ` +
      `${items.length === 1 ? "It was" : "They were"} closed without a result and nothing was restarted. ` +
      `Check whether the work is still needed before starting it again.\n${lines.join("\n")}`,
    details: {
      items: items.map((item) => ({
        id: item.id,
        owner: item.owner,
        kind: item.kind,
        label: item.label,
      })),
    },
  };
}

export class WorkHostRuntime implements WorkHost {
  private readonly options: WorkHostOptions;
  private readonly delivery: Delivery<WorkMessage>;
  private readonly entries = new Map<string, Entry>();
  /** Custom types this host delivered: what `continuesRun` recognizes at the run boundary. */
  private readonly delivered = new Set<string>();
  /** Completed items waiting for their message to reach the transcript (`confirmLanding`). */
  private readonly awaiting: Awaiting[] = [];
  private started = false;
  private settled = false;
  private disposed = false;

  constructor(options: WorkHostOptions) {
    this.options = options;
    this.delivery = new Delivery<WorkMessage>(options.delivery);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private newId(): string {
    return this.options.newId?.() ?? crypto.randomUUID();
  }

  /**
   * Load the items an earlier instance left open. They stay unadopted until their owner adopts
   * them. Call once, before any owner's `session_start` handler asks.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const record of openRecords(this.options.store.read())) {
      if (this.entries.has(record.id)) continue;
      this.track(
        {
          id: record.id,
          owner: record.owner,
          kind: record.kind,
          label: record.label,
          data: record.data,
          openedAt: record.at,
        },
        false,
      );
    }
  }

  open(spec: WorkItemSpec): WorkItem {
    if (this.disposed) throw new Error("work host is disposed");
    if (!isText(spec?.owner) || !isText(spec.kind) || typeof spec.label !== "string")
      throw new TypeError("work item needs an owner, a kind and a label");
    const view: WorkItemView = {
      id: this.newId(),
      owner: spec.owner,
      kind: spec.kind,
      label: spec.label,
      ...(spec.data !== undefined ? { data: spec.data } : {}),
      openedAt: this.now(),
    };
    // A failed write must reach the producer: an item that was not persisted cannot be adopted.
    this.options.store.append({
      v: 1,
      op: "open",
      id: view.id,
      owner: view.owner,
      kind: view.kind,
      label: view.label,
      ...(view.data !== undefined ? { data: view.data } : {}),
      at: view.openedAt,
    });
    const handle = this.track(view, true).handle;
    this.changed();
    return handle;
  }

  adopt(owner: string, adopt: (item: WorkItem) => boolean): void {
    for (const entry of this.entries.values()) {
      if (entry.adopted || entry.closed || entry.view.owner !== owner) continue;
      if (adopt(entry.handle)) entry.adopted = true;
    }
  }

  list(): readonly WorkItemView[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.closed)
      .map((entry) => ({ ...entry.view }));
  }

  /**
   * End of startup: close every item no owner adopted as lost, and say so with one message that
   * starts no turn. Returns the lost items. Later calls do nothing; owners that adopt afterwards
   * find nothing.
   */
  settleStartup(): readonly WorkItemView[] {
    if (this.settled || this.disposed) return [];
    this.settled = true;
    const lost = [...this.entries.values()].filter((entry) => !entry.adopted && !entry.closed);
    if (lost.length === 0) return [];
    for (const entry of lost) this.close(entry, "lost");
    const items = lost.map((entry) => ({ ...entry.view }));
    const message = lostMessage(items);
    try {
      // Straight to the host, not through the wake path: lost work never wakes anything.
      this.options.delivery.send([{ completionId: this.newId(), payload: message }], "record");
    } catch {
      // A stale context cannot take the message; the items are closed either way.
    }
    this.options.onLost?.(items);
    this.changed();
    return items;
  }

  /** `agent_start`: a run is active, so messages are recorded for its boundary instead of waking. */
  agentStart(): void {
    this.delivery.onAgentStart();
  }

  /** `agent_settled`: the run, including its continuations, is over. */
  agentSettled(): void {
    this.delivery.onAgentSettled();
  }

  /** Whether the run needs one more request for a work message that arrived after its last answer. */
  continuesRun(event: BeforeSettleEvent): boolean {
    return continuesRun(
      event,
      (m: ContextMessage) =>
        m.role === "custom" && !!m.customType && this.delivered.has(m.customType),
    );
  }

  /** Whether `customType` is one this host delivered: a message of it is work waiting for an answer. */
  delivers(customType: string): boolean {
    return this.delivered.has(customType);
  }

  /**
   * Close the open items as cancelled, with no message: the session's owner called them off, so
   * nothing is lost on the next start. Every open item, or only those `match` accepts (a parent's
   * answer closes the questions the session asked and leaves its jobs alone). Not part of the
   * producers' contract (`WorkHost`): only whoever runs the session calls it. Returns how many
   * were closed. Producers' handles go inert; the work behind them is theirs to stop (a stopped
   * session's shutdown does).
   */
  cancelOpen(match?: (item: WorkItemView) => boolean): number {
    if (this.disposed) return 0;
    const open = [...this.entries.values()].filter(
      (entry) => !entry.closed && (!match || match({ ...entry.view })),
    );
    for (const entry of open) this.close(entry, "cancelled");
    if (open.length) this.changed();
    return open.length;
  }

  /** The session is going away. Items stay persisted for the next instance to adopt or lose. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.delivery.dispose();
  }

  private track(view: WorkItemView, adopted: boolean): Entry {
    const entry = { view, adopted, closed: false } as Entry;
    entry.handle = {
      ...view,
      notify: (message) => this.notify(entry, message),
      complete: (message) => this.complete(entry, message),
      cancel: () => {
        if (!this.live(entry)) return;
        this.close(entry, "cancelled");
        this.changed();
      },
    };
    this.entries.set(view.id, entry);
    return entry;
  }

  private live(entry: Entry): boolean {
    return !this.disposed && !entry.closed;
  }

  private notify(entry: Entry, message: WorkMessage): void {
    if (this.live(entry)) this.deliver(message);
  }

  /**
   * Deliver the result, then close. The close record is the promise that the result reached the
   * transcript, so it is written only when it did: at once for a transport that appends directly,
   * otherwise when the transport reports the message (`messageLanded`). A message that delivery
   * refuses leaves the item open, so the next start reports it lost instead of closing it as done.
   */
  private complete(entry: Entry, message: WorkMessage): void {
    if (!this.live(entry)) return;
    entry.closed = true; // the handle is spent either way; undone below if delivery refuses
    const waiting: Awaiting | undefined = this.options.confirmLanding
      ? { key: messageKey(message), entry, mark: this.markLanding() }
      : undefined;
    if (waiting) this.awaiting.push(waiting);
    if (!this.deliver(message)) {
      entry.closed = false;
      if (waiting) this.awaiting.splice(this.awaiting.indexOf(waiting), 1);
      return;
    }
    if (!waiting) this.write(entry, "completed");
    this.changed();
  }

  private changed(): void {
    try {
      this.options.onChange?.();
    } catch {
      // A display or a policy reacting to the change must not break the producer that caused it.
    }
  }

  /** Whether completed items still wait for their message to reach the transcript. */
  awaitingLanding(): boolean {
    return this.awaiting.length > 0;
  }

  private markLanding(): unknown {
    try {
      return this.options.landingMark?.();
    } catch {
      return undefined; // the transport cannot say where it is; the message matches by content alone
    }
  }

  /** The marks of the items still waiting, oldest first. */
  landingMarks(): readonly unknown[] {
    return this.awaiting.map((waiting) => waiting.mark);
  }

  /**
   * The transport reports that `message` is now in the transcript (only with `confirmLanding`).
   * Closes the oldest item waiting for an identical message whose mark `accepts` (all of them,
   * when omitted): a message identical to one that landed before the send has an older mark and
   * is not taken for the new one. Any other message is ignored.
   */
  messageLanded(
    message: { customType?: string; content?: unknown; details?: unknown },
    accepts?: (mark: unknown) => boolean,
  ): void {
    if (this.awaiting.length === 0) return;
    const key = messageKey(message);
    const index = this.awaiting.findIndex(
      (waiting) => waiting.key === key && (!accepts || accepts(waiting.mark)),
    );
    if (index < 0) return;
    const [waiting] = this.awaiting.splice(index, 1);
    this.write(waiting.entry, "completed");
  }

  /**
   * Give every waiting item a new mark, or stop waiting for it: `undefined` drops it. A dropped
   * item stays open on disk, so the next start reports it lost; its message cannot land any more
   * (the transcript moved to another branch, or the run it was sent in is over).
   */
  reviseLanding(revise: (mark: unknown) => unknown): void {
    for (let i = this.awaiting.length - 1; i >= 0; i--) {
      const mark = revise(this.awaiting[i].mark);
      if (mark === undefined) this.awaiting.splice(i, 1);
      else this.awaiting[i].mark = mark;
    }
  }

  /** Whether delivery took the message (see `Delivery.add`). */
  private deliver(message: WorkMessage): boolean {
    this.delivered.add(message.customType);
    return this.delivery.add({ completionId: this.newId(), payload: message });
  }

  private close(entry: Entry, reason: "completed" | "cancelled" | "lost"): void {
    entry.closed = true;
    this.write(entry, reason);
  }

  private write(entry: Entry, reason: "completed" | "cancelled" | "lost"): void {
    try {
      this.options.store.append({ v: 1, op: "close", id: entry.view.id, reason, at: this.now() });
    } catch {
      // Best effort: a stale session cannot write. The item then stays open on disk and is
      // reported lost by the next instance, which is accurate.
    }
  }
}

export function createWorkHost(options: WorkHostOptions): WorkHostRuntime {
  return new WorkHostRuntime(options);
}
