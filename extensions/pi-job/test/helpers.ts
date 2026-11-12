import { existsSync, readFileSync } from "node:fs";
import type { TestContext } from "node:test";
import { tempDir as sharedTempDir, waitFor } from "#test-helpers";

export { sleep, tick } from "#test-helpers";

/** A temp directory removed when the test ends. */
export const tempDir = (t: Pick<TestContext, "after">): string => sharedTempDir(t, "pi-job-test-");

/** Poll every 25 ms until `predicate` holds. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
  what = "condition",
): Promise<void> {
  await waitFor(predicate, { timeout: timeoutMs, interval: 25, what });
}

/**
 * A killed process stays a zombie until its parent reaps it. Orphans are
 * reparented to PID 1, and some container inits never reap them, so
 * `kill(pid, 0)` keeps succeeding for a process that has already exited.
 * Count a zombie as dead.
 */
export function alive(pid: number): boolean {
  // kill(0, 0) probes our own process group, which is always alive.
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`alive: invalid PID ${pid}`);
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
}

function isZombie(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false; // no procfs (macOS): kill(pid, 0) is all we have
  }
  // "pid (comm) state ..."; comm may itself contain parentheses.
  return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
}

export function readPid(path: string): number {
  return Number(readFileSync(path, "utf8").trim());
}

/** Shell redirection creates the file before echo writes the PID into it. */
export async function waitForPid(path: string): Promise<number> {
  let pid = 0;
  await waitUntil(
    () => {
      if (!existsSync(path)) return false;
      pid = readPid(path);
      return Number.isSafeInteger(pid) && pid > 0;
    },
    5000,
    `PID in ${path}`,
  );
  return pid;
}
