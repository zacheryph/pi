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
  /** Called once per startup with the items closed as lost, after their message was written. */
  onLost?(items: readonly WorkItemView[]): void;
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
    return this.track(view, true).handle;
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
      complete: (message) => {
        if (this.live(entry)) {
          this.deliver(message);
          this.close(entry, "completed");
        }
      },
      cancel: () => {
        if (this.live(entry)) this.close(entry, "cancelled");
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

  private deliver(message: WorkMessage): void {
    this.delivered.add(message.customType);
    this.delivery.add({ completionId: this.newId(), payload: message });
  }

  private close(entry: Entry, reason: "completed" | "cancelled" | "lost"): void {
    entry.closed = true;
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
