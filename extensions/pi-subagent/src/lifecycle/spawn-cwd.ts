/**
 * spawn-cwd.ts — Check a caller's working directory for a new subagent.
 *
 * Local change: `subagent_start` and `SpawnOptions` accept a `cwd`, so the
 * caller (an orchestrator holding a worktree) chooses where the child runs. A
 * caller-chosen directory belongs to the caller: no workspace provider is
 * consulted and nothing is disposed when the run ends, so the child stays
 * resumable for as long as its session is kept.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve `value` against `baseCwd` and require an existing directory.
 * Absent (undefined or null) yields no override.
 */
export function resolveSpawnCwd(
  value: unknown,
  baseCwd: string,
): { cwd?: string } | { error: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || value.trim() === "") {
    return { error: "cwd must be a non-empty path to an existing directory" };
  }
  const cwd = resolve(baseCwd, value);
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    // Missing or unreadable: reported below with the resolved path.
  }
  if (!isDirectory) return { error: `cwd ${cwd} is not an existing directory` };
  return { cwd };
}
