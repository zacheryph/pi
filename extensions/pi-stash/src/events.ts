import { handleFor, versionsOf, type StashIndex, type StashRecord } from "#src/state";

/**
 * Action on this session's bus (see pi-surface): `{ id: <handle> }` resolves to
 * the entry's detail blocks with a bounded content preview. The `/stash`
 * browser loads details through it.
 */
export const STASH_INSPECT_ACTION = "stash.inspect";

/** View (see pi-surface): the `/stash` explorer's JSON model for this branch. */
export const STASH_EXPLORER_VIEW = "stash.explorer";
/** View (see pi-surface): this branch's entry count and sizes, and the shared store's (`stashSummaryModel`). */
export const STASH_SUMMARY_VIEW = "stash.summary";

/** One entry as `stash_list` reports it. */
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
