import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countLines, currentEntries, handleFor, parseRef, replayStashIndex, resolveRef,
  STASH_INDEX_TYPE, STASH_SCHEMA_VERSION, type StashRecord,
} from "#src/state";
import { BlobStore } from "#src/store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function store(): BlobStore {
  const dir = mkdtempSync(join(tmpdir(), "pi-stash-state-"));
  dirs.push(dir);
  return new BlobStore(dir);
}

function record(name: string, hash: string, createdAt = 1): StashRecord {
  return { name, hash, bytes: 1, lines: 1, mime: "text/plain", createdAt, createdBy: "session", source: "content" };
}
const put = (r: StashRecord) => ({ type: "custom", customType: STASH_INDEX_TYPE, data: { schemaVersion: STASH_SCHEMA_VERSION, op: "put", record: r } });
const checkpoint = (records: StashRecord[]) => ({ type: "custom", customType: STASH_INDEX_TYPE, data: { schemaVersion: STASH_SCHEMA_VERSION, op: "checkpoint", records } });
const branch = (...entries: unknown[]) => ({ sessionManager: { getBranch: () => entries } });

describe("handles", () => {
  it("formats with a 12-character hash prefix", () => {
    expect(handleFor({ name: "auth-findings", hash: "3f9a1c2b7d01".padEnd(64, "0") })).toBe("stash:auth-findings@3f9a1c2b7d01");
  });

  it("parses handles and bare names, rejecting short prefixes and bad names", () => {
    expect(parseRef("stash:a@3F9A1C2B7D01")).toEqual({ name: "a", prefix: "3f9a1c2b7d01" });
    expect(parseRef("a@3f9a1c2b7d01ff")).toEqual({ name: "a", prefix: "3f9a1c2b7d01ff" });
    expect(parseRef("stash:notes.v2")).toEqual({ name: "notes.v2", prefix: undefined });
    expect(parseRef(" notes ")).toEqual({ name: "notes", prefix: undefined });
    expect(() => parseRef("a@3f9a")).toThrow(/12-64 hex/);
    expect(() => parseRef("../x")).toThrow(/Invalid stash reference/);
    expect(() => parseRef("")).toThrow(/Invalid/);
  });

  it("counts lines with or without a trailing newline", () => {
    expect([countLines(""), countLines("a"), countLines("a\n"), countLines("a\nb"), countLines("\n\n")]).toEqual([0, 1, 1, 2, 2]);
  });
});

describe("index replay", () => {
  it("applies puts in order, keeps versions, and lets checkpoints reset the base", () => {
    const a1 = record("a", "1".repeat(64), 1);
    const a2 = record("a", "2".repeat(64), 2);
    const b = record("b", "3".repeat(64), 3);
    const index = replayStashIndex(branch(put(a1), checkpoint([a1]), put(a2), put(b)));
    expect(index.records).toEqual([a1, a2, b]);
    expect(currentEntries(index).map((entry) => entry.hash)).toEqual([b.hash, a2.hash]);
  });

  it("ignores foreign, malformed and future-version entries", () => {
    const good = record("ok", "a".repeat(64));
    const index = replayStashIndex(branch(
      { type: "custom", customType: "other", data: { op: "put", record: good } },
      { type: "custom", customType: STASH_INDEX_TYPE, data: { schemaVersion: 99, op: "put", record: good } },
      { type: "custom", customType: STASH_INDEX_TYPE, data: { schemaVersion: STASH_SCHEMA_VERSION, op: "put", record: { ...good, hash: "nope" } } },
      null,
      put(good),
    ));
    expect(index.records).toEqual([good]);
  });

  it("rebuilds from the current branch only (branch switch)", () => {
    const shared = record("shared", "1".repeat(64));
    const left = record("left", "2".repeat(64));
    const right = record("right", "3".repeat(64));
    expect(currentEntries(replayStashIndex(branch(put(shared), put(left)))).map((r) => r.name).sort()).toEqual(["left", "shared"]);
    expect(currentEntries(replayStashIndex(branch(put(shared), put(right)))).map((r) => r.name).sort()).toEqual(["right", "shared"]);
  });
});

describe("resolveRef", () => {
  it("resolves bare names via the branch index and full handles from the store", () => {
    const s = store();
    const v1 = s.put("one").hash;
    const v2 = s.put("two").hash;
    const index = { records: [record("doc", v1, 1), record("doc", v2, 2)] };
    expect(resolveRef("doc", index, s).hash).toBe(v2);
    expect(resolveRef(`stash:doc@${v1.slice(0, 12)}`, index, s)).toMatchObject({ hash: v1, record: { hash: v1 } });
    // Another session's handle: not in this index, still readable.
    const foreign = s.put("from a subagent").hash;
    expect(resolveRef(`stash:findings@${foreign.slice(0, 12)}`, { records: [] }, s)).toEqual({ hash: foreign, name: "findings", record: undefined });
    expect(() => resolveRef("missing", index, s)).toThrow(/No stash entry named "missing"/);
    expect(() => resolveRef(`x@${"0".repeat(12)}`, index, s)).toThrow(/not found/);
  });

  it("fails on ambiguous prefixes and lists every candidate", () => {
    const s = store();
    // Real sha256 collisions on 12 hex digits are impractical to produce, so
    // plant two blob files sharing a prefix in the store itself.
    const a = `abcdef012345${"0".repeat(52)}`;
    const b = `abcdef012345${"1".repeat(52)}`;
    s.put("create root");
    mkdirSync(join(s.root, "blobs", "ab"), { recursive: true });
    writeFileSync(join(s.root, "blobs", "ab", a), "a");
    writeFileSync(join(s.root, "blobs", "ab", b), "b");
    expect(() => resolveRef("stash:dup@abcdef012345", { records: [] }, s)).toThrow(new RegExp(`Ambiguous[\\s\\S]*${a}[\\s\\S]*${b}`));
    expect(resolveRef(`stash:dup@${a.slice(0, 13)}`, { records: [] }, s).hash).toBe(a);
  });
});
