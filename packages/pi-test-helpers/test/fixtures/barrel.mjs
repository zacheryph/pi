import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

void test("the barrel preserves session state and supports node:test cleanup", async (t) => {
  const key = Symbol.for("session-tree:registry");
  const sentinel = { existing: true };
  globalThis[key] = sentinel;
  const { plainTheme, resetSessionTree, tempDir, waitFor } = await import("#src/index");
  assert.equal(globalThis[key], sentinel);
  assert.equal(plainTheme.bold("plain"), "plain");
  assert.equal(await waitFor(() => "ready"), "ready");
  assert.ok(existsSync(tempDir(t, "barrel-")));
  resetSessionTree();
  assert.equal(globalThis[key], undefined);
});
