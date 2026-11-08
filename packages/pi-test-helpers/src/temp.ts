import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defer, type Defer } from "./cleanup.ts";

/**
 * A fresh directory under the system temp dir, removed when `cleanup` runs.
 * Keep `prefix` short where the path ends up in a unix socket (about 104 bytes on macOS).
 */
export function tempDir(cleanup: Defer, prefix = "pi-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  defer(cleanup, () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Write files under `root`, creating parent directories. Objects are written as
 * pretty JSON, strings as they are.
 */
export function writeFiles(root: string, files: Record<string, string | object>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
}
