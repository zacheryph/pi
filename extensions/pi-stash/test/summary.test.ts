import { describe, expect, it } from "vitest";
import { formatSummaryCount, isViewModel, summaryCount, type SummaryModel } from "#surface";
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
      { key: "store-bytes", label: "in the store", value: 2_000, unit: "bytes", tone: "warning" },
      { key: "store-max-bytes", label: "store cap", value: 1_000, unit: "bytes", tone: "muted" },
    ]);
    expect(JSON.stringify(over)).not.toContain('"live"');
  });

  it("labels entries and versions in agreement with their value, and sizes as bytes", () => {
    const text = (model: SummaryModel) => model.counts.map(formatSummaryCount);
    expect(text(stashSummaryModel({ records: [] }))).toEqual([
      "0 entries",
      "0 versions",
      "0 B on this branch",
    ]);
    expect(
      text(
        stashSummaryModel({ records: [record("a", 887, 1)] }, { bytes: 887, maxBytes: 1024 ** 3 }),
      ),
    ).toEqual([
      "1 entry",
      "1 version",
      "887 B on this branch",
      "887 B in the store",
      "1.0 GiB store cap",
    ]);
    const two = stashSummaryModel({ records: [record("a", 10_000, 1), record("b", 2_698, 2)] });
    expect(text(two)).toEqual(["2 entries", "2 versions", "12.4 KiB on this branch"]);
    expect(two.counts.filter((count) => count.unit === "bytes").map((count) => count.key)).toEqual([
      "bytes",
    ]);
  });
});
