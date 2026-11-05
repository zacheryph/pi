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

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
