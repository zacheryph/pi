import { ACTION_ID } from "#src/actions";
import { isArrayOf, isRecord, isString, isText, optional, uniqueBy } from "#src/guards";
import { isJsonValue, type JsonValue } from "#src/json";
import { isViewKind, isViewModel, VIEW_ID, type ViewKind, type ViewModelOf } from "#src/views";

// Types and guards for what an adapter (pi-bb, the dashboard reporter) sends a
// receiver. Nothing here knows a transport, an adapter or an extension.

/** Longest error an entry or action result carries, in UTF-16 units. */
export const MAX_VIEW_ERROR = 500;
/** Longest delivery id: the bb plugin's limit on a session id. */
export const MAX_DELIVERY_ID = 128;

/**
 * One collected view: its id, kind and title, and either its current model or
 * why the model is missing (its provider failed, or it was too large to send).
 * A view with nothing to show is left out of the collection, not sent empty.
 */
export type ViewEntry<Kind extends ViewKind = ViewKind> = {
  [K in Kind]: { id: string; kind: K; title: string } & (
    | { model: ViewModelOf<K>; error?: undefined }
    | { error: string; model?: undefined }
  );
}[Kind];

/** Where a host action such as dashboard Focus goes; set by a terminal adapter. */
export type HostTerminal = { kind: string; label: string };

/**
 * What the process hosting the session offers beyond its views. Host
 * information, not observed session state: it comes from the adapter.
 */
export type HostInfo = {
  /** The Pi process's id. */
  pid?: number;
  /** Present when a terminal adapter recognized the session, so Focus can bring it forward. */
  terminal?: HostTerminal;
};

/**
 * One complete delivery for one session. Each replaces the previous one at
 * its receiver; nothing is merged. Core session information is the `session`
 * view's model, not a field here, and a receiver tolerates its absence.
 */
export type DeliverySnapshot = {
  /**
   * The adapter's routing identity for the session, e.g. stable for the Pi
   * process across /new, /resume and /reload. Connection identity, separate
   * from anything the views observe.
   */
  id: string;
  host?: HostInfo;
  /** Every collected view, sorted by id. */
  views: readonly ViewEntry[];
};

/** A receiver asks the session to run an action, e.g. a `submit` from a form. */
export type ActionRequest = { action: string; args?: JsonValue };

/** How an action request ended: its JSON result, or a bounded error message. */
export type ActionResult = { ok: true; value?: JsonValue } | { ok: false; error: string };

const isError = (value: unknown) => isText(MAX_VIEW_ERROR)(value);
const isViewId = (value: unknown): value is string => isString(value) && VIEW_ID.test(value);

/** A well-formed entry of a kind this copy knows, with a valid model or a bounded error. */
export function isViewEntry(value: unknown): value is ViewEntry {
  if (!isRecord(value) || !isViewId(value.id) || !isText()(value.title)) return false;
  if (!isViewKind(value.kind)) return false;
  if (value.error !== undefined) return value.model === undefined && isError(value.error);
  return isViewModel(value.kind, value.model);
}

const isPid = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
const isTerminal = (value: unknown) =>
  isRecord(value) && isText()(value.kind) && isString(value.label);
const isHost = (value: unknown) =>
  isRecord(value) && optional(value.pid, isPid) && optional(value.terminal, isTerminal);
const isEnvelope = (value: unknown): value is Record<string, unknown> & { views: unknown[] } =>
  isRecord(value) &&
  isText(MAX_DELIVERY_ID)(value.id) &&
  optional(value.host, isHost) &&
  Array.isArray(value.views);

/**
 * Strict: a well-formed envelope whose every entry is a valid entry of a known
 * kind, with no two entries sharing an id. Use `readDeliverySnapshot` to accept
 * a newer producer's snapshot.
 */
export function isDeliverySnapshot(value: unknown): value is DeliverySnapshot {
  return (
    isEnvelope(value) &&
    isArrayOf(isViewEntry)(value.views) &&
    uniqueBy(value.views as ViewEntry[], (entry) => entry.id)
  );
}

/**
 * Tolerant: the snapshot as this copy can draw it, or `undefined` when the
 * envelope itself is malformed. An entry of a kind this copy does not know
 * (a newer producer's) and an entry without a usable id or title are left out;
 * a known kind whose model is malformed becomes an error entry; only the first
 * entry with an id is kept. Never throws and never drops the whole snapshot
 * for one entry.
 */
export function readDeliverySnapshot(value: unknown): DeliverySnapshot | undefined {
  if (!isEnvelope(value)) return undefined;
  const seen = new Set<string>();
  const views: ViewEntry[] = [];
  for (const raw of value.views) {
    if (!isRecord(raw) || !isViewId(raw.id) || !isText()(raw.title) || !isViewKind(raw.kind))
      continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    views.push(
      isViewEntry(raw)
        ? raw
        : ({
            id: raw.id,
            kind: raw.kind,
            title: raw.title,
            error: `Malformed ${raw.kind} view.`,
          } as ViewEntry),
    );
  }
  const host = value.host as HostInfo | undefined;
  return { id: value.id as string, ...(host ? { host } : {}), views };
}

export function isActionRequest(value: unknown): value is ActionRequest {
  return (
    isRecord(value) &&
    isString(value.action) &&
    ACTION_ID.test(value.action) &&
    optional(value.args, isJsonValue)
  );
}

export function isActionResult(value: unknown): value is ActionResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return value.error === undefined && optional(value.value, isJsonValue);
  return value.ok === false && value.value === undefined && isError(value.error);
}
