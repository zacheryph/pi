import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { alive, tempDir, waitForPid, waitUntil } from "./helpers.ts";

for (const initial of [undefined, "", "0", "invalid"]) {
  void test(`waitForPid waits for a positive PID when the file starts as ${JSON.stringify(initial)}`, async (t) => {
    const path = join(tempDir(t), "child.pid");
    if (initial !== undefined) writeFileSync(path, initial);
    // Poll once before publishing the PID, including the empty-file window between
    // shell redirection and echo. No sleep is needed to force that ordering.
    const pending = waitForPid(path);
    writeFileSync(path, `${process.pid}\n`);
    assert.equal(await pending, process.pid);
  });
}

void test(
  "alive counts an unreaped zombie as dead",
  {
    skip: !existsSync("/proc/self/stat") && "needs procfs",
  },
  async (t) => {
    // The shell starts a short child, then execs into a sleep that never reaps it.
    const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    t.after(() => parent.kill("SIGKILL"));
    const zombie = await new Promise<number>((resolve) =>
      parent.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))),
    );
    await waitUntil(() => !alive(zombie), 3000, "the unreaped child to read as dead");
    assert.equal(alive(parent.pid!), true);
  },
);
