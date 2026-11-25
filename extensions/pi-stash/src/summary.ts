import { plural } from "#foundations/format";
import type { SummaryCount, SummaryModel } from "#surface";
import { currentEntries, type StashIndex } from "#src/state";

/**
 * The `stash.summary` view: what this branch has stashed, counted from the same index as the
 * `stash.explorer` view. The explorer's items carry each entry's
 * handle as its id; this carries the totals no item does: sizes and the shared store's use
 * against its cap. Stash records live in the session file and the store on disk, so nothing
 * here is process-bound (`live`). Entry and version labels agree with their value ("1 entry",
 * "2 entries"); sizes are `unit: "bytes"`, so their labels follow a size ("887 B in the store").
 */
export function stashSummaryModel(
  index: StashIndex,
  /** The shared store's size and cap; absent when it cannot be measured. */
  store?: { bytes: number; maxBytes: number },
): SummaryModel {
  const entries = currentEntries(index);
  const versions = index.records.length;
  const counts: SummaryCount[] = [
    { key: "entries", label: plural(entries.length, "entry", "entries"), value: entries.length },
    { key: "versions", label: plural(versions, "version"), value: versions, tone: "muted" },
    {
      key: "bytes",
      label: "on this branch",
      value: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      unit: "bytes",
      tone: "muted",
    },
  ];
  if (store)
    counts.push(
      {
        key: "store-bytes",
        label: "in the store",
        value: store.bytes,
        unit: "bytes",
        ...(store.bytes > store.maxBytes ? { tone: "warning" as const } : {}),
      },
      {
        key: "store-max-bytes",
        label: "store cap",
        value: store.maxBytes,
        unit: "bytes",
        tone: "muted",
      },
    );
  return { counts };
}
