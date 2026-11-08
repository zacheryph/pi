import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export function tempDir(t: Pick<TestContext, "after">): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-job-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
