import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlobStore, defaultStashRoot, hashText } from "#src/store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-stash-store-"));
  dirs.push(dir);
  return dir;
}
const DAY = 24 * 60 * 60 * 1000;

describe("BlobStore", () => {
  it("stores content by sha256 under a two-character bucket and reads it back", () => {
    const root = join(temp(), "stash");
    const store = new BlobStore(root);
    const { hash, bytes } = store.put("héllo\n");
    expect(hash).toBe(hashText("héllo\n"));
    expect(bytes).toBe(7);
    expect(readFileSync(join(root, "blobs", hash.slice(0, 2), hash), "utf8")).toBe("héllo\n");
    expect(store.read(hash)).toBe("héllo\n");
    expect(store.has(hash)).toBe(true);
  });

  it("writes atomically: no temp files remain and re-putting is idempotent", () => {
    const root = temp();
    const store = new BlobStore(root);
    const first = store.put("same");
    const second = store.put("same");
    expect(second).toEqual(first);
    expect(readdirSync(join(root, "blobs", first.hash.slice(0, 2)))).toEqual([first.hash]);
  });

  it("detects corruption and missing content", () => {
    const root = temp();
    const store = new BlobStore(root);
    const { hash } = store.put("original");
    writeFileSync(join(root, "blobs", hash.slice(0, 2), hash), "tampered");
    expect(() => store.read(hash)).toThrow(/corrupted/);
    expect(() => store.read("0".repeat(64))).toThrow(/missing/);
    expect(() => store.read("../../etc/passwd")).toThrow(/Invalid stash hash/);
  });

  it("finds hashes by prefix", () => {
    const store = new BlobStore(temp());
    const a = store.put("a").hash;
    expect(store.findByPrefix(a.slice(0, 12))).toEqual([a]);
    expect(store.findByPrefix("zz")).toEqual([]);
    expect(store.findByPrefix("../")).toEqual([]);
  });

  it("refuses a symlinked root, bucket, or blob", () => {
    const base = temp();
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(base, "linked-root"));
    expect(() => new BlobStore(join(base, "linked-root")).put("x")).toThrow(/symlink/);

    const root = join(base, "root");
    const store = new BlobStore(root);
    const hash = hashText("payload");
    mkdirSync(join(root, "blobs"), { recursive: true });
    symlinkSync(outside, join(root, "blobs", hash.slice(0, 2)));
    expect(() => store.put("payload")).toThrow(/symlink/);
    expect(existsSync(join(outside, hash))).toBe(false);

    const other = new BlobStore(join(base, "other"));
    const target = hashText("secret");
    mkdirSync(join(base, "other", "blobs", target.slice(0, 2)), { recursive: true });
    writeFileSync(join(outside, "secret"), "secret");
    symlinkSync(join(outside, "secret"), join(base, "other", "blobs", target.slice(0, 2), target));
    expect(() => other.read(target)).toThrow(/symlink/);
  });

  it("sweeps blobs unused past retention, keeps protected and recent ones, and drops stale temp files", () => {
    const root = temp();
    const store = new BlobStore(root);
    const now = Date.now();
    const old = store.put("old").hash;
    const recent = store.put("recent").hash;
    const kept = store.put("kept").hash;
    const age = (hash: string, days: number) => {
      const when = new Date(now - days * DAY);
      utimesSync(join(root, "blobs", hash.slice(0, 2), hash), when, when);
    };
    age(old, 40);
    age(kept, 40);
    age(recent, 5);
    const tempFile = join(root, "blobs", old.slice(0, 2), ".tmp-abandoned");
    writeFileSync(tempFile, "partial");
    utimesSync(tempFile, new Date(now - 2 * DAY), new Date(now - 2 * DAY));
    const result = store.sweep(30, [kept], now);
    expect(result).toEqual({ removed: 1, freedBytes: 3, kept: 2 });
    expect(store.has(old)).toBe(false);
    expect(store.has(recent)).toBe(true);
    expect(store.has(kept)).toBe(true);
    expect(existsSync(tempFile)).toBe(false);
  });

  it("reading refreshes a blob so retention counts from last use", () => {
    const root = temp();
    const store = new BlobStore(root);
    const { hash } = store.put("used");
    const when = new Date(Date.now() - 40 * DAY);
    utimesSync(join(root, "blobs", hash.slice(0, 2), hash), when, when);
    store.read(hash);
    expect(store.sweep(30).removed).toBe(0);
  });

  it("reports usage and tolerates a missing root", () => {
    const store = new BlobStore(join(temp(), "missing"));
    expect(store.usage()).toEqual({ blobs: 0, bytes: 0 });
    expect(store.sweep(30)).toEqual({ removed: 0, freedBytes: 0, kept: 0 });
    store.put("12345");
    expect(store.usage()).toEqual({ blobs: 1, bytes: 5 });
  });

  it("uses PI_STASH_DIR when set", () => {
    expect(defaultStashRoot({ PI_STASH_DIR: "/tmp/custom-stash" })).toBe("/tmp/custom-stash");
    expect(defaultStashRoot({})).toMatch(/stash$/);
  });
});
