import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HubPaths } from "./protocol.ts";

export const HUB_ENTRY = fileURLToPath(new URL("./hub/server.ts", import.meta.url));
const MAX_LOG_BYTES = 1024 * 1024;

/** Pi's own Node when Pi runs on Node; compiled (Bun) builds fall back to `node` on PATH. */
export function nodeRuntime(configured?: string): string {
  if (configured) return configured;
  return process.versions.bun ? "node" : process.execPath;
}

export interface SpawnHubOptions {
  paths: HubPaths;
  port: number;
  node: string;
}

/** Starts a detached hub that outlives this Pi process. Output goes to the hub log. */
export function spawnHub(options: SpawnHubOptions): void {
  mkdirSync(options.paths.dir, { recursive: true, mode: 0o700 });
  try {
    if (statSync(options.paths.log).size > MAX_LOG_BYTES) truncateSync(options.paths.log);
  } catch {
    /* no log yet */
  }
  const log = openSync(options.paths.log, "a", 0o600);
  try {
    const child = spawn(
      options.node,
      [
        "--disable-warning=ExperimentalWarning",
        HUB_ENTRY,
        "--dir",
        options.paths.dir,
        "--port",
        String(options.port),
      ],
      { cwd: options.paths.dir, detached: true, stdio: ["ignore", log, log] },
    );
    // A missing runtime surfaces through the reporter's repeated connect failures.
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}
