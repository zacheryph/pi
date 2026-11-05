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
 * Whether `pid` is still running. A zombie counts as dead: a killed orphan is
 * reparented to PID 1 and stays a zombie until PID 1 reaps it, and some
 * container inits never do, while `kill(pid, 0)` still succeeds on it.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // /proc/<pid>/stat is "pid (comm) state ..."; comm may contain spaces or parens.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true; // no procfs (macOS): kill(pid, 0) is the best answer there
  }
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
