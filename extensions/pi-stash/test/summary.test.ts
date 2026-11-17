import { describe, expect, it } from "vitest";
import { isViewModel, summaryCount } from "#surface";
import { currentEntries, handleFor, type StashRecord } from "#src/state";
import { stashSummaryModel } from "#src/summary";
import { stashExplorerView } from "#src/ui/browser";

const record = (name: string, bytes: number, createdAt: number): StashRecord => ({
  name,
  hash: `${name}${createdAt}`.padEnd(64, "0").slice(0, 64),
  bytes,
  lines: 1,
  mime: "text/plain",
  createdAt,
  createdBy: "session-1",
  source: "content",
});

describe("stashSummaryModel", () => {
  it("counts every entry and version, past any list's rows, beside the explorer's handles", () => {
    const records = Array.from({ length: 120 }, (_, i) => record(`entry-${i}`, 10, i));
    // A second version of one entry replaces it in the list and adds a version.
    records.push(record("entry-0", 25, 1_000));
    const model = stashSummaryModel({ records });
    expect(isViewModel("summary", model)).toBe(true);
    expect(summaryCount(model, "entries")).toBe(120);
    expect(summaryCount(model, "versions")).toBe(121);
    expect(summaryCount(model, "bytes")).toBe(119 * 10 + 25);
    // The explorer lists every entry, newest first, by the handle a stash picker inserts.
    const explorer = stashExplorerView(currentEntries({ records }));
    expect(explorer.items).toHaveLength(120);
    expect(explorer.items[0]!.id).toBe(handleFor(records.at(-1)!));
  });

  it("reports the shared store against its cap only when it was measured", () => {
    expect(stashSummaryModel({ records: [] }).counts.map((count) => count.key)).toEqual([
      "entries",
      "versions",
      "bytes",
    ]);
    const over = stashSummaryModel({ records: [] }, { bytes: 2_000, maxBytes: 1_000 });
    expect(over.counts.slice(3)).toEqual([
      { key: "store-bytes", label: "bytes in the store", value: 2_000, tone: "warning" },
      { key: "store-max-bytes", label: "store cap in bytes", value: 1_000, tone: "muted" },
    ]);
    expect(JSON.stringify(over)).not.toContain('"live"');
  });
});
