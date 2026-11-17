// Live sessions' last snapshots in the plugin's SQLite database, so a thread
// keeps showing its tasks and subagents while no Pi runs for it: after a bb
// restart or a plugin reload, until the thread's next turn starts Pi again.
//
// Records are versioned. One this version cannot read (an older version's, or
// a malformed one) is treated as if it did not exist: it is removed, and the
// thread shows Pi again once its next turn reconnects. Nothing here touches
// Pi's own session files, transcripts, tasks or stash.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isDeliverySnapshot } from "pi-surface/delivery";
import type { ArchiveLoad, SavedSnapshot, SnapshotArchive } from "./sessions.ts";

/** A thread's saved snapshot is dropped after this long without an update. */
export const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The record format this version writes and reads: 1 is a pi-surface
 * `DeliverySnapshot` (protocol 3). Records from before versioning read as 0.
 */
export const SAVED_SNAPSHOT_VERSION = 1;

/** Append-only: the host records each statement by its index. */
const MIGRATIONS = [
  `CREATE TABLE snapshots (
    thread_id TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL,
    saved_at INTEGER NOT NULL
  )`,
  `ALTER TABLE snapshots ADD COLUMN version INTEGER NOT NULL DEFAULT 0`,
];

interface Row {
  thread_id: string;
  snapshot: string;
  saved_at: number;
  version: number;
}

/** The snapshot a row holds, when this version can read it. */
function readRow(row: Row): SavedSnapshot | undefined {
  if (row.version !== SAVED_SNAPSHOT_VERSION || !Number.isFinite(row.saved_at)) return undefined;
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(row.snapshot);
  } catch {
    return undefined;
  }
  return isDeliverySnapshot(snapshot)
    ? { threadId: row.thread_id, snapshot, savedAt: row.saved_at }
    : undefined;
}

export function snapshotArchive(
  storage: BbPluginApi["storage"],
  now: () => number = Date.now,
): SnapshotArchive {
  // The host hands out one handle per plugin load; migrate it once.
  let migrated: ReturnType<typeof storage.database> | undefined;
  const db = () => {
    const handle = storage.database();
    if (handle !== migrated) {
      storage.migrate(handle, MIGRATIONS);
      migrated = handle;
    }
    return handle;
  };
  return {
    load(): ArchiveLoad {
      const handle = db();
      handle.prepare("DELETE FROM snapshots WHERE saved_at < ?").run(now() - ARCHIVE_TTL_MS);
      const rows = handle
        .prepare("SELECT thread_id, snapshot, saved_at, version FROM snapshots")
        .all() as Row[];
      const saved: SavedSnapshot[] = [];
      const unreadable: string[] = [];
      for (const row of rows) {
        const record = readRow(row);
        if (record) saved.push(record);
        else unreadable.push(row.thread_id);
      }
      // As if they never existed: the thread's next live snapshot writes a new record.
      const drop = handle.prepare("DELETE FROM snapshots WHERE thread_id = ?");
      for (const threadId of unreadable) drop.run(threadId);
      return { saved, ignored: unreadable.length };
    },
    save({ threadId, snapshot, savedAt }) {
      db()
        .prepare(
          `INSERT INTO snapshots (thread_id, snapshot, saved_at, version) VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET snapshot = excluded.snapshot,
             saved_at = excluded.saved_at, version = excluded.version`,
        )
        .run(threadId, JSON.stringify(snapshot), savedAt, SAVED_SNAPSHOT_VERSION);
    },
    delete(threadId) {
      db().prepare("DELETE FROM snapshots WHERE thread_id = ?").run(threadId);
    },
  };
}
