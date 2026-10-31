import { HASH_PATTERN, type BlobStore } from "./store.ts";

/** Custom session entry; one per change, plus a checkpoint after compaction. */
export const STASH_INDEX_TYPE = "pi-personal:stash-index";
export const STASH_SCHEMA_VERSION = 1;
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MIN_HANDLE_PREFIX = 12;

export interface StashRecord {
  name: string;
  hash: string;
  bytes: number;
  lines: number;
  mime: string;
  description?: string;
  createdAt: number;
  /** Session that stored the version. */
  createdBy: string;
  /** Where the text came from: `content`, `path:<relative>`, `tool:<name>`, or `handle:<handle>`. */
  source: string;
  /** Stable identity of this version, kept when ancestors adopt it. */
  id?: string;
  /** pi-subagents agent id of the session that stored it, when that was a subagent. */
  agent?: string;
  /** `adopt`: journaled here because a descendant stored it. */
  via?: "adopt";
}

/** Every version stored on this branch, oldest first. The latest per name is current. */
export interface StashIndex {
  records: StashRecord[];
}

export type StashJournal =
  | { schemaVersion: typeof STASH_SCHEMA_VERSION; op: "put"; record: StashRecord }
  | { schemaVersion: typeof STASH_SCHEMA_VERSION; op: "checkpoint"; records: StashRecord[] };

export function createEmptyIndex(): StashIndex {
  return { records: [] };
}

export function handleFor(record: Pick<StashRecord, "name" | "hash">): string {
  return `stash:${record.name}@${record.hash.slice(0, MIN_HANDLE_PREFIX)}`;
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function isStashRecord(value: unknown): value is StashRecord {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.name === "string" && NAME_PATTERN.test(raw.name)
    && typeof raw.hash === "string" && HASH_PATTERN.test(raw.hash)
    && Number.isSafeInteger(raw.bytes) && Number.isSafeInteger(raw.lines)
    && typeof raw.mime === "string" && Number.isFinite(raw.createdAt)
    && typeof raw.createdBy === "string" && typeof raw.source === "string"
    && (raw.description === undefined || typeof raw.description === "string")
    && (raw.id === undefined || typeof raw.id === "string")
    && (raw.agent === undefined || typeof raw.agent === "string")
    && (raw.via === undefined || raw.via === "adopt");
}

/** Rebuilds the index from the current branch only; abandoned branches never leak in. */
export function replayStashIndex(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): StashIndex {
  let records: StashRecord[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item.type !== "custom" || item.customType !== STASH_INDEX_TYPE || !item.data || typeof item.data !== "object") continue;
    const data = item.data as { schemaVersion?: unknown; op?: unknown; record?: unknown; records?: unknown };
    if (data.schemaVersion !== STASH_SCHEMA_VERSION) continue;
    if (data.op === "put" && isStashRecord(data.record)) records.push({ ...data.record });
    else if (data.op === "checkpoint" && Array.isArray(data.records)) records = data.records.filter(isStashRecord).map((record) => ({ ...record }));
  }
  return { records };
}

/** Latest version per name, most recent first. */
export function currentEntries(index: StashIndex): StashRecord[] {
  const latest = new Map<string, StashRecord>();
  for (const record of index.records) latest.set(record.name, record);
  return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function versionsOf(index: StashIndex, name: string): StashRecord[] {
  return index.records.filter((record) => record.name === name);
}

export interface ParsedRef {
  name?: string;
  prefix?: string;
}

/**
 * Accepts `stash:<name>@<hex prefix>`, `<name>@<hex prefix>`, `stash:<name>`
 * and bare `<name>`. Prefixes need at least 12 hex digits.
 */
export function parseRef(ref: string): ParsedRef {
  const text = ref.trim().replace(/^stash:/, "");
  const at = text.lastIndexOf("@");
  const name = at < 0 ? text : text.slice(0, at);
  const prefix = at < 0 ? undefined : text.slice(at + 1).toLowerCase();
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid stash reference "${ref}": expected stash:<name>@<hash> or <name>`);
  if (prefix !== undefined && !new RegExp(`^[0-9a-f]{${MIN_HANDLE_PREFIX},64}$`).test(prefix)) {
    throw new Error(`Invalid stash handle "${ref}": hash prefix needs ${MIN_HANDLE_PREFIX}-64 hex digits`);
  }
  return { name, prefix };
}

export interface ResolvedRef {
  hash: string;
  name: string;
  /** Metadata when the version is in this branch's index; absent for foreign handles. */
  record?: StashRecord;
}

/**
 * A bare name resolves through the current branch's index. A full handle
 * resolves from the content store directly, so handles written by another
 * session (a parent or a subagent) work too.
 */
export function resolveRef(ref: string, index: StashIndex, store: BlobStore): ResolvedRef {
  const { name, prefix } = parseRef(ref);
  if (!prefix) {
    const record = currentEntries(index).find((entry) => entry.name === name);
    if (!record) throw new Error(`No stash entry named "${name}" on this branch. Use a full handle (stash:${name}@<hash>) for entries from other sessions.`);
    return { hash: record.hash, name: record.name, record };
  }
  const known = index.records.filter((record) => record.hash.startsWith(prefix));
  const stored = store.findByPrefix(prefix);
  const candidates = [...new Set([...stored, ...known.filter((record) => record.name === name).map((record) => record.hash)])];
  if (candidates.length > 1) {
    throw new Error(`Ambiguous stash handle "${ref}"; candidates:\n${candidates.map((hash) => `stash:${name}@${hash}`).join("\n")}`);
  }
  if (!candidates.length) throw new Error(`Stash content for "${ref}" not found (expired, or stored on another machine)`);
  const hash = candidates[0];
  const record = [...index.records].reverse().find((entry) => entry.hash === hash && entry.name === name)
    ?? [...index.records].reverse().find((entry) => entry.hash === hash);
  return { hash, name: name!, record };
}
