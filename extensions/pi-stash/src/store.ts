import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PREFIX_PATTERN = /^[0-9a-f]{2,64}$/;
const BUCKET_PATTERN = /^[0-9a-f]{2}$/;
const TEMP_PREFIX = ".tmp-";
const DAY_MS = 24 * 60 * 60 * 1000;

/** `$PI_STASH_DIR`, else `<agent dir>/stash` (normally `~/.pi/agent/stash`). */
export function defaultStashRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_STASH_DIR?.trim() ? resolve(env.PI_STASH_DIR) : join(getAgentDir(), "stash");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface SweepResult {
  removed: number;
  freedBytes: number;
  kept: number;
}

/**
 * Immutable, content-addressed blobs: `<root>/blobs/<aa>/<sha256>`. Every path
 * is checked to resolve inside the real root, and symlinks are refused at each
 * level, so a planted link cannot redirect reads, writes or deletes.
 */
export class BlobStore {
  constructor(readonly root: string) {}

  private realRoot(create: boolean): string | undefined {
    try {
      if (create) mkdirSync(this.root, { recursive: true, mode: 0o700 });
      if (lstatSync(this.root).isSymbolicLink())
        throw new Error(`Stash root is a symlink: ${this.root}`);
      return realpathSync(this.root);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Refuse anything outside the root or any symlink along root → path. */
  private checked(realRoot: string, path: string): string {
    const rel = relative(realRoot, path);
    if (!rel || rel.startsWith("..") || resolve(realRoot, rel) !== path) {
      throw new Error(`Stash path escapes root: ${path}`);
    }
    let current = realRoot;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new Error(`Stash path is a symlink: ${current}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    return path;
  }

  private dir(realRoot: string, bucket?: string): string {
    return this.checked(
      realRoot,
      bucket ? join(realRoot, "blobs", bucket) : join(realRoot, "blobs"),
    );
  }

  /** Atomically writes `text` (temp file + rename); an existing blob is only touched. */
  put(text: string): { hash: string; bytes: number } {
    const hash = hashText(text);
    const bytes = Buffer.byteLength(text, "utf8");
    const realRoot = this.realRoot(true)!;
    const bucket = this.dir(realRoot, hash.slice(0, 2));
    mkdirSync(bucket, { recursive: true, mode: 0o700 });
    this.checked(realRoot, bucket);
    const target = this.checked(realRoot, join(bucket, hash));
    if (this.exists(target)) {
      this.touch(target);
      return { hash, bytes };
    }
    const temp = this.checked(
      realRoot,
      join(bucket, `${TEMP_PREFIX}${hash.slice(0, 16)}-${randomBytes(6).toString("hex")}`),
    );
    try {
      // "wx" refuses to follow or reuse anything already at the temp path.
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeSync(fd, text, null, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return { hash, bytes };
  }

  private exists(path: string): boolean {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new Error(`Stash blob is not a regular file: ${path}`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Refreshes mtime so the retention sweep treats the blob as recently used. */
  private touch(path: string): void {
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      /* read-only stores still work */
    }
  }

  has(hash: string): boolean {
    if (!HASH_PATTERN.test(hash)) return false;
    const realRoot = this.realRoot(false);
    if (!realRoot) return false;
    return this.exists(this.checked(realRoot, join(this.dir(realRoot, hash.slice(0, 2)), hash)));
  }

  /** Reads and verifies a blob. Throws when it is missing or corrupted. */
  read(hash: string, options: { touch?: boolean } = {}): string {
    if (!HASH_PATTERN.test(hash)) throw new Error(`Invalid stash hash: ${hash}`);
    const realRoot = this.realRoot(false);
    const missing = () =>
      new Error(`Stash content ${hash.slice(0, 12)} is missing (expired or from another machine)`);
    if (!realRoot) throw missing();
    const path = this.checked(realRoot, join(this.dir(realRoot, hash.slice(0, 2)), hash));
    if (!this.exists(path)) throw missing();
    const text = readFileSync(path, "utf8");
    if (hashText(text) !== hash) throw new Error(`Stash content ${hash.slice(0, 12)} is corrupted`);
    if (options.touch !== false) this.touch(path);
    return text;
  }

  /** Full hashes in the store starting with `prefix` (at least two hex digits). */
  findByPrefix(prefix: string): string[] {
    if (!PREFIX_PATTERN.test(prefix)) return [];
    const realRoot = this.realRoot(false);
    if (!realRoot) return [];
    const bucket = this.dir(realRoot, prefix.slice(0, 2));
    try {
      if (!lstatSync(bucket).isDirectory()) return [];
    } catch {
      return [];
    }
    return readdirSync(bucket)
      .filter((name) => HASH_PATTERN.test(name) && name.startsWith(prefix))
      .sort();
  }

  /** Refreshes blobs still referenced by the current session so a sweep keeps them. */
  touchAll(hashes: Iterable<string>): void {
    const realRoot = this.realRoot(false);
    if (!realRoot) return;
    for (const hash of new Set(hashes)) {
      if (!HASH_PATTERN.test(hash)) continue;
      const path = this.checked(realRoot, join(this.dir(realRoot, hash.slice(0, 2)), hash));
      if (this.exists(path)) this.touch(path);
    }
  }

  private *files(): Generator<{ path: string; name: string; size: number; lastUsed: number }> {
    const realRoot = this.realRoot(false);
    if (!realRoot) return;
    const blobs = this.dir(realRoot);
    let buckets: string[];
    try {
      if (!lstatSync(blobs).isDirectory()) return;
      buckets = readdirSync(blobs).filter((name) => BUCKET_PATTERN.test(name));
    } catch {
      return;
    }
    for (const bucketName of buckets) {
      const bucket = this.dir(realRoot, bucketName);
      if (!lstatSync(bucket).isDirectory()) continue;
      for (const name of readdirSync(bucket)) {
        const path = this.checked(realRoot, join(bucket, name));
        const stat = lstatSync(path);
        if (!stat.isFile()) continue;
        yield { path, name, size: stat.size, lastUsed: Math.max(stat.mtimeMs, stat.atimeMs) };
      }
    }
  }

  usage(): { blobs: number; bytes: number } {
    let blobs = 0;
    let bytes = 0;
    for (const file of this.files()) {
      if (!HASH_PATTERN.test(file.name)) continue;
      blobs++;
      bytes += file.size;
    }
    return { blobs, bytes };
  }

  /**
   * Deletes blobs not read or written for `retentionDays`, and abandoned temp
   * files older than a day. `keep` hashes are never deleted.
   */
  sweep(retentionDays: number, keep: Iterable<string> = [], now = Date.now()): SweepResult {
    const protectedHashes = new Set(keep);
    const cutoff = now - retentionDays * DAY_MS;
    const result: SweepResult = { removed: 0, freedBytes: 0, kept: 0 };
    for (const file of this.files()) {
      const isTemp = file.name.startsWith(TEMP_PREFIX);
      if (!isTemp && !HASH_PATTERN.test(file.name)) continue;
      const expired = isTemp
        ? file.lastUsed < now - DAY_MS
        : file.lastUsed < cutoff && !protectedHashes.has(file.name);
      if (!expired) {
        if (!isTemp) result.kept++;
        continue;
      }
      // Re-check right before deleting: the path must still be a plain file.
      if (
        !statSync(file.path, { throwIfNoEntry: false })?.isFile() ||
        lstatSync(file.path).isSymbolicLink()
      )
        continue;
      rmSync(file.path, { force: true });
      if (!isTemp) {
        result.removed++;
        result.freedBytes += file.size;
      }
    }
    return result;
  }
}
