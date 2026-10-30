import { currentEntries, handleFor, versionsOf, type StashIndex, type StashRecord } from "./state.ts";

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
  /** `content`, `path:<relative>`, or `tool:<name>`. */
  source: string;
  versions: number;
}

export interface StashSnapshotEvent {
  version: typeof STASH_SNAPSHOT_VERSION;
  /** Latest version per name, newest first. */
  entries: StashSnapshotEntry[];
}

/** One entry as `stash_list` and the snapshot event report it. */
export function stashEntryJson(record: StashRecord, index: StashIndex) {
  return {
    handle: handleFor(record), name: record.name, hash: record.hash, bytes: record.bytes, lines: record.lines,
    mime: record.mime, ...(record.description ? { description: record.description } : {}),
    createdAt: record.createdAt, createdBy: record.createdBy, source: record.source,
    versions: versionsOf(index, record.name).length,
  };
}

export function stashSnapshotEvent(index: StashIndex): StashSnapshotEvent {
  return {
    version: STASH_SNAPSHOT_VERSION,
    entries: currentEntries(index).map((record) => stashEntryJson(record, index)),
  };
}
