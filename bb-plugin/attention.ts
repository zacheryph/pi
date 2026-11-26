// What needs the user across every Pi session the plugin knows: pi-surface's
// `attentionRows` for each thread, merged into one list, and the dismissals
// made while a thread's Pi was not running, kept in bb's key-value store until
// the thread's Pi comes back to run them.
import { attentionRows } from "pi-surface/attention-rows";
import type {
  AttentionItem,
  AttentionModel,
  AttentionResult,
  AttentionRow,
  DeliverySnapshot,
  ThreadAttentionRow,
} from "./contract.ts";

/** A queued dismissal is dropped after this long if its thread's Pi never comes back. */
export const DISMISSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DISMISSAL_PREFIX = "attention-dismissal:";

/** The user dismissed an item while no Pi ran for its thread; it runs when one reconnects. */
export interface Dismissal {
  threadId: string;
  viewId: string;
  itemId: string;
  /** The revision the user saw; a newer one is not dismissed. */
  rev?: string;
  at: number;
}

/** What the key-value store needs to offer; bb's `storage.kv` does. */
export interface DismissalStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

/** One key per item and revision: JSON keeps ids with `/` or `@` apart. */
export function dismissalKey(d: Pick<Dismissal, "threadId" | "viewId" | "itemId" | "rev">): string {
  return `${DISMISSAL_PREFIX}${JSON.stringify([d.threadId, d.viewId, d.itemId, d.rev ?? null])}`;
}

const isText = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function isDismissal(value: unknown): value is Dismissal {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    isText(d.threadId, 128) &&
    isText(d.viewId) &&
    isText(d.itemId) &&
    (d.rev === undefined || isText(d.rev)) &&
    typeof d.at === "number" &&
    Number.isFinite(d.at)
  );
}

/** The item an attention view in the snapshot lists under `viewId` and `itemId`. */
export function findItem(
  snapshot: DeliverySnapshot | null | undefined,
  viewId: string,
  itemId: string,
): { view: "missing" | "failed" } | { view: "ok"; item: AttentionItem | undefined } {
  const entry = snapshot?.views.find((view) => view.id === viewId);
  if (!entry || entry.kind !== "attention") return { view: "missing" };
  if (!entry.model) return { view: "failed" };
  const model: AttentionModel = entry.model;
  return { view: "ok", item: model.items.find((item) => item.id === itemId) };
}

/**
 * Queued dismissals, in memory and in bb's key-value store. Loading is
 * asynchronous; until it ends the queue is empty, and `onChange` fires once
 * it has loaded so readers ask again.
 */
export class DismissalQueue {
  private readonly queued = new Map<string, Dismissal>();
  readonly loaded: Promise<void>;

  constructor(
    private readonly storage: DismissalStorage,
    private readonly options: {
      onChange(threadId?: string): void;
      onError?(message: string): void;
      now?: () => number;
    },
  ) {
    this.loaded = this.load();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async load(): Promise<void> {
    try {
      const keys = await this.storage.list(DISMISSAL_PREFIX);
      for (const key of keys) {
        const value = await this.storage.get<unknown>(key);
        // Malformed, expired or filed under another key: as if it never existed.
        if (
          isDismissal(value) &&
          value.at >= this.now() - DISMISSAL_TTL_MS &&
          dismissalKey(value) === key
        )
          this.queued.set(key, value);
        else await this.storage.delete(key);
      }
    } catch (error) {
      this.warn(error);
    }
    this.options.onChange();
  }

  private warn(error: unknown): void {
    this.options.onError?.(
      `attention dismissals: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  /** Whether a queued dismissal hides this row of the thread. */
  hides(threadId: string, row: Pick<AttentionRow, "kind" | "viewId" | "itemId" | "rev">): boolean {
    return (
      row.kind === "owed" &&
      this.queued.has(
        dismissalKey({ threadId, viewId: row.viewId, itemId: row.itemId, rev: row.rev }),
      )
    );
  }

  forThread(threadId: string): Dismissal[] {
    return [...this.queued.values()].filter((d) => d.threadId === threadId);
  }

  async add(dismissal: Omit<Dismissal, "at">): Promise<void> {
    const queued: Dismissal = { ...dismissal, at: this.now() };
    const key = dismissalKey(queued);
    this.queued.set(key, queued);
    this.options.onChange(queued.threadId);
    await this.storage.set(key, queued);
  }

  /** Takes a dismissal off the queue; it never runs twice. */
  remove(dismissal: Dismissal): void {
    const key = dismissalKey(dismissal);
    if (!this.queued.delete(key)) return;
    this.options.onChange(dismissal.threadId);
    void this.storage.delete(key).catch((error: unknown) => this.warn(error));
  }

  /** The thread is gone: its queued dismissals with it. */
  forget(threadId: string): void {
    for (const dismissal of this.forThread(threadId)) this.remove(dismissal);
  }
}

/** Where a thread's rows come from, as the sessions list reports it. */
export interface AttentionSource {
  threadId: string;
  snapshot: DeliverySnapshot;
  source: ThreadAttentionRow["source"];
  connected: boolean;
}

/** Display name of a thread's session: its name, else its working directory. */
function sessionLabel(snapshot: DeliverySnapshot): string | undefined {
  for (const view of snapshot.views)
    if (view.kind === "session" && view.model)
      return view.model.name || view.model.cwd || undefined;
  return undefined;
}

const RANK = { blocking: 0, ready: 1, stale: 2 } as const;
const rank = (row: AttentionRow) => (row.kind === "blocking" ? RANK.blocking : RANK[row.state]);

/** `attentionRows`' order, across threads: blocking, ready, stale; oldest first; then by key. */
export function compareRows(a: ThreadAttentionRow, b: ThreadAttentionRow): number {
  const byRank = rank(a) - rank(b);
  if (byRank) return byRank;
  const bySince = (a.since ?? Infinity) - (b.since ?? Infinity);
  if (bySince) return bySince;
  const ka = `${a.threadId}/${a.key}`;
  const kb = `${b.threadId}/${b.key}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** One thread's rows and counts, without the rows a queued dismissal hides. */
export function threadAttention(
  { threadId, snapshot, source, connected }: AttentionSource,
  hides: (threadId: string, row: AttentionRow) => boolean = () => false,
): AttentionResult {
  const list = attentionRows(snapshot);
  const session = sessionLabel(snapshot);
  const rows = list.rows
    .filter((row) => !hides(threadId, row))
    .map((row): ThreadAttentionRow => ({
      ...row,
      threadId,
      source,
      connected,
      ...(session ? { session } : {}),
    }));
  const hidden = list.rows.length - rows.length;
  return { rows, blocking: list.blocking, owed: list.owed - hidden, more: list.more };
}

/** Every thread's rows in one list. */
export function allAttention(
  sources: readonly AttentionSource[],
  hides?: (threadId: string, row: AttentionRow) => boolean,
): AttentionResult {
  const result: AttentionResult = { rows: [], blocking: 0, owed: 0, more: 0 };
  for (const source of sources) {
    const one = threadAttention(source, hides);
    result.rows.push(...one.rows);
    result.blocking += one.blocking;
    result.owed += one.owed;
    result.more += one.more;
  }
  result.rows.sort(compareRows);
  return result;
}
