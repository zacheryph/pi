import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir, waitForPid } from "./helpers.ts";

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
