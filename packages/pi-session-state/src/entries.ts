/**
 * entries.ts — read an extension's custom entries back out of a session.
 *
 * Extensions persist with `pi.appendEntry(customType, data)` and rebuild their
 * state by replaying those entries in order. These helpers do the filtering;
 * folding the data stays with each extension.
 */

/** One custom entry's type and data. */
export interface CustomEntryData {
  customType: string;
  data: unknown;
}

/**
 * The custom entries of `types`, in session order. Entries of other types and
 * values that are not entries are skipped. Pass several types to fold entries
 * that must be replayed interleaved.
 */
export function customEntries(
  entries: Iterable<unknown>,
  types: string | readonly string[],
): CustomEntryData[] {
  const wanted: readonly string[] = typeof types === "string" ? [types] : types;
  const out: CustomEntryData[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item.type !== "custom" || typeof item.customType !== "string") continue;
    if (wanted.includes(item.customType))
      out.push({ customType: item.customType, data: item.data });
  }
  return out;
}

/** The data of every custom entry of `type`, in order, keeping only what `guard` accepts. */
export function customData<T = unknown>(
  entries: Iterable<unknown>,
  type: string,
  guard?: (data: unknown) => data is T,
): T[] {
  const out: T[] = [];
  for (const { data } of customEntries(entries, type))
    if (!guard || guard(data)) out.push(data as T);
  return out;
}

/** A context whose current branch can be read (Pi's `ExtensionContext` satisfies it). */
export interface BranchSource {
  sessionManager: { getBranch(): Iterable<unknown> };
}

/** A context whose every entry, on every branch, can be read. */
export interface EntriesSource {
  sessionManager: { getEntries(): Iterable<unknown> };
}

export interface ReadEntriesOptions<T> {
  /** The entries' `customType`. */
  type: string;
  /** Keep only data this accepts; malformed entries are skipped. */
  guard?: (data: unknown) => data is T;
}

/**
 * The data of `ctx`'s custom entries of `type`, in order. `scope: "branch"`
 * (the default) reads the current branch, so abandoned branches never leak in;
 * `scope: "all"` reads every entry of the session.
 */
export function readEntries<T = unknown>(
  ctx: BranchSource,
  options: ReadEntriesOptions<T> & { scope?: "branch" },
): T[];
export function readEntries<T = unknown>(
  ctx: EntriesSource,
  options: ReadEntriesOptions<T> & { scope: "all" },
): T[];
export function readEntries<T = unknown>(
  ctx: BranchSource | EntriesSource,
  options: ReadEntriesOptions<T> & { scope?: "branch" | "all" },
): T[] {
  const entries =
    options.scope === "all"
      ? (ctx as EntriesSource).sessionManager.getEntries()
      : (ctx as BranchSource).sessionManager.getBranch();
  return customData(entries, options.type, options.guard);
}
