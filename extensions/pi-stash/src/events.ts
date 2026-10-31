import {
  currentEntries,
  handleFor,
  versionsOf,
  type StashIndex,
  type StashRecord,
} from "./state.ts";

/**
 * `pi.events` channel carrying this branch's stash index for other extensions
 * in the same session (each subagent has its own bus). Emitted on session
 * start, branch changes and every `stash_put`. Metadata only, never content.
 */
export const STASH_SNAPSHOT_EVENT = "pi-stash:snapshot";
export const STASH_SNAPSHOT_VERSION = 1;

export interface StashSnapshotEntry {
  handle: string;
  name: string;
  hash: string;
  bytes: number;
  lines: number;
  mime: string;
  description?: string;
  createdAt: number;
  /** Session that stored this version. */
  createdBy: string;
  /** `content`, `path:<relative>`, `tool:<name>`, or `handle:<handle>`. */
  source: string;
  versions: number;
  /** pi-subagents agent id of the session that stored it, when that was a subagent. */
  agent?: string;
  /** `adopt` when a descendant stored it and it was adopted onto this branch. */
  via?: "adopt";
}

export interface StashSnapshotEvent {
  version: typeof STASH_SNAPSHOT_VERSION;
  /** Latest version per name, newest first. */
  entries: StashSnapshotEntry[];
  /** Size of the shared content store and its configured cap; absent when it cannot be measured. */
  store?: { bytes: number; maxBytes: number };
}

/**
 * `pi.events` request channel: another extension in the same session asks for
 * the head of one entry on this branch, for a user who explicitly opened it.
 * pi-stash answers synchronously through `respond` with at most `maxLines`
 * lines and `maxBytes` bytes (capped at 200 / 16 KB), read through the
 * hash-verified store. Full handles and other branches' entries are refused.
 */
export const STASH_PREVIEW_REQUEST = "pi-stash:preview";
export const PREVIEW_MAX_LINES = 200;
export const PREVIEW_MAX_BYTES = 16 * 1024;

export interface StashPreviewRequest {
  name: string;
  maxLines?: number;
  maxBytes?: number;
  respond(result: StashPreviewResult): void;
}

export type StashPreviewResult =
  | { ok: true; handle: string; lines: string[]; total: number; complete: boolean }
  | { ok: false; error: string };

/** One entry as `stash_list` and the snapshot event report it. */
export function stashEntryJson(record: StashRecord, index: StashIndex) {
  return {
    handle: handleFor(record),
    name: record.name,
    hash: record.hash,
    bytes: record.bytes,
    lines: record.lines,
    mime: record.mime,
    ...(record.description ? { description: record.description } : {}),
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    source: record.source,
    versions: versionsOf(index, record.name).length,
    ...(record.agent ? { agent: record.agent } : {}),
    ...(record.via ? { via: record.via } : {}),
  };
}

export function stashSnapshotEvent(
  index: StashIndex,
  store?: StashSnapshotEvent["store"],
): StashSnapshotEvent {
  return {
    version: STASH_SNAPSHOT_VERSION,
    entries: currentEntries(index).map((record) => stashEntryJson(record, index)),
    ...(store ? { store } : {}),
  };
}
