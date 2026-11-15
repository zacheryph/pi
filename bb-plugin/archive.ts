// Live sessions' last snapshots in the plugin's SQLite database, so a thread
// keeps showing its tasks and subagents while no Pi runs for it: after a bb
// restart or a plugin reload, until the thread's next turn starts Pi again.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SessionSnapshot } from "./contract.ts";
import type { SavedSnapshot, SnapshotArchive } from "./sessions.ts";

/** A thread's saved snapshot is dropped after this long without an update. */
export const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MIGRATIONS = [
  `CREATE TABLE snapshots (
    thread_id TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL,
    saved_at INTEGER NOT NULL
  )`,
];

interface Row {
  thread_id: string;
  snapshot: string;
  saved_at: number;
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
    load() {
      const handle = db();
      handle.prepare("DELETE FROM snapshots WHERE saved_at < ?").run(now() - ARCHIVE_TTL_MS);
      const rows = handle
        .prepare("SELECT thread_id, snapshot, saved_at FROM snapshots")
        .all() as Row[];
      const saved: SavedSnapshot[] = [];
      for (const row of rows) {
        try {
          const snapshot = JSON.parse(row.snapshot) as SessionSnapshot;
          if (snapshot && typeof snapshot === "object" && typeof snapshot.cwd === "string")
            saved.push({ threadId: row.thread_id, snapshot, savedAt: row.saved_at });
        } catch {
          /* a row this version cannot read is skipped; the next update replaces it */
        }
      }
      return saved;
    },
    save({ threadId, snapshot, savedAt }) {
      db()
        .prepare(
          `INSERT INTO snapshots (thread_id, snapshot, saved_at) VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET snapshot = excluded.snapshot, saved_at = excluded.saved_at`,
        )
        .run(threadId, JSON.stringify(snapshot), savedAt);
    },
    delete(threadId) {
      db().prepare("DELETE FROM snapshots WHERE thread_id = ?").run(threadId);
    },
  };
}
