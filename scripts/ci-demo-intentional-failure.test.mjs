import assert from "node:assert/strict";
import { test } from "node:test";

void test("intentional failure for CI monitoring demonstration", () => {
  assert.equal(1, 2, "Intentional CI demonstration failure: do not fix or merge this test.");
});
