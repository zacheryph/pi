import type { ActionBus } from "#src/actions";
import { MAX_VIEW_BYTES, utf8Bytes } from "#src/bytes";
import {
  isDeliverySnapshot,
  MAX_DELIVERY_ID,
  MAX_VIEW_ERROR,
  type DeliverySnapshot,
  type HostInfo,
  type ViewEntry,
} from "#src/delivery";
import { isText } from "#src/guards";
import { isViewKind, isViewModel, listViews, readView, VIEW_ID } from "#src/views";

// Collection reads every view registered on a session's bus, at the moment of
// the read, into one complete `DeliverySnapshot`. It keeps no copy of any
// extension's state and announces nothing: reading is pure.

export interface CollectOptions {
  /** Largest model, as UTF-8 JSON, an entry may carry. Default `MAX_VIEW_BYTES` (256 KiB). */
  maxViewBytes?: number;
}

/** A collected entry with its JSON, measured once. */
type Collected = { entry: ViewEntry; json: string; bytes: number };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** At most `MAX_VIEW_ERROR` units, never ending in half a surrogate pair, never blank. */
function boundedError(text: string, fallback: string): string {
  let bounded = text.length > MAX_VIEW_ERROR ? text.slice(0, MAX_VIEW_ERROR) : text;
  const last = bounded.charCodeAt(bounded.length - 1);
  if (text.length > MAX_VIEW_ERROR && last >= 0xd800 && last <= 0xdbff)
    bounded = bounded.slice(0, -1);
  return bounded.trim() ? bounded : fallback;
}

const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

function measured(entry: ViewEntry): Collected {
  const json = JSON.stringify(entry);
  return { entry, json, bytes: utf8Bytes(json) };
}

function collect(bus: ActionBus, options: CollectOptions): Collected[] {
  const maxViewBytes = options.maxViewBytes ?? MAX_VIEW_BYTES;
  const seen = new Set<string>();
  const collected: Collected[] = [];
  for (const { id, kind, title } of listViews(bus)) {
    // Another copy of this library answers the same list; skip what this copy cannot vouch for.
    if (typeof id !== "string" || !VIEW_ID.test(id) || seen.has(id)) continue;
    if (!isViewKind(kind) || !isText()(title)) continue;
    seen.add(id);
    const head = { id, kind, title };
    const failed = (error: string) =>
      measured({ ...head, error: boundedError(error, `View "${id}" failed.`) } as ViewEntry);
    let model: unknown;
    try {
      model = readView(bus, id);
    } catch (error) {
      collected.push(failed(message(error)));
      continue;
    }
    if (model === undefined) continue;
    if (!isViewModel(kind, model)) {
      collected.push(failed(`View "${id}" returned a malformed ${kind} model.`));
      continue;
    }
    const bytes = utf8Bytes(JSON.stringify(model));
    if (bytes > maxViewBytes) {
      collected.push(failed(`Too large to send: ${kb(bytes)}, over ${kb(maxViewBytes)}.`));
      continue;
    }
    collected.push(measured({ ...head, model } as ViewEntry));
  }
  // In `listViews`' order: sorted by id.
  return collected;
}

/**
 * Every view registered on the bus now, sorted by id. A view with nothing to
 * show (`undefined`) is left out. A provider that throws, returns something
 * that is not JSON or not a valid model of its kind, or a model over
 * `maxViewBytes` of UTF-8 JSON becomes an error entry; the others are
 * unaffected. A view of a kind this copy does not know is left out, since its
 * model cannot be checked. Throws only when the bus itself does, as a bus Pi
 * has retired does.
 */
export function collectViews(bus: ActionBus, options: CollectOptions = {}): ViewEntry[] {
  return collect(bus, options).map(({ entry }) => entry);
}

export interface DeliveryBudget {
  /** The transport's ceiling for one complete message, in UTF-8 bytes, e.g. `BB_MESSAGE_BYTES`. */
  maxBytes: number;
  /**
   * Bytes the adapter adds around the snapshot's JSON: its message envelope,
   * other fields, a line terminator. The snapshot gets `maxBytes - framingBytes`.
   */
  framingBytes: number;
}

export interface DeliveryOptions extends CollectOptions {
  /** The adapter's routing identity for the session; see `DeliverySnapshot.id`. */
  id: string;
  host?: HostInfo;
  budget: DeliveryBudget;
}

/**
 * What a collection for one delivery produced. When `ok`, `json` is the
 * snapshot's JSON exactly as measured (`bytes` of UTF-8), ready to embed in
 * the adapter's message, and `evicted` names the views whose models were
 * replaced by error entries to fit the budget, largest first. When not, no
 * snapshot fits: `error` says why, for the adapter to report, and `bytes` is
 * the smallest snapshot that could have been sent.
 */
export type DeliveryResult =
  | {
      ok: true;
      snapshot: DeliverySnapshot;
      json: string;
      bytes: number;
      evicted: readonly string[];
    }
  | { ok: false; error: string; bytes: number };

function envelope(id: string, host: HostInfo | undefined, entries: readonly Collected[]): string {
  // The same text `JSON.stringify(snapshot)` makes, built from the entries' measured JSON.
  const head = JSON.stringify(host ? { id, host } : { id }).slice(0, -1);
  return `${head},"views":[${entries.map((item) => item.json).join(",")}]}`;
}

/**
 * Collect the session's views into one complete `DeliverySnapshot` that fits
 * the adapter's budget.
 *
 * Every view is collected as `collectViews` does. When the snapshot's UTF-8
 * JSON is over `budget.maxBytes - budget.framingBytes`, models are replaced by
 * error entries, the largest first (ties by id), until it fits; a form is
 * replaced like any other model, never cut short. When even the snapshot with
 * every model replaced does not fit, or the bus cannot be read, nothing is
 * sent and the result says why: an adapter reports that rather than skipping
 * the update silently.
 *
 * Throws for an id that is not a delivery id, a host that is not a `HostInfo`,
 * and a budget that leaves no room.
 */
export function collectDelivery(bus: ActionBus, options: DeliveryOptions): DeliveryResult {
  const { id, host, budget } = options;
  if (!isText(MAX_DELIVERY_ID)(id))
    throw new TypeError(`Delivery id must be 1-${MAX_DELIVERY_ID} characters.`);
  if (!isDeliverySnapshot({ id, ...(host ? { host } : {}), views: [] }))
    throw new TypeError("Delivery host is not a HostInfo.");
  const available = budget.maxBytes - budget.framingBytes;
  if (!Number.isSafeInteger(budget.maxBytes) || !Number.isSafeInteger(budget.framingBytes))
    throw new RangeError("Delivery budget must be whole bytes.");
  if (budget.framingBytes < 0 || available <= 0)
    throw new RangeError("Delivery budget leaves no room for a snapshot.");

  let entries: Collected[];
  try {
    entries = collect(bus, options);
  } catch (error) {
    return { ok: false, error: `Could not read views: ${message(error)}`, bytes: 0 };
  }
  const evicted: string[] = [];
  let json = envelope(id, host, entries);
  let bytes = utf8Bytes(json);
  if (bytes > available) {
    const total = bytes;
    // Largest model first; ties by id, so the same views always give the same result.
    const order = entries
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.entry.model !== undefined)
      .sort((a, b) => b.item.bytes - a.item.bytes || (a.item.entry.id < b.item.entry.id ? -1 : 1));
    for (const { item, index } of order) {
      const { id: viewId, kind, title } = item.entry;
      const replaced = measured({
        id: viewId,
        kind,
        title,
        error: `Left out to fit one message: ${kb(item.bytes)}; the update was ${kb(total)}, over ${kb(available)}.`,
      } as ViewEntry);
      bytes += replaced.bytes - item.bytes;
      entries[index] = replaced;
      evicted.push(viewId);
      if (bytes <= available) break;
    }
    json = envelope(id, host, entries);
    bytes = utf8Bytes(json);
    if (bytes > available)
      return {
        ok: false,
        error: `Snapshot does not fit one message: at least ${kb(bytes)} with every model left out, over ${kb(available)}.`,
        bytes,
      };
  }
  const snapshot: DeliverySnapshot = {
    id,
    ...(host ? { host } : {}),
    views: entries.map((item) => item.entry),
  };
  return { ok: true, snapshot, json, bytes, evicted };
}
