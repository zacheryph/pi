import type { SummaryCount, SummaryModel } from "#surface";
import { currentEntries, type StashIndex } from "#src/state";

/**
 * The `stash.summary` view: what this branch has stashed, counted from the same index as the
 * `stash.explorer` view. The explorer's items carry each entry's
 * handle as its id; this carries the totals no item does: sizes and the shared store's use
 * against its cap. Stash records live in the session file and the store on disk, so nothing
 * here is process-bound (`live`).
 */
export function stashSummaryModel(
  index: StashIndex,
  /** The shared store's size and cap; absent when it cannot be measured. */
  store?: { bytes: number; maxBytes: number },
): SummaryModel {
  const entries = currentEntries(index);
  const counts: SummaryCount[] = [
    { key: "entries", label: "entries", value: entries.length },
    { key: "versions", label: "versions", value: index.records.length, tone: "muted" },
    {
      key: "bytes",
      label: "bytes on this branch",
      value: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      tone: "muted",
    },
  ];
  if (store)
    counts.push(
      {
        key: "store-bytes",
        label: "bytes in the store",
        value: store.bytes,
        ...(store.bytes > store.maxBytes ? { tone: "warning" as const } : {}),
      },
      { key: "store-max-bytes", label: "store cap in bytes", value: store.maxBytes, tone: "muted" },
    );
  return { counts };
}
